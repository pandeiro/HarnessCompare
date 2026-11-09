import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, PlanError } from "../src/plan.js";

const code = (fn, expected) =>
  assert.throws(fn, (error) => error instanceof PlanError && error.code === expected);

test("hidden: empty task list", () => {
  assert.deepEqual(buildPlan([]), { waves: [], order: [] });
});

test("hidden: single independent task", () => {
  assert.deepEqual(buildPlan([{ id: "only" }]), { waves: [["only"]], order: ["only"] });
});

test("hidden: long chain", () => {
  const tasks = [{ id: "d", deps: ["c"] }, { id: "c", deps: ["b"] }, { id: "b", deps: ["a"] }, { id: "a" }];
  assert.deepEqual(buildPlan(tasks).waves, [["a"], ["b"], ["c"], ["d"]]);
});

test("hidden: wave membership on a mixed graph", () => {
  const plan = buildPlan([
    { id: "deploy", deps: ["test", "build"] },
    { id: "test", deps: ["compile"] },
    { id: "lint" },
    { id: "build", deps: ["compile"] },
    { id: "compile" },
  ]);
  assert.deepEqual(plan, {
    waves: [["compile", "lint"], ["build", "test"], ["deploy"]],
    order: ["compile", "lint", "build", "test", "deploy"],
  });
});

test("hidden: ids sort by code unit, not locale", () => {
  assert.deepEqual(buildPlan([{ id: "a" }, { id: "Z" }, { id: "B" }]).waves, [["B", "Z", "a"]]);
});

test("hidden: duplicate ids report the id", () => {
  assert.throws(
    () => buildPlan([{ id: "a" }, { id: "b" }, { id: "a" }]),
    (error) => error instanceof PlanError && error.code === "DUPLICATE_ID" && error.id === "a",
  );
});

test("hidden: unknown dependency reports task and dependency", () => {
  assert.throws(
    () => buildPlan([{ id: "b", deps: ["missing"] }]),
    (error) =>
      error instanceof PlanError &&
      error.code === "UNKNOWN_DEP" &&
      error.id === "b" &&
      error.dependency === "missing",
  );
});

test("hidden: self dependency is a cycle", () => {
  assert.throws(
    () => buildPlan([{ id: "a", deps: ["a"] }]),
    (error) => error instanceof PlanError && error.code === "CYCLE" && error.cycle.join(",") === "a",
  );
});

test("hidden: cycle includes blocked dependents", () => {
  assert.throws(
    () =>
      buildPlan([
        { id: "a", deps: ["b"] },
        { id: "b", deps: ["a"] },
        { id: "c", deps: ["a"] },
        { id: "free" },
      ]),
    (error) => error instanceof PlanError && error.code === "CYCLE" && error.cycle.join(",") === "a,b,c",
  );
});

test("hidden: duplicate dependency names are deduped", () => {
  assert.deepEqual(buildPlan([{ id: "a" }, { id: "b", deps: ["a", "a", "a"] }]), {
    waves: [["a"], ["b"]],
    order: ["a", "b"],
  });
});

test("hidden: missing deps property means no dependencies", () => {
  assert.deepEqual(buildPlan([{ id: "b" }, { id: "a" }]).waves, [["a", "b"]]);
});

test("hidden: invalid tasks", () => {
  code(() => buildPlan("nope"), "INVALID_TASKS");
  code(() => buildPlan([null]), "INVALID_TASK");
  code(() => buildPlan([{}]), "INVALID_TASK");
  code(() => buildPlan([{ id: "" }]), "INVALID_TASK");
  code(() => buildPlan([[]]), "INVALID_TASK");
});

test("hidden: invalid deps", () => {
  code(() => buildPlan([{ id: "a", deps: null }]), "INVALID_DEPS");
  code(() => buildPlan([{ id: "a", deps: "b" }]), "INVALID_DEPS");
  code(() => buildPlan([{ id: "a", deps: [1] }]), "INVALID_DEPS");
  code(() => buildPlan([{ id: "a", deps: [""] }]), "INVALID_DEPS");
});

test("hidden: no mutation of the input", () => {
  const tasks = [
    { id: "b", deps: ["a"] },
    { id: "a" },
  ];
  buildPlan(tasks);
  assert.deepEqual(tasks, [
    { id: "b", deps: ["a"] },
    { id: "a" },
  ]);
});

test("hidden: complex graph is complete and consistent", () => {
  const tasks = [
    { id: "app", deps: ["lib", "ui"] },
    { id: "ui", deps: ["lib", "styles"] },
    { id: "lib", deps: ["core"] },
    { id: "core" },
    { id: "styles" },
    { id: "docs" },
  ];
  const plan = buildPlan(tasks);
  assert.deepEqual(plan.waves, [["core", "docs", "styles"], ["lib"], ["ui"], ["app"]]);
  assert.equal(plan.order.length, tasks.length);
  assert.equal(new Set(plan.order).size, tasks.length);
});
