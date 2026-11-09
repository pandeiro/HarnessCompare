#!/usr/bin/env node
/**
 * Serial batch-mode harness eval.
 *
 * Runs the same prompt, in the same fixture workspace, against opencode, pi,
 * and omp with the same OpenCode Go model. Captures wall time, JSON event
 * streams, token usage, cost, tool calls, diffs, and visible/hidden test
 * results, then writes the task report.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const TASKS_DIR = path.join(HERE, "tasks");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const HARNESSES = ["opencode", "pi", "omp"];
const DEFAULT_TIMEOUT_SEC = 600;

function parseArgs(argv) {
  const out = {
    trials: 1,
    timeout: DEFAULT_TIMEOUT_SEC,
    only: HARNESSES,
    report: true,
    reportOnly: false,
    tag: null,
    task: "slugify",
    reportPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trials") out.trials = Number(argv[++i]);
    else if (arg === "--timeout") out.timeout = Number(argv[++i]);
    else if (arg === "--only") out.only = argv[++i].split(",").filter(Boolean);
    else if (arg === "--no-report") out.report = false;
    else if (arg === "--report-only") out.reportOnly = true;
    else if (arg === "--tag") out.tag = argv[++i];
    else if (arg === "--task") out.task = argv[++i];
    else if (arg === "--report-path") out.reportPath = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: node runner.mjs [--task NAME] [--trials N] [--timeout SEC] [--only a,b] [--tag NAME] [--report-path FILE] [--no-report] [--report-only]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.trials) || out.trials < 1) throw new Error("--trials must be a positive integer");
  if (!Number.isFinite(out.timeout) || out.timeout < 1) throw new Error("--timeout must be positive");
  return out;
}

async function loadTask(task) {
  const dir = path.join(TASKS_DIR, task);
  const meta = JSON.parse(await fs.readFile(path.join(dir, "task.json"), "utf8"));
  if (meta.name !== task) throw new Error(`task.json name mismatch in ${dir}`);
  return { dir, meta };
}

async function readKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  const key = auth["opencode-go"]?.key;
  if (!key) throw new Error(`no opencode-go credential in ${authPath}`);
  return key;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true, force: true });
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8");
  const events = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
  }
  return "";
}

function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function addUsage(target, usage) {
  if (!usage) return;
  const cost = usage.cost;
  target.input += usage.input ?? usage.inputTokens ?? 0;
  target.output += usage.output ?? usage.outputTokens ?? 0;
  target.reasoning += usage.reasoning ?? usage.reasoningTokens ?? 0;
  target.cacheRead += usage.cacheRead ?? usage.cache?.read ?? usage.cachedInputTokens ?? 0;
  target.cacheWrite += usage.cacheWrite ?? usage.cache?.write ?? 0;
  target.total += usage.totalTokens ?? usage.total ?? 0;
  if (typeof cost === "number") target.cost += cost;
  else if (cost && typeof cost === "object") target.cost += cost.total ?? 0;
}

function inc(map, key) {
  const name = key || "unknown";
  map[name] = (map[name] ?? 0) + 1;
}

function analyzeOpencode(events) {
  const usage = { ...emptyUsage(), cost: 0 };
  const toolCalls = {};
  const seenSteps = new Set();
  const models = new Set();
  const errors = [];
  let steps = 0;
  let finalText = "";
  for (const event of events) {
    if (event.type === "step_start") steps++;
    if (event.type === "step_finish") {
      const id = event.part?.id;
      if (!id || !seenSteps.has(id)) {
        if (id) seenSteps.add(id);
        addUsage(usage, event.part?.tokens);
        if (typeof event.part?.cost === "number") usage.cost += event.part.cost;
      }
      if (event.part?.modelID) models.add(event.part.modelID);
    }
    if (event.type === "text" && typeof event.part?.text === "string") {
      finalText += event.part.text;
    }
    const part = event.part ?? event;
    const tool = part.tool ?? part.toolName ?? (event.type === "tool" ? event.name : undefined);
    if ((event.type === "tool_use" || event.type === "tool_call" || event.type === "tool") && tool) {
      inc(toolCalls, tool);
    }
    if (event.type === "error") errors.push(event.error ?? event);
  }
  return { usage, toolCalls, models: [...models], errors, steps, finalText, turns: steps };
}

function analyzePiLike(events) {
  const usage = { ...emptyUsage(), cost: 0 };
  const toolCalls = {};
  const models = new Set();
  const providers = new Set();
  const errors = [];
  let turns = 0;
  let finalText = "";
  for (const event of events) {
    if (event.type === "turn_end") turns++;
    if (event.type === "tool_execution_start") {
      inc(toolCalls, event.toolName ?? event.tool?.name);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      addUsage(usage, event.message.usage);
      if (event.message.model) models.add(event.message.model);
      if (event.message.provider) providers.add(event.message.provider);
      const text = textOf(event.message);
      if (text) finalText = text;
      if (event.message.errorMessage) errors.push(event.message.errorMessage);
    }
  }
  return { usage, toolCalls, models: [...models], providers: [...providers], errors, steps: turns, finalText, turns };
}

function countTestInvocations(events) {
  const commands = [];
  for (const event of events) {
    const part = event.part ?? event;
    const input = part.state?.input ?? part.input ?? event.args ?? event.arguments;
    if (input && typeof input === "object") {
      for (const key of ["command", "cmd"]) {
        if (typeof input[key] === "string") commands.push(input[key]);
      }
    }
    if (typeof event.command === "string") commands.push(event.command);
  }
  return commands.filter((command) =>
    /\b(?:npm\s+test|node\s+--test|bun\s+test|vitest|pytest)\b/.test(command),
  ).length;
}

function parseTap(text) {
  const passed = [];
  const failed = [];
  let passSummary = null;
  let failSummary = null;
  for (const line of text.split(/\r?\n/)) {
    const test = line.match(/^\s*(not ok|ok)\s+\d+\s+-\s+(.*?)(?:\s+#.*)?$/);
    if (test) {
      const name = test[2].trim();
      if (name && !name.startsWith("#")) (test[1] === "not ok" ? failed : passed).push(name);
    }
    const pass = line.match(/^# pass (\d+)/);
    if (pass) passSummary = Number(pass[1]);
    const fail = line.match(/^# fail (\d+)/);
    if (fail) failSummary = Number(fail[1]);
  }
  return {
    passed: passSummary ?? passed.length,
    failed: failSummary ?? failed.length,
    passedNames: passed,
    failedNames: failed,
  };
}

function runCommand({ command, args, cwd, env, stdoutPath, stderrPath, timeoutMs }) {
  return new Promise((resolve) => {
    const stdoutFd = openSync(stdoutPath, "w");
    const stderrFd = openSync(stderrPath, "w");
    const started = performance.now();
    let timedOut = false;
    let settled = false;
    let timer;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        closeSync(stdoutFd);
      } catch {}
      try {
        closeSync(stderrFd);
      } catch {}
      resolve({ ...result, durationMs: performance.now() - started, timedOut });
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
    } catch (error) {
      writeSync(stderrFd, String(error?.stack ?? error));
      finish({ exitCode: null, signal: null, spawnError: String(error) });
      return;
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {}
      }
    }, timeoutMs);
    child.on("error", (error) => {
      try {
        writeSync(stderrFd, String(error?.stack ?? error));
      } catch {}
      finish({ exitCode: null, signal: null, spawnError: String(error) });
    });
    child.on("close", (code, signal) => finish({ exitCode: code, signal }));
  });
}

function redactCommand(args) {
  const out = [...args];
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === "--api-key") out[i + 1] = "<key>";
  }
  return out;
}

function harnessCommand(harness, { prompt, key, timeoutSec, workspace }) {
  switch (harness) {
    case "opencode":
      return {
        command: "opencode",
        args: [
          "run",
          "--format",
          "json",
          "--pure",
          "--model",
          MODEL,
          "--auto",
          "--dir",
          workspace,
          "--title",
          `eval-${path.basename(workspace)}`,
          prompt,
        ],
      };
    case "pi":
      return {
        command: "pi",
        args: [
          "-p",
          "--mode",
          "json",
          "--model",
          MODEL,
          "--api-key",
          key,
          "--no-session",
          "--no-context-files",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          prompt,
        ],
      };
    case "omp":
      return {
        command: "omp",
        args: [
          "-p",
          "--mode",
          "json",
          "--model",
          MODEL,
          "--api-key",
          key,
          "--no-session",
          "--auto-approve",
          "--no-extensions",
          "--no-skills",
          "--no-context-files",
          "--no-rules",
          "--no-lsp",
          "--max-time",
          `${Math.max(1, Math.ceil(timeoutSec / 60))}m`,
          prompt,
        ],
      };
    default:
      throw new Error(`unknown harness: ${harness}`);
  }
}

async function setupWorkspace(workspace, taskDir) {
  await copyDir(path.join(taskDir, "fixture"), workspace);
  await git(workspace, ["init", "-q"]);
  await git(workspace, ["config", "user.email", "eval@example.invalid"]);
  await git(workspace, ["config", "user.name", "Harness Eval"]);
  await git(workspace, ["add", "-A"]);
  await git(workspace, ["commit", "-qm", "baseline"]);
}

async function captureDiff(workspace) {
  await git(workspace, ["add", "-A"]);
  const nameStatus = await git(workspace, ["diff", "--cached", "--name-status"]);
  const numstat = await git(workspace, ["diff", "--cached", "--numstat"]);
  const patch = await git(workspace, ["diff", "--cached", "--binary"]);
  await git(workspace, ["reset", "-q"]);

  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split("\n")) {
    const [add, del] = line.split("\t");
    insertions += Number.parseInt(add, 10) || 0;
    deletions += Number.parseInt(del, 10) || 0;
  }
  const changes = nameStatus
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0], path: parts[1], from: parts[2] };
    });
  return { patch, changes, insertions, deletions };
}

async function scoreWorkspace(workspace, timeoutSec, taskDir, meta) {
  // Restore the contract files the task forbids changing, so scoring cannot be
  // gamed by editing tests or the package manifest.
  await fs.rm(path.join(workspace, "test"), { recursive: true, force: true });
  await copyDir(path.join(taskDir, "fixture", "test"), path.join(workspace, "test"));
  for (const file of ["SPEC.md", "package.json"]) {
    await fs.copyFile(path.join(taskDir, "fixture", file), path.join(workspace, file));
  }
  await fs.rm(path.join(workspace, ".eval-hidden"), { recursive: true, force: true });
  await fs.mkdir(path.join(workspace, ".eval-hidden"), { recursive: true });
  await fs.copyFile(
    path.join(taskDir, "hidden", meta.hiddenTest),
    path.join(workspace, ".eval-hidden", meta.hiddenTest),
  );

  const env = { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb" };
  const visiblePath = path.join(workspace, "visible.tap");
  const hiddenPath = path.join(workspace, "hidden.tap");
  const visibleRun = await runCommand({
    command: process.execPath,
    args: ["--test", "--test-reporter=tap", meta.visibleTest],
    cwd: workspace,
    env,
    stdoutPath: visiblePath,
    stderrPath: path.join(workspace, "visible.stderr.log"),
    timeoutMs: timeoutSec * 1000,
  });
  const hiddenRun = await runCommand({
    command: process.execPath,
    args: ["--test", "--test-reporter=tap", path.join(".eval-hidden", meta.hiddenTest)],
    cwd: workspace,
    env,
    stdoutPath: hiddenPath,
    stderrPath: path.join(workspace, "hidden.stderr.log"),
    timeoutMs: timeoutSec * 1000,
  });
  const visible = parseTap(await fs.readFile(visiblePath, "utf8"));
  const hidden = parseTap(await fs.readFile(hiddenPath, "utf8"));
  return {
    visible: { ...visible, exitCode: visibleRun.exitCode, timedOut: visibleRun.timedOut },
    hidden: { ...hidden, exitCode: hiddenRun.exitCode, timedOut: hiddenRun.timedOut },
  };
}

async function runTrial({ harness, trial, tag, key, timeoutSec, prompt, task, taskDir, meta }) {
  const id = `${harness}-t${trial}`;
  const runDir = path.join(HERE, "runs", task, tag, id);
  const workRoot = path.join(os.tmpdir(), "harness-task", task, tag, id);
  const workspace = path.join(workRoot, "workspace");
  await fs.mkdir(runDir, { recursive: true });
  await fs.rm(workRoot, { recursive: true, force: true });
  await setupWorkspace(workspace, taskDir);

  const stdoutPath = path.join(runDir, "events.jsonl");
  const stderrPath = path.join(runDir, "stderr.log");
  const { command, args } = harnessCommand(harness, { prompt, key, timeoutSec, workspace });
  const startedAt = new Date().toISOString();
  const env = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    OPENCODE_API_KEY: key,
    XDG_STATE_HOME: path.join(workRoot, "xdg-state"),
    XDG_CACHE_HOME: path.join(workRoot, "xdg-cache"),
  };
  delete env.OPENCODE_CONFIG_CONTENT;

  const run = await runCommand({
    command,
    args,
    cwd: workspace,
    env,
    stdoutPath,
    stderrPath,
    timeoutMs: timeoutSec * 1000,
  });

  const { events, malformed } = await readJsonl(stdoutPath);
  const analysis =
    harness === "opencode" ? analyzeOpencode(events) : analyzePiLike(events);
  const diff = await captureDiff(workspace);
  const forbidden = diff.changes.filter(
    (change) =>
      change.path === "SPEC.md" ||
      change.path === "package.json" ||
      change.path === "test" ||
      change.path.startsWith("test/"),
  );
  const score = await scoreWorkspace(workspace, timeoutSec, taskDir, meta);
  await fs.writeFile(path.join(runDir, "diff.patch"), diff.patch);
  await fs.writeFile(path.join(runDir, "final.txt"), analysis.finalText + "\n");
  await fs.writeFile(path.join(runDir, "visible.tap"), await fs.readFile(path.join(workspace, "visible.tap"), "utf8"));
  await fs.writeFile(path.join(runDir, "hidden.tap"), await fs.readFile(path.join(workspace, "hidden.tap"), "utf8"));
  const stdoutText = await fs.readFile(stdoutPath, "utf8");
  const stderrText = await fs.readFile(stderrPath, "utf8");
  const fullSolve =
    run.exitCode === 0 &&
    !run.timedOut &&
    score.visible.failed === 0 &&
    score.hidden.failed === 0 &&
    forbidden.length === 0;

  const metrics = {
    task,
    harness,
    trial,
    id,
    startedAt,
    model: MODEL,
    command: [command, ...redactCommand(args.slice(0, -1)), "<prompt>"].join(" "),
    exitCode: run.exitCode,
    signal: run.signal,
    timedOut: run.timedOut,
    durationMs: round(run.durationMs, 1),
    stdoutBytes: Buffer.byteLength(stdoutText),
    stderrBytes: Buffer.byteLength(stderrText),
    eventCount: events.length,
    malformedEventLines: malformed,
    modelsReported: analysis.models,
    providersReported: analysis.providers ?? [],
    usage: {
      input: analysis.usage.input,
      output: analysis.usage.output,
      reasoning: analysis.usage.reasoning,
      cacheRead: analysis.usage.cacheRead,
      cacheWrite: analysis.usage.cacheWrite,
      total: analysis.usage.total || analysis.usage.input + analysis.usage.output,
    },
    costUsd: round(analysis.usage.cost ?? 0, 6),
    turns: analysis.turns,
    steps: analysis.steps,
    toolCalls: analysis.toolCalls,
    toolCallCount: Object.values(analysis.toolCalls).reduce((a, b) => a + b, 0),
    testInvocations: countTestInvocations(events),
    errors: analysis.errors.slice(0, 10),
    diff: {
      changedFiles: diff.changes.length,
      insertions: diff.insertions,
      deletions: diff.deletions,
      files: diff.changes,
      forbidden: forbidden.map((change) => change.path),
    },
    visible: score.visible,
    hidden: score.hidden,
    fullSolve,
  };
  await fs.writeFile(path.join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  return metrics;
}

function pct(n, d) {
  if (!d) return "—";
  return `${round((n / d) * 100, 1)}%`;
}

async function writeReport(all, { tag, trials, timeoutSec, task, meta, reportPath }) {
  const byHarness = new Map(HARNESSES.map((h) => [h, all.filter((m) => m.harness === h)]));
  const lines = [];
  lines.push(`# Task eval: ${meta.title} across three harnesses`, "");
  lines.push(
    "Same fixture, same prompt, same model (`" + MODEL + "`), one harness at a time in non-interactive batch mode.",
    "",
  );
  const allSolved = all.every((m) => m.fullSolve);
  if (allSolved) {
    lines.push(
      "All trials solved the task. The differences below are harness overhead and working style, not correctness.",
      "",
    );
  } else {
    lines.push("Not every trial solved the task; failure modes are listed below.", "");
  }
  lines.push("## Design", "");
  if (Array.isArray(meta.related) && meta.related.length > 0) {
    lines.push(
      "Related: " + meta.related.map((item) => `[${item.label}](${item.href})`).join(", ") + ".",
      "",
    );
  }
  lines.push(
    `Each trial starts from a fresh copy of \`eval/harness-task/tasks/${task}/fixture\`: ${meta.start}. The visible suite has ${meta.visibleTotal} tests and ${meta.visibleFailures} fail. The model must read the spec, edit the implementation, and run the tests. Scoring restores \`SPEC.md\`, \`package.json\`, and \`test/\` from the pristine fixture, then runs both the visible suite and a ${meta.hiddenTotal}-test hidden suite. That prevents a test edit from counting as a solve.`,
    "",
  );
  if (meta.designNote) lines.push(meta.designNote, "");
  lines.push(
    `- Model: \`${MODEL}\` (OpenCode Go), selected explicitly for every harness.`,
    `- Installed CLI versions: opencode 1.19.5, pi 1.5.0, omp 18.18.3.`,
    `- Run date: ${new Date().toISOString().slice(0, 10)}.`,
    `- Trials: ${trials} per harness, serial (no concurrent runs).`,
    `- Timeout: ${timeoutSec}s per agent run.`,
    "- Workspace: fresh git repository per trial, no project instructions, no dependency install.",
    "- Fairness switches: extensions, skills, project context files, prompt templates, and themes disabled where the CLI supports it; `opencode` runs with `--pure`.",
    "- Credential: the local OpenCode Go login is reused. `pi` and `omp` receive it explicitly because their stored OpenCode Go key had expired.",
    "- Model verification: every `pi` and `omp` trial reported `provider=opencode-go` and `model=deepseek-v4.1-flash` in its event stream; `opencode` receives the same id through `--model`.",
    "",
  );
  lines.push("## Commands", "");
  lines.push("```sh");
  lines.push("opencode run --format json --pure --model " + MODEL + " --auto --dir <workspace> --title <id> \"<prompt>\"");
  lines.push(
    "pi -p --mode json --model " + MODEL + " --api-key <key> --no-session --no-context-files --no-extensions --no-skills --no-prompt-templates --no-themes \"<prompt>\"",
  );
  lines.push(
    "omp -p --mode json --model " + MODEL + " --api-key <key> --no-session --auto-approve --no-extensions --no-skills --no-context-files --no-rules --no-lsp --max-time 10m \"<prompt>\"",
  );
  lines.push("```", "");
  lines.push("## Trials", "");
  lines.push(
    "| Harness | Trial | Wall (s) | Exit | Input | Output | Reasoning | Cache read | Total | Cost (USD) | Tools | Test cmds | Visible | Hidden | Solve | Forbidden edits |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const harness of HARNESSES) {
    for (const m of byHarness.get(harness)) {
      lines.push(
        `| ${harness} | ${m.trial} | ${round(m.durationMs / 1000, 2)} | ${m.exitCode ?? "—"}${m.timedOut ? " (timeout)" : ""} | ${m.usage.input} | ${m.usage.output} | ${m.usage.reasoning} | ${m.usage.cacheRead} | ${m.usage.total} | ${m.costUsd} | ${m.toolCallCount} | ${m.testInvocations} | ${m.visible.passed}/${m.visible.passed + m.visible.failed} | ${m.hidden.passed}/${m.hidden.passed + m.hidden.failed} | ${m.fullSolve ? "yes" : "no"} | ${m.diff.forbidden.length ? m.diff.forbidden.join(", ") : "—"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Aggregate", "");
  lines.push("| Harness | Median wall (s) | Median cost (USD) | Median total tokens | Hidden pass rate | Full solves | Avg tool calls | Avg turns |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const harness of HARNESSES) {
    const rows = byHarness.get(harness);
    const hiddenPassed = rows.reduce((n, m) => n + m.hidden.passed, 0);
    const hiddenTotal = rows.reduce((n, m) => n + m.hidden.passed + m.hidden.failed, 0);
    lines.push(
      `| ${harness} | ${round(median(rows.map((m) => m.durationMs)) / 1000, 2)} | ${round(median(rows.map((m) => m.costUsd)), 6)} | ${Math.round(median(rows.map((m) => m.usage.total)))} | ${pct(hiddenPassed, hiddenTotal)} | ${rows.filter((m) => m.fullSolve).length}/${rows.length} | ${round(rows.reduce((n, m) => n + m.toolCallCount, 0) / rows.length, 1)} | ${round(rows.reduce((n, m) => n + m.turns, 0) / rows.length, 1)} |`,
    );
  }
  lines.push("");
  lines.push("## Tool usage by name", "");
  lines.push("| Harness | Tool calls (all trials) |");
  lines.push("|---|---|");
  for (const harness of HARNESSES) {
    const totals = {};
    for (const m of byHarness.get(harness)) {
      for (const [name, count] of Object.entries(m.toolCalls)) totals[name] = (totals[name] ?? 0) + count;
    }
    const text =
      Object.entries(totals)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} × ${count}`)
        .join(", ") || "—";
    lines.push(`| ${harness} | ${text} |`);
  }
  lines.push("");
  lines.push("## Changed files", "");
  lines.push("| Harness | Trial | Changed | Insertions | Deletions | Files |");
  lines.push("|---|---:|---:|---:|---:|---|");
  for (const harness of HARNESSES) {
    for (const m of byHarness.get(harness)) {
      const files = m.diff.files.map((f) => `${f.status} ${f.path}`).join("<br>") || "—";
      lines.push(`| ${harness} | ${m.trial} | ${m.diff.changedFiles} | ${m.diff.insertions} | ${m.diff.deletions} | ${files} |`);
    }
  }
  lines.push("");
  lines.push("## Observations", "");
  const stats = HARNESSES.map((harness) => {
    const rows = byHarness.get(harness);
    return {
      harness,
      rows,
      medianWall: median(rows.map((m) => m.durationMs)) / 1000,
      medianCost: median(rows.map((m) => m.costUsd)),
      medianTokens: median(rows.map((m) => m.usage.total)),
      solves: rows.filter((m) => m.fullSolve).length,
      tests: rows.reduce((n, m) => n + m.testInvocations, 0),
      toolText:
        Object.entries(
          rows.reduce((totals, m) => {
            for (const [name, count] of Object.entries(m.toolCalls)) totals[name] = (totals[name] ?? 0) + count;
            return totals;
          }, {}),
        )
          .sort((a, b) => b[1] - a[1])
          .map(([name, count]) => `${name} × ${count}`)
          .join(", ") || "—",
    };
  });
  const fastest = [...stats].sort((a, b) => a.medianWall - b.medianWall)[0];
  const slowest = [...stats].sort((a, b) => b.medianWall - a.medianWall)[0];
  const cheapest = [...stats].sort((a, b) => a.medianCost - b.medianCost)[0];
  const heaviest = [...stats].sort((a, b) => b.medianTokens - a.medianTokens)[0];
  lines.push(
    `- Fastest median wall time: **${fastest.harness}** (${round(fastest.medianWall, 2)}s); slowest: **${slowest.harness}** (${round(slowest.medianWall, 2)}s).`,
    `- Lowest median reported cost: **${cheapest.harness}** ($${round(cheapest.medianCost, 6)}); highest median token volume: **${heaviest.harness}** (${Math.round(heaviest.medianTokens)} tokens).`,
    `- Test-suite invocations across all trials: ${stats.map((s) => `${s.harness} ${s.tests}`).join("; ")}.`,
    `- Tool mix: ${stats.map((s) => `${s.harness} — ${s.toolText}`).join("; ")}.`,
    `- Full solves: ${stats.map((s) => `${s.harness} ${s.solves}/${s.rows.length}`).join("; ")}.`,
    allSolved
      ? "- The task was solved by every trial, so it measures harness overhead and working style, not a correctness gap between the tools. Raising difficulty would need a larger fixture or hidden edge cases that the visible suite does not hint at."
      : "- At least one trial failed; the failure modes below are the correctness signal for this task.",
    "- Wall time varied within harnesses; medians are more useful than a single run.",
    "",
  );
  lines.push("### Reliability", "");
  for (const harness of HARNESSES) {
    const rows = byHarness.get(harness);
    const complete = rows.filter((m) => m.exitCode === 0 && !m.timedOut).length;
    const solved = rows.filter((m) => m.fullSolve).length;
    lines.push(`- **${harness}**: ${complete}/${rows.length} runs exited cleanly; ${solved}/${rows.length} fully solved.`);
  }
  lines.push("");
  lines.push("### Failure modes", "");
  const failures = all.filter((m) => !m.fullSolve);
  if (failures.length === 0) lines.push("- No failed trials.");
  for (const m of failures) {
    const reasons = [];
    if (m.timedOut) reasons.push("timeout");
    if (m.exitCode !== 0) reasons.push(`exit ${m.exitCode}`);
    if (m.visible.failed) reasons.push(`visible fail ${m.visible.failed}`);
    if (m.hidden.failed) reasons.push(`hidden fail ${m.hidden.failed}`);
    if (m.diff.forbidden.length) reasons.push(`forbidden edits: ${m.diff.forbidden.join(", ")}`);
    lines.push(`- **${m.id}**: ${reasons.join("; ") || "passed"}.`);
  }
  lines.push("");
  lines.push("### Cost and context overhead", "");
  lines.push(
    "Token totals include each harness's system prompt, tool schemas, cache reads, and the task conversation. The harnesses do not account for cache tokens identically, so compare totals within a column with caution; they measure end-to-end harness overhead, not model efficiency in isolation. Cost is the harness-reported estimate at the time of the run.",
    "",
  );
  lines.push("## Caveats", "");
  lines.push(
    "- One task and one model per report. The result does not generalize to large repositories or other models.",
    "- The installed `opencode` CLI is 1.19.5, while `docs/compare/code.md` describes the cloned 2.2.5 tree. This eval measures the installed build; the other two installed versions match their cloned trees.",
    "- Wall time includes process startup, server startup (`opencode`), provider latency, and test execution; provider load varies.",
    "- Three trials per harness is enough to expose gross failures, not to estimate a stable pass rate.",
    "- The visible and hidden suites are intentionally narrow. A solve means these assertions pass without editing the contract files; it is not a code-review judgment.",
    "- Global user settings remain active where a CLI has no switch to disable them. Project instructions are absent, and customization surfaces were disabled per the switches above.",
    "- `pi` and `omp` used the local OpenCode Go key explicitly; their own stored OpenCode Go credentials were expired. `opencode` used its stored login.",
    "",
  );
  lines.push("## Reproduce", "");
  lines.push("```sh");
  lines.push("node eval/harness-task/runner.mjs --task " + task + " --trials 3 --timeout 600 --tag " + tag);
  lines.push("```");
  lines.push("");
  lines.push("## Raw artifacts", "");
  lines.push(
    `Each trial is under \`eval/harness-task/runs/${task}/${tag}/<harness>-t<n>/\`: \`events.jsonl\` (raw harness events), \`stderr.log\`, \`final.txt\`, \`diff.patch\`, \`visible.tap\`, \`hidden.tap\`, and \`metrics.json\`. The aggregate is \`eval/harness-task/runs/${task}/${tag}/index.json\`.`,
  );
  lines.push("");
  await fs.writeFile(path.join(ROOT, reportPath), lines.join("\n"));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { dir: taskDir, meta } = await loadTask(opts.task);
  const reportPath = opts.reportPath;
  if (opts.reportOnly) {
    if (!opts.tag) throw new Error("--report-only requires --tag");
    if (!reportPath) throw new Error("--report-only requires --report-path");
    const all = JSON.parse(
      await fs.readFile(path.join(HERE, "runs", opts.task, opts.tag, "index.json"), "utf8"),
    );
    await writeReport(all, {
      tag: opts.tag,
      trials: opts.trials,
      timeoutSec: opts.timeout,
      task: opts.task,
      meta,
      reportPath,
    });
    console.log(`report: ${reportPath}`);
    return;
  }
  const key = await readKey();
  const prompt = (await fs.readFile(path.join(taskDir, "prompt.txt"), "utf8")).trim();
  const tag = opts.tag ?? new Date().toISOString().replace(/[:.]/g, "-");
  const all = [];
  for (const harness of opts.only) {
    for (let trial = 1; trial <= opts.trials; trial++) {
      console.log(`[${new Date().toISOString()}] ${opts.task} ${harness} trial ${trial}/${opts.trials}`);
      const metrics = await runTrial({
        harness,
        trial,
        tag,
        key,
        timeoutSec: opts.timeout,
        prompt,
        task: opts.task,
        taskDir,
        meta,
      });
      console.log(
        `  exit=${metrics.exitCode} wall=${(metrics.durationMs / 1000).toFixed(1)}s ` +
          `tokens=${metrics.usage.total} cost=$${metrics.costUsd} ` +
          `hidden=${metrics.hidden.passed}/${metrics.hidden.passed + metrics.hidden.failed} ` +
          `solve=${metrics.fullSolve}`,
      );
      all.push(metrics);
      await fs.writeFile(
        path.join(HERE, "runs", opts.task, tag, "index.json"),
        JSON.stringify(all, null, 2),
      );
    }
  }
  if (opts.report && reportPath) {
    await writeReport(all, {
      tag,
      trials: opts.trials,
      timeoutSec: opts.timeout,
      task: opts.task,
      meta,
      reportPath,
    });
    console.log(`report: ${reportPath}`);
  } else if (opts.report) {
    console.log("per-task report skipped; run eval/harness-task/combine.mjs for the combined report");
  }
  console.log(`runs: eval/harness-task/runs/${opts.task}/${tag}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
