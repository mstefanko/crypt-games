import type { AssetFamily, SceneDocument, StyleId } from "./types";
export function createDemoScene(): SceneDocument {
  const styles: StyleId[] = ["8-bit", "16-bit", "realistic"];
  const assets: AssetFamily[] = [
    "courier",
    "keeper",
    "station",
    "foreground",
    "lamp",
  ].map((key) => ({
    id: `lantern:${key}`,
    name: key[0].toUpperCase() + key.slice(1),
    kind:
      key === "courier" || key === "keeper"
        ? "character"
        : key === "lamp"
          ? "prop"
          : "set",
    source: "Original Pocket Director procedural fixture",
    license: "MIT",
    packId: "lantern:original",
    variants: styles.map((style) => ({
      id: `lantern:${key}:${style}`,
      name: `${key} · ${style}`,
      style,
      revision: 1,
      frames: Array.from({ length: 4 }, (_, i) => ({
        x: i * 24,
        y: 0,
        width: 24,
        height: 32,
        duration: 10,
      })),
      clips: [
        { name: "idle", frames: [0, 1], loop: true, fps: 4 },
        ...(style === "realistic" && key === "keeper"
          ? []
          : [{ name: "walk", frames: [0, 1, 2, 3], loop: true, fps: 6 }]),
        { name: "turn", frames: [2, 3], loop: false, fps: 4 },
        ...(key === "keeper"
          ? [{ name: "talk", frames: [0, 1], loop: true, fps: 5 }]
          : []),
      ],
      sockets: {
        ground: { x: 12, y: 32 },
        hand: { x: 19, y: 18 },
        ...(key === "courier" || key === "keeper"
          ? { speech: { x: 12, y: 0 } }
          : {}),
      },
      logicalHeight: 32,
      ready: !(
        style === "realistic" &&
        (key === "keeper" || key === "foreground")
      ),
      missing:
        style === "realistic" && key === "keeper"
          ? ["walk frames"]
          : style === "realistic" && key === "foreground"
            ? ["foreground artwork"]
            : [],
      renderKey: key,
    })),
  }));
  return {
    schemaVersion: 1,
    id: "lantern-courier",
    revision: 1,
    title: "Arrival at the night station",
    width: 256,
    height: 176,
    fps: 60,
    style: "8-bit",
    brief:
      "A courier reaches the night station. The keeper warns them to keep the lantern lit before they enter the tunnel.",
    shots: [
      {
        id: "arrival-wide",
        name: "Arrival wide",
        start: 0,
        duration: 360,
      },
      {
        id: "platform-meeting",
        name: "The warning",
        start: 360,
        duration: 420,
      },
      {
        id: "lantern-handoff",
        name: "Into the tunnel",
        start: 780,
        duration: 300,
      },
    ],
    actors: [
      {
        id: "courier",
        name: "Courier",
        familyId: "lantern:courier",
        x: 40,
        y: 130,
        scale: 1,
      },
      {
        id: "keeper",
        name: "Keeper",
        familyId: "lantern:keeper",
        x: 206,
        y: 130,
        scale: 1,
      },
    ],
    layers: [
      "sky",
      "facade",
      "platform",
      "lamp",
      "foreground",
      "rain-back",
      "rain-front",
      "mist",
    ].map((kind, i) => ({
      id: kind,
      name: kind,
      kind: kind as SceneDocument["layers"][number]["kind"],
      x: 0,
      y: 0,
      z: kind === "rain-back" ? 2.5 : i,
      visible: true,
      output: true,
      opacity: 1,
      ...(kind === "facade"
        ? { familyId: "lantern:station" }
        : kind === "foreground"
          ? { familyId: "lantern:foreground" }
          : kind === "lamp"
            ? { familyId: "lantern:lamp" }
            : {}),
    })),
    motions: [
      {
        id: "courier-arrives",
        shotId: "arrival-wide",
        actorId: "courier",
        action: "walk",
        start: 0,
        duration: 210,
        from: { x: 40, y: 130 },
        to: { x: 132, y: 130 },
        ease: "ease-out",
      },
      {
        id: "keeper-approaches",
        shotId: "platform-meeting",
        actorId: "keeper",
        action: "walk",
        start: 36,
        duration: 60,
        from: { x: 206, y: 130 },
        to: { x: 172, y: 130 },
        ease: "linear",
      },
      {
        id: "courier-handoff",
        shotId: "lantern-handoff",
        actorId: "courier",
        action: "walk",
        start: 0,
        duration: 240,
        from: { x: 132, y: 130 },
        to: { x: 246, y: 130 },
        ease: "linear",
      },
    ],
    dialogue: [
      {
        id: "line-title",
        shotId: "lantern-handoff",
        actorId: "courier",
        text: "NIGHT LINE",
        start: 180,
        duration: 120,
        revealRate: 30,
        waitForInput: false,
        voiceNeedsReview: false,
        style: "title",
      },
      {
        id: "line-keeper",
        shotId: "platform-meeting",
        actorId: "keeper",
        text: "The last train is gone. Keep your lantern lit.",
        start: 96,
        duration: 324,
        revealRate: 28,
        waitForInput: true,
        voiceNeedsReview: false,
        style: "bubble",
      },
    ],
    camera: [
      {
        id: "camera-arrival",
        shotId: "arrival-wide",
        start: 0,
        duration: 360,
        from: { x: 128, y: 88 },
        to: { x: 136, y: 88 },
        zoom: 1,
      },
      {
        id: "camera-warning",
        shotId: "platform-meeting",
        start: 0,
        duration: 420,
        from: { x: 140, y: 88 },
        to: { x: 148, y: 88 },
        zoom: 1.12,
      },
      {
        id: "camera-tunnel",
        shotId: "lantern-handoff",
        start: 0,
        duration: 300,
        from: { x: 148, y: 88 },
        to: { x: 164, y: 88 },
        zoom: 1.05,
      },
    ],
    audio: [],
    environment: {
      weather: "rain",
      timeOfDay: "night",
      frontRain: 0.45,
      backRain: 0.3,
      lantern: 0.85,
      wetness: 0.6,
      ambience: true,
      abandoned: false,
    },
    locks: [
      {
        id: "courier-cast",
        target: "actor",
        targetId: "courier",
        property: "familyId",
        label: "Keep the Courier identity",
      },
      {
        id: "keeper-cast",
        target: "actor",
        targetId: "keeper",
        property: "familyId",
        label: "Keep the Keeper identity",
      },
      {
        id: "platform-x",
        target: "layer",
        targetId: "platform",
        property: "x",
        label: "Keep platform placement",
      },
      {
        id: "platform-y",
        target: "layer",
        targetId: "platform",
        property: "y",
        label: "Keep platform placement",
      },
      {
        id: "night-lock",
        target: "environment",
        property: "timeOfDay",
        label: "Keep the night setting",
      },
    ],
    assets,
    media: [],
    slot: {
      id: "opening",
      name: "Opening scene",
      onComplete: "game:start",
      onSkip: "game:start",
    },
  };
}

/** An authored scene begins without starter content, asset dependencies, or protection locks. */
export function createBlankScene(): SceneDocument {
  return {
    schemaVersion: 1,
    id: "scene-" + globalThis.crypto.randomUUID(),
    revision: 1,
    title: "Untitled scene",
    width: 256,
    height: 176,
    fps: 60,
    style: "8-bit",
    brief: "",
    shots: [{ id: "shot-1", name: "Shot 1", start: 0, duration: 360 }],
    actors: [],
    layers: [],
    motions: [],
    dialogue: [],
    camera: [],
    audio: [],
    assets: [],
    media: [],
    locks: [],
    environment: {
      weather: "clear",
      timeOfDay: "day",
      frontRain: 0,
      backRain: 0,
      lantern: 0,
      wetness: 0,
      ambience: false,
      abandoned: false,
    },
    slot: {
      id: "opening",
      name: "Opening scene",
      onComplete: "game:start",
      onSkip: "game:start",
    },
  };
}
