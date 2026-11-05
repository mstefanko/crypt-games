import { createKartTrack, trackPointAt } from "./kart-track";
import {
  createKartBody,
  stepKartBody,
  collideKarts,
  KART_PROFILES,
  type KartBody,
} from "./kart-motion";
import {
  createRacerProgress,
  stepRaceProgress,
  rankRacers,
  racingLineControl,
  resetKartToCheckpoint,
  type RacerProgress,
} from "./kart-race";
import { KartItemOwner } from "./kart-items";
import {
  canonicalJson,
  type OrderedSessionEvent,
  type SessionProtocolDescriptor,
} from "./session-protocol";
export interface KartRaceEvent extends OrderedSessionEvent {}
type DeepReadonlyRace<T> = T extends object
  ? { readonly [K in keyof T]: DeepReadonlyRace<T[K]> }
  : T;
export interface KartRaceInput {
  kind: "drive";
  throttle: boolean;
  brake: boolean;
  steer: number;
  drift: boolean;
  useItem?: boolean;
  rescue?: boolean;
  retry?: boolean;
  profile?: number;
}
export const kartRaceProtocol = {
  protocolVersion: 1,
  owner: "createKartRaceSession",
  observationSchema: "KartRaceObservation@1",
  snapshot: {
    kind: "kart-race",
    version: 1,
    contentId: "lantern-rally-v1",
    rulesBuildId: "kart-race-r3-v1",
  },
  commands: {
    drive: {
      throttle: "boolean",
      brake: "boolean",
      steer: "-1 | 0 | 1",
      drift: "boolean",
      useItem: "optional boolean",
      rescue: "optional boolean",
      retry: "optional boolean",
      profile: "optional 0 | 1 | 2",
    },
  },
  semantics: {
    commandResult:
      "boolean false rejects malformed drive frames without mutation; last accepted frame replaces pending controls",
    metadata:
      "No sequence/revision cursor; command duplication repeats held controls, edges are consumed once per explicit step",
    step: "Finite nonnegative seconds <= 0.05. One explicit host step; no implicit clock or RNG outside item owner",
    events:
      "Single destructive drain in emission order. Snapshot preserves pending events. Retry resets tick and event sequence; reset consumer branch cursors",
    restore:
      "Validate detached candidates and staged item/projectile owner before adoption. Same seed/content/rules identity; restores held input and pending edges",
  },
} as const satisfies SessionProtocolDescriptor;
const ITEM_LABEL = {
  boost: "BOOST BOTTLE",
  oil: "OIL PUDDLE",
  firework: "FIREWORK",
  lantern: "HOMING LANTERN",
};
// Bounded finish-only visual coasting. |x| <= .1; twelve terms differ from exp by < 1e-15.
export function finishDecay(dt: number): number {
  let sum = 1,
    term = 1;
  for (let i = 1; i <= 12; i++) {
    term *= (-2 * dt) / i;
    sum += term;
  }
  return sum;
}
/** Private game policy composing existing track/motion/item mechanisms. */
export function createKartRaceSession(seed: number) {
  if (!Number.isSafeInteger(seed)) throw Error("Invalid kart race seed");
  const track = createKartTrack(seed);
  let pending: KartRaceInput = {
    kind: "drive",
    throttle: false,
    brake: false,
    steer: 0,
    drift: false,
  };
  let karts: KartBody[] = [],
    progress: RacerProgress[] = [],
    items = new KartItemOwner(track, seed),
    time = 0,
    countdown = 4,
    phase: "grid" | "race" | "finish" = "grid",
    tick = 0,
    sequence = 0,
    events: KartRaceEvent[] = [],
    profile = 0,
    notice = "Choose a cart: 1 · 2 · 3",
    noticeTime = 5,
    lastPlace = 1,
    placeCooldown = 0,
    lastWarning = 0,
    aiTimers = [0, 4, 5, 6, 7, 8];
  function emit(kind: string, sourceId = "kart-0") {
    events.push({ sequence: ++sequence, tick, sourceId, kind });
  }
  function reset() {
    karts = Array.from({ length: 6 }, (_, i) => {
      const q = trackPointAt(track, -12 - Math.floor(i / 2) * 24),
        offset = (i % 2 ? 1 : -1) * 19;
      const start = track.points[q.segment]!,
        end = track.points[(q.segment + 1) % track.points.length]!,
        length = track.lengths[q.segment]!;
      const k = createKartBody(
        `kart-${i}`,
        q.x - ((end.y - start.y) / length) * offset,
        q.y + ((end.x - start.x) / length) * offset,
        q.heading,
        i === 0 ? profile : i % 3,
      );
      k.segment = q.segment;
      return k;
    });
    progress = karts.map((k) => createRacerProgress(k.id));
    items = new KartItemOwner(track, seed);
    time = 0;
    countdown = 4;
    phase = "grid";
    events = [];
    tick = 0;
    sequence = 0;
    lastPlace = 1;
    placeCooldown = 0;
    lastWarning = 0;
    aiTimers = [0, 4, 5, 6, 7, 8];
  }
  reset();
  function player() {
    return karts[0]!;
  }
  function ranked() {
    return rankRacers(progress);
  }
  function incoming() {
    return items.state.projectiles.some(
      (p) => p.homing?.targetId === player().id,
    );
  }

  function snapshot() {
    return structuredClone({
      kind: "kart-race" as const,
      version: 1 as const,
      contentId: "lantern-rally-v1",
      rulesBuildId: "kart-race-r3-v1",
      seed,
      karts,
      progress,
      items: items.capture(),
      time,
      countdown,
      phase,
      tick,
      sequence,
      profile,
      notice,
      noticeTime,
      lastPlace,
      placeCooldown,
      lastWarning,
      aiTimers,
      pending,
      events,
    });
  }
  return {
    command(input: KartRaceInput): boolean {
      if (
        !input ||
        input.kind !== "drive" ||
        [input.throttle, input.brake, input.drift].some(
          (v) => typeof v !== "boolean",
        ) ||
        ![-1, 0, 1].includes(input.steer) ||
        [input.useItem, input.rescue, input.retry].some(
          (v) => v !== undefined && typeof v !== "boolean",
        ) ||
        (input.profile !== undefined && ![0, 1, 2].includes(input.profile))
      )
        return false;
      pending = {
        kind: "drive",
        throttle: input.throttle,
        brake: input.brake,
        steer: input.steer,
        drift: input.drift,
        useItem: input.useItem,
        rescue: input.rescue,
        retry: input.retry,
        profile: input.profile,
      };
      return true;
    },
    step(dt: number) {
      if (!Number.isFinite(dt) || dt < 0 || dt > 0.05)
        throw Error("Invalid kart race delta");
      const frame = pending;
      pending = {
        ...pending,
        useItem: false,
        rescue: false,
        retry: false,
        profile: undefined,
      };
      tick++;
      noticeTime = Math.max(0, noticeTime - dt);
      placeCooldown = Math.max(0, placeCooldown - dt);
      if (phase === "finish") {
        if (frame.retry || frame.useItem) {
          reset();
          notice = "Another delivery run!";
          noticeTime = 2;
          return;
        }
        if (time - progress[0]!.finishTime! >= 8)
          for (const racer of progress)
            if (racer.finishTime === null) racer.dnf = true;
        if (progress.every((r) => r.finishTime !== null || r.dnf)) {
          time += dt;
          for (const k of karts) {
            k.vx *= finishDecay(dt);
            k.vy *= finishDecay(dt);
            k.x += k.vx * dt;
            k.y += k.vy * dt;
          }
          return;
        }
      }
      if (phase === "grid") {
        for (let i = 0; i < 3; i++)
          if (frame.profile === i) {
            profile = i;
            player().profile = i;
            notice = KART_PROFILES[i]!.name;
            noticeTime = 2;
          }
        const old = Math.ceil(countdown);
        countdown -= dt;
        if (Math.ceil(countdown) !== old) emit(countdown > 0 ? "count" : "go");
        if (countdown <= 0) {
          phase = "race";
          notice = "GO! Follow the lantern road";
          noticeTime = 3;
        }
        return;
      }
      time += dt;
      const order = ranked(),
        ids = order.map((p) => p.id),
        p = player();
      if (frame.rescue || p.stuck > 7) {
        resetKartToCheckpoint(track, p, progress[0]!);
        notice = "Rescued to last checkpoint";
        noticeTime = 2;
      }
      if (frame.useItem) {
        const used = items.use(p, ids, karts);
        if (used) {
          emit("item");
          notice = ITEM_LABEL[used];
          noticeTime = 1.5;
        }
      }
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i]!,
          before = { x: k.x, y: k.y };
        let control =
          i === 0
            ? {
                throttle: frame.throttle ? 1 : 0,
                brake: frame.brake ? 1 : 0,
                steer: frame.steer,
                drift: frame.drift,
              }
            : racingLineControl(
                track,
                k,
                karts,
                progress[0]!.score - progress[i]!.score,
                [...items.state.oil, ...items.state.projectiles],
              );
        if (progress[i]!.finishTime !== null)
          control = { throttle: 0, brake: 0.5, steer: 0, drift: false };
        const motion = stepKartBody(k, control, track, dt);
        if (motion.turbo && i === 0) {
          emit("turbo");
          notice = "MINI TURBO!";
          noticeTime = 1;
        }
        if (motion.wall && i === 0 && tick % 15 === 0) emit("wall");
        if (
          stepRaceProgress(track, progress[i]!, before, k, time) &&
          i === 0 &&
          progress[0]!.checkpoint === 0
        ) {
          emit(progress[0]!.lap >= 3 ? "finish" : "lap");
          notice =
            progress[0]!.lap === 2
              ? "FINAL LAP"
              : `Lap ${progress[0]!.lap + 1}`;
          noticeTime = 3;
        }
        if (i > 0) {
          aiTimers[i]! -= dt;
          if (aiTimers[i]! <= 0) {
            items.use(k, ids, karts);
            aiTimers[i] = 3 + (i % 3);
          }
          if (k.stuck > 5) resetKartToCheckpoint(track, k, progress[i]!);
        }
      }
      collideKarts(karts);
      for (const e of items.step(track, karts, ids, dt))
        if (e.sourceId === p.id) emit(e.kind, e.sourceId);
      if (incoming() && time - lastWarning > 0.75) {
        emit("warning");
        lastWarning = time;
      }
      const place = ranked().findIndex((r) => r.id === p.id) + 1;
      if (place !== lastPlace && placeCooldown <= 0) {
        notice =
          place < lastPlace
            ? "A clean pass!"
            : `${place} / 6 — stay on the racing line`;
        noticeTime = 1.6;
        placeCooldown = 3;
      }
      lastPlace = place;
      if (progress[0]!.finishTime !== null) {
        phase = "finish";
        notice = "DELIVERIES COMPLETE";
        noticeTime = 20;
      }
    },
    observe() {
      const observation = {
        ...snapshot(),
        track: structuredClone(track),
        outcome:
          phase === "finish" &&
          progress.every((r) => r.finishTime !== null || r.dnf) &&
          time -
            Math.max(
              ...progress.map(
                (r) => r.finishTime ?? progress[0]!.finishTime! + 8,
              ),
            ) >
            2
            ? ("won" as const)
            : ("playing" as const),
        incoming: incoming(),
        ranking: structuredClone(ranked()),
      };
      return observation as DeepReadonlyRace<typeof observation>;
    },
    snapshot,
    drainEvents() {
      const batch = events;
      events = [];
      return batch;
    },
    restore(value: unknown) {
      canonicalJson(value);
      const v = structuredClone(value) as ReturnType<typeof snapshot>;
      validateSnapshot(v, snapshot());
      const stagedItems = new KartItemOwner(track, seed);
      stagedItems.restore(v.items);
      ({
        karts,
        progress,
        time,
        countdown,
        phase,
        tick,
        sequence,
        profile,
        notice,
        noticeTime,
        lastPlace,
        placeCooldown,
        lastWarning,
        aiTimers,
        pending,
        events,
      } = v);
      items = stagedItems;
    },
  };
}

