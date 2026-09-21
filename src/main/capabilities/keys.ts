// Keystrokes, for the handful of things macOS exposes no other way.
//
// Everything Clance can do through the accessibility API it does through
// the accessibility API — it needs no focus, can't land on the wrong thing,
// and reports whether it worked. These are the exceptions: scrolling, and
// the "focus the address bar" / "open find" chords that every app answers
// but almost none publish as an action.
export type Chord = {
  key: string;
  command?: boolean;
  shift?: boolean;
  control?: boolean;
  option?: boolean;
};

export async function chord(spec: Chord): Promise<void> {
  const { keyboard, Key } = await import("@nut-tree-fork/nut-js");
  const keys: number[] = [];
  if (spec.command) keys.push(Key.LeftCmd);
  if (spec.control) keys.push(Key.LeftControl);
  if (spec.option) keys.push(Key.LeftAlt);
  if (spec.shift) keys.push(Key.LeftShift);
  const main = (Key as unknown as Record<string, number>)[spec.key];
  if (main === undefined) throw new Error(`unknown key "${spec.key}"`);
  keys.push(main);
  await keyboard.pressKey(...keys);
  await keyboard.releaseKey(...keys);
}

export async function pressEnter(): Promise<void> {
  await chord({ key: "Enter" });
}
