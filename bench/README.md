# RingZero × Terminal-Bench 2.0

Run RingZero against the [Terminal-Bench 2.0](https://www.tbench.ai/benchmarks/terminal-bench-2)
benchmark (89 tasks) using Harbor, the official harness.

## Prereqs
- Docker running, `uv`, Harbor installed on **Python 3.12**:
  `uv tool install harbor --python 3.12`  (0.20.0 crashes on Python 3.14)
- RingZero built: `npm run build` (adapter uploads `dist/` into each sandbox)

## Run the full benchmark (pass@1)
```powershell
$env:PYTHONPATH = "C:\Repos\ringzero\bench"
# read keys from .env without echoing
$key = (Get-Content .env | Where-Object { $_ -match '^API_KEY=' }).Split('=',2)[1].Trim()
$url = (Get-Content .env | Where-Object { $_ -match '^API_URL=' }).Split('=',2)[1].Trim()

harbor run -d terminal-bench/terminal-bench-2 `
  --agent ringzero_agent:RingZeroAgent `
  --ak "ringzero_dist=C:\Repos\ringzero\dist" `
  --ae "API_URL=$url" --ae "API_KEY=$key" --ae MODEL=deepseek-v4-flash `
  --ae MAX_STEPS=77 --ae EFFORT=medium `
  --jobs-dir jobs-tb2-full -n 4 --yes
```
- No `--include-task-name` → runs ALL tasks. `-n 4` = 4 concurrent sandboxes.
- `-k N` = N attempts/task (pass@N, ~N× cost). Omit for pass@1.
- Single task: add `--include-task-name terminal-bench/<task>`.

## Monitor
- Job dir: `jobs-tb2-full\<timestamp>\result.json` (rewritten as trials finish)
- `harbor view jobs` — summary table
- Per trial: `jobs-tb2-full\<ts>\<task>__<id>\{trial.log, exception.txt}`
- Per-trial reward: parse `result.json` → `stats.evals["ringzero__terminal-bench/terminal-bench-2"].reward_stats.reward`

## Submit to leaderboard
Per tbench.ai: open a PR to the HF repo `alexgshaw/terminal-bench-2-leaderboard`
with the job logs (needs your HF account). `harbor upload jobs-tb2-full\<ts>`
shares the results. A new submission process is also listed as "coming soon".

## Notes / gotchas
- Task sandboxes lack `curl` and often `python3` → `bench/ringzero_agent.py` node
  install falls back python3 → curl → wget → apt-get; extracts `.tar.gz`.
- Tasks with `allow_internet = false` can't reach the API → 0 (inherent for any API agent).
- RingZero fixes found here: `src/version.ts` (module-load package.json read →
  try/catch), `src/providers/openai-compat.ts` (connect timeout no longer caps the stream).
