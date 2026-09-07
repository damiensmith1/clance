import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { readConfig, writeConfig } from "./config";

// Reuses Claude Code's own convention so skills are shared directly between
// the two ecosystems, per the compatibility goal in the requirements doc.
const SKILLS_DIR = join(homedir(), ".claude", "skills");

export type SkillInfo = {
  name: string;
  description: string;
  enabled: boolean;
};

// SKILL.md frontmatter is a small, flat "key: value" block — no need for a
// real YAML parser for the two fields Clance actually displays.
function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

export async function listSkills(): Promise<SkillInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(SKILLS_DIR);
  } catch {
    return [];
  }

  const config = readConfig();
  const enabledSkills = config.enabledSkills;

  const skills: SkillInfo[] = [];
  for (const dirName of entries) {
    const skillPath = join(SKILLS_DIR, dirName, "SKILL.md");
    let raw: string;
    try {
      raw = await readFile(skillPath, "utf8");
    } catch {
      continue;
    }

    const frontmatter = parseFrontmatter(raw);
    const name = frontmatter.name || dirName;
    skills.push({
      name,
      description: frontmatter.description || "",
      enabled: enabledSkills === "all" || enabledSkills.includes(name),
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Turning one skill off for the first time converts the "all" default into
// an explicit list, so newly-added skills stay off by default afterward —
// a later "on" only ever adds back to that explicit list, it never
// collapses back to "all" implicitly.
export async function setSkillEnabled(name: string, enabled: boolean): Promise<SkillInfo[]> {
  const current = await listSkills();
  const allNames = current.map((skill) => skill.name);

  // name/enabled cross an IPC boundary from the renderer — only ever a
  // known, currently-discovered skill name is accepted, so a compromised
  // or buggy renderer can't write arbitrary strings into config.json.
  if (typeof name !== "string" || typeof enabled !== "boolean" || !allNames.includes(name)) {
    return current;
  }

  const config = readConfig();
  const currentlyEnabled =
    config.enabledSkills === "all" ? allNames : config.enabledSkills;

  const nextEnabled = enabled
    ? Array.from(new Set([...currentlyEnabled, name]))
    : currentlyEnabled.filter((skillName) => skillName !== name);

  config.enabledSkills = nextEnabled;
  writeConfig(config);

  return listSkills();
}
