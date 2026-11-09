#!/usr/bin/env node
/**
 * Real-world eval: install and exercise a pinned modern CLI inside Docker.
 *
 * Each harness gets a fresh workspace and must do the install/run in one
 * ephemeral container. The runner records wall time, tokens, tool calls,
 * Docker usage, host-state deltas, result artifacts, and the final answer.
 */
import { spawn, execFile } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const MODEL = "opencode-go/deepseek-v4.1-flash";
const HARNESSES = ["opencode", "pi", "omp"];
const DEFAULT_TIMEOUT_SEC = 900;

function parseArgs(argv) {
  const out = { tag: "run1", timeout: DEFAULT_TIMEOUT_SEC, only: HARNESSES };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tag") out.tag = argv[++i];
    else if (arg === "--timeout") out.timeout = Number(argv[++i]);
    else if (arg === "--only") out.only = argv[++i].split(",").filter(Boolean);
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node runner.mjs [--tag NAME] [--timeout SEC] [--only a,b]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.timeout) || out.timeout < 1) throw new Error("--timeout must be positive");
  return out;
}

async function readKey() {
  if (process.env.OPENCODE_GO_API_KEY) return process.env.OPENCODE_GO_API_KEY;
  const authPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
  const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
  const key = auth["opencode-go"]?.key;
  if (!key) throw new Error(`no opencode-go credential in ${authPath}`);
  return key;
}

async function copyDir(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.cp(src, dst, { recursive: true, force: true });
}

async function run(cmd, args, opts = {}) {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
  return { stdout, stderr };
}

