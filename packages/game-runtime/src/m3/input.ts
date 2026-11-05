import { InputQueue, type Action } from "../input.ts";
export type Profile = "arena" | "grid" | "duel" | "adventure";
export type Direction = "left" | "right" | "up" | "down";
export class M3Input {
  readonly queue: InputQueue;
  readonly vertical: InputQueue;
  private abort = new AbortController();
  private active = false;
  private pointers = new Map<number, HTMLElement>();
  private commands: Direction[] = [];
  private nativeReleases: { slot: number; action: string; source: string }[] =
    [];
  private suppressedPads = new Set<number>();
  private padCommands = new Map<number, string>();
  private padsUnavailable = false;
  aim = 0;
  constructor(
    private root: HTMLElement,
    private profile: () => Profile,
    diagnostic: (message: string) => void,
  ) {
    this.queue = new InputQueue(diagnostic);
    this.vertical = new InputQueue(diagnostic);
    const signal = this.abort.signal;
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.metaKey || e.altKey || e.ctrlKey || e.isComposing) {
          this.cancel();
          return;
        }
        if (
          e.target instanceof Element &&
          e.target.closest(
            "button,a,input,textarea,select,summary,[contenteditable]",
          )
        )
          return;
        if (!this.active || e.repeat) return;
        const binding = this.binding(e.code);
        if (!binding) return;
        e.preventDefault();
        this.set(`key:${e.code}`, ...binding, true);
      },
      { signal },
    );
    window.addEventListener(
      "keyup",
      (e) => {
        const binding = this.binding(e.code);
        if (binding) this.set(`key:${e.code}`, ...binding, false);
      },
      { signal },
    );
    window.addEventListener(
      "focusin",
      (e) => {
        if (
          e.target instanceof Element &&
          e.target.closest(
            "button,a,input,textarea,select,summary,[contenteditable]",
          )
        )
          this.cancel();
      },
      { signal },
    );
    window.addEventListener("compositionstart", () => this.cancel(), {
      signal,
    });
    root.addEventListener(
      "pointerdown",
      (e) => {
        const button = (e.target as Element).closest<HTMLElement>(
          "[data-control]",
        );
        if (!button || !this.active) return;
        e.preventDefault();
        button.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, button);
        this.set(
          `pointer:${e.pointerId}`,
          Number(button.dataset.slot ?? 0),
          button.dataset.control!,
          true,
        );
      },
      { signal },
    );
    for (const type of [
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ] as const)
      root.addEventListener(
        type,
        (e) => {
          const button = this.pointers.get(e.pointerId);
          if (!button) return;
          this.set(
            `pointer:${e.pointerId}`,
            Number(button.dataset.slot ?? 0),
            button.dataset.control!,
            false,
            type !== "pointerup",
          );
          this.pointers.delete(e.pointerId);
        },
        { signal },
      );
  }
  private binding(code: string): [number, string] | undefined {
    if (this.profile() === "duel")
      return (
        {
          ArrowLeft: [0, "left"],
          ArrowRight: [0, "right"],
          KeyZ: [0, "jump"],
          Space: [0, "jump"],
          KeyX: [0, "attack"],
          KeyC: [0, "heavy"],
          KeyV: [0, "guard"],
          KeyA: [1, "left"],
          KeyD: [1, "right"],
          KeyF: [1, "jump"],
          KeyG: [1, "attack"],
          KeyH: [1, "heavy"],
          KeyR: [1, "guard"],
        } as Record<string, [number, string]>
      )[code];
    return (
      {
        ArrowLeft: [0, "left"],
        KeyA: [0, "left"],
        ArrowRight: [0, "right"],
        KeyD: [0, "right"],
        ArrowUp: [0, "up"],
        KeyW: [0, "up"],
        ArrowDown: [0, "down"],
        KeyS: [0, "down"],
        Space: [0, "attack"],
        KeyX: [0, "attack"],
        KeyC: [0, "heavy"],
        ShiftLeft: [0, "heavy"],
        ShiftRight: [0, "heavy"],
        KeyV: [0, "guard"],
      } as Record<string, [number, string]>
    )[code];
  }
  private set(
    source: string,
    slot: number,
    action: string,
    down: boolean,
    cancel = false,
  ) {
    if (action === "up" || action === "down")
      this.vertical.set(
        source,
        slot,
        action === "up" ? "left" : "right",
        down,
        cancel,
      );
    else this.queue.set(source, slot, action as Action, down, cancel);
    if (
      down &&
      slot === 0 &&
      ["left", "right", "up", "down"].includes(action)
    ) {
      if (this.commands.length >= 32) {
        this.cancel();
        return;
      }
      this.commands.push(action as Direction);
    }
  }
  pulse(slot: number, action: string) {
    if (!this.active) return;
    const source = `native:${slot}:${action}`;
    this.set(source, slot, action, true);
    if (
      ((this.profile() === "arena" || this.profile() === "duel") &&
        ["left", "right", "up", "down"].includes(action)) ||
      (this.profile() === "duel" && action === "guard")
    ) {
      if (!this.nativeReleases.some((release) => release.source === source))
        this.nativeReleases.push({ source, slot, action });
    } else this.set(source, slot, action, false);
  }
  /** Once per host RAF; controllers share the same two-slot semantic queue. */
  poll() {
    if (this.padsUnavailable) return;
    try {
      this.pollPads();
    } catch (error) {
      this.padsUnavailable = true;
      this.queue.cancelSource("pad:");
      this.vertical.cancelSource("pad:");
      throw error;
    }
  }
  private pollPads() {
    const pads = navigator.getGamepads?.() ?? [];
    for (let slot = 0; slot < 2; slot++) {
      const pad = pads[slot],
        prefix = `pad:${slot}:`;
      if (!pad?.connected) {
        this.queue.cancelSource(prefix);
        this.vertical.cancelSource(prefix);
        continue;
      }
      if (pad.axes.some((value) => !Number.isFinite(value)))
        throw Error(
          "Invalid controller axis; resume with keyboard or pointer.",
        );
      if (this.suppressedPads.has(slot)) {
        if (
          pad.buttons.every((b) => !b.pressed) &&
          pad.axes.every((v) => Math.abs(v) < 16 / 127)
        )
          this.suppressedPads.delete(slot);
        continue;
      }
      if (!this.active || (slot === 1 && this.profile() !== "duel")) continue;
      const axis = (i: number) => {
        const value = Math.round((pad.axes[i] ?? 0) * 127);
        return Math.abs(value) <= 16 ? 0 : value;
      };
      const x = axis(0),
        y = axis(1);
      this.queue.axis(`${prefix}x`, slot, x);
      if (this.profile() !== "duel") this.vertical.axis(`${prefix}y`, slot, y);
      for (const [index, action] of [
        [14, "left"],
        [15, "right"],
        [0, this.profile() === "duel" ? "jump" : "attack"],
        [2, "attack"],
        [1, "heavy"],
        [4, "guard"],
      ] as const)
        this.queue.set(
          `${prefix}${index}`,
          slot,
          action,
          pad.buttons[index]?.pressed ?? false,
        );
      if (this.profile() !== "duel")
        for (const [index, action] of [
          [12, "left"],
          [13, "right"],
        ] as const)
          this.vertical.set(
            `${prefix}${index}`,
            slot,
            action,
            pad.buttons[index]?.pressed ?? false,
          );
      if (this.profile() === "grid" || this.profile() === "adventure") {
        const lr =
            (pad.buttons[14]?.pressed ? 1 : 0) -
            (pad.buttons[15]?.pressed ? 1 : 0),
          ud =
            (pad.buttons[12]?.pressed ? 1 : 0) -
            (pad.buttons[13]?.pressed ? 1 : 0);
        const direction = lr
          ? lr > 0
            ? "left"
            : "right"
          : ud
            ? ud > 0
              ? "up"
              : "down"
            : [12, 13, 14, 15].some((index) => pad.buttons[index]?.pressed)
              ? ""
              : Math.abs(x) >= Math.abs(y) && x
                ? x < 0
                  ? "left"
                  : "right"
                : y
                  ? y < 0
                    ? "up"
                    : "down"
                  : "";
        if (
          direction &&
          this.padCommands.get(slot) !== direction &&
          this.commands.length < 32
        )
          this.commands.push(direction as Direction);
        this.padCommands.set(slot, direction);
      }
    }
  }
  consume() {
    const x = this.queue.consume(),
      y = this.vertical.consume();
    for (const release of this.nativeReleases)
      this.set(release.source, release.slot, release.action, false);
    this.nativeReleases = [];
    const names = { attack: "fire", heavy: "dash", guard: "shove" } as const;
    const edges = x.slots[0].edges.flatMap((edge) =>
      edge.action in names
        ? [
            {
              action: names[edge.action as keyof typeof names],
              kind: edge.kind,
            },
          ]
        : [],
    );
    return {
      frame: x,
      moveX: x.slots[0].axes.moveX,
      moveY: y.slots[0].axes.moveX,
      aim: this.aim,
      cancel: false,
      fire: x.slots[0].held.attack,
      dash: x.slots[0].held.heavy,
      shove: x.slots[0].held.guard,
      edges,
    };
  }
  drainCommands() {
    const next = this.commands;
    this.commands = [];
    return next;
  }
  setActive(active: boolean) {
    this.active = active;
    if (!active) this.cancel();
  }
  cancel() {
    this.queue.cancelAll(true);
    this.vertical.cancelAll(true);
    this.commands = [];
    this.nativeReleases = [];
    this.suppressedPads.add(0);
    this.suppressedPads.add(1);
    this.padCommands.clear();
    for (const [id, button] of this.pointers) {
      try {
        if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
      } catch {}
    }
    this.pointers.clear();
  }
  dispose() {
    this.setActive(false);
    this.abort.abort();
  }
}
