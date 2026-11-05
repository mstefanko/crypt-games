import { expect, it } from "vitest";
import {
  controllerActions,
  decodeSettings,
  defaultSettings,
  loadSettings,
  presentationText,
  rebind,
  SETTINGS_KEY,
  LEGACY_SETTINGS_KEY,
} from "./exploration-settings.ts";
it("roundtrips bounded versioned preferences and rejects corruption/conflicts", () => {
  const original = defaultSettings();
  expect(decodeSettings(JSON.stringify(original))).toEqual(original);
  expect(rebind(original, "jump", "KeyZ").bindings.jump).toBe("KeyZ");
  expect(original.bindings.jump).toBe("Space");
  expect(() => rebind(original, "jump", "KeyJ")).toThrow("assigned");
  for (const bad of [
    "{",
    JSON.stringify({ ...original, version: 3 }),
    JSON.stringify({ ...original, volume: 1.1 }),
    JSON.stringify({
      ...original,
      bindings: { ...original.bindings, jump: "Tab" },
    }),
  ])
    expect(() => decodeSettings(bad)).toThrow();
  expect(loadSettings({ getItem: () => "corrupt" }).settings).toEqual(original);
  expect(
    loadSettings({
      getItem: () => {
        throw Error("denied");
      },
    }).warning,
  ).toContain("defaults");
});
it("quantizes only standard controller with bounded deadzone and explicit actions", () => {
  const pad = {
    mapping: "standard",
    axes: [0.5],
    buttons: Array.from({ length: 16 }, () => ({ pressed: false })),
  };
  expect([...controllerActions(pad)]).toEqual([]);
  pad.axes = [-0.51];
  pad.buttons[0].pressed = true;
  expect([...controllerActions(pad)]).toEqual(["left", "jump"]);
  expect(controllerActions({ ...pad, mapping: "" }).size).toBe(0);
});
it("keeps English fallback and expands presentation text without modifying IDs", () => {
  expect(presentationText("Enter shrine", "en")).toBe("Enter shrine");
  expect(presentationText("Enter shrine", "en-XA").length).toBeGreaterThan(16);
});
it("format arguments and declared core glyph repertoire cover table and pseudo output", async () => {
  const { EXPLORATION_STRINGS, REQUIRED_UI_GLYPHS, localizedText } =
    await import("./exploration-settings.ts");
  expect(localizedText("health", "en", { current: 3, maximum: 4 })).toBe(
    "Health 3 / 4",
  );
  for (const id of Object.keys(
    EXPLORATION_STRINGS,
  ) as (keyof typeof EXPLORATION_STRINGS)[]) {
    const output = localizedText(id, "en-XA", {
      current: 3,
      maximum: 4,
      key: "KeyK",
      action: "Jump",
    });
    expect([...output].every((char) => REQUIRED_UI_GLYPHS.includes(char))).toBe(
      true,
    );
  }
});
it("keeps default A/D aliases while explicit bindings and changed movement take precedence", async () => {
  const { keyboardAction, keyLabel, localizedText } = await import(
    "./exploration-settings.ts"
  );
  const settings = defaultSettings();
  expect(keyboardAction(settings, "KeyA")).toBe("left");
  expect(keyboardAction(settings, "KeyD")).toBe("right");
  expect(keyboardAction(rebind(settings, "jump", "KeyA"), "KeyA")).toBe("jump");
  expect(
    keyboardAction(rebind(settings, "left", "KeyQ"), "KeyA"),
  ).toBeUndefined();
  expect(keyLabel("KeyZ")).toBe("Z");
  expect(keyLabel("ArrowLeft")).toBe("←");
  expect(presentationText("Use KeyA or ArrowLeft", "en-XA")).toContain("KeyA");
  expect(presentationText("Use KeyA or ArrowLeft", "en-XA")).toContain(
    "ArrowLeft",
  );
  expect(localizedText("abilityReady", "en-XA", { key: "KeyA" })).toContain(
    "KeyA",
  );
});