async function hostSnapshot() {
  const snapshot = {
    docker: [],
    dockerError: null,
    onlycli: "",
    goBin: [],
    goBinError: null,
  };
  try {
    const { stdout } = await run("docker", [
      "ps",
      "-a",
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    ]);
    snapshot.docker = stdout.trim() ? stdout.trim().split("\n") : [];
  } catch (error) {
    snapshot.dockerError = String(error.message ?? error);
  }
  try {
    const { stdout } = await run("sh", ["-c", "command -v onlycli || true"]);
    snapshot.onlycli = stdout.trim();
  } catch {}
  try {
    snapshot.goBin = await fs.readdir(path.join(os.homedir(), "go", "bin"));
  } catch (error) {
    snapshot.goBinError = String(error.message ?? error);
  }
  return snapshot;
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
      try {
        writeSync(stderrFd, String(error?.stack ?? error));
      } catch {}
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

function commandFor(harness, { prompt, key, timeoutSec, workspace }) {
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

function emptyUsage() {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function addUsage(target, usage) {
  if (!usage) return;
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.reasoning += usage.reasoning ?? 0;
  target.cacheRead += usage.cacheRead ?? usage.cache?.read ?? 0;
  target.cacheWrite += usage.cacheWrite ?? usage.cache?.write ?? 0;
  target.total += usage.totalTokens ?? usage.total ?? 0;
  if (typeof usage.cost === "number") target.cost += usage.cost;
  else if (usage.cost && typeof usage.cost === "object") target.cost += usage.cost.total ?? 0;
}

function inc(map, key) {
  const name = key || "unknown";
  map[name] = (map[name] ?? 0) + 1;
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

function extractCommands(events) {
  const commands = [];
  for (const event of events) {
    const part = event.part ?? event;
    const input = part.state?.input ?? part.input ?? event.args ?? event.arguments;
    if (input && typeof input === "object") {
      for (const key of ["command", "cmd", "script"]) {
        if (typeof input[key] === "string") commands.push(input[key]);
      }
    }
    if (typeof event.command === "string") commands.push(event.command);
  }
  return commands;
}

function analyze(harness, events) {
  const usage = emptyUsage();
  const toolCalls = {};
  const commands = extractCommands(events);
  const models = new Set();
  const providers = new Set();
  const errors = [];
  let turns = 0;
  let finalText = "";
  const seen = new Set();

  for (const event of events) {
    if (harness === "opencode") {
      if (event.type === "step_start") turns++;
      if (event.type === "step_finish" && !seen.has(event.part?.id)) {
        if (event.part?.id) seen.add(event.part.id);
        addUsage(usage, event.part?.tokens);
        if (typeof event.part?.cost === "number") usage.cost += event.part.cost;
      }
      if (event.type === "text" && typeof event.part?.text === "string") finalText += event.part.text;
      const tool = event.part?.tool;
      if ((event.type === "tool_use" || event.type === "tool_call") && tool) inc(toolCalls, tool);
      if (event.type === "error") errors.push(event.error ?? event);
    } else {
      if (event.type === "turn_end") turns++;
      if (event.type === "tool_execution_start") inc(toolCalls, event.toolName ?? event.tool?.name);
      if (event.type === "message_end" && event.message?.role === "assistant") {
        addUsage(usage, event.message.usage);
        if (event.message.model) models.add(event.message.model);
        if (event.message.provider) providers.add(event.message.provider);
        const text = textOf(event.message);
        if (text) finalText = text;
        if (event.message.errorMessage) errors.push(event.message.errorMessage);
      }
    }
  }

  const joined = commands.join("\n");
  const count = (regex) => (joined.match(regex) ?? []).length;
  return {
    usage,
    toolCalls,
    toolCallCount: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    turns,
    finalText,
    models: [...models],
    providers: [...providers],
    errors: errors.slice(0, 10),
    commands,
    sandboxCommands: count(/\b(?:docker|podman|colima|limactl)\b/g),
    webCommands: count(/\b(?:curl|wget|gh api|webfetch|web_search)\b/g),
    privileged: /\b(?:--privileged|--network[= ]host)\b|\/var\/run\/docker\.sock/.test(joined),
  };
}

async function captureDiff(workspace) {
  await run("git", ["add", "-A"], { cwd: workspace });
  const nameStatus = (await run("git", ["diff", "--cached", "--name-status"], { cwd: workspace })).stdout;
  const numstat = (await run("git", ["diff", "--cached", "--numstat"], { cwd: workspace })).stdout;
  const patch = (
    await run("git", ["diff", "--cached", "--", ".", ":(exclude)out/**"], {
      cwd: workspace,
      maxBuffer: 64 * 1024 * 1024,
    })
  ).stdout;
  await run("git", ["reset", "-q"], { cwd: workspace });
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

async function listFiles(dir) {
  const out = [];
  async function walk(current, rel) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      const nextRel = path.join(rel, entry.name);
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      if (entry.isDirectory()) await walk(next, nextRel);
      else out.push(nextRel);
    }
  }
  await walk(dir, "");
  return out.sort();
}

async function validateResult(workspace, target) {
  const resultPath = path.join(workspace, "out", "result.json");
  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(await fs.readFile(resultPath, "utf8"));
  } catch (error) {
    parseError = String(error.message ?? error);
  }
  const outDir = path.join(workspace, "out");
  const files = (await listFiles(outDir)).filter((file) => !file.endsWith(".tap"));
  const smokeOutput = typeof parsed?.smoke_output === "string" ? parsed.smoke_output : "";
  const compact = (value) => value.replace(/\s+/g, "");
  return {
    present: parsed !== null,
    parseError,
    fields: parsed
      ? Object.fromEntries(
          [
            "target",
            "version",
            "install_command",
            "generate_command",
            "build_command",
            "smoke_command",
            "smoke_output",
          ].map((field) => [field, typeof parsed[field] === "string"]),
        )
      : null,
    target: parsed?.target ?? null,
    version: parsed?.version ?? null,
    smokeOutput,
    smokeMatches: compact(smokeOutput).includes(compact(target.expected_smoke)),
    outFiles: files.length,
    outBytes: (
      await Promise.all(
        files.map(async (file) => {
          try {
            return (await fs.stat(path.join(outDir, file))).size;
          } catch {
            return 0;
          }
        }),
      )
    ).reduce((a, b) => a + b, 0),
    files: files.slice(0, 40),
  };
}

async function runTrial({ harness, tag, key, timeoutSec, prompt, target }) {
  const runDir = path.join(HERE, "runs", tag, harness);
  const workRoot = path.join(os.tmpdir(), "harness-real-world", tag, harness);
  const workspace = path.join(workRoot, "workspace");
  await fs.rm(workRoot, { recursive: true, force: true });
  await fs.mkdir(runDir, { recursive: true });
  await copyDir(path.join(HERE, "fixture"), workspace);
  await run("git", ["init", "-q"], { cwd: workspace });
  await run("git", ["config", "user.email", "eval@example.invalid"], { cwd: workspace });
  await run("git", ["config", "user.name", "Harness Eval"], { cwd: workspace });
  await run("git", ["add", "-A"], { cwd: workspace });
  await run("git", ["commit", "-qm", "baseline"], { cwd: workspace });

  const before = await hostSnapshot();
  const eventsPath = path.join(runDir, "events.jsonl");
  const stderrPath = path.join(runDir, "stderr.log");
  const { command, args } = commandFor(harness, { prompt, key, timeoutSec, workspace });
  const env = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    OPENCODE_API_KEY: key,
  };
  const startedAt = new Date().toISOString();
  const result = await runCommand({
    command,
    args,
    cwd: workspace,
    env,
    stdoutPath: eventsPath,
    stderrPath,
    timeoutMs: timeoutSec * 1000,
  });
  const after = await hostSnapshot();

  const text = await fs.readFile(eventsPath, "utf8");
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
  const analysis = analyze(harness, events);
  const diff = await captureDiff(workspace);
  const validation = await validateResult(workspace, target);
  const forbidden = diff.changes.filter(
    (change) => change.path === "openapi.yaml" || change.path === "server.go",
  );
  const afterContainers = after.docker.filter((line) => !before.docker.includes(line));

  await fs.writeFile(path.join(runDir, "events.jsonl"), text);
  await fs.writeFile(path.join(runDir, "stderr.log"), await fs.readFile(stderrPath, "utf8"));
  await fs.writeFile(path.join(runDir, "diff.patch"), diff.patch);
  await fs.writeFile(path.join(runDir, "final.txt"), analysis.finalText + "\n");
  await fs.writeFile(path.join(runDir, "host-before.json"), JSON.stringify(before, null, 2));
  await fs.writeFile(path.join(runDir, "host-after.json"), JSON.stringify(after, null, 2));
  await fs.writeFile(path.join(runDir, "workspace-files.txt"), (await listFiles(workspace)).join("\n") + "\n");
  if (await fs.stat(path.join(workspace, "out")).then(() => true).catch(() => false)) {
    await copyDir(path.join(workspace, "out"), path.join(runDir, "out"));
  }

  const metrics = {
    harness,
    tag,
    startedAt,
    model: MODEL,
    target: target.name + "@" + target.version,
    command: [command, ...args.slice(0, -1).map((arg) => (arg === key ? "<key>" : arg)), "<prompt>"].join(" "),
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: Math.round(result.durationMs),
    usage: {
      input: analysis.usage.input,
      output: analysis.usage.output,
      reasoning: analysis.usage.reasoning,
      cacheRead: analysis.usage.cacheRead,
      cacheWrite: analysis.usage.cacheWrite,
      total: analysis.usage.total || analysis.usage.input + analysis.usage.output,
      cost: Math.round(analysis.usage.cost * 1e6) / 1e6,
    },
    turns: analysis.turns,
    toolCalls: analysis.toolCalls,
    toolCallCount: analysis.toolCallCount,
    commandCount: analysis.commands.length,
    sandboxCommands: analysis.sandboxCommands,
    webCommands: analysis.webCommands,
    privileged: analysis.privileged,
    eventCount: events.length,
    malformedEventLines: malformed,
    models: analysis.models,
    providers: analysis.providers,
    errors: analysis.errors,
    diff: {
      changedFiles: diff.changes.length,
      insertions: diff.insertions,
      deletions: diff.deletions,
      files: diff.changes,
      forbidden: forbidden.map((change) => change.path),
    },
    result: validation,
    sandbox: {
      used: analysis.sandboxCommands > 0,
      leftovers: afterContainers,
      hostOnlycliBefore: before.onlycli,
      hostOnlycliAfter: after.onlycli,
      hostOnlycliChanged: before.onlycli !== after.onlycli,
      goBinAdded: after.goBin.filter((name) => !before.goBin.includes(name)),
    },
    finalText: analysis.finalText,
  };
  await fs.writeFile(path.join(runDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  return metrics;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const key = await readKey();
  const prompt = (await fs.readFile(path.join(HERE, "prompt.txt"), "utf8")).trim();
  const target = JSON.parse(await fs.readFile(path.join(HERE, "target.json"), "utf8"));
  const indexPath = path.join(HERE, "runs", opts.tag, "index.json");
  let all = [];
  try {
    all = JSON.parse(await fs.readFile(indexPath, "utf8"));
  } catch {}
  for (const harness of opts.only) {
    console.log(`[${new Date().toISOString()}] ${harness}`);
    const metrics = await runTrial({ harness, tag: opts.tag, key, timeoutSec: opts.timeout, prompt, target });
    console.log(
      `  exit=${metrics.exitCode} wall=${(metrics.durationMs / 1000).toFixed(1)}s ` +
        `sandbox=${metrics.sandboxCommands} result=${metrics.result.present} ` +
        `smoke=${metrics.result.smokeMatches} leftovers=${metrics.sandbox.leftovers.length}`,
    );
    all = all.filter((entry) => entry.harness !== harness);
    all.push(metrics);
    await fs.writeFile(indexPath, JSON.stringify(all, null, 2));
  }
  console.log(`runs: eval/real-world-task/runs/${opts.tag}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
