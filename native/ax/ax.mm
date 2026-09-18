// Clance's reader for the macOS accessibility tree — the same API VoiceOver
// uses, which is how a session can read a field, a selection or a window's
// text directly instead of screenshotting the screen and guessing at
// pixels. Reads and writes go through AXUIElement, so they work on whatever
// app is frontmost without touching the clipboard, synthesising keystrokes
// or stealing focus.
//
// Shape: the addon exports exactly two functions, `call` (async) and
// `callSync`, both taking one JSON string naming an operation and returning
// one JSON string. Every operation is dispatched inside this file, so
// adding a tool later costs an `if` here and nothing in N-API. JSON is
// NSJSONSerialization's, so there is no dependency and no hand-written
// serializer.
//
// Threading: `call` runs the operation on a libuv worker, since an AX read
// is synchronous IPC to the target app and a wedged app would otherwise
// block Electron's main thread. Each element additionally gets a short
// messaging timeout, so even the worker can't hang indefinitely. `callSync`
// exists for the cheap, must-be-immediate cases (a trust check).

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

#include <node_api.h>

#include <unistd.h>

#include <mutex>
#include <string>
#include <unordered_map>

// How long any one AX call waits on the target app. macOS's default is 6s,
// which is an eternity to hold a worker for an app that is beachballing —
// a miss here just reports the attribute as absent, which every caller
// already handles.
static const float kMessagingTimeoutSeconds = 0.4f;

// Bounds for a tree walk. A deep document (a big web page under Chrome's AX
// tree) is effectively unbounded, so both the depth and the node count are
// capped and the result says whether it was cut short.
static const int kDefaultMaxDepth = 12;
static const int kDefaultMaxNodes = 600;
static const int kHardMaxNodes = 5000;

// ---------------------------------------------------------------------------
// Element handles
//
// An AXUIElementRef can't cross into JavaScript, so elements a caller may
// want to act on later are kept here and referred to by number. Retained on
// the way in, released on the way out; the oldest go when the table grows
// past its cap, which keeps a runaway tree walk from pinning every element
// of every app forever.
// ---------------------------------------------------------------------------

static const size_t kMaxHandles = 4000;

static std::mutex gHandlesMutex;
static std::unordered_map<uint64_t, AXUIElementRef> gHandles;
static uint64_t gNextHandle = 1;

static uint64_t RetainElement(AXUIElementRef element) {
  if (element == NULL) return 0;
  std::lock_guard<std::mutex> lock(gHandlesMutex);
  if (gHandles.size() >= kMaxHandles) {
    // Oldest first: handle ids increase monotonically, so the lowest live id
    // is the least recently produced.
    uint64_t oldest = 0;
    bool found = false;
    for (const auto &entry : gHandles) {
      if (!found || entry.first < oldest) {
        oldest = entry.first;
        found = true;
      }
    }
    if (found) {
      CFRelease(gHandles[oldest]);
      gHandles.erase(oldest);
    }
  }
  uint64_t id = gNextHandle++;
  CFRetain(element);
  gHandles[id] = element;
  return id;
}

// Borrowed, not owned — the caller must not release what comes back.
static AXUIElementRef ElementForHandle(uint64_t id) {
  std::lock_guard<std::mutex> lock(gHandlesMutex);
  auto it = gHandles.find(id);
  return it == gHandles.end() ? NULL : it->second;
}

static void ReleaseHandle(uint64_t id) {
  std::lock_guard<std::mutex> lock(gHandlesMutex);
  auto it = gHandles.find(id);
  if (it == gHandles.end()) return;
  CFRelease(it->second);
  gHandles.erase(it);
}

static void ReleaseAllHandles() {
  std::lock_guard<std::mutex> lock(gHandlesMutex);
  for (const auto &entry : gHandles) CFRelease(entry.second);
  gHandles.clear();
}

// ---------------------------------------------------------------------------
// CoreFoundation → JSON-able Foundation values
// ---------------------------------------------------------------------------

static id ValueToObject(CFTypeRef value, int depth);

// AXValueRef wraps the geometry and range types; unwrap the ones a caller
// can do anything with and describe the rest by name rather than dropping
// them silently.
static id AXValueToObject(AXValueRef value) {
  AXValueType type = AXValueGetType(value);
  switch (type) {
    case kAXValueTypeCGPoint: {
      CGPoint point;
      if (AXValueGetValue(value, kAXValueTypeCGPoint, &point)) {
        return @{@"x" : @(point.x), @"y" : @(point.y)};
      }
      break;
    }
    case kAXValueTypeCGSize: {
      CGSize size;
      if (AXValueGetValue(value, kAXValueTypeCGSize, &size)) {
        return @{@"width" : @(size.width), @"height" : @(size.height)};
      }
      break;
    }
    case kAXValueTypeCGRect: {
      CGRect rect;
      if (AXValueGetValue(value, kAXValueTypeCGRect, &rect)) {
        return @{
          @"x" : @(rect.origin.x),
          @"y" : @(rect.origin.y),
          @"width" : @(rect.size.width),
          @"height" : @(rect.size.height)
        };
      }
      break;
    }
    case kAXValueTypeCFRange: {
      CFRange range;
      if (AXValueGetValue(value, kAXValueTypeCFRange, &range)) {
        return @{@"location" : @(range.location), @"length" : @(range.length)};
      }
      break;
    }
    default:
      break;
  }
  return @{@"axValueType" : @((int)type)};
}

