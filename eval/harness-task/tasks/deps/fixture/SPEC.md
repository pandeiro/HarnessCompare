# Dependency planner

`buildPlan(tasks)` converts a list of tasks with dependencies into execution
waves. It returns:

```js
{
  waves: string[][], // wave 0 first; each wave is sorted by id
  order: string[],   // waves flattened
}
```

## Input

`tasks` is an array of objects:

```js
{ id: string, deps?: string[] }
```

- `id` must be a non-empty string and unique across the array.
- `deps` is optional. When present it must be an array of non-empty strings.
- Duplicate dependency names in one task are allowed and are treated as one
  dependency.
- Extra properties are ignored.

## Planning

- Wave 0 contains every task with no dependencies.
- Wave `n` contains every task whose dependencies all appear in earlier waves.
- Ids within a wave are sorted ascending using JavaScript string comparison
  (UTF-16 code units).
- `order` is the concatenation of the waves.
- Every valid task appears exactly once.
- `buildPlan([])` returns `{ waves: [], order: [] }`.

## Errors

All validation and planning failures throw `PlanError`:

```js
class PlanError extends Error {
  name = "PlanError";
  code: string;
  // additional fields listed below
}
```

| Code | Condition | Extra fields |
| --- | --- | --- |
| `INVALID_TASKS` | `tasks` is not an array | — |
| `INVALID_TASK` | A task is not a plain object with a non-empty string `id` | `index` |
| `DUPLICATE_ID` | Two tasks share an `id` | `id` |
| `INVALID_DEPS` | `deps` is present but not an array of non-empty strings | `id` |
| `UNKNOWN_DEP` | A dependency names an unknown task | `id`, `dependency` |
| `CYCLE` | The graph cannot be fully ordered | `cycle` |

For `CYCLE`, `cycle` is the sorted list of every task that could not be placed,
including tasks that depend on a cycle.

## Examples

```js
buildPlan([
  { id: "c", deps: ["b"] },
  { id: "b", deps: ["a"] },
  { id: "a" },
]);
// { waves: [["a"], ["b"], ["c"]], order: ["a", "b", "c"] }
```

```js
buildPlan([
  { id: "base" },
  { id: "right", deps: ["base"] },
  { id: "left", deps: ["base"] },
  { id: "top", deps: ["left", "right"] },
]);
// { waves: [["base"], ["left", "right"], ["top"]], order: ["base", "left", "right", "top"] }
```

```js
buildPlan([{ id: "a" }, { id: "b", deps: ["missing"] }]);
// throws PlanError with code "UNKNOWN_DEP"
```
