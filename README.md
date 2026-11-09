# HarnessCompare

A side-by-side study of three agentic coding harnesses: **opencode**, **pi**, and **oh-my-pi** (`omp`).

The goal is to separate two questions that are easy to blur together:

1. **What is each harness, structurally?** Process model, session state, tool pipeline, permissions, prompt architecture, context management, and extensibility. This is the static comparison in [`docs/compare/code.md`](docs/compare/code.md), based on the cloned source trees.
2. **How does each behave on the same work?** Two small software tasks, the same prompt per task, the same model (`opencode-go/deepseek-v4.1-flash`), serial non-interactive batch runs, isolated workspaces, hidden tests, and recorded time/cost/token/tool metrics. This is [`docs/compare/tasks.md`](docs/compare/tasks.md).

The point is not to crown a winner from two toy tasks. It is to make the architectural differences concrete and to show how they surface in wall time, token overhead, tool choice, and verification behavior.

## Headline results

Both tasks were solved by all 9 trials, so correctness did not separate the harnesses. The differences are overhead and working style.

| Task | Fastest median wall | Lowest median cost | Fewest median tokens | Full solves |
|---|---|---|---|---|
| Slugify fix | opencode, 22.21s | opencode, $0.00337 | pi, 33.2k | 9/9 |
| Dependency planner | opencode, 19.42s | opencode, $0.00302 | pi, 29.2k | 9/9 |

Across both tasks:

- **opencode** was fastest and cheapest at the median, helped by aggressive prompt-cache reads.
- **pi** used the fewest tokens but had the highest median wall time.
- **omp** used the most tools and tokens, consistent with its larger built-in surface.
- Verification behavior differed more than final correctness: opencode ran the test suite once per trial; pi ran it 4–9 times; omp 5–15 times.

The dependency planner produced roughly twice the diff size of the slugify task (70–104 insertions versus 27–59), with similar tool counts.

## Layout

```
code/opencode/            git submodule: anomalyco/opencode
code/pi/                  git submodule: earendil-works/pi
code/oh-my-pi/            git submodule: can1357/oh-my-pi
docs/compare/code.md      architecture, stack, features, prompt glossaries
docs/compare/tasks.md     combined two-task eval report
eval/harness-task/        fixtures, hidden tests, serial runner, combined reporter
eval/harness-task/runs/   per-trial events, diffs, TAP output, metrics
```

The harness repositories are submodules rather than copies so this repository stays small and the inspected commits stay reproducible.

## Reproduce

The evals require the three CLIs on `PATH` and an authenticated OpenCode Go account.

```sh
git clone --recurse-submodules <this-repo-url>
cd HarnessCompare

# Optional: fetch the exact commits recorded in the submodule gitlinks
git submodule update --init --recursive

node eval/harness-task/runner.mjs --task slugify --trials 3 --timeout 600 --tag run1
node eval/harness-task/runner.mjs --task deps --trials 3 --timeout 600 --tag run1
node eval/harness-task/combine.mjs --tag run1
```

The runner reads the OpenCode Go key from `~/.local/share/opencode/auth.json`. It passes that key explicitly to `pi` and `omp` because their own stored OpenCode Go credentials were expired. The key is never written to run artifacts or reports.

See [`eval/harness-task/README.md`](eval/harness-task/README.md) for the task format, scoring rules, and CLI options.

## Notes and caveats

- The installed `opencode` CLI is 1.19.5; `docs/compare/code.md` describes the cloned 2.2.5 tree. The evals measure the installed build. Installed `pi` (1.5.0) and `omp` (18.18.3) match their cloned trees.
- Two small tasks and one model do not generalize to large repositories or other models. Both tasks hit a correctness ceiling: every trial solved them.
- Token totals include system prompts, tool schemas, cache reads, and the conversation. Harnesses account for cache tokens differently, so compare totals carefully.
- Wall time includes process startup, server startup (`opencode`), provider latency, and test execution; provider load varies.
- The task fixtures and hidden suites are intentionally narrow. A solve means the assertions pass without editing the contract files; it is not a code-review judgment.
