#!/usr/bin/env node
/**
 * Combine the per-task eval indexes into one report.
 *
 * The detailed per-task generator lives in runner.mjs; this script produces
 * the canonical cross-task document under docs/compare/tasks.md.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const HARNESSES = ["opencode", "pi", "omp"];
const TASKS = [
  { name: "slugify", label: "Task 1: slugify fix" },
  { name: "deps", label: "Task 2: dependency planner" },
];

function parseArgs(argv) {
  const out = { tag: "run1", out: "docs/compare/tasks.md" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tag") out.tag = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node combine.mjs [--tag run1] [--out docs/compare/tasks.md]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n, d) {
  if (!d) return "—";
  return `${round((n / d) * 100, 1)}%`;
}

function aggregate(rows) {
  const hiddenPassed = rows.reduce((n, m) => n + m.hidden.passed, 0);
  const hiddenTotal = rows.reduce((n, m) => n + m.hidden.passed + m.hidden.failed, 0);
  return {
    wall: median(rows.map((m) => m.durationMs)) / 1000,
    cost: median(rows.map((m) => m.costUsd)),
    tokens: median(rows.map((m) => m.usage.total)),
    hiddenPassRate: pct(hiddenPassed, hiddenTotal),
    solves: rows.filter((m) => m.fullSolve).length,
    toolCalls: rows.reduce((n, m) => n + m.toolCallCount, 0) / rows.length,
    turns: rows.reduce((n, m) => n + m.turns, 0) / rows.length,
    tests: rows.reduce((n, m) => n + m.testInvocations, 0),
  };
}

function trialTable(rows) {
  const lines = [
    "| Harness | Trial | Wall (s) | Exit | Input | Output | Reasoning | Cache read | Total | Cost (USD) | Tools | Test cmds | Visible | Hidden | Solve | Forbidden edits |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ];
  for (const harness of HARNESSES) {
    for (const m of rows.filter((row) => row.harness === harness)) {
      lines.push(
        `| ${harness} | ${m.trial} | ${round(m.durationMs / 1000, 2)} | ${m.exitCode ?? "—"}${m.timedOut ? " (timeout)" : ""} | ${m.usage.input} | ${m.usage.output} | ${m.usage.reasoning} | ${m.usage.cacheRead} | ${m.usage.total} | ${m.costUsd} | ${m.toolCallCount} | ${m.testInvocations} | ${m.visible.passed}/${m.visible.passed + m.visible.failed} | ${m.hidden.passed}/${m.hidden.passed + m.hidden.failed} | ${m.fullSolve ? "yes" : "no"} | ${m.diff.forbidden.length ? m.diff.forbidden.join(", ") : "—"} |`,
      );
    }
  }
  return lines;
}

function aggregateTable(rows) {
  const lines = [
    "| Harness | Median wall (s) | Median cost (USD) | Median total tokens | Hidden pass rate | Full solves | Avg tool calls | Avg turns |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const harness of HARNESSES) {
    const stats = aggregate(rows.filter((row) => row.harness === harness));
    lines.push(
      `| ${harness} | ${round(stats.wall, 2)} | ${round(stats.cost, 6)} | ${Math.round(stats.tokens)} | ${stats.hiddenPassRate} | ${stats.solves}/3 | ${round(stats.toolCalls, 1)} | ${round(stats.turns, 1)} |`,
    );
  }
  return lines;
}

function toolMix(rows) {
  return HARNESSES.map((harness) => {
    const totals = {};
    for (const m of rows.filter((row) => row.harness === harness)) {
      for (const [name, count] of Object.entries(m.toolCalls)) totals[name] = (totals[name] ?? 0) + count;
    }
    const text =
      Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} × ${count}`)
        .join(", ") || "—";
    return `- **${harness}**: ${text}`;
  });
}

function taskSection(task, meta, rows) {
  const stats = HARNESSES.map((harness) => ({
    harness,
    ...aggregate(rows.filter((row) => row.harness === harness)),
  }));
  const fastest = [...stats].sort((a, b) => a.wall - b.wall)[0];
  const cheapest = [...stats].sort((a, b) => a.cost - b.cost)[0];
  const heaviest = [...stats].sort((a, b) => b.tokens - a.tokens)[0];
  const solved = rows.filter((m) => m.fullSolve).length;
  const diffs = rows.map((m) => m.diff.insertions);
  const tests = rows.reduce((n, m) => n + m.testInvocations, 0);
  const lines = [];
  lines.push(`## ${task.label}`, "");
  lines.push(`**Fixture:** \`eval/harness-task/tasks/${task.name}/fixture\`. ${meta.start}.`, "");
  lines.push(
    `The visible suite has ${meta.visibleTotal} tests and ${meta.visibleFailures} fail; the hidden suite has ${meta.hiddenTotal}. ${meta.designNote ?? ""}`.trim(),
    "",
  );
  lines.push(...trialTable(rows), "");
  lines.push(...aggregateTable(rows), "");
  lines.push("Observations:", "");
  lines.push(
    `- Fastest median wall time: **${fastest.harness}** (${round(fastest.wall, 2)}s); lowest median cost: **${cheapest.harness}** ($${round(cheapest.cost, 6)}); highest median token volume: **${heaviest.harness}** (${Math.round(heaviest.tokens)} tokens).`,
    `- Full solves: ${stats.map((s) => `${s.harness} ${s.solves}/3`).join("; ")}; test-suite invocations: ${stats.map((s) => `${s.harness} ${s.tests}`).join(", ")}.`,
    `- Successful diffs touched one implementation file, with ${Math.min(...diffs)}–${Math.max(...diffs)} insertions across trials.`,
    "",
  );
  lines.push("Tool usage across all trials:", "");
  lines.push(...toolMix(rows), "");
  return lines;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tasks = [];
  for (const task of TASKS) {
    const meta = JSON.parse(
      await fs.readFile(path.join(HERE, "tasks", task.name, "task.json"), "utf8"),
    );
    const rows = JSON.parse(
      await fs.readFile(path.join(HERE, "runs", task.name, opts.tag, "index.json"), "utf8"),
    );
    tasks.push({ task, meta, rows });
  }

  const lines = [];
  lines.push("# Task evals: slugify and dependency planner", "");
  lines.push(
    "The same two software tasks, the same prompt per task, and the same model were given to opencode, pi, and oh-my-pi. Each harness ran in non-interactive batch mode, one at a time, in a fresh workspace.",
    "",
  );
  lines.push("## At a glance", "");
  lines.push(
    "| Task | Harness | Median wall (s) | Median cost (USD) | Median total tokens | Full solves |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const { task, rows } of tasks) {
    for (const harness of HARNESSES) {
      const stats = aggregate(rows.filter((row) => row.harness === harness));
      lines.push(
        `| ${task.name} | ${harness} | ${round(stats.wall, 2)} | ${round(stats.cost, 6)} | ${Math.round(stats.tokens)} | ${stats.solves}/3 |`,
      );
    }
  }
  lines.push("");

  lines.push("## Method", "");
  lines.push(
    `- Model: \`${MODEL}\` (OpenCode Go), selected explicitly for every harness.`,
    "- Installed CLI versions: opencode 1.19.5, pi 1.5.0, omp 18.18.3.",
    "- Three trials per harness per task, strictly serial. Each trial starts from a fresh git repository.",
    "- The agent's diff is captured, then `SPEC.md`, `package.json`, and `test/` are restored from the fixture before scoring. A trial is a full solve only if the visible suite, the hidden suite, and the contract-file check all pass.",
    "- Workspaces are created under the OS temp directory, outside this repository, so hidden tests are not reachable by walking up.",
    "- Extensions, skills, project context files, prompt templates, and themes are disabled where the CLI supports it; `opencode` runs with `--pure`.",
    "- `pi` and `omp` receive the local OpenCode Go key explicitly because their stored OpenCode Go credentials were expired; `opencode` uses its stored login.",
    "- Every `pi` and `omp` trial reported `provider=opencode-go` and `model=deepseek-v4.1-flash`; `opencode` receives the same id through `--model`.",
    "",
  );

  for (const { task, meta, rows } of tasks) {
    lines.push(...taskSection(task, meta, rows));
  }

  lines.push("## Cross-task observations", "");
  lines.push(
    "- `opencode` had the lowest median wall time and reported cost on both tasks.",
    "- `pi` used the fewest total tokens on both tasks, but had the highest median wall time on both.",
    "- `omp` used the most tools and tokens on both tasks, consistent with its larger built-in surface.",
    "- Every one of the 18 trials solved its task. Both tasks are therefore ceiling tests for correctness; the differences are overhead and working style.",
    "- The dependency planner produced roughly twice the diff size of the slugify task, with 70–104 insertions versus 27–59, while tool counts stayed in a similar range. The harder task changed what the models had to write, not how many tools they reached for.",
    "- Test-suite invocation counts varied widely (opencode 1 per trial; pi 4–9; omp 5–15), so the harnesses differ more in verification behavior than in final correctness here.",
    "",
  );

  lines.push("## Caveats", "");
  lines.push(
    "- Two small tasks and one model. The results do not generalize to large repositories or other models.",
    "- The installed `opencode` CLI is 1.19.5, while `docs/compare/code.md` describes the cloned 2.2.5 tree. These evals measure the installed build; the installed `pi` and `omp` versions match their cloned trees.",
    "- Token totals include each harness's system prompt, tool schemas, cache reads, and the conversation. Cache accounting differs between harnesses, so compare totals within a column with caution.",
    "- Wall time includes process startup, server startup (`opencode`), provider latency, and test execution; provider load varies.",
    "- Three trials per harness per task is enough to expose gross failures, not to estimate a stable pass rate.",
    "- Global user settings remain active where a CLI has no switch to disable them. Project instructions are absent.",
    "",
  );

  lines.push("## Reproduce", "");
  lines.push("```sh");
  lines.push("node eval/harness-task/runner.mjs --task slugify --trials 3 --timeout 600 --tag run1");
  lines.push("node eval/harness-task/runner.mjs --task deps --trials 3 --timeout 600 --tag run1");
  lines.push("node eval/harness-task/combine.mjs --tag run1");
  lines.push("```");
  lines.push("");

  lines.push("## Raw artifacts", "");
  lines.push(
    "Each trial is under `eval/harness-task/runs/<task>/run1/<harness>-t<n>/`: `events.jsonl`, `stderr.log`, `final.txt`, `diff.patch`, `visible.tap`, `hidden.tap`, and `metrics.json`. Per-task aggregates are `eval/harness-task/runs/<task>/run1/index.json`.",
  );
  lines.push("");

  await fs.writeFile(path.join(ROOT, opts.out), lines.join("\n"));
  console.log(`report: ${opts.out}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
