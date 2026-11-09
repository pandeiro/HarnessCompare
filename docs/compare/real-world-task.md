# Real-world task: install and exercise OnlyCLI in a sandbox

A messy, capability-oriented eval rather than a deterministic unit-test task. Each harness had to find a recent CLI release, install it inside Docker, generate and build a tool, run a local service, and prove the result. The point is to observe knowledge horizon, tool choice, installation friction, failure recovery, and final quality together.

## Target pin

**OnlyCLI v0.2.0**, released 2026-03-27. It turns an OpenAPI spec into a native Go CLI.

- Repository: https://github.com/onlycli/onlycli
- Release: https://github.com/onlycli/onlycli/releases/tag/v0.2.0
- Asset: `onlycli_0.2.0_linux_arm64.tar.gz`
- SHA-256: `926cb2293b3d7a7388031f4d13a6a0c1c1a853851004945f0512950e0575b130`
- Smoke expectation: generate a CLI from `openapi.yaml`, build it, serve `server.go` on `127.0.0.1:18080`, and run the generated operation for id `42`; expected `{"id":"42","message":"ok"}`.

The target was pinned before any harness ran. It is recent, has a small public footprint, and is not a tool the harnesses could install from confident prior knowledge alone: the release asset, generated command path, and Go toolchain friction all had to be discovered.

## Method

- Model: `opencode-go/deepseek-v4.1-flash`, selected explicitly for all three.
- Installed CLI versions: opencode 1.19.5, pi 1.5.0, omp 18.18.3.
- One fresh workspace and one ephemeral Docker container per harness, run serially.
- Non-interactive batch mode, 900-second cap per harness.
- Agents had to keep installs and execution inside the container, copy artifacts into `out/`, write `out/result.json`, and remove the container.
- `openapi.yaml` and `server.go` were read-only.
- Host state was snapshotted before and after each run: Docker containers, `command -v onlycli`, and `~/go/bin`.
- Correctness is not a hidden test suite. It is the presence and validity of the generated project, built binary, `result.json`, and the exact smoke output, plus host/sandbox hygiene. The six-dimension rubric is a qualitative pass over that evidence.

## Results

| Harness | Wall (s) | Input | Output | Reasoning | Cache read | Total tokens | Cost (USD) | Turns | Tool calls | Sandbox cmds | Web cmds | Rubric |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| opencode | 98.0 | 42,660 | 4,569 | 3,897 | 617,984 | 669,110 | 0.013333 | 26 | 35 | 24 | 16 | 12/12 |
| pi | 77.2 | 25,317 | 5,326 | 1,930 | 240,000 | 270,643 | 0.007713 | 20 | 19 | 88 | 68 | 12/12 |
| omp | 63.3 | 19,183 | 5,162 | 0 | 188,416 | 212,761 | 0.006540 | 15 | 17 | 115 | 40 | 12/12 |

All three runs exited 0. All produced a valid `out/result.json`, all copied the generated project and binary into `out/`, all matched the expected smoke output, and all left no containers, no host `onlycli`, and no new `~/go/bin` entries. No harness modified `openapi.yaml` or `server.go`; all used Docker without `--privileged` or host networking.

The “sandbox cmds” and “web cmds” columns count commands found inside tool inputs, not discrete model actions. pi and omp used many short `docker exec` invocations; opencode tended to combine more work into fewer shell calls. They are evidence of working style, not a normalized efficiency metric.

## Rubric

Scores are 0–2 per dimension, judged from captured artifacts rather than final answers alone.

| Dimension | opencode | pi | omp | Evidence |
|---|---:|---:|---:|---|
| Discovery/source accuracy | 2 | 2 | 2 | All found the v0.2.0 release, linux/arm64 asset, and upstream checksums |
| Install correctness | 2 | 2 | 2 | All installed to `/usr/local/bin/onlycli` inside the container; all confirmed `0.2.0` |
| Execution parameters | 2 | 2 | 2 | All generated from the supplied spec, built the generated CLI, started port 18080, and invoked `api get-echo --id 42 --format json` |
| Output analysis | 2 | 2 | 2 | All captured the exact JSON and explained the command group/auth/PATH issues |
| Recovery/adaptation | 2 | 2 | 2 | All diagnosed and recovered from real friction without help |
| Safety/isolation | 2 | 2 | 2 | All used Docker, cleaned up, and left the host unchanged |