it("localizes binding errors without expanding their formatted friendly key", () => {
  for (const [action, code, label] of [
    ["jump", "KeyE", "E"],
    ["jump", "ArrowUp", "↑"],
    ["attack", "Space", "Space"],
  ] as const) {
    const settings = defaultSettings();
    if (code === "ArrowUp") settings.bindings.pause = "ArrowUp";
    expect(() => rebind(settings, action, code, "en-XA")).toThrow(label);
  }
});

it("migrates retained version-one preferences and rejects malformed controller maps atomically", async () => {
  const { rebindController, controllerInputs, validControllerBinding } =
    await import("./exploration-settings.ts");
  const settings = rebind(defaultSettings(), "jump", "KeyZ");
  const original = structuredClone(settings);
  const { controllerBindings: _legacy, ...legacy } = settings;
  expect(decodeSettings(JSON.stringify({ ...legacy, version: 1 }))).toEqual(
    settings,
  );
  const changed = rebindController(settings, "jump", "Button5");
  expect(changed.controllerBindings.jump).toBe("Button5");
  expect(settings.controllerBindings.jump).toBe("Button0");
  expect(() => rebindController(settings, "jump", "Button2")).toThrow(
    "assigned",
  );
  for (const bad of [
    undefined,
    {},
    { ...settings.controllerBindings, jump: "Button99" },
    { ...settings.controllerBindings, jump: "Button2" },
  ])
    expect(() =>
      decodeSettings(JSON.stringify({ ...settings, controllerBindings: bad })),
    ).toThrow();
  expect(settings).toEqual(original);
  expect(validControllerBinding("Axis4+")).toBe(false);
  const pad = {
    mapping: "standard",
    axes: [NaN, 0.51, 0, -1, 1],
    buttons: Array.from({ length: 18 }, (_, i) => ({
      pressed: i === 5 || i === 17,
    })),
  };
  expect(controllerInputs(pad)).toEqual(["Button5", "Axis1+", "Axis3-"]);
  expect(controllerActions(pad, changed.controllerBindings).has("jump")).toBe(
    true,
  );
});
it("explicit directional button bindings win over default movement aliases", async () => {
  const { rebindController } = await import("./exploration-settings.ts");
  const settings = rebindController(defaultSettings(), "jump", "Button14");
  const pad = {
    mapping: "standard",
    axes: [0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: i === 14 })),
  };
  expect([...controllerActions(pad, settings.controllerBindings)]).toEqual([
    "jump",
  ]);
  expect([...controllerActions(pad)]).toEqual(["left"]);
});

it("recovers only damaged controller preferences and isolates legacy builds from v2 storage", () => {
  const wanted = rebind(defaultSettings(), "jump", "KeyZ");
  wanted.volume = 0.2;
  wanted.locale = "en-XA";
  wanted.muted = true;
  wanted.reducedMotion = true;
  for (const controllerBindings of [
    undefined,
    {},
    { ...wanted.controllerBindings, jump: "Button99" },
  ]) {
    const source = JSON.stringify({ ...wanted, controllerBindings });
    const store = new Map([[SETTINGS_KEY, source]]);
    const recovered = loadSettings({
      getItem: (key) => store.get(key) ?? null,
    });
    expect(recovered.settings).toEqual(wanted);
    expect(recovered.warning).toContain(
      "keyboard, sound and display settings were retained",
    );
    expect(store.get(SETTINGS_KEY)).toBe(source);
  }
  const { controllerBindings: _, ...legacy } = wanted;
  const store = new Map([
    [LEGACY_SETTINGS_KEY, JSON.stringify({ ...legacy, version: 1 })],
  ]);
  expect(
    loadSettings({ getItem: (key) => store.get(key) ?? null }).settings,
  ).toEqual(wanted);
  store.set(SETTINGS_KEY, JSON.stringify(wanted));
  // An old binary may overwrite its own namespace; current preferences survive.
  store.set(
    LEGACY_SETTINGS_KEY,
    JSON.stringify({ ...legacy, version: 1, volume: 1 }),
  );
  expect(
    loadSettings({ getItem: (key) => store.get(key) ?? null }).settings,
  ).toEqual(wanted);
  expect(SETTINGS_KEY).not.toBe(LEGACY_SETTINGS_KEY);
});
