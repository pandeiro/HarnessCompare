# Task evals: slugify and dependency planner

The same two software tasks, the same prompt per task, and the same model were given to opencode, pi, and oh-my-pi. Each harness ran in non-interactive batch mode, one at a time, in a fresh workspace.

## At a glance

| Task | Harness | Median wall (s) | Median cost (USD) | Median total tokens | Full solves |
|---|---|---:|---:|---:|---:|
| slugify | opencode | 22.21 | 0.00337 | 69408 | 3/3 |
| slugify | pi | 41.67 | 0.004681 | 33212 | 3/3 |
| slugify | omp | 37.33 | 0.004734 | 89705 | 3/3 |
| deps | opencode | 19.42 | 0.003019 | 58983 | 3/3 |
| deps | pi | 27.24 | 0.003064 | 29200 | 3/3 |
| deps | omp | 22.62 | 0.003157 | 71619 | 3/3 |

## Method

- Model: `opencode-go/deepseek-v4.1-flash` (OpenCode Go), selected explicitly for every harness.
- Installed CLI versions: opencode 1.19.5, pi 1.5.0, omp 18.18.3.
- Three trials per harness per task, strictly serial. Each trial starts from a fresh git repository.
- The agent's diff is captured, then `SPEC.md`, `package.json`, and `test/` are restored from the fixture before scoring. A trial is a full solve only if the visible suite, the hidden suite, and the contract-file check all pass.
- Workspaces are created under the OS temp directory, outside this repository, so hidden tests are not reachable by walking up.
- Extensions, skills, project context files, prompt templates, and themes are disabled where the CLI supports it; `opencode` runs with `--pure`.
- `pi` and `omp` receive the local OpenCode Go key explicitly because their stored OpenCode Go credentials were expired; `opencode` uses its stored login.
- Every `pi` and `omp` trial reported `provider=opencode-go` and `model=deepseek-v4.1-flash`; `opencode` receives the same id through `--model`.

## Task 1: slugify fix

**Fixture:** `eval/harness-task/tasks/slugify/fixture`. A small ESM package whose `src/slug.js` violates `SPEC.md`.

The visible suite has 6 tests and 2 fail; the hidden suite has 12.

| Harness | Trial | Wall (s) | Exit | Input | Output | Reasoning | Cache read | Total | Cost (USD) | Tools | Test cmds | Visible | Hidden | Solve | Forbidden edits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| opencode | 1 | 27.45 | 0 | 11595 | 1196 | 1467 | 56064 | 70322 | 0.003505 | 8 | 1 | 6/6 | 12/12 | yes | — |
| opencode | 2 | 22.21 | 0 | 11357 | 902 | 1597 | 55552 | 69408 | 0.00337 | 7 | 1 | 6/6 | 12/12 | yes | — |
| opencode | 3 | 21.14 | 0 | 17480 | 585 | 449 | 32768 | 51282 | 0.003341 | 4 | 1 | 6/6 | 12/12 | yes | — |
| pi | 1 | 23.72 | 0 | 6457 | 3238 | 2201 | 9728 | 19423 | 0.002941 | 5 | 4 | 6/6 | 12/12 | yes | — |
| pi | 2 | 67.62 | 0 | 9228 | 7745 | 6031 | 31488 | 48461 | 0.006126 | 8 | 8 | 6/6 | 12/12 | yes | — |
| pi | 3 | 41.67 | 0 | 8747 | 5521 | 4160 | 18944 | 33212 | 0.004681 | 7 | 4 | 6/6 | 12/12 | yes | — |
| omp | 1 | 70.9 | 0 | 9844 | 5200 | 2843 | 93312 | 108356 | 0.004877 | 10 | 15 | 6/6 | 12/12 | yes | — |
| omp | 2 | 37.33 | 0 | 13651 | 4118 | 1515 | 71936 | 89705 | 0.004734 | 10 | 14 | 6/6 | 12/12 | yes | — |
| omp | 3 | 27.37 | 0 | 11576 | 2441 | 1142 | 36608 | 50625 | 0.003311 | 8 | 8 | 6/6 | 12/12 | yes | — |

| Harness | Median wall (s) | Median cost (USD) | Median total tokens | Hidden pass rate | Full solves | Avg tool calls | Avg turns |
|---|---:|---:|---:|---:|---:|---:|---:|
| opencode | 22.21 | 0.00337 | 69408 | 100% | 3/3 | 6.3 | 5.7 |
| pi | 41.67 | 0.004681 | 33212 | 100% | 3/3 | 6.7 | 6 |
| omp | 37.33 | 0.004734 | 89705 | 100% | 3/3 | 9.3 | 7.3 |

Observations:

- Fastest median wall time: **opencode** (22.21s); lowest median cost: **opencode** ($0.00337); highest median token volume: **omp** (89705 tokens).
- Full solves: opencode 3/3; pi 3/3; omp 3/3; test-suite invocations: opencode 3, pi 16, omp 37.
- Successful diffs touched one implementation file, with 27–59 insertions across trials.

Tool usage across all trials:

- **opencode**: bash × 10, read × 6, write × 3
- **pi**: bash × 16, write × 3, edit × 1
- **omp**: read × 12, bash × 9, write × 3, edit × 2, glob × 1, eval × 1

## Task 2: dependency planner

**Fixture:** `eval/harness-task/tasks/deps/fixture`. A small ESM package whose `src/plan.js` returns incomplete or unstable plans.