The rubric saturated: this task did not separate the harnesses on correctness. That is itself the main finding. The differentiation is in cost, time, investigation style, and how much shell composition each harness used.

## Per-harness assessment

### opencode

**Result:** complete and well evidenced. It used the GitHub API and raw README, verified the checksum, generated and built the CLI, started the server, and copied the artifacts. It explicitly recovered from `bash -lc` resetting the Go PATH. Its final report names the generated command path and the unexpected bearer-auth default.

**Tradeoffs:** highest wall time, token volume, and cost of the three. It used todo tracking and the most assistant turns, and its cache-read volume dominates the token total. The work was thorough but comparatively expensive for a task this size.

Evidence: `eval/real-world-task/runs/run1/opencode/` (`events.jsonl`, `final.txt`, `out/result.json`, `metrics.json`).

### pi

**Result:** complete. With no built-in web/fetch tool, it used `curl` and shell composition to find and install the release, then drove Docker through many small `docker exec` calls. It verified the checksum, generated and built the project, started the server, and copied artifacts.

**Tradeoffs:** roughly half opencode's tokens and two-thirds its cost, but more command churn than opencode. The final report is technically strong and calls out the `go install @latest` pinning problem, the generic `api` group, and the generated module path oddity. Most of its work is hidden inside a small number of broad `bash` tool calls.

Evidence: `eval/real-world-task/runs/run1/pi/`.

### oh-my-pi

**Result:** complete and the most efficient run: fastest wall time, lowest token count, lowest cost, fewest turns, and fewest tool calls. It still used the most Docker commands because it split setup into granular `exec` steps. It caught a real checksum filename mismatch, mapped the canonical asset name, and reported it clearly.

**Tradeoffs:** the leanest process. It spent less time on exploratory reads than opencode, going directly to the releases API and then the pin, and concentrated on execution. Its final answer is concise and includes the state-changing details (binary size, auth env, PATH issue). The high sandbox-command count is an artifact of granular execution, not inefficiency in model turns.

Evidence: `eval/real-world-task/runs/run1/omp/`.

## Cross-harness interpretation

- **Knowledge horizon:** all three found the correct release and asset. The prompt supplied the repository and version, so this tests release/asset discovery and execution knowledge, not open-ended “find a new tool” research.
- **Tool orchestration:** pi had the fewest tool types and leaned hardest on shell composition; omp used read plus bash; opencode used the broadest surface, including todo, write, edit, and web access. All paths reached the same result.
- **Sandbox safety:** every harness used a container, avoided privileged/host networking, removed it, and left the host clean. This is a strong common baseline.
- **Cost/latency:** omp < pi < opencode in both time and reported cost. opencode's much larger cache-read total suggests heavier context churn rather than more useful work.
- **Evidence quality:** all three produced artifacts that can be checked independently. None relied on a final-answer claim alone.

## Caveats

- One run per harness, one model, one target. This is a pragmatic probe, not a statistically stable ranking.
- The target release is pinned in the prompt. A fully open-ended “find a modern tool” task would add discovery variance but would make cross-harness comparison harder.
- The Docker base image (`golang:1.24-bookworm`) was already cached on the host for the probe, but each harness still had to pull or reuse it inside its run. Network latency and registry state affect wall time.
- The rubric is a qualitative judgment supported by artifacts. Scores are intentionally coarse; process metrics are the more discriminating evidence here.
- Sandbox command counts are not normalized across harnesses: one broad bash call can contain many commands, while another harness may issue each command as a separate tool call.

## Reproduce

```sh
docker info
node eval/real-world-task/runner.mjs --tag run1 --timeout 900
```

Artifacts are under `eval/real-world-task/runs/run1/<harness>/`: raw events, stderr, final answer, diff, host snapshots, `metrics.json`, and `out/` with `result.json`, the generated project, and the built binary. Built binaries are kept locally but ignored by git; rerun the task to regenerate them.
