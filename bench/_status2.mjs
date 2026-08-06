import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// newest first
const jobs = [
  ['requiretool', 'jobs-tb2-requiretool/2026-08-06__04-07-25'],
  ['promptfix2', 'jobs-tb2-promptfix2/2026-08-06__03-50-16'],
  ['promptfix', 'jobs-tb2-promptfix/2026-08-06__03-19-01'],
  ['crashfix2', 'jobs-tb2-crashfix2/2026-08-06__02-59-58'],
  ['crashfix', 'jobs-tb2-crashfix/2026-08-06__02-57-16'],
  ['steps300b', 'jobs-tb2-steps300b/2026-08-06__01-56-07'],
  ['steps300', 'jobs-tb2-steps300/2026-08-06__01-23-08'],
  ['rerun2-fix', 'jobs-tb2-rerun2-fix/2026-08-06__00-24-57'],
  ['rerun2', 'jobs-tb2-rerun2/2026-08-05__07-43-57'],
  ['rerun1', 'jobs-tb2-rerun/2026-08-05__05-56-37'],
  ['usage', 'jobs-tb2-usage/2026-08-06__00-51-55'],
  ['full', 'jobs-tb2-full/2026-08-05__02-22-30'],
];

const best = new Map(); // task -> best reward
for (const [, j] of jobs) {
  if (!existsSync(join(j, 'result.json'))) continue;
  const rj = JSON.parse(readFileSync(join(j, 'result.json'), 'utf8'));
  for (const ev of Object.values(rj.stats?.evals ?? {})) {
    for (const [rw, trials] of Object.entries(ev.reward_stats?.reward ?? {})) {
      const val = parseFloat(rw);
      for (const t of trials) {
        const task = t.split('__')[0];
        best.set(task, Math.max(best.get(task) ?? -1, val));
      }
    }
  }
}

// newest state per failing task
const state = new Map();
for (const [jname, j] of jobs) {
  if (!existsSync(j)) continue;
  for (const d of readdirSync(j)) {
    if (!d.includes('__')) continue;
    const task = d.split('__')[0];
    if ((best.get(task) ?? -1) >= 1 || state.has(task)) continue;
    const p = join(j, d, 'result.json');
    if (!existsSync(p)) continue;
    const tr = JSON.parse(readFileSync(p, 'utf8'));
    const s = Date.parse(tr.started_at ?? '');
    const f = Date.parse(tr.finished_at ?? '');
    const mins = isNaN(s) || isNaN(f) ? -1 : Math.round((f - s) / 60000);
    const exc = tr.exception_info ? tr.exception_info.exception_type : '(completed)';
    const steps = tr.agent_result?.metadata?.steps;
    state.set(task, `${jname} dur=${mins}m steps=${steps} ${exc}`);
  }
}

const fails = [...best.entries()].filter(([, v]) => v < 1).sort((a, b) => a[0].localeCompare(b[0]));
console.log(`FAILING: ${fails.length}`);
for (const [task] of fails) console.log(`  ${task.padEnd(30)} ${state.get(task)}`);
