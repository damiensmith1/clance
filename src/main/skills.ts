import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// Reuses Claude Code's own convention so skills are shared directly between
// the two ecosystems, per the compatibility goal in the requirements doc.
const SKILLS_DIR = join(homedir(), ".claude", "skills");

// Read-only — there's no CLI flag to selectively enable/disable individual
// skills (only --disable-slash-commands, which is all-or-nothing), so
// there's nothing for a per-skill toggle to actually control. An earlier
// version had one anyway (`enabledSkills` in config.ts, a `setSkillEnabled`
// export here): it wrote real config that no launched session ever read —
// exactly the "toggle that looks like it works but doesn't" trust bug this
// replaced (see docs/design.md's "Extensibility").
// Skills are managed the same way a bare `claude` session manages them: add
// or remove a folder under `~/.claude/skills/`.
export type SkillInfo = {
  name: string;
  description: string;
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
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
