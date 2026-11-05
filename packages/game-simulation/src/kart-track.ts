/** Closed flat circuits in world units. Queries stay local to the previous segment. */
export interface TrackPoint {
  x: number;
  y: number;
  width: number;
  surface: "road" | "ramp";
}
export interface KartTrack {
  points: TrackPoint[];
  lengths: number[];
  cumulative: number[];
  length: number;
  gates: number[];
  seed: number;
  variant: string;
}
export interface TrackQuery {
  segment: number;
  t: number;
  x: number;
  y: number;
  distance: number;
  signedDistance: number;
  heading: number;
  progress: number;
  width: number;
  surface: "road" | "ramp";
}
export function createKartTrack(seed: number): KartTrack {
  const mirror = seed & 1 ? -1 : 1,
    variant = (seed >>> 1) % 3;
  // Radial authored sector combinations cannot cross: every sector advances its polar angle.
  const radii =
    variant === 0
      ? [520, 480, 560, 440, 540, 480, 500, 410]
      : variant === 1
        ? [490, 560, 450, 520, 470, 550, 430, 500]
        : [540, 440, 500, 560, 430, 500, 560, 450];
  const anchors = radii.map((r, i) => ({
    x: 2000 + mirror * Math.cos((i * Math.PI) / 4) * r * 2.5,
    y: 2000 + Math.sin((i * Math.PI) / 4) * r * 2.5,
  }));
  const points: TrackPoint[] = [];
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 10; j++) {
      const a = anchors[(i + 7) % 8]!,
        b = anchors[i]!,
        c = anchors[(i + 1) % 8]!,
        d = anchors[(i + 2) % 8]!,
        t = j / 10;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b +
          (-a + c) * t +
          (2 * a - 5 * b + 4 * c - d) * t * t +
          (-a + 3 * b - 3 * c + d) * t * t * t);
      points.push({
        x: f(a.x, b.x, c.x, d.x),
        y: f(a.y, b.y, c.y, d.y),
        width: 108 + (i === 3 ? 22 : 0),
        surface: i === 5 && j >= 3 && j <= 5 ? "ramp" : "road",
      });
    }
  if (mirror < 0) points.reverse();
  // Reject non-adjacent intersections and curvature below a road-width turning radius.
  const cross = (a: TrackPoint, b: TrackPoint, c: TrackPoint) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let safe = true;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!,
      b = points[(i + 1) % points.length]!,
      c = points[(i + 2) % points.length]!;
    const angle = Math.abs(
      kartAngle(
        Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x),
      ),
    );
    if (angle > 0 && Math.hypot(b.x - a.x, b.y - a.y) / angle < 90)
      safe = false;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const c = points[j]!,
        d = points[(j + 1) % points.length]!;
      if (
        cross(a, b, c) * cross(a, b, d) < 0 &&
        cross(c, d, a) * cross(c, d, b) < 0
      )
        safe = false;
    }
  }
  if (!safe)
    points.splice(
      0,
      points.length,
      ...Array.from({ length: 80 }, (_, i) => ({
        x: 2000 + 1250 * Math.cos((i * Math.PI) / 40),
        y: 2000 + 1250 * Math.sin((i * Math.PI) / 40),
        width: 108,
        surface: "road" as const,
      })),
    );
  const lengths = points.map((p, i) =>
    Math.hypot(
      points[(i + 1) % points.length]!.x - p.x,
      points[(i + 1) % points.length]!.y - p.y,
    ),
  );
  let length = 0;
  const cumulative = lengths.map((l) => {
    const v = length;
    length += l;
    return v;
  });
  return {
    points,
    lengths,
    cumulative,
    length,
    gates: [0, 10, 20, 30, 40, 50, 60, 70],
    seed,
    variant: safe
      ? ["Moon market", "Willow sweep", "Firefly gardens"][variant]!
      : "Festival fallback",
  };
}
export function queryKartTrack(
  track: KartTrack,
  x: number,
  y: number,
  previous?: number,
): TrackQuery {
  const n = track.points.length;
  let best: TrackQuery | undefined;
  const indices =
    previous === undefined
      ? Array.from({ length: n }, (_, i) => i)
      : Array.from({ length: 13 }, (_, i) => (previous + i - 6 + n) % n);
  for (const i of indices) {
    const a = track.points[i]!,
      b = track.points[(i + 1) % n]!,
      dx = b.x - a.x,
      dy = b.y - a.y,
      l = track.lengths[i]!,
      t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (l * l))),
      px = a.x + dx * t,
      py = a.y + dy * t,
      d = Math.hypot(x - px, y - py);
    if (!best || d < best.distance)
      best = {
        segment: i,
        t,
        x: px,
        y: py,
        distance: d,
        signedDistance: ((x - px) * -dy + (y - py) * dx) / l,
        heading: Math.atan2(dy, dx),
        progress: track.cumulative[i]! + l * t,
        width: a.width,
        surface: a.surface,
      };
  }
  return best!;
}
export function trackPointAt(track: KartTrack, progress: number): TrackQuery {
  const p = ((progress % track.length) + track.length) % track.length;
  let i = 0;
  while (i < track.points.length - 1 && track.cumulative[i + 1]! < p) i++;
  const a = track.points[i]!,
    b = track.points[(i + 1) % track.points.length]!,
    t = (p - track.cumulative[i]!) / track.lengths[i]!;
  return queryKartTrack(track, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, i);
}
export function kartAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
