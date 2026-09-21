import { checkPermissions } from "../permissions";
import { captureActiveDisplay } from "../screenCapture";
import { clickAtNormalized, screenPointForNormalized } from "../frontApp";
import * as ax from "../ax";
import { type Outcome, ok, fail, image } from "./types";

export async function lookAtScreen(): Promise<Outcome> {
  // Screen Recording is optional, so a user declining it is a supported
  // state rather than a misconfiguration — say so plainly, in words the
  // model can pass on, instead of a guess.
  if (!checkPermissions().screenRecording) {
    return fail(
      "Screen Recording isn't enabled for Clance, so the screen can't be read. " +
        "The user can turn it on in System Settings → Privacy & Security → Screen Recording " +
        "(Clance needs a restart after enabling it)."
    );
  }
  const base64 = await captureActiveDisplay();
  if (!base64) return fail("Couldn't capture the screen.");
  return image(base64, "image/png");
}

// `x` and `y` are fractions of the cursor's display, not pixels.
export async function clickAt(x: number, y: number): Promise<Outcome> {
  try {
    // What's actually there, read before the click lands: a coordinate
    // guessed off a screenshot is the one action here with no way to
    // tell afterwards whether it hit what was intended.
    const point = await screenPointForNormalized(x, y);
    const under = point ? await ax.elementAt(point.x, point.y) : null;
    await clickAtNormalized(x, y);
    const what = under
      ? `${under.role ?? "element"}${under.title ? ` "${under.title}"` : ""}` +
        `${under.app?.name ? ` in ${under.app.name}` : ""}`
      : null;
    return ok(
      what
        ? `Clicked at (${x}, ${y}) — on ${what}. click_element is surer when the target has a name.`
        : `Clicked at (${x}, ${y}).`
    );
  } catch (error) {
    return fail(`Failed to click: ${(error as Error).message}`);
  }
}