export type KartRaceSession = ReturnType<typeof createKartRaceSession>;
export type KartRaceObservation = ReturnType<KartRaceSession["observe"]>;
export type KartRaceSnapshot = ReturnType<KartRaceSession["snapshot"]>;

type RaceSnapshot = ReturnType<
  ReturnType<typeof createKartRaceSession>["snapshot"]
>;
function validateSnapshot(v: RaceSnapshot, before: RaceSnapshot) {
  const fail = () => {
    throw Error("Invalid kart race checkpoint");
  };
  const finite = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n);
  const natural = (n: unknown): n is number =>
    finite(n) && Number.isSafeInteger(n) && n >= 0;
  if (
    !v ||
    v.kind !== before.kind ||
    v.version !== 1 ||
    v.seed !== before.seed ||
    v.contentId !== before.contentId ||
    v.rulesBuildId !== before.rulesBuildId
  )
    fail();
  const track = createKartTrack(v.seed);
  if (
    !Array.isArray(v.karts) ||
    v.karts.length !== 6 ||
    !Array.isArray(v.progress) ||
    v.progress.length !== 6 ||
    !Array.isArray(v.aiTimers) ||
    v.aiTimers.length !== 6 ||
    v.aiTimers.some((n) => !finite(n)) ||
    !natural(v.tick) ||
    !natural(v.sequence) ||
    !["grid", "race", "finish"].includes(v.phase) ||
    ![0, 1, 2].includes(v.profile) ||
    ![v.time, v.noticeTime, v.placeCooldown, v.lastWarning].every(
      (n) => finite(n) && n >= 0,
    ) ||
    !finite(v.countdown) ||
    v.countdown < -0.05 ||
    v.countdown > 4 ||
    !Number.isInteger(v.lastPlace) ||
    v.lastPlace < 1 ||
    v.lastPlace > 6 ||
    typeof v.notice !== "string" ||
    (v.phase === "grid" && v.countdown <= 0) ||
    (v.phase !== "grid" && v.countdown > 0)
  )
    fail();
  for (let i = 0; i < 6; i++) {
    const k = v.karts[i]!,
      p = v.progress[i]!;
    if (
      !k ||
      k.id !== `kart-${i}` ||
      Object.keys(k).some(
        (key) => key !== "id" && !finite(k[key as keyof KartBody]),
      ) ||
      canonicalJson(Object.keys(k).sort()) !==
        canonicalJson(Object.keys(before.karts[i]!).sort()) ||
      !natural(k.segment) ||
      k.segment >= track.points.length ||
      ![0, 1, 2].includes(k.profile) ||
      ![-1, 0, 1].includes(k.drift) ||
      [k.speed, k.slip, k.charge, k.boost, k.spin, k.immune, k.z, k.stuck].some(
        (n) => n < 0,
      ) ||
      k.charge > 2.4 ||
      !p ||
      p.id !== k.id ||
      !natural(p.lap) ||
      p.lap > 3 ||
      !natural(p.nextGate) ||
      p.nextGate >= track.gates.length ||
      !track.gates.includes(p.checkpoint) ||
      ![p.lapStarted, p.score].every((n) => finite(n) && n >= 0) ||
      p.lapStarted > v.time ||
      !Array.isArray(p.splits) ||
      p.splits.length !== p.lap ||
      p.splits.some((n) => !finite(n) || n < 0) ||
      (p.finishTime !== null &&
        (!finite(p.finishTime) ||
          p.finishTime < 0 ||
          p.finishTime > v.time ||
          p.lap !== 3)) ||
      (p.dnf !== undefined && typeof p.dnf !== "boolean")
    )
      fail();
  }
  const p = v.pending;
  if (
    !p ||
    p.kind !== "drive" ||
    [p.throttle, p.brake, p.drift].some((x) => typeof x !== "boolean") ||
    ![-1, 0, 1].includes(p.steer) ||
    [p.useItem, p.rescue, p.retry].some(
      (x) => x !== undefined && typeof x !== "boolean",
    ) ||
    (p.profile !== undefined && ![0, 1, 2].includes(p.profile))
  )
    fail();
  const ids = v.karts.map((k) => k.id),
    validItem = (item: unknown) =>
      item === null ||
      ["boost", "oil", "firework", "lantern"].includes(item as string);
  const item = v.items,
    initial = new KartItemOwner(track, v.seed).capture();
  if (
    !item ||
    !natural(item.rng) ||
    item.rng > 4294967295 ||
    !natural(item.sequence) ||
    !item.inventory ||
    Array.isArray(item.inventory) ||
    Object.entries(item.inventory).some(
      ([id, item]) => !ids.includes(id) || !validItem(item),
    ) ||
    !Array.isArray(item.boxes) ||
    item.boxes.length !== initial.boxes.length ||
    item.boxes.some(
      (b, i) =>
        !b ||
        b.x !== initial.boxes[i]!.x ||
        b.y !== initial.boxes[i]!.y ||
        !finite(b.cooldown) ||
        b.cooldown < 0 ||
        b.cooldown > 6,
    ) ||
    !Array.isArray(item.oil) ||
    item.oil.some(
      (o) =>
        !o ||
        ![o.x, o.y, o.life, o.armed].every(finite) ||
        o.life <= 0 ||
        o.life > 17 ||
        !ids.includes(o.owner),
    ) ||
    !Array.isArray(item.projectiles) ||
    item.projectiles.some(
      (p) =>
        !p ||
        (p.ignoreTargetId !== undefined && !ids.includes(p.ignoreTargetId)) ||
        (p.homing && !ids.includes(p.homing.targetId)),
    )
  )
    fail();
  if (!Array.isArray(v.events)) fail();
  let sequence = 0;
  for (const event of v.events) {
    if (
      !event ||
      !natural(event.sequence) ||
      event.sequence <= sequence ||
      event.sequence > v.sequence ||
      !natural(event.tick) ||
      event.tick > v.tick ||
      !ids.includes(event.sourceId) ||
      ![
        "count",
        "go",
        "turbo",
        "wall",
        "item",
        "finish",
        "lap",
        "box",
        "spin",
        "warning",
      ].includes(event.kind)
    )
      fail();
    sequence = event.sequence;
  }
}