static id ValueToObject(CFTypeRef value, int depth) {
  if (value == NULL) return [NSNull null];
  CFTypeID typeId = CFGetTypeID(value);

  if (typeId == CFStringGetTypeID()) return (__bridge NSString *)value;
  if (typeId == CFNumberGetTypeID()) return (__bridge NSNumber *)value;
  if (typeId == CFBooleanGetTypeID()) {
    return CFBooleanGetValue((CFBooleanRef)value) ? @YES : @NO;
  }
  if (typeId == AXValueGetTypeID()) return AXValueToObject((AXValueRef)value);
  if (typeId == AXUIElementGetTypeID()) {
    // An element referenced by an attribute becomes a handle, so a caller
    // can read or act on it without walking back to it.
    return @{@"handle" : @(RetainElement((AXUIElementRef)value))};
  }
  if (typeId == CFArrayGetTypeID()) {
    // One level only: an array of arrays is vanishingly rare and the guard
    // keeps a malformed tree from recursing without end.
    if (depth > 1) return @"[array]";
    CFArrayRef array = (CFArrayRef)value;
    CFIndex count = CFArrayGetCount(array);
    NSMutableArray *result = [NSMutableArray arrayWithCapacity:(NSUInteger)count];
    for (CFIndex i = 0; i < count; i++) {
      [result addObject:ValueToObject(CFArrayGetValueAtIndex(array, i), depth + 1)];
    }
    return result;
  }
  CFStringRef description = CFCopyTypeIDDescription(typeId);
  NSString *name = description ? (__bridge_transfer NSString *)description : @"unknown";
  return [NSString stringWithFormat:@"[%@]", name];
}

// ---------------------------------------------------------------------------
// Element reads
// ---------------------------------------------------------------------------

static void ApplyTimeout(AXUIElementRef element) {
  if (element) AXUIElementSetMessagingTimeout(element, kMessagingTimeoutSeconds);
}

static CFTypeRef CopyAttribute(AXUIElementRef element, CFStringRef name) {
  if (element == NULL) return NULL;
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return NULL;
  return value;
}

static NSString *CopyStringAttribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = CopyAttribute(element, name);
  if (value == NULL) return nil;
  NSString *result = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    result = [(__bridge NSString *)value copy];
  } else if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    result = [(__bridge NSNumber *)value stringValue];
  }
  CFRelease(value);
  return result;
}

// A password field. Checked as both role and subrole: AppKit gives one the
// AXSecureTextField role, while a web password input under Chromium or
// WebKit is an AXTextField carrying that as its subrole.
//
// Nothing below ever returns a secure field's text — not its value, not its
// selection, not as part of a window's text. The guard lives here rather
// than in the tools so that no future caller can reach around it, and the
// element is still reported (marked `secure`), so a reader can say "there
// is a password field here" without saying what is in it.
static BOOL IsSecureElement(AXUIElementRef element) {
  if (element == NULL) return NO;
  NSString *role = CopyStringAttribute(element, kAXRoleAttribute);
  if ([role isEqualToString:@"AXSecureTextField"]) return YES;
  NSString *subrole = CopyStringAttribute(element, kAXSubroleAttribute);
  return [subrole isEqualToString:@"AXSecureTextField"];
}

static id AttributeObject(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = CopyAttribute(element, name);
  if (value == NULL) return nil;
  id object = ValueToObject(value, 0);
  CFRelease(value);
  return object;
}

static NSArray<NSString *> *AttributeNames(AXUIElementRef element) {
  CFArrayRef names = NULL;
  if (AXUIElementCopyAttributeNames(element, &names) != kAXErrorSuccess || names == NULL) {
    return @[];
  }
  NSArray<NSString *> *result = (__bridge_transfer NSArray<NSString *> *)names;
  return result;
}

static NSArray<NSString *> *ActionNames(AXUIElementRef element) {
  CFArrayRef names = NULL;
  if (AXUIElementCopyActionNames(element, &names) != kAXErrorSuccess || names == NULL) {
    return @[];
  }
  NSArray<NSString *> *result = (__bridge_transfer NSArray<NSString *> *)names;
  return result;
}

// The app an element belongs to, so a caller can tell "the field I read" from
// "a field in some other app that happened to be focused a moment later".
static NSDictionary *AppInfo(AXUIElementRef element) {
  pid_t pid = 0;
  if (element == NULL || AXUIElementGetPid(element, &pid) != kAXErrorSuccess) return nil;
  NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
  if (app == nil) return @{@"pid" : @(pid)};
  return @{
    @"pid" : @(pid),
    @"name" : app.localizedName ?: [NSNull null],
    @"bundleId" : app.bundleIdentifier ?: [NSNull null]
  };
}

