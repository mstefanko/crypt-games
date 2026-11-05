/** Single consumer: bounded arena wave authoring. Costs stay on enemy definitions. */
export function allocateEncounterWaves(
  roles: readonly { id: string; cost: number }[],
  budgets: readonly number[],
  seed: number,
): string[][] {
  let cursor = seed >>> 0 || 1;
  return budgets.map((budget) => {
    const wave: string[] = [];
    let remaining = Math.max(0, Math.floor(budget));
    while (remaining > 0 && wave.length < 12) {
      const choices = roles.filter((r) => r.cost > 0 && r.cost <= remaining);
      if (!choices.length) break;
      cursor = (Math.imul(cursor, 1664525) + 1013904223) >>> 0;
      const role = choices[cursor % choices.length]!;
      wave.push(role.id);
      remaining -= role.cost;
    }
    return wave;
  });
}
