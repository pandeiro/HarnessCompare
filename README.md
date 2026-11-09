# HarnessCompare

A side-by-side study of three agentic coding harnesses: **opencode**, **pi**, and **oh-my-pi** (`omp`).

The goal is to separate two questions that are easy to blur together:

1. **What is each harness, structurally?** Process model, session state, tool pipeline, permissions, prompt architecture, context management, and extensibility. This is the static comparison in [`docs/compare/code.md`](docs/compare/code.md), based on the cloned source trees.
2. **How does each behave on the same work?** Two small software tasks plus one real-world sandbox task, the same prompt per task, the same model (`opencode-go/deepseek-v4.1-flash`), serial non-interactive batch runs, isolated workspaces, hidden tests or artifact checks, and recorded time/cost/token/tool metrics. The deterministic tasks are in [`docs/compare/tasks.md`](docs/compare/tasks.md); the real-world probe is in [`docs/compare/real-world-task.md`](docs/compare/real-world-task.md).

The point is not to crown a winner from a handful of small tasks. It is to make the architectural differences concrete and to show how they surface in wall time, token overhead, tool choice, and verification behavior.

## Headline results

All deterministic trials and all three sandbox runs succeeded, so correctness did not separate the harnesses. The differences are overhead and working style.

| Task | Fastest median wall | Lowest median cost | Fewest median tokens | Full solves |
|---|---|---|---|---|
| Slugify fix | opencode, 22.21s | opencode, $0.00337 | pi, 33.2k | 9/9 |
| Dependency planner | opencode, 19.42s | opencode, $0.00302 | pi, 29.2k | 9/9 |
| OnlyCLI sandbox probe | omp, 63.3s | omp, $0.00654 | omp, 212.8k | 3/3 |

The deterministic rows are medians of three trials; the OnlyCLI row is one run per harness.

Across the deterministic tasks:

- **opencode** was fastest and cheapest at the median, helped by aggressive prompt-cache reads.
- **pi** used the fewest tokens but had the highest median wall time.
- **omp** used the most tools and tokens, consistent with its larger built-in surface.
- Verification behavior differed more than final correctness: opencode ran the test suite once per trial; pi ran it 4–9 times; omp 5–15 times.

The dependency planner produced roughly twice the diff size of the slugify task (70–104 insertions versus 27–59), with similar tool counts.

In the real-world sandbox probe:

- **omp** was fastest and cheapest, **pi** was in the middle, and **opencode** was slowest and most expensive.
- All three found the pinned release, installed it inside Docker, generated and built the CLI, ran the local service, and captured the exact smoke output.
- pi had no built-in web tool and worked through `curl` plus shell composition; opencode used the broadest tool surface; omp used the fewest turns and tool calls.

## Layout

```
code/opencode/            git submodule: anomalyco/opencode
code/pi/                  git submodule: earendil-works/pi
code/oh-my-pi/            git submodule: can1357/oh-my-pi
docs/compare/code.md      architecture, stack, features, prompt glossaries
docs/compare/tasks.md     combined two-task eval report
docs/compare/real-world-task.md  sandboxed OnlyCLI install/run probe
eval/harness-task/        deterministic fixtures, hidden tests, runner, combined reporter
eval/real-world-task/     OnlyCLI sandbox probe: fixture, prompt, runner
eval/harness-task/runs/   per-trial events, diffs, TAP output, metrics
```

The harness repositories are submodules rather than copies so this repository stays small and the inspected commits stay reproducible.

## Reproduce

The evals require the three CLIs on `PATH` and an authenticated OpenCode Go account.

```sh
# From a clone of this repository, with submodules initialized:
git submodule update --init --recursive

node eval/harness-task/runner.mjs --task slugify --trials 3 --timeout 600 --tag run1
node eval/harness-task/runner.mjs --task deps --trials 3 --timeout 600 --tag run1
node eval/harness-task/combine.mjs --tag run1

# Real-world probe (requires Docker)
node eval/real-world-task/runner.mjs --tag run1 --timeout 900
```

The runner reads the OpenCode Go key from `~/.local/share/opencode/auth.json`. It passes that key explicitly to `pi` and `omp` because their own stored OpenCode Go credentials were expired. The key is never written to run artifacts or reports.

See [`eval/harness-task/README.md`](eval/harness-task/README.md) for the task format, scoring rules, and CLI options.

## Notes and caveats

- The installed `opencode` CLI is 1.19.5; `docs/compare/code.md` describes the cloned 2.2.5 tree. The evals measure the installed build. Installed `pi` (1.5.0) and `omp` (18.18.3) match their cloned trees.
- Two small tasks and one real-world probe with one model do not generalize to large repositories or other models. All deterministic trials and all three sandbox runs succeeded, so the studies expose overhead and working style more than correctness gaps.
- Token totals include system prompts, tool schemas, cache reads, and the conversation. Harnesses account for cache tokens differently, so compare totals carefully.
- Wall time includes process startup, server startup (`opencode`), provider latency, and test execution; provider load varies.
- The task fixtures and hidden suites are intentionally narrow. A solve means the assertions pass without editing the contract files; it is not a code-review judgment.