// A trimmed description of one element: what it is, what it holds, where it
// is, and what can be done to it. `full` adds the things only worth paying
// for on a single element (every attribute name, the action list), which a
// 600-node tree walk would rather not carry.
static NSMutableDictionary *DescribeElement(AXUIElementRef element, BOOL full) {
  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  if (element == NULL) return node;
  ApplyTimeout(element);

  node[@"handle"] = @(RetainElement(element));

  NSString *role = CopyStringAttribute(element, kAXRoleAttribute);
  if (role) node[@"role"] = role;
  NSString *subrole = CopyStringAttribute(element, kAXSubroleAttribute);
  if (subrole) node[@"subrole"] = subrole;
  NSString *roleDescription = CopyStringAttribute(element, kAXRoleDescriptionAttribute);
  if (roleDescription) node[@"roleDescription"] = roleDescription;

  NSString *title = CopyStringAttribute(element, kAXTitleAttribute);
  if (title.length) node[@"title"] = title;
  NSString *label = CopyStringAttribute(element, kAXDescriptionAttribute);
  if (label.length) node[@"label"] = label;
  NSString *help = CopyStringAttribute(element, kAXHelpAttribute);
  if (help.length) node[@"help"] = help;
  NSString *placeholder = CopyStringAttribute(element, kAXPlaceholderValueAttribute);
  if (placeholder.length) node[@"placeholder"] = placeholder;

  BOOL secure = IsSecureElement(element);
  if (secure) node[@"secure"] = @YES;

  if (!secure) {
    id value = AttributeObject(element, kAXValueAttribute);
    if (value && value != [NSNull null]) node[@"value"] = value;

    NSString *selectedText = CopyStringAttribute(element, kAXSelectedTextAttribute);
    if (selectedText.length) node[@"selectedText"] = selectedText;
    id selectedRange = AttributeObject(element, kAXSelectedTextRangeAttribute);
    if (selectedRange) node[@"selectedRange"] = selectedRange;
  }

  id position = AttributeObject(element, kAXPositionAttribute);
  id size = AttributeObject(element, kAXSizeAttribute);
  if ([position isKindOfClass:[NSDictionary class]] && [size isKindOfClass:[NSDictionary class]]) {
    node[@"frame"] = @{
      @"x" : position[@"x"] ?: @0,
      @"y" : position[@"y"] ?: @0,
      @"width" : size[@"width"] ?: @0,
      @"height" : size[@"height"] ?: @0
    };
  }

  Boolean settable = false;
  if (AXUIElementIsAttributeSettable(element, kAXValueAttribute, &settable) == kAXErrorSuccess) {
    node[@"editable"] = settable ? @YES : @NO;
  }

  if (full) {
    node[@"attributes"] = AttributeNames(element);
    node[@"actions"] = ActionNames(element);
    NSDictionary *app = AppInfo(element);
    if (app) node[@"app"] = app;
    id window = AttributeObject(element, kAXWindowAttribute);
    if ([window isKindOfClass:[NSDictionary class]]) {
      AXUIElementRef windowElement = ElementForHandle([window[@"handle"] unsignedLongLongValue]);
      NSString *windowTitle = windowElement ? CopyStringAttribute(windowElement, kAXTitleAttribute) : nil;
      if (windowTitle.length) node[@"windowTitle"] = windowTitle;
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Roots
// ---------------------------------------------------------------------------

static AXUIElementRef CopyFrontmostApplicationElement(void) {
  NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
  if (app == nil) return NULL;
  return AXUIElementCreateApplication(app.processIdentifier);
}

// An app by pid, so a caller can read the app the user came *from* rather
// than whatever is frontmost — which is Clance itself whenever someone is
// typing to Claude in the widget.
static AXUIElementRef CopyApplicationElement(pid_t pid) {
  if (pid <= 0) return CopyFrontmostApplicationElement();
  return AXUIElementCreateApplication(pid);
}

static pid_t RequestedPid(NSDictionary *op) {
  id pid = op[@"pid"];
  return [pid isKindOfClass:[NSNumber class]] ? (pid_t)[pid intValue] : 0;
}

// The focused element, preferring the system-wide route (which follows
// keyboard focus wherever it is) and falling back to asking the frontmost
// app directly, since some apps answer one and not the other.
static AXUIElementRef CopyFocusedElement(pid_t pid) {
  if (pid > 0) {
    AXUIElementRef app = CopyApplicationElement(pid);
    if (app == NULL) return NULL;
    ApplyTimeout(app);
    CFTypeRef focused = CopyAttribute(app, kAXFocusedUIElementAttribute);
    CFRelease(app);
    if (focused != NULL && CFGetTypeID(focused) == AXUIElementGetTypeID()) {
      return (AXUIElementRef)focused;
    }
    if (focused != NULL) CFRelease(focused);
    return NULL;
  }

  AXUIElementRef systemWide = AXUIElementCreateSystemWide();
  ApplyTimeout(systemWide);
  CFTypeRef focused = CopyAttribute(systemWide, kAXFocusedUIElementAttribute);
  CFRelease(systemWide);
  if (focused != NULL && CFGetTypeID(focused) == AXUIElementGetTypeID()) {
    return (AXUIElementRef)focused;
  }
  if (focused != NULL) CFRelease(focused);

  AXUIElementRef app = CopyFrontmostApplicationElement();
  if (app == NULL) return NULL;
  ApplyTimeout(app);
  CFTypeRef appFocused = CopyAttribute(app, kAXFocusedUIElementAttribute);
  CFRelease(app);
  if (appFocused != NULL && CFGetTypeID(appFocused) == AXUIElementGetTypeID()) {
    return (AXUIElementRef)appFocused;
  }
  if (appFocused != NULL) CFRelease(appFocused);
  return NULL;
}

static AXUIElementRef CopyFocusedWindowElement(pid_t pid) {
  AXUIElementRef app = CopyApplicationElement(pid);
  if (app == NULL) return NULL;
  ApplyTimeout(app);
  CFTypeRef window = CopyAttribute(app, kAXFocusedWindowAttribute);
  CFRelease(app);
  if (window != NULL && CFGetTypeID(window) == AXUIElementGetTypeID()) {
    return (AXUIElementRef)window;
  }
  if (window != NULL) CFRelease(window);
  return NULL;
}

// Resolves whichever root an operation asked for: an explicit handle, the
// focused window, or the focused element.
static AXUIElementRef CopyRootForRequest(NSDictionary *op, BOOL *needsRelease) {
  *needsRelease = NO;
  id handle = op[@"handle"];
  if ([handle isKindOfClass:[NSNumber class]]) {
    AXUIElementRef element = ElementForHandle([handle unsignedLongLongValue]);
    return element;  // borrowed
  }
  NSString *root = op[@"root"];
  pid_t pid = RequestedPid(op);
  AXUIElementRef element = [root isEqualToString:@"focusedElement"] ? CopyFocusedElement(pid)
                                                                   : CopyFocusedWindowElement(pid);
  *needsRelease = element != NULL;
  return element;
}

// ---------------------------------------------------------------------------
// Tree walk
// ---------------------------------------------------------------------------

// Roles whose value is the app's own text rather than chrome — used by the
// windowText operation to decide what to keep.
static BOOL IsTextRole(NSString *role) {
  static NSSet *textRoles = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    textRoles = [NSSet setWithArray:@[
      @"AXStaticText", @"AXTextField", @"AXTextArea", @"AXHeading", @"AXLink", @"AXButton",
      @"AXMenuItem", @"AXCheckBox", @"AXRadioButton", @"AXCell", @"AXRow", @"AXPopUpButton",
      @"AXTabButton", @"AXComboBox", @"AXSearchField", @"AXWebArea", @"AXGroup"
    ]];
  });
  return [textRoles containsObject:role];
}

typedef struct {
  int maxDepth;
  int maxNodes;
  BOOL includeFrames;
  BOOL truncated;
  int visited;
} WalkState;

static void WalkElement(AXUIElementRef element, int depth, int parentIndex,
                        NSMutableArray *nodes, WalkState *state) {
  if (element == NULL || state->visited >= state->maxNodes) {
    if (element != NULL) state->truncated = YES;
    return;
  }
  ApplyTimeout(element);

  NSMutableDictionary *node = [NSMutableDictionary dictionary];
  node[@"handle"] = @(RetainElement(element));
  node[@"depth"] = @(depth);
  node[@"parent"] = @(parentIndex);

  NSString *role = CopyStringAttribute(element, kAXRoleAttribute);
  if (role) node[@"role"] = role;
  NSString *title = CopyStringAttribute(element, kAXTitleAttribute);
  if (title.length) node[@"title"] = title;
  NSString *label = CopyStringAttribute(element, kAXDescriptionAttribute);
  if (label.length) node[@"label"] = label;
  NSString *placeholder = CopyStringAttribute(element, kAXPlaceholderValueAttribute);
  if (placeholder.length) node[@"placeholder"] = placeholder;
  if (IsSecureElement(element)) {
    node[@"secure"] = @YES;
  } else {
    NSString *value = CopyStringAttribute(element, kAXValueAttribute);
    if (value.length) node[@"value"] = value;
  }

  if (state->includeFrames) {
    id position = AttributeObject(element, kAXPositionAttribute);
    id size = AttributeObject(element, kAXSizeAttribute);
    if ([position isKindOfClass:[NSDictionary class]] && [size isKindOfClass:[NSDictionary class]]) {
      node[@"frame"] = @{
        @"x" : position[@"x"] ?: @0,
        @"y" : position[@"y"] ?: @0,
        @"width" : size[@"width"] ?: @0,
        @"height" : size[@"height"] ?: @0
      };
    }
  }

  int index = (int)nodes.count;
  [nodes addObject:node];
  state->visited++;

  if (depth >= state->maxDepth) {
    CFTypeRef children = CopyAttribute(element, kAXChildrenAttribute);
    if (children != NULL) {
      if (CFGetTypeID(children) == CFArrayGetTypeID() && CFArrayGetCount((CFArrayRef)children) > 0) {
        state->truncated = YES;
      }
      CFRelease(children);
    }
    return;
  }

  CFTypeRef children = CopyAttribute(element, kAXChildrenAttribute);
  if (children == NULL) return;
  if (CFGetTypeID(children) != CFArrayGetTypeID()) {
    CFRelease(children);
    return;
  }
  CFArrayRef array = (CFArrayRef)children;
  CFIndex count = CFArrayGetCount(array);
  for (CFIndex i = 0; i < count; i++) {
    CFTypeRef child = CFArrayGetValueAtIndex(array, i);
    if (child == NULL || CFGetTypeID(child) != AXUIElementGetTypeID()) continue;
    WalkElement((AXUIElementRef)child, depth + 1, index, nodes, state);
    if (state->visited >= state->maxNodes) {
      state->truncated = YES;
      break;
    }
  }
  CFRelease(children);
}

// The editable roles a "focused field" can be. Used when falling back to a
// tree search, so a marked-but-uninteresting element (a group, a web area)
// doesn't win over the field someone was actually typing in.
static BOOL IsFieldRole(NSString *role) {
  static NSSet *fieldRoles = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    fieldRoles = [NSSet setWithArray:@[
      @"AXTextField", @"AXTextArea", @"AXComboBox", @"AXSearchField", @"AXSecureTextField"
    ]];
  });
  return [fieldRoles containsObject:role];
}

