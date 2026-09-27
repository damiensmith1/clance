import { spawn, type ChildProcess } from "child_process";
import { dirname, join } from "path";
import type { WebContents } from "electron";
import { isDirectory } from "./git";

// Find in Files (⇧⌘F): ripgrep over the Files folder, streamed to the window
// as it finds things. ripgrep rather than `git grep` because Files browses
// folders that aren't repositories, and ripgrep reads .gitignore itself. It
// ships inside the app (@vscode/ripgrep-darwin-arm64) — a Mac doesn't have it.
//
// Arguments are an array and the query follows `-e`, so nothing typed into
// the search box can become an option or reach a shell.

const MAX_MATCHES = 5000;
const FLUSH_MS = 60;

export type SearchOptions = {
  query: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  /** Comma-separated globs. */
  include?: string;
  exclude?: string;
  /** Search what git ignores too. */
  includeIgnored?: boolean;
};

export type SearchMatch = {
  path: string;
  line: number;
  text: string;
  /** Character ranges of the match within `text`. */
  ranges: [number, number][];
};

function rgPath(): string {
  // Resolved from this package's own directory, which works both in a dev
  // checkout and inside the packaged app (asar is off; see package.json).
  return join(dirname(require.resolve("@vscode/ripgrep-darwin-arm64/package.json")), "bin", "rg");
}

function globs(list: string | undefined, negate: boolean): string[] {
  return (list ?? "")
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean)
    .flatMap((glob) => ["-g", negate ? `!${glob}` : glob]);
}

/** ripgrep reports byte offsets; the renderer needs character offsets. */
function charRange(text: string, start: number, end: number): [number, number] {
  const bytes = Buffer.from(text, "utf8");
  return [bytes.subarray(0, start).toString("utf8").length, bytes.subarray(0, end).toString("utf8").length];
}

const running = new Map<number, ChildProcess>();

export function cancelSearch(sender: WebContents): void {
  running.get(sender.id)?.kill();
  running.delete(sender.id);
}

/**
 * Starts a search for `sender`, replacing any it had running. Matches arrive
 * as `search:results` { id, matches }, then one `search:done`
 * { id, count, capped, error }.
 */
export function startSearch(sender: WebContents, id: unknown, root: unknown, options: unknown): void {
  cancelSearch(sender);
  const opts = (options ?? {}) as SearchOptions;
  const send = (channel: string, payload: unknown) => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };
  if (typeof id !== "number") return;
  if (!isDirectory(root) || typeof opts.query !== "string" || opts.query.length === 0) {
    send("search:done", { id, count: 0, capped: false, error: null });
    return;
  }

  const args = [
    "--json",
    "--hidden",
    "-g",
    "!.git",
    "--max-columns",
    "400",
    "--max-columns-preview",
    "--max-filesize",
    "4M",
    opts.caseSensitive ? "--case-sensitive" : "--ignore-case",
    ...(opts.wholeWord ? ["--word-regexp"] : []),
    ...(opts.regex ? [] : ["--fixed-strings"]),
    ...(opts.includeIgnored ? ["--no-ignore"] : []),
    ...globs(opts.include, false),
    ...globs(opts.exclude, true),
    "-e",
    opts.query,
    "--",
    ".",
  ];

  let child: ChildProcess;
  try {
    child = spawn(rgPath(), args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    send("search:done", { id, count: 0, capped: false, error: error instanceof Error ? error.message : "Search couldn't start" });
    return;
  }
  running.set(sender.id, child);

  let buffered = "";
  let batch: SearchMatch[] = [];
  let count = 0;
  let capped = false;
  let stderr = "";
  let timer: NodeJS.Timeout | null = null;

  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (batch.length === 0) return;
    send("search:results", { id, matches: batch });
    batch = [];
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (capped) return;
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      let event: { type: string; data: Record<string, any> };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "match") continue;
      const data = event.data;
      const path = (data.path?.text ?? "").replace(/^\.\//, "");
      const raw: string = data.lines?.text ?? "";
      const text = raw.replace(/\r?\n$/, "");
      const ranges = (data.submatches ?? []).map((s: { start: number; end: number }) => charRange(raw, s.start, s.end));
      batch.push({ path, line: data.line_number, text, ranges });
      count += 1;
      if (count >= MAX_MATCHES) {
        capped = true;
        child.kill();
        break;
      }
    }
    if (!timer) timer = setTimeout(flush, FLUSH_MS);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.on("close", (code) => {
    if (running.get(sender.id) === child) running.delete(sender.id);
    flush();
    // 0: matches, 1: none, 2: an error — but also 2 when some files couldn't
    // be read while others matched, so a bad regex is the only error shown.
    const error = code === 2 && count === 0 && /regex|parse/i.test(stderr) ? stderr.trim().split("\n").pop() ?? null : null;
    send("search:done", { id, count, capped, error });
  });
  child.on("error", (error) => {
    send("search:done", { id, count, capped, error: error.message });
  });
}
