# Harness task eval

Small, reproducible software-development evals for the three cloned coding
harnesses. Each task runs the same fixture and prompt against opencode, pi, and
omp in non-interactive batch mode with the same OpenCode Go model, one harness
at a time, and records:

- wall time, exit status, timeout/signal
- harness-reported input/output/reasoning/cache tokens and cost
- tool calls by name, turns/steps, and test-suite invocations
- the git diff of the workspace
- visible test results and a hidden test suite
- the final assistant text and raw event stream

## Tasks

| Task | Fixture | Difficulty | Report |
| --- | --- | --- | --- |
| `slugify` | Unicode slug function with max-length and validation rules | Small | combined in `docs/compare/tasks.md` |
| `deps` | Dependency planner with validation, deterministic waves, and cycle reporting | Medium | combined in `docs/compare/tasks.md` |

## Layout

```
tasks/<task>/
  task.json              title, test filenames, test counts, design note
  fixture/               starting workspace
  hidden/                hidden test file
  prompt.txt             identical prompt for all harnesses
runs/<task>/<tag>/       recorded artifacts for each trial
runner.mjs               serial runner and scorer
combine.mjs              combined report generator
```

## Run

```sh
node eval/harness-task/runner.mjs --task slugify --trials 3 --timeout 600
node eval/harness-task/runner.mjs --task deps --trials 3 --timeout 600
node eval/harness-task/combine.mjs --tag <tag>
```

Options:

- `--task NAME` — task directory under `tasks/` (default `slugify`)
- `--trials N` — repetitions per harness (default 1)
- `--timeout SEC` — per agent run (default 600)
- `--only opencode,pi,omp` — subset
- `--tag NAME` — artifact directory name (default: timestamp)
- `--report-path FILE` — write a per-task report (the canonical report is produced by `combine.mjs`)
- `--no-report` — skip per-task report generation
- `--report-only` — regenerate a per-task report; requires `--report-path` and an existing `--tag`

## Scoring

After the agent exits, the runner restores `SPEC.md`, `package.json`, and
`test/` from the fixture, then runs the visible suite and the hidden suite. A
trial counts as a full solve only when:

1. the agent exits cleanly,
2. all visible tests pass,
3. all hidden tests pass, and
4. the agent did not change the contract files (`SPEC.md`, `package.json`,
   `test/`).

Scoring happens in the same workspace but after the diff is captured, so
forbidden edits are recorded without being able to affect the score.

Workspaces are created under the OS temp directory, not inside this repository,
so the agent cannot walk up into `hidden/` or other trials.

## Credential

The runner reuses the local OpenCode Go login from
`~/.local/share/opencode/auth.json`. `opencode` uses its stored login; `pi` and
`omp` receive the key explicitly because their stored OpenCode Go credentials
were expired at the time of the run. The key is never written to run artifacts
or the report.