static BOOL IsElementFocused(AXUIElementRef element) {
  CFTypeRef focused = CopyAttribute(element, kAXFocusedAttribute);
  if (focused == NULL) return NO;
  BOOL result = CFGetTypeID(focused) == CFBooleanGetTypeID() && CFBooleanGetValue((CFBooleanRef)focused);
  CFRelease(focused);
  return result;
}

// Depth-first search for the element an app considers focused. This is the
// fallback for reading an app that isn't frontmost: macOS gives an inactive
// app no keyboard focus, so AXFocusedUIElement comes back nil, but the app
// still marks AXFocused on the element it would return to — which is how
// Clance can read the field someone was typing in before they switched to
// the widget to ask about it. A field beats a non-field, so a marked
// container can't shadow the real answer.
static AXUIElementRef CopyFocusedDescendant(AXUIElementRef element, int depth, int maxDepth,
                                            int *budget, AXUIElementRef *fallback) {
  if (element == NULL || *budget <= 0) return NULL;
  (*budget)--;
  ApplyTimeout(element);

  if (IsElementFocused(element)) {
    NSString *role = CopyStringAttribute(element, kAXRoleAttribute);
    if (IsFieldRole(role)) {
      CFRetain(element);
      return element;
    }
    if (*fallback == NULL) {
      CFRetain(element);
      *fallback = element;
    }
  }
  if (depth >= maxDepth) return NULL;

  CFTypeRef children = CopyAttribute(element, kAXChildrenAttribute);
  if (children == NULL) return NULL;
  AXUIElementRef found = NULL;
  if (CFGetTypeID(children) == CFArrayGetTypeID()) {
    CFArrayRef array = (CFArrayRef)children;
    CFIndex count = CFArrayGetCount(array);
    for (CFIndex i = 0; i < count && found == NULL; i++) {
      CFTypeRef child = CFArrayGetValueAtIndex(array, i);
      if (child == NULL || CFGetTypeID(child) != AXUIElementGetTypeID()) continue;
      found = CopyFocusedDescendant((AXUIElementRef)child, depth + 1, maxDepth, budget, fallback);
    }
  }
  CFRelease(children);
  return found;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

// Whether an element belongs to Clance itself. Writing into our own UI over
// AX deadlocks — the call waits on a reply from the very process making it,
// and the messaging timeout doesn't rescue it (observed: a setValue against
// this process's own text field hung for tens of seconds). It is never a
// thing a caller wants either: the widget is frontmost while the user types
// to Claude, so "the focused field" would be Clance's own terminal.
static BOOL IsOwnProcess(AXUIElementRef element) {
  pid_t pid = 0;
  if (element == NULL || AXUIElementGetPid(element, &pid) != kAXErrorSuccess) return NO;
  return pid == getpid();
}

static int ClampedInt(id value, int fallback, int max) {
  if (![value isKindOfClass:[NSNumber class]]) return fallback;
  int result = [value intValue];
  if (result <= 0) return fallback;
  return result > max ? max : result;
}

static NSDictionary *RunOperation(NSDictionary *op) {
  NSString *name = op[@"op"];
  if (![name isKindOfClass:[NSString class]]) {
    return @{@"ok" : @NO, @"error" : @"missing op"};
  }

  if ([name isEqualToString:@"isTrusted"]) {
    return @{@"ok" : @YES, @"trusted" : AXIsProcessTrusted() ? @YES : @NO};
  }

  // Everything below reads another app's UI, which macOS refuses outright
  // without the Accessibility grant. Saying so once here beats every
  // operation reporting an empty result that reads like "nothing there".
  if (!AXIsProcessTrusted()) {
    return @{@"ok" : @NO, @"error" : @"accessibility-denied"};
  }

  if ([name isEqualToString:@"focusedElement"]) {
    AXUIElementRef element = CopyFocusedElement(RequestedPid(op));
    if (element == NULL) return @{@"ok" : @YES, @"element" : [NSNull null]};
    NSMutableDictionary *described = DescribeElement(element, YES);
    CFRelease(element);
    return @{@"ok" : @YES, @"element" : described};
  }

  if ([name isEqualToString:@"focusedField"]) {
    pid_t pid = RequestedPid(op);
    AXUIElementRef element = CopyFocusedElement(pid);
    if (element != NULL) {
      NSString *role = CopyStringAttribute(element, kAXRoleAttribute);
      if (IsFieldRole(role)) {
        NSMutableDictionary *described = DescribeElement(element, YES);
        CFRelease(element);
        return @{@"ok" : @YES, @"element" : described, @"via" : @"focus"};
      }
      CFRelease(element);
    }

    AXUIElementRef window = CopyFocusedWindowElement(pid);
    if (window == NULL) return @{@"ok" : @YES, @"element" : [NSNull null]};
    int budget = ClampedInt(op[@"maxNodes"], 800, kHardMaxNodes);
    AXUIElementRef fallback = NULL;
    AXUIElementRef found =
        CopyFocusedDescendant(window, 0, ClampedInt(op[@"maxDepth"], 20, 60), &budget, &fallback);
    CFRelease(window);

    AXUIElementRef result = found ? found : fallback;
    if (result == NULL) {
      if (fallback != NULL) CFRelease(fallback);
      return @{@"ok" : @YES, @"element" : [NSNull null]};
    }
    NSMutableDictionary *described = DescribeElement(result, YES);
    if (found != NULL) CFRelease(found);
    if (fallback != NULL) CFRelease(fallback);
    return @{@"ok" : @YES, @"element" : described, @"via" : found ? @"marked" : @"marked-container"};
  }

  if ([name isEqualToString:@"focusedWindow"]) {
    AXUIElementRef window = CopyFocusedWindowElement(RequestedPid(op));
    if (window == NULL) return @{@"ok" : @YES, @"element" : [NSNull null]};
    NSMutableDictionary *described = DescribeElement(window, YES);
    CFRelease(window);
    return @{@"ok" : @YES, @"element" : described};
  }

  if ([name isEqualToString:@"frontmostApp"]) {
    NSRunningApplication *app = [[NSWorkspace sharedWorkspace] frontmostApplication];
    if (app == nil) return @{@"ok" : @YES, @"app" : [NSNull null]};
    return @{
      @"ok" : @YES,
      @"app" : @{
        @"pid" : @(app.processIdentifier),
        @"name" : app.localizedName ?: [NSNull null],
        @"bundleId" : app.bundleIdentifier ?: [NSNull null],
        // Whether the frontmost app is Clance — the caller then knows to
        // read the app the user came from instead of our own windows.
        @"ours" : app.processIdentifier == getpid() ? @YES : @NO
      }
    };
  }

  if ([name isEqualToString:@"appByName"]) {
    NSString *needle = op[@"name"];
    if (![needle isKindOfClass:[NSString class]] || needle.length == 0) {
      return @{@"ok" : @NO, @"error" : @"name is required"};
    }
    NSMutableArray *matches = [NSMutableArray array];
    for (NSRunningApplication *app in [[NSWorkspace sharedWorkspace] runningApplications]) {
      if (app.activationPolicy != NSApplicationActivationPolicyRegular) continue;
      NSString *appName = app.localizedName ?: @"";
      NSString *bundleId = app.bundleIdentifier ?: @"";
      if ([appName rangeOfString:needle options:NSCaseInsensitiveSearch].location == NSNotFound &&
          [bundleId rangeOfString:needle options:NSCaseInsensitiveSearch].location == NSNotFound) {
        continue;
      }
      [matches addObject:@{
        @"pid" : @(app.processIdentifier),
        @"name" : appName,
        @"bundleId" : bundleId,
        @"frontmost" : app.isActive ? @YES : @NO
      }];
    }
    return @{@"ok" : @YES, @"apps" : matches};
  }

  if ([name isEqualToString:@"elementAt"]) {
    float x = [op[@"x"] floatValue];
    float y = [op[@"y"] floatValue];
    AXUIElementRef systemWide = AXUIElementCreateSystemWide();
    ApplyTimeout(systemWide);
    AXUIElementRef element = NULL;
    AXError error = AXUIElementCopyElementAtPosition(systemWide, x, y, &element);
    CFRelease(systemWide);
    if (error != kAXErrorSuccess || element == NULL) {
      return @{@"ok" : @YES, @"element" : [NSNull null]};
    }
    NSMutableDictionary *described = DescribeElement(element, YES);
    CFRelease(element);
    return @{@"ok" : @YES, @"element" : described};
  }

  if ([name isEqualToString:@"describe"]) {
    AXUIElementRef element = ElementForHandle([op[@"handle"] unsignedLongLongValue]);
    if (element == NULL) return @{@"ok" : @NO, @"error" : @"unknown handle"};
    return @{@"ok" : @YES, @"element" : DescribeElement(element, YES)};
  }

  if ([name isEqualToString:@"attributes"]) {
    AXUIElementRef element = ElementForHandle([op[@"handle"] unsignedLongLongValue]);
    if (element == NULL) return @{@"ok" : @NO, @"error" : @"unknown handle"};
    ApplyTimeout(element);
    NSArray<NSString *> *names = [op[@"names"] isKindOfClass:[NSArray class]] ? op[@"names"]
                                                                             : AttributeNames(element);
    // The one generic read, and so the one that could hand back a password
    // by asking for AXValue by name. Secure fields answer everything except
    // what they hold.
    BOOL secure = IsSecureElement(element);
    NSSet *withheld = [NSSet setWithArray:@[ @"AXValue", @"AXSelectedText", @"AXSelectedTextRange" ]];
    NSMutableDictionary *values = [NSMutableDictionary dictionary];
    for (NSString *attribute in names) {
      if (![attribute isKindOfClass:[NSString class]]) continue;
      if (secure && [withheld containsObject:attribute]) continue;
      id value = AttributeObject(element, (__bridge CFStringRef)attribute);
      if (value) values[attribute] = value;
    }
    if (secure) values[@"secure"] = @YES;
    return @{@"ok" : @YES, @"values" : values};
  }

  if ([name isEqualToString:@"tree"]) {
    BOOL needsRelease = NO;
    AXUIElementRef root = CopyRootForRequest(op, &needsRelease);
    if (root == NULL) return @{@"ok" : @YES, @"nodes" : @[], @"truncated" : @NO};
    WalkState state = {
      .maxDepth = ClampedInt(op[@"maxDepth"], kDefaultMaxDepth, 60),
      .maxNodes = ClampedInt(op[@"maxNodes"], kDefaultMaxNodes, kHardMaxNodes),
      .includeFrames = [op[@"includeFrames"] boolValue],
      .truncated = NO,
      .visited = 0,
    };
    NSMutableArray *nodes = [NSMutableArray array];
    WalkElement(root, 0, -1, nodes, &state);
    if (needsRelease) CFRelease(root);
    return @{@"ok" : @YES, @"nodes" : nodes, @"truncated" : state.truncated ? @YES : @NO};
  }

  if ([name isEqualToString:@"setValue"]) {
    AXUIElementRef element = ElementForHandle([op[@"handle"] unsignedLongLongValue]);
    if (element == NULL) return @{@"ok" : @NO, @"error" : @"unknown handle"};
    if (IsOwnProcess(element)) return @{@"ok" : @NO, @"error" : @"self-target"};
    NSString *value = op[@"value"];
    if (![value isKindOfClass:[NSString class]]) return @{@"ok" : @NO, @"error" : @"value must be a string"};
    ApplyTimeout(element);
    AXError error = AXUIElementSetAttributeValue(element, kAXValueAttribute, (__bridge CFTypeRef)value);
    return @{@"ok" : error == kAXErrorSuccess ? @YES : @NO, @"axError" : @((int)error)};
  }

  if ([name isEqualToString:@"setSelectedText"]) {
    AXUIElementRef element = ElementForHandle([op[@"handle"] unsignedLongLongValue]);
    if (element == NULL) return @{@"ok" : @NO, @"error" : @"unknown handle"};
    if (IsOwnProcess(element)) return @{@"ok" : @NO, @"error" : @"self-target"};
    NSString *value = op[@"value"];
    if (![value isKindOfClass:[NSString class]]) return @{@"ok" : @NO, @"error" : @"value must be a string"};
    ApplyTimeout(element);
    AXError error =
        AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute, (__bridge CFTypeRef)value);
    return @{@"ok" : error == kAXErrorSuccess ? @YES : @NO, @"axError" : @((int)error)};
  }

  if ([name isEqualToString:@"performAction"]) {
    AXUIElementRef element = ElementForHandle([op[@"handle"] unsignedLongLongValue]);
    if (element == NULL) return @{@"ok" : @NO, @"error" : @"unknown handle"};
    if (IsOwnProcess(element)) return @{@"ok" : @NO, @"error" : @"self-target"};
    NSString *action = op[@"action"];
    if (![action isKindOfClass:[NSString class]]) return @{@"ok" : @NO, @"error" : @"action must be a string"};
    ApplyTimeout(element);
    AXError error = AXUIElementPerformAction(element, (__bridge CFStringRef)action);
    return @{@"ok" : error == kAXErrorSuccess ? @YES : @NO, @"axError" : @((int)error)};
  }

  if ([name isEqualToString:@"windowText"]) {
    BOOL needsRelease = NO;
    AXUIElementRef root = CopyRootForRequest(op, &needsRelease);
    if (root == NULL) return @{@"ok" : @YES, @"text" : @"", @"truncated" : @NO};
    WalkState state = {
      .maxDepth = ClampedInt(op[@"maxDepth"], 20, 60),
      .maxNodes = ClampedInt(op[@"maxNodes"], 1500, kHardMaxNodes),
      .includeFrames = NO,
      .truncated = NO,
      .visited = 0,
    };
    NSMutableArray *nodes = [NSMutableArray array];
    WalkElement(root, 0, -1, nodes, &state);
    if (needsRelease) CFRelease(root);

    // One line per element that actually carries text, de-duplicated:
    // container roles repeat their children's text, and a web page under
    // Chrome's tree repeats it several times over.
    NSMutableArray<NSString *> *lines = [NSMutableArray array];
    NSMutableSet<NSString *> *seen = [NSMutableSet set];
    NSUInteger maxChars = (NSUInteger)ClampedInt(op[@"maxChars"], 20000, 200000);
    NSUInteger total = 0;
    for (NSDictionary *node in nodes) {
      NSString *role = node[@"role"];
      if (role && !IsTextRole(role)) continue;
      for (NSString *key in @[ @"value", @"title", @"label" ]) {
        NSString *text = node[key];
        if (![text isKindOfClass:[NSString class]]) continue;
        NSString *trimmed = [text stringByTrimmingCharactersInSet:
                                      [NSCharacterSet whitespaceAndNewlineCharacterSet]];
        if (trimmed.length == 0 || [seen containsObject:trimmed]) continue;
        [seen addObject:trimmed];
        [lines addObject:trimmed];
        total += trimmed.length + 1;
        break;
      }
      if (total >= maxChars) {
        state.truncated = YES;
        break;
      }
    }
    return @{
      @"ok" : @YES,
      @"text" : [lines componentsJoinedByString:@"\n"],
      @"truncated" : state.truncated ? @YES : @NO
    };
  }

  if ([name isEqualToString:@"release"]) {
    id handles = op[@"handles"];
    if ([handles isKindOfClass:[NSArray class]]) {
      for (id handle in handles) {
        if ([handle isKindOfClass:[NSNumber class]]) ReleaseHandle([handle unsignedLongLongValue]);
      }
    } else {
      ReleaseAllHandles();
    }
    return @{@"ok" : @YES};
  }

  return @{@"ok" : @NO, @"error" : [NSString stringWithFormat:@"unknown op: %@", name]};
}

