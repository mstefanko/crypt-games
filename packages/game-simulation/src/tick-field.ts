export interface TickField {
  period: number;
  phase: number;
  direction: 1 | -1;
  speed: number;
}
/** Pure tick-driven moving weather front. Coordinates and width share world units. */
export function sampleTickField(
  field: TickField,
  tick: number,
  x: number,
  y: number,
  exposure = 1,
): number {
  if (
    ![field.period, field.phase, field.speed, tick, x, y, exposure].every(
      Number.isFinite,
    ) ||
    field.period <= 0 ||
    field.speed < 0
  )
    throw Error("Invalid field");
  const cycle =
    (((tick * field.speed + field.phase + field.direction * (x + y * 0.3)) %
      field.period) +
      field.period) %
    field.period;
  return (
    Math.max(0, Math.min(1, exposure)) *
    (0.5 + 0.5 * Math.cos((cycle / field.period) * Math.PI * 2))
  );
}