The visible suite has 5 tests and 4 fail; the hidden suite has 15. The planner requires topological ordering, validation, deterministic wave ordering, and cycle reporting. Successful diffs were roughly twice the size of the slugify diffs.

| Harness | Trial | Wall (s) | Exit | Input | Output | Reasoning | Cache read | Total | Cost (USD) | Tools | Test cmds | Visible | Hidden | Solve | Forbidden edits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|
| opencode | 1 | 10.37 | 0 | 9951 | 859 | 179 | 31104 | 42093 | 0.002209 | 3 | 1 | 5/5 | 15/15 | yes | — |
| opencode | 2 | 21.77 | 0 | 11493 | 1363 | 520 | 55168 | 68544 | 0.003019 | 7 | 1 | 5/5 | 15/15 | yes | — |
| opencode | 3 | 19.42 | 0 | 11703 | 1148 | 1204 | 44928 | 58983 | 0.003301 | 6 | 1 | 5/5 | 15/15 | yes | — |
| pi | 1 | 28.36 | 0 | 7162 | 3222 | 1911 | 18816 | 29200 | 0.003064 | 5 | 4 | 5/5 | 15/15 | yes | — |
| pi | 2 | 27.24 | 0 | 4485 | 3986 | 2202 | 30208 | 38679 | 0.003155 | 6 | 9 | 5/5 | 15/15 | yes | — |
| pi | 3 | 21.11 | 0 | 6115 | 2677 | 1251 | 13056 | 21848 | 0.002563 | 6 | 4 | 5/5 | 15/15 | yes | — |
| omp | 1 | 22.62 | 0 | 6425 | 2683 | 988 | 55552 | 64660 | 0.00274 | 5 | 5 | 5/5 | 15/15 | yes | — |
| omp | 2 | 38.12 | 0 | 14271 | 2810 | 983 | 57216 | 74297 | 0.003998 | 8 | 8 | 5/5 | 15/15 | yes | — |
| omp | 3 | 21.71 | 0 | 12061 | 1958 | 284 | 57600 | 71619 | 0.003157 | 9 | 8 | 5/5 | 15/15 | yes | — |

| Harness | Median wall (s) | Median cost (USD) | Median total tokens | Hidden pass rate | Full solves | Avg tool calls | Avg turns |
|---|---:|---:|---:|---:|---:|---:|---:|
| opencode | 19.42 | 0.003019 | 58983 | 100% | 3/3 | 5.3 | 5 |
| pi | 27.24 | 0.003064 | 29200 | 100% | 3/3 | 5.7 | 6 |
| omp | 22.62 | 0.003157 | 71619 | 100% | 3/3 | 7.3 | 6.7 |

Observations:

- Fastest median wall time: **opencode** (19.42s); lowest median cost: **opencode** ($0.003019); highest median token volume: **omp** (71619 tokens).
- Full solves: opencode 3/3; pi 3/3; omp 3/3; test-suite invocations: opencode 3, pi 17, omp 21.
- Successful diffs touched one implementation file, with 70–104 insertions across trials.

Tool usage across all trials:

- **opencode**: bash × 8, read × 6, write × 2
- **pi**: bash × 13, write × 2, edit × 1, read × 1
- **omp**: bash × 9, read × 9, write × 3, glob × 1

## Cross-task observations

- `opencode` had the lowest median wall time and reported cost on both tasks.
- `pi` used the fewest total tokens on both tasks, but had the highest median wall time on both.
- `omp` used the most tools and tokens on both tasks, consistent with its larger built-in surface.
- Every one of the 18 trials solved its task. Both tasks are therefore ceiling tests for correctness; the differences are overhead and working style.
- The dependency planner produced roughly twice the diff size of the slugify task, with 70–104 insertions versus 27–59, while tool counts stayed in a similar range. The harder task changed what the models had to write, not how many tools they reached for.
- Test-suite invocation counts varied widely (opencode 1 per trial; pi 4–9; omp 5–15), so the harnesses differ more in verification behavior than in final correctness here.

## Caveats

- Two small tasks and one model. The results do not generalize to large repositories or other models.
- The installed `opencode` CLI is 1.19.5, while `docs/compare/code.md` describes the cloned 2.2.5 tree. These evals measure the installed build; the installed `pi` and `omp` versions match their cloned trees.
- Token totals include each harness's system prompt, tool schemas, cache reads, and the conversation. Cache accounting differs between harnesses, so compare totals within a column with caution.
- Wall time includes process startup, server startup (`opencode`), provider latency, and test execution; provider load varies.
- Three trials per harness per task is enough to expose gross failures, not to estimate a stable pass rate.
- Global user settings remain active where a CLI has no switch to disable them. Project instructions are absent.

## Reproduce

```sh
node eval/harness-task/runner.mjs --task slugify --trials 3 --timeout 600 --tag run1
node eval/harness-task/runner.mjs --task deps --trials 3 --timeout 600 --tag run1
node eval/harness-task/combine.mjs --tag run1
```

## Raw artifacts

Each trial is under `eval/harness-task/runs/<task>/run1/<harness>-t<n>/`: `events.jsonl`, `stderr.log`, `final.txt`, `diff.patch`, `visible.tap`, `hidden.tap`, and `metrics.json`. Per-task aggregates are `eval/harness-task/runs/<task>/run1/index.json`.
