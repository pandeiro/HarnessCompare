export class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PlanError";
    this.code = code;
  }
}

export function buildPlan(tasks) {
  const waves = [];
  let remaining = tasks.slice();

  while (remaining.length > 0) {
    const done = new Set(waves.flat());
    const wave = remaining.filter((task) => (task.deps ?? []).every((dep) => done.has(dep)));
    if (wave.length === 0) break;
    waves.push(wave.map((task) => task.id));
    remaining = remaining.filter((task) => !wave.includes(task));
  }

  return { waves, order: waves.flat() };
}
