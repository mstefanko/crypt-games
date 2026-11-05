export * from "./types";
export { createDemoScene, createBlankScene } from "./fixture";
import type {
  SceneDocument,
  SceneCommand,
  Diagnostic,
  EvaluatedFrame,
  Candidate,
  MergeResult,
  Coverage,
  StyleId,
  Weather,
} from "./types";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const targets = {
  actor: "actors",
  layer: "layers",
  motion: "motions",
  dialogue: "dialogue",
  shot: "shots",
  camera: "camera",
  audio: "audio",
} as const;
const fields: Record<string, string[]> = {
  scene: ["title", "brief", "style"],
  actor: ["x", "y", "scale", "familyId", "variantId", "name"],
  layer: [
    "x",
    "y",
    "z",
    "visible",
    "output",
    "opacity",
    "manualOverride",
    "familyId",
  ],
  motion: ["start", "duration", "from", "to", "action", "ease", "endLink"],
  dialogue: [
    "text",
    "start",
    "duration",
    "revealRate",
    "waitForInput",
    "voiceMediaId",
    "transcript",
    "voiceNeedsReview",
    "style",
  ],
  camera: ["start", "duration", "from", "to", "zoom", "fromZoom"],
  audio: ["start", "duration", "mediaId", "title", "volume", "kind"],
  shot: ["name", "start", "duration", "environment"],
  environment: [
    "weather",
    "timeOfDay",
    "frontRain",
    "backRain",
    "lantern",
    "wetness",
    "ambience",
    "abandoned",
  ],
};
function object(
  scene: SceneDocument,
  c: SceneCommand,
): Record<string, unknown> {
  if (c.target === "scene") return scene as unknown as Record<string, unknown>;
  if (c.target === "environment") {
    if (c.targetId) {
      const s = scene.shots.find((s) => s.id === c.targetId);
      if (!s) throw Error("Unknown shot");
      return (s.environment ??= {}) as Record<string, unknown>;
    }
    return scene.environment as unknown as Record<string, unknown>;
  }
  const key = targets[c.target];
  const item = key && scene[key].find((x) => x.id === c.targetId);
  if (!item) throw Error(`Unknown ${c.target}: ${c.targetId}`);
  return item as unknown as Record<string, unknown>;
}
const key = (c: SceneCommand) =>
  `${c.target}:${c.targetId ?? ""}:${c.property}`;
