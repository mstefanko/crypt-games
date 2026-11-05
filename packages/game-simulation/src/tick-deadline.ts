/**
 * Inclusive scalar deadlines in owner-defined integer ticks. Public operations reject
 * negative/unsafe ticks and overflow. null means cancelled (never ready, zero remaining).
 * Owners choose their check phase: zero delay is ready at their next check, including
 * the current tick if checked after arming. secondsToTicks uses ceiling (at least the
 * authored duration, within the documented floating arithmetic tolerance below).
 * No wall clock, callbacks, queue, or owner/game policy is retained.
 * Deadlines belong in the owner's checkpoint; snapshots need no helper-owned state.
 * Work and storage are O(1). Defense (60 Hz) and combat ability updates consume this API.
 */
export type TickDeadline = number | null;
export function validateTick(tick: number): number {
  if (!Number.isSafeInteger(tick) || tick < 0)
    throw new Error("Tick must be a nonnegative safe integer");
  return tick;
}
export function armDeadline(now: number, delayTicks: number): number {
  validateTick(now);
  validateTick(delayTicks);
  return validateTick(now + delayTicks);
}
export function cancelDeadline(): null {
  return null;
}
export function deadlineReady(now: number, deadline: TickDeadline): boolean {
  validateTick(now);
  return deadline !== null && now >= validateTick(deadline);
}
export function remainingTicks(now: number, deadline: TickDeadline): number {
  validateTick(now);
  return deadline === null ? 0 : Math.max(0, validateTick(deadline) - now);
}
/** Ceiling conversion with an arithmetic-error boundary tolerance of two relative
 * machine epsilons in the product, capped at 1e-7 tick so large durations cannot
 * round away meaningful fractional ticks. A positive integer boundary within that range
 * is treated as exact (e.g. authored 4.15 seconds at 60 Hz is 249, not 250).
 * The tolerance covers representation plus multiplication rounding; genuinely
 * fractional values beyond it still ceil. Positive durations never round to zero.
 * Raw product overflow rejects before any boundary adjustment. */
export function secondsToTicks(
  seconds: number,
  ticksPerSecond: number,
): number {
  if (
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !Number.isSafeInteger(ticksPerSecond) ||
    ticksPerSecond < 1
  )
    throw new Error("Invalid duration or tick rate");
  const product = seconds * ticksPerSecond;
  if (!Number.isFinite(product) || product > Number.MAX_SAFE_INTEGER)
    throw new Error("Duration exceeds safe tick range");
  const nearest = Math.round(product);
  const tolerance = Math.min(
    1e-7,
    2 * Number.EPSILON * Math.max(1, Math.abs(product)),
  );
  const adjusted =
    nearest >= 1 && Math.abs(product - nearest) <= tolerance
      ? nearest
      : product;
  return validateTick(Math.ceil(adjusted));
}
