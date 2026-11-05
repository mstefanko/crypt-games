import {
  kartAngle,
  queryKartTrack,
  trackPointAt,
  type KartTrack,
} from "./kart-track";
import { type KartBody, type KartControl } from "./kart-motion";
export interface RacerProgress {
  id: string;
  lap: number;
  nextGate: number;
  checkpoint: number;
  finishTime: number | null;
  dnf?: boolean;
  splits: number[];
  lapStarted: number;
  score: number;
}
export function createRacerProgress(id: string): RacerProgress {
  return {
    id,
    lap: 0,
    nextGate: 1,
    checkpoint: 0,
    finishTime: null,
    splits: [],
    lapStarted: 0,
    score: 0,
  };
}
export function stepRaceProgress(
  track: KartTrack,
  p: RacerProgress,
  previous: { x: number; y: number },
  kart: KartBody,
  time: number,
  laps = 3,
): boolean {
  if (p.finishTime !== null || p.dnf) return false;
  const gate = track.gates[p.nextGate]!,
    a = track.points[gate]!,
    b = track.points[(gate + 1) % track.points.length]!,
    len = track.lengths[gate]!,
    nx = (b.x - a.x) / len,
    ny = (b.y - a.y) / len;
  const before = (previous.x - a.x) * nx + (previous.y - a.y) * ny,
    after = (kart.x - a.x) * nx + (kart.y - a.y) * ny;
  let crossed = false;
  if (before <= 0 && after > 0) {
    const t = -before / (after - before),
      x = previous.x + (kart.x - previous.x) * t,
      y = previous.y + (kart.y - previous.y) * t;
    if (Math.abs((x - a.x) * -ny + (y - a.y) * nx) < a.width / 2 + 9) {
      p.checkpoint = gate;
      p.nextGate = (p.nextGate + 1) % track.gates.length;
      crossed = true;
      if (gate === 0) {
        p.lap++;
        p.splits.push(time - p.lapStarted);
        p.lapStarted = time;
        if (p.lap >= laps) p.finishTime = time;
      }
    }
  }
  const q = queryKartTrack(track, kart.x, kart.y, kart.segment),
    last = track.cumulative[p.checkpoint]!,
    end = track.cumulative[track.gates[p.nextGate]!]!,
    span = (end - last + track.length) % track.length,
    local = (q.progress - last + track.length) % track.length;
  p.score =
    p.lap * track.length +
    (p.checkpoint === 0 ? 0 : last) +
    Math.min(span, local > track.length / 2 ? 0 : local);
  return crossed;
}
export function rankRacers(progress: RacerProgress[]): RacerProgress[] {
  return [...progress].sort((a, b) =>
    a.finishTime !== null && b.finishTime !== null
      ? a.finishTime - b.finishTime
      : a.finishTime !== null
        ? -1
        : b.finishTime !== null
          ? 1
          : b.score - a.score || a.id.localeCompare(b.id),
  );
}
export function resetKartToCheckpoint(
  track: KartTrack,
  k: KartBody,
  p: RacerProgress,
): void {
  const gate = track.points[p.checkpoint]!,
    next = track.points[(p.checkpoint + 1) % track.points.length]!;
  k.x = gate.x;
  k.y = gate.y;
  k.heading = Math.atan2(next.y - gate.y, next.x - gate.x);
  k.vx = 0;
  k.vy = 0;
  k.spin = 0;
  k.boost = 0;
  k.z = 0;
  k.vz = 0;
  k.charge = 0;
  k.drift = 0;
  k.segment = p.checkpoint;
  k.immune = 2;
  k.stuck = 0;
}
export function racingLineControl(
  track: KartTrack,
  k: KartBody,
  others: readonly KartBody[],
  raceGap: number,
  hazards: readonly { x: number; y: number }[] = [],
): KartControl {
  const q = queryKartTrack(track, k.x, k.y, k.segment),
    near = trackPointAt(track, q.progress + Math.max(35, k.speed * 0.55)),
    far = trackPointAt(track, q.progress + 320),
    bend = kartAngle(far.heading - q.heading);
  let offset = Math.sin(Number(k.id.replace(/\D/g, "")) * 2.1) * 14;
  for (const other of others)
    if (other !== k && Math.hypot(other.x - k.x, other.y - k.y) < 45)
      offset += (q.signedDistance >= 0 ? 1 : -1) * 15;
  for (const hazard of hazards) {
    const dx = hazard.x - k.x,
      dy = hazard.y - k.y,
      ahead = dx * Math.cos(k.heading) + dy * Math.sin(k.heading),
      side = -dx * Math.sin(k.heading) + dy * Math.cos(k.heading);
    if (ahead > 0 && ahead < 110 && Math.abs(side) < 30)
      offset += (side > 0 ? -1 : 1) * 28;
  }
  offset = Math.max(-30, Math.min(30, offset));
  const tx = near.x - Math.sin(near.heading) * offset,
    ty = near.y + Math.cos(near.heading) * offset,
    error = kartAngle(Math.atan2(ty - k.y, tx - k.x) - k.heading);
  const target =
    100 -
    Math.min(50, Math.abs(bend) * 40) +
    Math.max(-5, Math.min(7, raceGap * 0.006));
  const drift =
    Math.abs(bend) > 0.2 &&
    Math.abs(bend) < 1.1 &&
    k.speed > 55 &&
    k.charge < 1.9;
  return {
    throttle: k.speed < target ? 1 : 0.15,
    brake: k.speed > target + 10 ? 0.55 : 0,
    steer: Math.max(
      -1,
      Math.min(1, error * 2.5 - (k.drift ? k.drift * 0.25 : 0)),
    ),
    drift,
  };
}