static NSString *RunOperationJSON(NSString *request) {
  @autoreleasepool {
    NSDictionary *result = nil;
    @try {
      NSData *data = [request dataUsingEncoding:NSUTF8StringEncoding];
      id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
      if (![parsed isKindOfClass:[NSDictionary class]]) {
        result = @{@"ok" : @NO, @"error" : @"request must be a JSON object"};
      } else {
        result = RunOperation(parsed);
      }
    } @catch (NSException *exception) {
      result = @{@"ok" : @NO, @"error" : exception.reason ?: @"native exception"};
    }
    NSData *encoded = [NSJSONSerialization dataWithJSONObject:result options:0 error:NULL];
    if (encoded == nil) {
      return @"{\"ok\":false,\"error\":\"result was not serializable\"}";
    }
    return [[NSString alloc] initWithData:encoded encoding:NSUTF8StringEncoding];
  }
}

// ---------------------------------------------------------------------------
// N-API surface: one sync entry point, one async
// ---------------------------------------------------------------------------

static std::string StringArg(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok) return "";
  std::string result(length, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, &result[0], length + 1, &written) != napi_ok) return "";
  result.resize(written);
  return result;
}

static napi_value CallSync(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "expected a JSON request string");
    return NULL;
  }
  std::string request = StringArg(env, argv[0]);
  NSString *response = RunOperationJSON([NSString stringWithUTF8String:request.c_str()]);
  napi_value result;
  napi_create_string_utf8(env, response.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

struct AsyncCall {
  napi_async_work work;
  napi_deferred deferred;
  std::string request;
  std::string response;
};

static void ExecuteAsyncCall(napi_env env, void *data) {
  AsyncCall *call = static_cast<AsyncCall *>(data);
  NSString *response = RunOperationJSON([NSString stringWithUTF8String:call->request.c_str()]);
  call->response = response.UTF8String;
}

static void CompleteAsyncCall(napi_env env, napi_status status, void *data) {
  AsyncCall *call = static_cast<AsyncCall *>(data);
  napi_value result;
  napi_create_string_utf8(env, call->response.c_str(), NAPI_AUTO_LENGTH, &result);
  napi_resolve_deferred(env, call->deferred, result);
  napi_delete_async_work(env, call->work);
  delete call;
}

static napi_value Call(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  if (argc < 1) {
    napi_throw_type_error(env, NULL, "expected a JSON request string");
    return NULL;
  }

  AsyncCall *call = new AsyncCall();
  call->request = StringArg(env, argv[0]);

  napi_value promise;
  napi_create_promise(env, &call->deferred, &promise);

  napi_value name;
  napi_create_string_utf8(env, "clance-ax", NAPI_AUTO_LENGTH, &name);
  napi_create_async_work(env, NULL, name, ExecuteAsyncCall, CompleteAsyncCall, call, &call->work);
  napi_queue_async_work(env, call->work);
  return promise;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value call, callSync;
  napi_create_function(env, "call", NAPI_AUTO_LENGTH, Call, NULL, &call);
  napi_create_function(env, "callSync", NAPI_AUTO_LENGTH, CallSync, NULL, &callSync);
  napi_set_named_property(env, exports, "call", call);
  napi_set_named_property(env, exports, "callSync", callSync);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