function read(s: SceneDocument, c: SceneCommand): unknown {
  try {
    return object(clone(s), c)[c.property];
  } catch {
    return undefined;
  }
}
export function sceneDuration(s: SceneDocument): number {
  return Math.max(0, ...s.shots.map((x) => x.start + x.duration));
}
export function styleCoverage(s: SceneDocument, style: StyleId): Coverage[] {
  const used = new Set([
    ...s.actors.map((a) => a.familyId),
    ...s.layers
      .filter((l) => l.output)
      .map((l) => l.familyId)
      .filter((x): x is string => !!x),
  ]);
  return [...used].map((id) => {
    const f = s.assets.find((f) => f.id === id),
      v = f?.variants.find((v) => v.style === style);
    const actions = s.motions
      .filter((m) => s.actors.find((a) => a.id === m.actorId)?.familyId === id)
      .map((m) => m.action);
    const missing = [
      ...(v?.missing ?? []),
      ...actions
        .filter((a) => !v?.clips.some((c) => c.name === a))
        .map((a) => `${a} clip`),
    ];
    if (!v) missing.push("appearance variant");
    if (v && !v.ready && !missing.length) missing.push("unfinished appearance");
    return {
      familyId: id,
      name: f?.name ?? id,
      variantId: v?.id,
      ready: !!v?.ready && !missing.length,
      missing: [...new Set(missing)],
    };
  });
}
/** Readiness of the variants actually bound to scene instances, including pins. */
export function effectiveCoverage(s: SceneDocument): Coverage[] {
  const groups = new Map<
    string,
    {
      familyId: string;
      variantId?: string;
      actions: Set<string>;
      sockets: Set<string>;
    }
  >();
  const add = (
    familyId: string,
    variantId: string | undefined,
    actions: string[],
    sockets: string[],
  ) => {
    const family = s.assets.find((f) => f.id === familyId);
    const variant = variantId
      ? family?.variants.find((v) => v.id === variantId)
      : family?.variants.find((v) => v.style === s.style);
    const key = familyId + ":" + (variantId ?? variant?.id ?? s.style);
    const group = groups.get(key) ?? {
      familyId,
      variantId: variantId ?? variant?.id,
      actions: new Set<string>(),
      sockets: new Set<string>(),
    };
    actions.forEach((a) => group.actions.add(a));
    sockets.forEach((a) => group.sockets.add(a));
    groups.set(key, group);
  };
  for (const actor of s.actors)
    add(
      actor.familyId,
      actor.variantId,
      [
        "idle",
        ...s.motions.filter((m) => m.actorId === actor.id).map((m) => m.action),
      ],
      [
        "ground",
        ...(s.dialogue.some(
          (d) => d.actorId === actor.id && d.style === "bubble",
        )
          ? ["speech"]
          : []),
      ],
    );
  for (const layer of s.layers)
    if (layer.output && layer.familyId) add(layer.familyId, undefined, [], []);
  return [...groups.values()].map((group) => {
    const family = s.assets.find((f) => f.id === group.familyId),
      variant = family?.variants.find((v) => v.id === group.variantId);
    const missing = [...(variant?.missing ?? [])];
    if (!variant) missing.push("appearance variant");
    else {
      if (!variant.ready) missing.push("unfinished appearance");
      if (!variant.frames.length) missing.push("frame artwork");
      if (variant.mediaId && !s.media.some((m) => m.id === variant.mediaId))
        missing.push("appearance media");
      if (!variant.mediaId && !variant.renderKey)
        missing.push("appearance artwork");
      for (const action of group.actions)
        if (
          !variant.clips.some(
            (c) =>
              c.name === action &&
              c.frames.length &&
              c.frames.every((i) => !!variant.frames[i]),
          )
        )
          missing.push(action + " clip");
      for (const socket of group.sockets)
        if (
          !variant.sockets[socket] &&
          !variant.frames.every((f) => !!f.sockets?.[socket])
        )
          missing.push(socket + " socket");
    }
    return {
      familyId: group.familyId,
      name: family?.name ?? group.familyId,
      variantId: group.variantId,
      ready: !missing.length,
      missing: [...new Set(missing)],
    };
  });
}
function validateSceneInternal(s: SceneDocument): Diagnostic[] {
  const d: Diagnostic[] = [];
  const err = (code: string, message: string, targetId?: string) =>
    d.push({ code, message, severity: "error", targetId });
  if (!s || s.schemaVersion !== 1 || s.fps !== 60) {
    err("schema", "Expected scene schema 1 at 60 Hz");
    return d;
  }
  for (const k of [
    "shots",
    "actors",
    "layers",
    "motions",
    "dialogue",
    "camera",
    "audio",
    "assets",
    "media",
    "locks",
  ] as const)
    if (!Array.isArray(s[k])) {
      err("schema", `Missing ${k}`);
      return d;
    }
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  const tick = (v: unknown) =>
    finite(v) && Number.isInteger(v) && Number(v) >= 0;
  if (!finite(s.width) || !finite(s.height) || s.width <= 0 || s.height <= 0)
    err("dimensions", "Invalid stage dimensions");
  if (!["8-bit", "16-bit", "realistic"].includes(s.style))
    err("style", "Unknown style");
  for (const list of [
    s.shots,
    s.actors,
    s.layers,
    s.motions,
    s.dialogue,
    s.camera,
    s.audio,
    s.assets,
    s.media,
    s.locks,
  ]) {
    const ids = new Set<string>();
    for (const x of list) {
      if (typeof x.id !== "string" || !x.id || ids.has(x.id))
        err("duplicate-id", "Missing or duplicate identity", x.id);
      ids.add(x.id);
    }
  }
  const shot = (id: string) => s.shots.find((x) => x.id === id);
  const actor = (id: string) => s.actors.some((x) => x.id === id);
  for (const x of [
    ...s.shots,
    ...s.motions,
    ...s.dialogue,
    ...s.camera,
    ...s.audio,
  ]) {
    if (!tick(x.start) || !tick(x.duration) || x.duration <= 0)
      err(
        "timing",
        "Start and duration must be positive integer ticks (start may be zero)",
        x.id,
      );
    if ("shotId" in x) {
      const sh = shot(x.shotId);
      if (!sh) err("shot-reference", "Unknown shot", x.id);
      else if (x.start + x.duration > sh.duration)
        err("shot-bounds", "Track exceeds its shot", x.id);
    }
  }
  if (!s.shots.length) err("shots", "A scene requires at least one shot");
  for (const a of s.actors) {
    const tracks = s.motions
      .filter((m) => m.actorId === a.id)
      .sort(
        (a, b) =>
          (shot(a.shotId)?.start ?? 0) +
          a.start -
          (shot(b.shotId)?.start ?? 0) -
          b.start,
      );
    for (let i = 1; i < tracks.length; i++) {
      const previous = tracks[i - 1],
        next = tracks[i];
      if (
        (shot(previous.shotId)?.start ?? 0) +
          previous.start +
          previous.duration >
        (shot(next.shotId)?.start ?? 0) + next.start
      )
        err("motion-overlap", "Actor motions overlap", next.id);
    }
  }
  const ordered = [...s.shots].sort((a, b) => a.start - b.start);
  ordered.forEach((sh, i) => {
    if (i && sh.start < ordered[i - 1].start + ordered[i - 1].duration)
      err("shot-overlap", "Shots overlap", sh.id);
  });
  for (const a of s.actors) {
    const f = s.assets.find((f) => f.id === a.familyId);
    if (!f || f.kind !== "character")
      err("family-reference", "Actor requires character family", a.id);
    if (![a.x, a.y, a.scale].every(finite) || a.scale <= 0)
      err("transform", "Invalid actor transform", a.id);
    if (a.variantId && !f?.variants.some((v) => v.id === a.variantId))
      err("variant-reference", "Unknown pinned variant", a.id);
  }
  for (const l of s.layers) {
    if (typeof l.visible !== "boolean" || typeof l.output !== "boolean")
      err("layer", "Layer visibility/output must be boolean", l.id);
    if (
      ![l.x, l.y, l.z, l.opacity].every(finite) ||
      l.opacity < 0 ||
      l.opacity > 1
    )
      err("layer", "Invalid layer values", l.id);
    if (l.familyId && !s.assets.some((f) => f.id === l.familyId))
      err("family-reference", "Unknown layer family", l.id);
  }
  for (const m of s.motions) {
    if (!actor(m.actorId)) err("actor-reference", "Unknown actor", m.id);
    if (!m.from || !m.to || ![m.from.x, m.from.y, m.to.x, m.to.y].every(finite))
      err("path", "Invalid motion points", m.id);
    if (!["linear", "ease-out"].includes(m.ease))
      err("ease", "Unknown easing", m.id);
    if (m.endLink) {
      const line = s.dialogue.find((l) => l.id === m.endLink);
      if (!line || line.shotId !== m.shotId)
        err(
          "timing-link",
          "Motion must link to dialogue in the same shot",
          m.id,
        );
      else if (line.start <= m.start)
        err("timing-link", "Linked endpoint must follow motion start", m.id);
      else if (m.duration !== line.start - m.start)
        err(
          "timing-link",
          "Linked motion duration must end at dialogue start",
          m.id,
        );
    }
  }
  for (const l of s.dialogue) {
    if (
      typeof l.waitForInput !== "boolean" ||
      typeof l.voiceNeedsReview !== "boolean" ||
      !["bubble", "caption", "portrait", "title"].includes(l.style)
    )
      err("dialogue", "Invalid dialogue presentation", l.id);
    if (!(l.style === "title" && l.actorId === "") && !actor(l.actorId))
      err("actor-reference", "Unknown speaker", l.id);
    if (
      typeof l.text !== "string" ||
      !finite(l.revealRate) ||
      l.revealRate <= 0
    )
      err("dialogue", "Invalid dialogue", l.id);
    if (l.voiceMediaId && !s.media.some((m) => m.id === l.voiceMediaId))
      err("media-reference", "Missing voice recording", l.id);
  }
  for (const c of s.camera)
    if (
      ![c.from.x, c.from.y, c.to.x, c.to.y, c.zoom].every(finite) ||
      c.zoom <= 0 ||
      c.zoom > 16 ||
      (c.fromZoom !== undefined &&
        (!finite(c.fromZoom) || c.fromZoom <= 0 || c.fromZoom > 16))
    )
      err("camera", "Invalid camera transform", c.id);
  for (const a of s.audio) {
    if (a.start + a.duration > sceneDuration(s))
      err("audio-bounds", "Audio exceeds scene duration", a.id);
    if (!["music", "voice", "sfx", "ambience"].includes(a.kind))
      err("audio", "Unknown audio kind", a.id);
    if (!finite(a.volume) || a.volume < 0 || a.volume > 1)
      err("audio", "Invalid audio volume", a.id);
    if (a.mediaId && !s.media.some((m) => m.id === a.mediaId))
      err("media-reference", "Missing audio media", a.id);
  }
  const env = (e: Partial<SceneDocument["environment"]>, id?: string) => {
    if (Object.keys(e).some((k) => !fields.environment.includes(k)))
      err("environment", "Unknown environment channel", id);
    for (const k of ["ambience", "abandoned"] as const)
      if (e[k] !== undefined && typeof e[k] !== "boolean")
        err("environment", `Invalid ${k}`, id);
    if (
      e.weather !== undefined &&
      !["clear", "rain", "storm"].includes(e.weather)
    )
      err("weather", "Unknown weather", id);
    if (e.timeOfDay !== undefined && !["night", "day"].includes(e.timeOfDay))
      err("time-of-day", "Unknown time of day", id);
    for (const k of ["frontRain", "backRain", "lantern", "wetness"] as const)
      if (e[k] !== undefined && (!finite(e[k]) || e[k]! < 0 || e[k]! > 1))
        err("environment", `Invalid ${k}`, id);
  };
  if (Object.keys(s.environment).length < 8)
    err("environment", "Global environment requires every channel");
  env(s.environment);
  s.shots.forEach((x) => x.environment && env(x.environment, x.id));
  const variantIds = new Set<string>();
  for (const f of s.assets) {
    if (
      !["character", "set", "prop", "audio"].includes(f.kind) ||
      typeof f.source !== "string" ||
      typeof f.license !== "string" ||
      !Array.isArray(f.variants)
    )
      err("asset", "Invalid asset family", f.id);
    for (const v of f.variants) {
      if (typeof v.id !== "string" || !v.id || variantIds.has(v.id))
        err("duplicate-id", "Duplicate or invalid variant identity", v.id);
      variantIds.add(v.id);
      if (
        !["8-bit", "16-bit", "realistic"].includes(v.style) ||
        typeof v.ready !== "boolean" ||
        !Number.isInteger(v.revision) ||
        v.revision < 1 ||
        !finite(v.logicalHeight) ||
        v.logicalHeight <= 0 ||
        !Array.isArray(v.frames) ||
        !Array.isArray(v.clips)
      )
        err("variant", "Invalid appearance variant", v.id);
      for (const point of Object.values(v.sockets))
        if (!point || !finite(point.x) || !finite(point.y))
          err("socket", "Invalid socket", v.id);
      const clipNames = new Set<string>();
      for (const clip of v.clips) {
        if (
          typeof clip.name !== "string" ||
          !clip.name ||
          clipNames.has(clip.name) ||
          typeof clip.loop !== "boolean"
        )
          err("clip", "Duplicate or invalid clip", v.id);
        clipNames.add(clip.name);
      }

      if (
        v.renderKey &&
        !["courier", "keeper", "station", "foreground", "lamp"].includes(
          v.renderKey,
        )
      )
        err("renderer", "Unknown built-in render key", v.id);
      if (v.mediaId && !s.media.some((m) => m.id === v.mediaId))
        err("media-reference", "Missing appearance media", v.id);
      for (const c of v.clips)
        if (
          !finite(c.fps) ||
          c.fps <= 0 ||
          !c.frames.length ||
          c.frames.some(
            (i) => !Number.isInteger(i) || i < 0 || i >= v.frames.length,
          )
        )
          err("clip", "Invalid animation frames", v.id);
      for (const f of v.frames)
        if (
          ![f.x, f.y, f.width, f.height, f.duration].every(finite) ||
          f.x < 0 ||
          f.y < 0 ||
          !Number.isInteger(f.duration) ||
          f.width <= 0 ||
          f.height <= 0 ||
          f.duration <= 0
        )
          err("frame", "Invalid frame geometry", v.id);
    }
  }
  for (const m of s.media)
    if (
      !/^data:(image\/(png|jpeg|webp|gif)|audio\/[a-z0-9.+-]+);base64,[a-z0-9+/=\s]*$/i.test(
        m.dataUrl,
      )
    )
      err("media", "Media must be portable image/audio data", m.id);
  for (const c of effectiveCoverage(s))
    if (!c.ready)
      d.push({
        code: "missing-appearance",
        severity: "warning",
        message: `${c.name}: ${c.missing.join(", ")}`,
        targetId: c.familyId,
      });
  return d;
}
export function validateScene(s: SceneDocument): Diagnostic[] {
  try {
    return validateSceneInternal(s);
  } catch {
    return [
      {
        code: "schema",
        severity: "error",
        message: "Malformed scene structure",
      },
    ];
  }
}
export function evaluateScene(s: SceneDocument, tick: number): EvaluatedFrame {
  const t = Math.max(
    0,
    Math.min(sceneDuration(s), Math.floor(Number.isFinite(tick) ? tick : 0)),
  );
  const shot =
    s.shots.find((sh) => t >= sh.start && t < sh.start + sh.duration) ??
    (t === sceneDuration(s) ? s.shots.at(-1) : undefined);
  const local = t - (shot?.start ?? 0);
  const dialogue = s.dialogue.find(
    (l) =>
      l.shotId === shot?.id && local >= l.start && local < l.start + l.duration,
  );
  const actors = s.actors.map((a) => {
    let x = a.x,
      y = a.y,
      action = "idle",
      phase = 0,
      elapsed = local;
    const tracks = s.motions
      .filter((m) => m.actorId === a.id)
      .map((m) => ({
        m,
        abs: (s.shots.find((sh) => sh.id === m.shotId)?.start ?? 0) + m.start,
      }))
      .sort((a, b) => a.abs - b.abs);
    for (const { m, abs } of tracks) {
      if (t < abs) continue;
      const linked = s.dialogue.find((l) => l.id === m.endLink);
      const duration = linked ? linked.start - m.start : m.duration;
      const p = clamp((t - abs) / duration),
        e = m.ease === "ease-out" ? 1 - (1 - p) ** 2 : p;
      x = m.from.x + (m.to.x - m.from.x) * e;
      y = m.from.y + (m.to.y - m.from.y) * e;
      if (p < 1) {
        action = m.action;
        phase = p;
        elapsed = t - abs;
      }
    }
    if (
      dialogue?.actorId === a.id &&
      dialogue.style !== "title" &&
      action === "idle"
    )
      action = "talk";
    const family = s.assets.find((f) => f.id === a.familyId);
    const variant =
      family?.variants.find((v) => v.id === a.variantId) ??
      family?.variants.find((v) => v.style === s.style);
    const clip = variant?.clips.find((c) => c.name === action);
    let frameIndex = 0;
    if (clip && variant) {
      const durations = clip.frames.map(
        (index) => variant.frames[index].duration,
      );
      const total = durations.reduce((sum, duration) => sum + duration, 0);
      let cursor = clip.loop
        ? Math.max(0, elapsed) % total
        : Math.min(Math.max(0, elapsed), total - 1);
      let index = 0;
      while (index < durations.length - 1 && cursor >= durations[index])
        cursor -= durations[index++];
      frameIndex = clip.frames[index];
    }
    return { ...a, x, y, action, phase, variant, frameIndex };
  });
  const c = s.camera
    .filter((c) => c.shotId === shot?.id && c.start <= local)
    .sort((a, b) => a.start - b.start)
    .at(-1);
  const p = c ? clamp((local - c.start) / c.duration) : 0;
  return {
    tick: t,
    shot,
    actors,
    dialogue,
    revealedText: dialogue
      ? Array.from(dialogue.text)
          .slice(
            0,
            Math.floor(((local - dialogue.start) * dialogue.revealRate) / 60) +
              1,
          )
          .join("")
      : "",
    environment: { ...s.environment, ...shot?.environment },
    camera: c
      ? {
          x: c.from.x + (c.to.x - c.from.x) * p,
          y: c.from.y + (c.to.y - c.from.y) * p,
          zoom: (c.fromZoom ?? c.zoom) + (c.zoom - (c.fromZoom ?? c.zoom)) * p,
        }
      : { x: s.width / 2, y: s.height / 2, zoom: 1 },
    gate:
      dialogue?.waitForInput && local >= dialogue.start + dialogue.duration - 1
        ? dialogue.id
        : undefined,
  };
}
function protectedValue(
  s: SceneDocument,
  l: SceneDocument["locks"][number],
): unknown {
  if (l.target === "environment" && l.targetId && l.property !== "*") {
    const shot = s.shots.find((sh) => sh.id === l.targetId);
    return shot
      ? (shot.environment?.[l.property as keyof typeof shot.environment] ??
          s.environment[l.property as keyof typeof s.environment])
      : undefined;
  }
  if (l.target === "environment" && l.property === "*") {
    if (l.targetId) {
      const sh = s.shots.find((sh) => sh.id === l.targetId);
      return sh ? { ...s.environment, ...sh.environment } : undefined;
    }
    return {
      global: s.environment,
      overrides: s.shots
        .filter(
          (sh) =>
            sh.environment &&
            Object.keys(sh.environment).some(
              (k) =>
                sh.environment![k as keyof typeof sh.environment] !==
                s.environment[k as keyof typeof s.environment],
            ),
        )
        .map((sh) => ({
          id: sh.id,
          environment: { ...s.environment, ...sh.environment },
        })),
    };
  }
  if (
    l.target === "layer" &&
    ["appearance", "style", "familyId"].includes(l.property)
  ) {
    const layer = s.layers.find((layer) => layer.id === l.targetId);
    return layer ? { familyId: layer.familyId, style: s.style } : undefined;
  }
  if (l.property === "*") {
    try {
      return object(clone(s), {
        type: "set",
        target: l.target,
        targetId: l.targetId,
        property: "",
        value: null,
      });
    } catch {
      return undefined;
    }
  }
  if (l.target === "environment" && !l.targetId)
    return {
      global: read(s, {
        type: "set",
        target: l.target,
        property: l.property,
        value: null,
      }),
      shots: s.shots
        .filter(
          (sh) =>
            sh.environment?.[l.property as keyof typeof sh.environment] !==
              undefined &&
            sh.environment?.[l.property as keyof typeof sh.environment] !==
              s.environment[l.property as keyof typeof s.environment],
        )
        .map((sh) => ({
          id: sh.id,
          value:
            sh.environment?.[l.property as keyof typeof sh.environment] ??
            s.environment[l.property as keyof typeof s.environment],
        })),
    };
  if (
    l.target === "actor" &&
    ["style", "variantId", "appearance"].includes(l.property)
  ) {
    const a = s.actors.find((a) => a.id === l.targetId);
    return a
      ? {
          familyId: a.familyId,
          variantId: a.variantId,
          style: a.variantId ? undefined : s.style,
        }
      : undefined;
  }
  return read(s, {
    type: "set",
    target: l.target,
    targetId: l.targetId,
    property: l.property,
    value: null,
  });
}
export function applyCommands(
  s: SceneDocument,
  commands: SceneCommand[],
  options: { allowProtected?: boolean } = {},
): SceneDocument {
  if (!Array.isArray(commands) || commands.length > 500)
    throw Error("Expected at most 500 commands");
  const portable = (v: unknown): boolean =>
    v === null ||
    typeof v === "string" ||
    typeof v === "boolean" ||
    (typeof v === "number" && Number.isFinite(v)) ||
    (Array.isArray(v) && v.every(portable)) ||
    (typeof v === "object" &&
      v !== null &&
      Object.getPrototypeOf(v) === Object.prototype &&
      Object.entries(v).every(
        ([k, x]) =>
          !["__proto__", "constructor", "prototype"].includes(k) && portable(x),
      ));
  if (!commands.every((c) => c && portable(c.value)))
    throw Error("Commands require finite portable JSON values");
  const out = clone(s);
  for (const c of commands) {
    if (
      !c ||
      c.type !== "set" ||
      !fields[c.target]?.includes(c.property) ||
      ["__proto__", "constructor", "prototype"].includes(c.property)
    )
      throw Error(`Unsupported command property: ${c?.target}.${c?.property}`);
    if (c.value === undefined)
      throw Error("Command value must be portable JSON");
    const target = object(out, c);
    target[c.property] = clone(c.value);
    if (c.target === "dialogue" && c.property === "text") {
      const line = out.dialogue.find((l) => l.id === c.targetId)!;
      if (line.voiceMediaId) line.voiceNeedsReview = true;
    }
  }
  // Linked actions stretch to their dialogue anchor. This is an effective timing edit and is checked against locks below.
  for (const m of out.motions)
    if (m.endLink) {
      const l = out.dialogue.find((l) => l.id === m.endLink);
      if (l) m.duration = l.start - m.start;
    }
  if (!options.allowProtected)
    for (const lock of s.locks)
      if (!same(protectedValue(s, lock), protectedValue(out, lock)))
        throw Error(`Protected property: ${lock.label}`);
  const errors = validateScene(out).filter((d) => d.severity === "error");
  if (errors.length) throw Error(errors.map((e) => e.message).join("; "));
  out.revision = s.revision + 1;
  return out;
}
fields.scene.push(
  "shots",
  "actors",
  "motions",
  "dialogue",
  "camera",
  "audio",
  "layers",
);
export function planStyleChange(
  s: SceneDocument,
  style: StyleId,
): SceneCommand[] {
  if (!["8-bit", "16-bit", "realistic"].includes(style))
    throw Error("Unknown style");
  return [{ type: "set", target: "scene", property: "style", value: style }];
}
export function planWeatherChange(
  _s: SceneDocument,
  weather: Weather,
  shotId?: string,
): SceneCommand[] {
  if (!["clear", "rain", "storm"].includes(weather))
    throw Error("Unknown weather");
  const values = {
    weather,
    frontRain: weather === "clear" ? 0 : weather === "rain" ? 0.45 : 0.9,
    backRain: weather === "clear" ? 0 : weather === "rain" ? 0.3 : 0.7,
    wetness: weather === "clear" ? 0 : weather === "rain" ? 0.6 : 1,
    ambience: weather !== "clear",
  };
  return Object.entries(values).map(([property, value]) => ({
    type: "set",
    target: "environment",
    targetId: shotId,
    property,
    value,
  }));
}
export function createCandidate(
  s: SceneDocument,
  commands: SceneCommand[],
  name: string,
  source: Candidate["source"] = "manual",
): Candidate {
  const result = applyCommands(s, commands);
  return {
    id: `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    base: clone(s),
    commands: clone(commands),
    createdAt: new Date().toISOString(),
    source,
    diagnostics: validateScene(result),
  };
}
export function mergeCandidate(
  current: SceneDocument,
  c: Candidate,
  resolutions: Record<string, "current" | "candidate"> = {},
): MergeResult {
  if (current.id !== c.base.id)
    return {
      scene: current,
      conflicts: [],
      applied: [],
      diagnostics: [
        {
          code: "scene-mismatch",
          severity: "error",
          message: "Candidate belongs to a different scene",
        },
      ],
    };
  const conflicts: MergeResult["conflicts"] = [],
    accepted: SceneCommand[] = [];
  let proposal: SceneDocument;
  try {
    proposal = applyCommands(c.base, c.commands);
  } catch (e) {
    return {
      scene: current,
      conflicts: [],
      applied: [],
      diagnostics: [
        { code: "candidate-invalid", severity: "error", message: String(e) },
      ],
    };
  }
  for (const command of c.commands) {
    const k = key(command),
      base = read(c.base, command),
      now = read(current, command),
      next = read(proposal, command);
    if (!same(base, now) && !same(now, next)) {
      if (resolutions[k] === "current") continue;
      if (resolutions[k] !== "candidate") {
        conflicts.push({
          key: k,
          command,
          baseValue: base,
          currentValue: now,
          proposedValue: next,
          reason: "Both the draft and candidate changed this property",
        });
        continue;
      }
    }
    accepted.push(command);
  }
  if (conflicts.length)
    return { scene: current, conflicts, diagnostics: [], applied: [] };
  try {
    const scene = accepted.length ? applyCommands(current, accepted) : current;
    return {
      scene,
      conflicts: [],
      diagnostics: validateScene(scene),
      applied: accepted,
    };
  } catch (e) {
    return {
      scene: current,
      conflicts: [],
      applied: [],
      diagnostics: [
        { code: "merge-invalid", severity: "error", message: String(e) },
      ],
    };
  }
}

/** Produce one validated transaction. Local tracks stay inside their shot; audio uses scene time.
 * Moving/resizing a linked motion shifts the anchored line intact; moving a line stretches
 * its linked motion from the fixed starting point. Locks and overlap errors remain explicit.
 */
export function planClipTiming(
  s: SceneDocument,
  target: "motion" | "dialogue" | "camera" | "audio",
  id: string,
  timing: { start?: number; duration?: number },
  options: { allowProtected?: boolean } = {},
): SceneCommand[] {
  if (
    !timing ||
    Object.keys(timing).some((k) => !["start", "duration"].includes(k)) ||
    Object.values(timing).some((v) => !Number.isFinite(v))
  )
    throw Error("Clip timing requires finite start/duration");
  const list =
    target === "motion"
      ? s.motions
      : target === "dialogue"
        ? s.dialogue
        : target === "camera"
          ? s.camera
          : s.audio;
  const item = list.find((item) => item.id === id);
  if (!item) throw Error("Unknown clip");
  const bound =
    "shotId" in item
      ? s.shots.find((sh) => sh.id === item.shotId)?.duration
      : sceneDuration(s);
  if (!bound) throw Error("Clip requires a valid timing scope");
  let duration = Math.max(
    1,
    Math.min(bound, Math.round(timing.duration ?? item.duration)),
  );
  let minStart = 0,
    maxEnd = bound;
  const linked =
    target === "motion"
      ? s.dialogue.find(
          (line) => line.id === (item as (typeof s.motions)[number]).endLink,
        )
      : undefined;
  if (linked) maxEnd = Math.min(maxEnd, bound - linked.duration);
  if (target === "dialogue")
    minStart = Math.max(
      0,
      ...s.motions.filter((m) => m.endLink === id).map((m) => m.start + 1),
    );
  if (maxEnd - minStart < 1)
    throw Error("No room for linked timing within shot");
  duration = Math.min(duration, maxEnd - minStart);
  // A duration edit keeps its starting edge fixed. A move keeps duration fixed.
  const start = Math.max(
    minStart,
    Math.min(
      maxEnd -
        (timing.duration !== undefined && timing.start === undefined
          ? 1
          : duration),
      Math.round(timing.start ?? item.start),
    ),
  );
  duration = Math.min(duration, maxEnd - start);
  const commands: SceneCommand[] = [];
  if (start !== item.start)
    commands.push({
      type: "set",
      target,
      targetId: id,
      property: "start",
      value: start,
    });
  if (duration !== item.duration)
    commands.push({
      type: "set",
      target,
      targetId: id,
      property: "duration",
      value: duration,
    });
  if (linked && linked.start !== start + duration)
    commands.push({
      type: "set",
      target: "dialogue",
      targetId: linked.id,
      property: "start",
      value: start + duration,
    });
  applyCommands(s, commands, options);
  return commands;
}
