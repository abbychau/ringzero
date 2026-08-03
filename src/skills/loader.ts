import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

/** List skills across dirs: each skill is a folder containing SKILL.md. */
export function listSkills(...dirs: string[]): SkillInfo[] {
  const out: SkillInfo[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      const md = join(p, 'SKILL.md');
      if (!existsSync(md)) continue;
      const text = readFileSync(md, 'utf8');
      const desc = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? 'no description';
      out.push({ name, description: desc, path: p });
    }
  }
  return out;
}

export function loadSkill(skillPath: string): string {
  return readFileSync(join(skillPath, 'SKILL.md'), 'utf8');
}
