import test from "node:test";
import assert from "node:assert/strict";
import { buildPlan, PlanError } from "../src/plan.js";

test("builds a chain", () => {
  assert.deepEqual(
    buildPlan([
      { id: "c", deps: ["b"] },
      { id: "b", deps: ["a"] },
      { id: "a" },
    ]),
    { waves: [["a"], ["b"], ["c"]], order: ["a", "b", "c"] },
  );
});

test("groups a diamond into waves", () => {
  assert.deepEqual(
    buildPlan([
      { id: "base" },
      { id: "right", deps: ["base"] },
      { id: "left", deps: ["base"] },
      { id: "top", deps: ["left", "right"] },
    ]),
    { waves: [["base"], ["left", "right"], ["top"]], order: ["base", "left", "right", "top"] },
  );
});

test("sorts ids inside a wave", () => {
  assert.deepEqual(buildPlan([{ id: "zed" }, { id: "alpha" }, { id: "mike" }]), {
    waves: [["alpha", "mike", "zed"]],
    order: ["alpha", "mike", "zed"],
  });
});

test("rejects duplicate ids", () => {
  assert.throws(
    () => buildPlan([{ id: "a" }, { id: "a" }]),
    (error) => error instanceof PlanError && error.code === "DUPLICATE_ID",
  );
});

test("rejects cycles", () => {
  assert.throws(
    () =>
      buildPlan([
        { id: "a", deps: ["b"] },
        { id: "b", deps: ["a"] },
      ]),
    (error) => error instanceof PlanError && error.code === "CYCLE",
  );
});
