/** Presentation preferences never enter the journey/checkpoint codec. */
export const CONTROL_ACTIONS = [
  "left",
  "right",
  "jump",
  "attack",
  "heavy",
  "guard",
  "interact",
  "pause",
] as const;
export type ControlAction = (typeof CONTROL_ACTIONS)[number];
export type ExplorationSettings = {
  version: 2;
  controllerBindings: Record<ControlAction, ControllerBinding>;
  bindings: Record<ControlAction, string>;
  muted: boolean;
  volume: number;
  reducedMotion: boolean;
  locale: "en" | "en-XA";
};
export const SETTINGS_KEY = "beacon-return-settings-v2";
export const LEGACY_SETTINGS_KEY = "beacon-return-settings-v1";
export function defaultSettings(): ExplorationSettings {
  return {
    version: 2,
    controllerBindings: defaultControllerBindings(),
    bindings: {
      left: "ArrowLeft",
      right: "ArrowRight",
      jump: "Space",
      attack: "KeyJ",
      heavy: "KeyK",
      guard: "KeyL",
      interact: "KeyE",
      pause: "Escape",
    },
    muted: false,
    volume: 0.5,
    reducedMotion: false,
    locale: "en",
  };
}
export function validBinding(code: string): boolean {
  return /^(Key[A-Z]|Digit[0-9]|Arrow(Left|Right|Up|Down)|Space|Escape)$/.test(
    code,
  );
}
function decodeStoredSettings(
  text: string,
  recoverController = false,
): { settings: ExplorationSettings; warning: string } {
  if (text.length > 4096) throw Error("Settings exceed the size limit");
  const s = JSON.parse(text);
  if (
    !s ||
    ![1, 2].includes(s.version) ||
    typeof s.muted !== "boolean" ||
    typeof s.reducedMotion !== "boolean" ||
    !Number.isFinite(s.volume) ||
    s.volume < 0 ||
    s.volume > 1 ||
    !["en", "en-XA"].includes(s.locale) ||
    !s.bindings ||
    Object.keys(s.bindings).length !== CONTROL_ACTIONS.length
  )
    throw Error("Unsupported settings");
  const codes = CONTROL_ACTIONS.map((a) => s.bindings[a]);
  if (
    codes.some((code) => typeof code !== "string" || !validBinding(code)) ||
    new Set(codes).size !== codes.length
  )
    throw Error("Invalid or conflicting bindings");
  let controllerBindings =
    s.version === 1 ? defaultControllerBindings() : s.controllerBindings;
  let warning = "";
  if (
    !controllerBindings ||
    Object.keys(controllerBindings).length !== CONTROL_ACTIONS.length ||
    CONTROL_ACTIONS.some(
      (a) => !validControllerBinding(controllerBindings[a]),
    ) ||
    new Set(CONTROL_ACTIONS.map((a) => controllerBindings[a])).size !==
      CONTROL_ACTIONS.length
  ) {
    if (!recoverController)
      throw Error("Invalid or conflicting controller bindings");
    controllerBindings = defaultControllerBindings();
    warning =
      "Controller bindings were invalid and reset. Your keyboard, sound and display settings were retained.";
  }
  return {
    warning,
    settings: {
      version: 2,
      controllerBindings: Object.fromEntries(
        CONTROL_ACTIONS.map((a) => [a, controllerBindings[a]]),
      ) as ExplorationSettings["controllerBindings"],
      muted: s.muted,
      reducedMotion: s.reducedMotion,
      volume: s.volume,
      locale: s.locale,
      bindings: Object.fromEntries(
        CONTROL_ACTIONS.map((a) => [a, s.bindings[a]]),
      ) as ExplorationSettings["bindings"],
    },
  };
}
export function decodeSettings(text: string): ExplorationSettings {
  return decodeStoredSettings(text).settings;
}
export function rebind(
  settings: ExplorationSettings,
  action: ControlAction,
  code: string,
  locale: ExplorationSettings["locale"] = "en",
): ExplorationSettings {
  if (!validBinding(code)) throw Error(localizedText("invalidBinding", locale));
  const conflict = CONTROL_ACTIONS.find(
    (a) => a !== action && settings.bindings[a] === code,
  );
  if (conflict)
    throw Error(
      localizedText("bindingConflict", locale, {
        key: keyLabel(code),
        action: presentationText(CONTROL_LABELS[conflict], locale),
      }),
    );
  return decodeSettings(
    JSON.stringify({
      ...settings,
      bindings: { ...settings.bindings, [action]: code },
    }),
  );
}
export function loadSettings(storage: Pick<Storage, "getItem">): {
  settings: ExplorationSettings;
  warning: string;
} {
  try {
    // A newer build never writes v2 into the namespace used by older clients.
    // Also recover v2 records written there by the earlier development build.
    const text =
      storage.getItem(SETTINGS_KEY) ?? storage.getItem(LEGACY_SETTINGS_KEY);
    return text === null
      ? { settings: defaultSettings(), warning: "" }
      : decodeStoredSettings(text, true);
  } catch {
    return {
      settings: defaultSettings(),
      warning:
        "Settings unavailable or invalid. Safe defaults are active; journey data is separate.",
    };
  }
}
export type ControllerBinding = `Button${number}` | `Axis${number}${"-" | "+"}`;
export type StandardController = {
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
};
export function defaultControllerBindings(): Record<
  ControlAction,
  ControllerBinding
