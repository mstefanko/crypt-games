/** Bounded authoring policy for a horizontal ferry over a safe static recovery
 * floor. Every tick is an ordinary selected production frame. A blocked history
 * is rejected rather than assigned the phase of an ideal unblocked oscillator. */
import { integer } from "@onepage/game-project/runtime";
import type { Platform } from "@onepage/game-project/runtime";
import { CampaignPlatformOwner } from "./campaign-platform";
import type { PlatformActionV2 } from "./platform-input-v2";

export interface PlatformWaitPhases {
  periodTicks: number;
  strideTicks: number;
  phaseCount: number;
  phases: number[];
}
/** Endpoints snap on the last step. Consequently P is 2*ceil(D/speed),
 * including when speed does not divide the distance. Sampling by g visits
 * exactly P/gcd(P,g) distinct phases. This assumes no blocked ticks. */
export function enumeratePlatformWaitPhases(
  distance: number,
  speed: number,
  strideTicks = 1,
): PlatformWaitPhases {
  integer(distance, 1, 16777216);
  integer(speed, 1, 8192);
  integer(strideTicks, 1, 1800);
  const periodTicks = 2 * Math.ceil(distance / speed);
  if (periodTicks > 1800) throw Error("Timed platform phase budget exceeded");
  let a = periodTicks,
    b = strideTicks;
  while (b) [a, b] = [b, a % b];
  const phaseCount = periodTicks / a;
  return {
    periodTicks,
    strideTicks,
    phaseCount,
    phases: Array.from(
      { length: phaseCount },
      (_, i) => (i * strideTicks) % periodTicks,
    ),
  };
}
export interface TimedFerryEvidence {
  entryPolicy: "canonical-anchor-with-bounded-neutral-wait";
  blockedHistories: "rejected";
  periodTicks: number;
  sampledPhaseCount: number;
  waitTicks: number;
  boardTick: number;
  rideTicks: number;
  dismountTick: number;
  totalTicks: number;
}
export type TimedFerryFrame = (
  axis?: number,
  actions?: PlatformActionV2[],
) => void;
/** Record the west-to-east ferry motif. The callback must execute exactly one
 * owner frame, and may additionally record it and charge its shared work budget.
 * No actor or platform state is patched. This records one canonical entry
 * witness; phaseCount describes the finite wait domain, not a proof of every
 * possible uncontrolled arrival or blocked history. */
export function recordTimedFerryTraversal(
  owner: CampaignPlatformOwner,
  frame: TimedFerryFrame,
  platform: Pick<Platform, "id" | "x" | "endX" | "speed" | "width" | "y">,
  options: { maxTicks?: number; waitStride?: number } = {},
): TimedFerryEvidence {
  const schedule = enumeratePlatformWaitPhases(
    Math.abs(platform.endX - platform.x),
    platform.speed,
    options.waitStride ?? 1,
  );
  const maxTicks = integer(options.maxTicks ?? 1800, 1, 1800);
  if (platform.endX <= platform.x)
    throw Error("Timed ferry requires west-to-east path");
  const initial = owner.observation();
  const roomId = initial.roomId;
  if (initial.anchorId !== "west")
    throw Error("Timed ferry requires canonical west ingress");
  let ticks = 0,
    waitTicks = 0,
    boardTick = -1,
    rideTicks = 0;
  const actor = () =>
    owner.observation().platform.actors.find((a) => a.slot === 0)!;
  const ferry = () => {
    const o = owner.observation();
    if (o.roomId !== roomId || o.platform.status !== "playing")
      throw Error("Timed ferry left playable source room");
    const p = o.platform.platforms.find((p) => p.id === platform.id);
    if (!p || p.blocked)
      throw Error("Timed ferry blocked history is unsupported");
    return p;
  };
  const center = () => {
    const a = actor();
    return a.x + a.width / 2;
  };
  const supported = () =>
    actor().platformMotion?.supportId === `platform:${platform.id}`;
  function emit(axis = 0, actions: PlatformActionV2[] = []) {
    ferry();
    if (++ticks > maxTicks) throw Error("Timed ferry no witness within budget");
    const before = owner.observation().platform.tick;
    frame(axis, actions);
    if (owner.observation().platform.tick !== before + 1)
      throw Error("Timed ferry callback must execute one frame");
    ferry();
  }
  // Recovery floor approach, with a visible stationary waiting area left of the
  // full moving-platform path. This floor is also the failure recovery route.
  const waitingX = platform.x - 16 * 256;
  if (
    center() > platform.x ||
    !actor().grounded ||
    actor().platformMotion === undefined
  )
    throw Error("Timed ferry entry pose is outside supported ingress");
  while (Math.abs(center() - waitingX) > 2 * 256)
    emit(center() < waitingX ? 127 : -127);
  emit();
  // Wait at most one complete oscillator cycle, sampling the requested stride.
  // Launch near its left turn so ordinary horizontal steering can board it.
  for (;;) {
    const p = ferry();
    if (p.direction === -1 && p.x <= platform.x + 24 * 256) break;
    for (let n = 0; n < schedule.strideTicks; n++) {
      emit();
      waitTicks++;
    }
  }
  emit(127, ["jump"]);
  while (!supported()) {
    const target = ferry().x + platform.width / 2,
      delta = target - center();
    emit(Math.abs(delta) <= 2 * 256 ? 0 : delta > 0 ? 127 : -127);
    if (actor().grounded && !supported())
      throw Error("Timed ferry boarding failed");
  }
  boardTick = ticks;
  // Neutral production input carries the rider; no inherited velocity or
  // coordinate injection is used. Detect the endpoint from actual state.
  while (ferry().x !== platform.endX) {
    if (!supported()) throw Error("Timed ferry lost support while riding");
    emit();
    rideTicks++;
  }
  emit(127, ["jump"]);
  const safeX = platform.endX + platform.width + 12 * 256;
  while (!actor().grounded || supported() || center() < safeX) emit(127);
  emit();
  return {
    entryPolicy: "canonical-anchor-with-bounded-neutral-wait",
    blockedHistories: "rejected",
    periodTicks: schedule.periodTicks,
    sampledPhaseCount: schedule.phaseCount,
    waitTicks,
    boardTick,
    rideTicks,
    dismountTick: ticks,
    totalTicks: ticks,
  };
}