> {
  return {
    left: "Axis0-",
    right: "Axis0+",
    jump: "Button0",
    attack: "Button2",
    heavy: "Button1",
    guard: "Button4",
    interact: "Button3",
    pause: "Button9",
  };
}
export function validControllerBinding(
  value: unknown,
): value is ControllerBinding {
  return (
    typeof value === "string" &&
    /^(Button([0-9]|1[0-6])|Axis[0-3][-+])$/.test(value)
  );
}
/** Fixed standard layout, independent of a vendor's displayed glyphs. */
export function controllerLabel(binding: ControllerBinding): string {
  const labels: Record<string, string> = {
    Button0: "A / bottom",
    Button1: "B / right",
    Button2: "X / left",
    Button3: "Y / top",
    Button4: "LB",
    Button5: "RB",
    Button6: "LT",
    Button7: "RT",
    Button8: "Back",
    Button9: "Start",
    Button10: "Left stick press",
    Button11: "Right stick press",
    Button12: "D-pad up",
    Button13: "D-pad down",
    Button14: "D-pad left",
    Button15: "D-pad right",
    Button16: "Home",
    "Axis0-": "Left stick left",
    "Axis0+": "Left stick right",
    "Axis1-": "Left stick up",
    "Axis1+": "Left stick down",
    "Axis2-": "Right stick left",
    "Axis2+": "Right stick right",
    "Axis3-": "Right stick up",
    "Axis3+": "Right stick down",
  };
  return labels[binding] ?? binding;
}
/** Capture and gameplay share a finite 17-button/four-axis domain and 0.5 deadzone. */
export function controllerInputs(pad: StandardController): ControllerBinding[] {
  if (pad.mapping !== "standard") return [];
  const result: ControllerBinding[] = [];
  for (let i = 0; i < 17; i++)
    if (pad.buttons[i]?.pressed) result.push(`Button${i}`);
  for (let i = 0; i < 4; i++) {
    const value = pad.axes[i];
    if (Number.isFinite(value) && Math.abs(value) > 0.5)
      result.push(`Axis${i}${value < 0 ? "-" : "+"}`);
  }
  return result;
}
export function controllerActions(
  pad: StandardController,
  bindings = defaultControllerBindings(),
): Set<ControlAction> {
  const inputs = new Set(controllerInputs(pad));
  const result = new Set<ControlAction>();
  // Stable action order, including historical movement aliases.
  for (const action of CONTROL_ACTIONS) {
    if (inputs.has(bindings[action])) result.add(action);
    const alias =
      action === "left" ? "Button14" : action === "right" ? "Button15" : null;
    if (
      alias &&
      bindings[action] === (action === "left" ? "Axis0-" : "Axis0+") &&
      inputs.has(alias) &&
      !Object.values(bindings).includes(alias)
    )
      result.add(action);
  }
  return result;
}
export function rebindController(
  settings: ExplorationSettings,
  action: ControlAction,
  binding: ControllerBinding,
): ExplorationSettings {
  if (!validControllerBinding(binding))
    throw Error(localizedText("invalidControllerBinding", settings.locale));
  const conflict = CONTROL_ACTIONS.find(
    (a) => a !== action && settings.controllerBindings[a] === binding,
  );
  if (conflict)
    throw Error(
      localizedText("controllerBindingConflict", settings.locale, {
        key: controllerLabel(binding),
        action: presentationText(CONTROL_LABELS[conflict], settings.locale),
      }),
    );
  return decodeSettings(
    JSON.stringify({
      ...settings,
      controllerBindings: { ...settings.controllerBindings, [action]: binding },
    }),
  );
}
export function presentationText(
  text: string,
  locale: ExplorationSettings["locale"],
): string {
  if (locale === "en") return text;
  const accents: Record<string, string> = {
    a: "á",
    e: "é",
    i: "í",
    o: "ó",
    u: "ú",
    A: "Á",
    E: "É",
  };
  const expanded = text
    .split(/(Key[A-Z]|Digit[0-9]|Arrow(?:Left|Right|Up|Down)|Space|Escape)/g)
    .map((part, index) =>
      index % 2 ? part : part.replace(/[aeiouAE]/g, (c) => accents[c]),
    )
    .join("");
  return `[${expanded} ${"~".repeat(Math.ceil(text.length * 0.35))}]`;
}
/** Initial language scope: English and expanded Latin fit proof, no RTL/shaping claim. */
export const EXPLORATION_STRINGS = {
  invalidControllerBinding:
    "Use one standard controller button or stick direction",
  invalidBinding: "Use a letter, number, arrow, Space or Escape",
  bindingConflict: "{key} is already assigned to {action}. Choose another key.",
  controllerBindingConflict:
    "{key} is already assigned to {action}. Choose another control.",
  begin: "Begin",
  pause: "Pause",
  resume: "Resume",
  health: "Health {current} / {maximum}",
  abilityReady: "Phase burst-strike ready · {key}",
  abilityMissing: "Phase burst undiscovered",
  complete: "Beacon reclaimed · journey complete",
  objective: "Find and reclaim the beacon",
} as const;
export const REQUIRED_UI_GLYPHS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 áéíóúÁÉ←→↑↓·[]~/ :.,;!?'-()";
export function localizedText(
  id: keyof typeof EXPLORATION_STRINGS,
  locale: ExplorationSettings["locale"],
  args: Record<string, string | number> = {},
): string {
  const source = EXPLORATION_STRINGS[id]; // English is the fallback for every supported key.
  const values: string[] = [];
  const template = source.replace(/\{(\w+)\}/g, (_, name: string) => {
    values.push(String(args[name] ?? `{${name}}`));
    return `@@${values.length - 1}@@`;
  });
  return presentationText(template, locale).replace(
    /@@(\d+)@@/g,
    (_, index: string) => values[Number(index)],
  );
}
export const CONTROL_LABELS: Record<ControlAction, string> = {
  left: "Move left",
  right: "Move right",
  jump: "Jump",
  attack: "Strike",
  heavy: "Burst-strike",
  guard: "Guard",
  interact: "Interact",
  pause: "Pause / resume",
};
export function keyLabel(code: string): string {
  const names: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Space: "Space",
    Escape: "Escape",
  };
  return names[code] ?? code.replace(/^(Key|Digit)/, "");
}
/** Explicit bindings always win; default movement retains the previous A/D aliases. */
export function keyboardAction(
  settings: ExplorationSettings,
  code: string,
): ControlAction | undefined {
  const explicit = CONTROL_ACTIONS.find((a) => settings.bindings[a] === code);
  if (explicit) return explicit;
  if (code === "KeyA" && settings.bindings.left === "ArrowLeft") return "left";
  if (code === "KeyD" && settings.bindings.right === "ArrowRight")
    return "right";
  return undefined;
}
/** Match native disabled-fieldset semantics and exclude unavailable DOM branches. */
export function isControllerFocusable(element: HTMLElement): boolean {
  return (
    !element.matches(":disabled") &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility !== "hidden"
  );
}
