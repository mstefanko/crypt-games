import { ActionMap } from "./action-map";
export const actions = [
  "left",
  "right",
  "jump",
  "attack",
  "heavy",
  "guard",
] as const;
export type Action = (typeof actions)[number];
export type Edge = { action: Action; kind: "pressed" | "released" | "cancel" };
export type SlotInput = {
  slot: number;
  held: Record<Action, boolean>;
  axes: { moveX: number };
  edges: Edge[];
};
type Source<A extends string> = { slot: number; action?: A; axis?: number };
/** Independent device sources combine before ordered semantic edges are queued. */
export class InputQueue<A extends string = Action> {
  private sources = new Map<string, Source<A>>();
  private held: Record<A, boolean>[];
  private pending: { action: A; kind: "pressed" | "released" | "cancel" }[][];
  private names: readonly A[];
  private slots: number;
  private neutral(): Record<A, boolean> {
    return Object.fromEntries(this.names.map((a) => [a, false])) as Record<
      A,
      boolean
    >;
  }
  constructor(
    private readonly diagnostic: (message: string) => void = () => {},
    config: { actions: readonly A[]; slots?: number } = {
      actions: actions as unknown as readonly A[],
    },
  ) {
    this.names = [...config.actions];
    this.slots = config.slots ?? 2;
    if (
      !this.names.length ||
      this.names.length > 32 ||
      new Set(this.names).size !== this.names.length ||
      this.names.some((a) => typeof a !== "string" || !a || a.length > 128) ||
      !Number.isInteger(this.slots) ||
      this.slots < 1 ||
      this.slots > 16
    )
      throw new Error("Invalid input queue configuration");
    this.held = Array.from({ length: this.slots }, () => this.neutral());
    this.pending = Array.from({ length: this.slots }, () => []);
  }

  set(
    sourceId: string,
    slot: number,
    action: A,
    down: boolean,
    cancel = false,
  ): void {
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= this.slots ||
      !this.names.includes(action)
    )
      return;
    if (down) this.sources.set(sourceId, { slot, action });
    else this.sources.delete(sourceId);
    const value = [...this.sources.values()].some(
      (s) => s.slot === slot && s.action === action,
    );
    if (value === this.held[slot][action]) return;
    this.held[slot][action] = value;
    this.pending[slot].push({
      action,
      kind: value ? "pressed" : cancel ? "cancel" : "released",
    });
    if (this.pending[slot].length > 32) {
      this.cancelAll(true);
      this.diagnostic("Input transition limit reached; controls canceled.");
    }
  }

  axis(sourceId: string, slot: number, value: number): void {
    if (
      !Number.isInteger(slot) ||
      slot < 0 ||
      slot >= this.slots ||
      !Number.isFinite(value)
    )
      return;
    this.sources.set(sourceId, {
      slot,
      axis: Math.max(-127, Math.min(127, Math.round(value))),
    });
  }

  cancelSource(prefix: string): void {
    for (const [id, source] of [...this.sources]) {
      if (!id.startsWith(prefix)) continue;
      if (source.action) this.set(id, source.slot, source.action, false, true);
      else this.sources.delete(id);
    }
  }

  cancelAll(discardOverflow = false): void {
    this.sources.clear();
    for (let slot = 0; slot < this.slots; slot += 1) {
      const cancels = this.names.map((action) => ({
        action,
        kind: "cancel" as const,
      }));
      if (discardOverflow || this.pending[slot].length + cancels.length > 32) {
        this.pending[slot] = cancels;
        if (!discardOverflow)
          this.diagnostic(
            "Input transition limit reached while canceling; pending controls reset.",
          );
      } else {
        this.pending[slot].push(...cancels);
      }
      this.held[slot] = this.neutral();
    }
  }

  consume() {
    return {
      slots: this.held.map((held, slot) => {
        let axis = 0;
        for (const source of this.sources.values()) {
          if (
            source.slot === slot &&
            source.axis !== undefined &&
            Math.abs(source.axis) > Math.abs(axis)
          )
            axis = source.axis;
        }
        const directions = held as Record<string, boolean>;
        if (directions.left || directions.right)
          axis =
            directions.left === directions.right
              ? 0
              : directions.left
                ? -127
                : 127;
        const edges = this.pending[slot];
        this.pending[slot] = [];
        return { slot, held: { ...held }, axes: { moveX: axis }, edges };
      }),
    };
  }
}

const keys: Record<string, [number, Action]> = {
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
  KeyW: [1, "jump"],
  KeyG: [1, "attack"],
  KeyH: [1, "heavy"],
  KeyR: [1, "guard"],
};

const keyboardMap = new ActionMap(
  Object.entries(keys).map(([code, [slot, action]]) => ({
    code,
    slot,
    action,
  })),
);

export class BrowserInput {
  readonly queue: InputQueue;
  private abort = new AbortController();
  private suppressedPads = new Set<number>();
  private pointerButtons = new Map<number, HTMLButtonElement>();
  private active = true;
  private padsUnavailable = false;

  constructor(root: HTMLElement, diagnostic: (message: string) => void) {
    this.queue = new InputQueue(diagnostic);
    const signal = this.abort.signal;
    window.addEventListener(
      "keydown",
      (event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          /^(Meta|Control|Alt)/.test(event.code)
        ) {
          this.cancelKeyboard();
          return;
        }
        if (event.isComposing) {
          this.cancelKeyboard();
          return;
        }
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.matches("input,select,textarea,button,a,summary") ||
            target.isContentEditable)
        )
          return;
        const binding = keyboardMap.lookup(event.code)[0];
        if (!binding || !this.active) return;
        event.preventDefault();
        if (!event.repeat)
          this.queue.set(
            `key:${event.code}`,
            binding.slot ?? 0,
            binding.action,
            true,
          );
      },
      { signal },
    );
    window.addEventListener(
      "keyup",
      (event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          /^(Meta|Control|Alt)/.test(event.code)
        ) {
          this.cancelKeyboard();
          return;
        }
        const binding = keyboardMap.lookup(event.code)[0];
        if (!binding) return;
        this.queue.set(
          `key:${event.code}`,
          binding.slot ?? 0,
          binding.action,
          false,
        );
      },
      { signal },
    );
    window.addEventListener(
      "focusin",
      (event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.matches(
            "input,select,textarea,button:not([data-action]),a,summary",
          )
        )
          this.cancelKeyboard();
      },
      { signal },
    );
    window.addEventListener("compositionstart", () => this.cancelKeyboard(), {
      signal,
    });
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-action]",
    )) {
      const action = button.dataset.action as Action;
      button.addEventListener(
        "pointerdown",
        (event) => {
          if (!this.active) return;
          event.preventDefault();
          button.setPointerCapture(event.pointerId);
          this.pointerButtons.set(event.pointerId, button);
          this.queue.set(
            `pointer:${event.pointerId}`,
            Number(button.dataset.slot ?? 0),
            action,
            true,
          );
        },
        { signal },
      );
      const finish = (event: PointerEvent) => {
        this.queue.set(
          `pointer:${event.pointerId}`,
          Number(button.dataset.slot ?? 0),
          action,
          false,
          event.type !== "pointerup",
        );
        this.pointerButtons.delete(event.pointerId);
      };
      button.addEventListener(
        "keydown",
        (event) => {
          if (
            !this.active ||
            event.metaKey ||
            event.ctrlKey ||
            event.altKey ||
            (event.code !== "Space" && event.code !== "Enter")
          )
            return;
          event.preventDefault();
          if (!event.repeat)
            this.queue.set(
              `button:${action}`,
              Number(button.dataset.slot ?? 0),
              action,
              true,
            );
        },
        { signal },
      );
      button.addEventListener(
        "keyup",
        (event) => {
          if (event.metaKey || event.ctrlKey || event.altKey) {
            this.cancelKeyboard();
            return;
          }
          if (event.code !== "Space" && event.code !== "Enter") return;
          event.preventDefault();
          this.queue.set(
            `button:${action}`,
            Number(button.dataset.slot ?? 0),
            action,
            false,
          );
        },
        { signal },
      );
      button.addEventListener(
        "blur",
        () => this.queue.cancelSource(`button:${action}`),
        { signal },
      );
      button.addEventListener("pointerup", finish, { signal });
      button.addEventListener("pointercancel", finish, { signal });
      button.addEventListener("lostpointercapture", finish, { signal });
    }
  }

  private cancelKeyboard(): void {
    this.queue.cancelSource("key:");
    this.queue.cancelSource("button:");
  }

  /** A denied/malformed controller pauses once, then keyboard and touch remain usable. */
  poll(): void {
    if (this.padsUnavailable) return;
    try {
      this.pollPads();
    } catch (error) {
      this.padsUnavailable = true;
      this.queue.cancelSource("pad:");
      throw new Error(
        `Gamepad input unavailable: ${error instanceof Error ? error.message : String(error)}. Resume with keyboard or touch.`,
      );
    }
  }

  /** Called once, before all fixed updates in a RAF. */
  private pollPads(): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (let slot = 0; slot < 2; slot += 1) {
      const pad = pads[slot];
      const prefix = `pad:${slot}:`;
      if (!pad?.connected) {
        this.queue.cancelSource(prefix);
        continue;
      }
      if (pad.axes.some((value) => !Number.isFinite(value)))
        throw new Error("Invalid controller axis");
      const neutralPad =
        pad.buttons.every((b) => !b.pressed) &&
        pad.axes.every((a) => Math.abs(a) < 16 / 127);
      if (this.suppressedPads.has(slot)) {
        if (neutralPad) this.suppressedPads.delete(slot);
        continue;
      }
      if (!this.active) continue;
      const value = Math.round((pad.axes[0] ?? 0) * 127);
      this.queue.axis(`${prefix}axis`, slot, Math.abs(value) <= 16 ? 0 : value);
      const buttons: [number, Action][] = [
        [14, "left"],
        [15, "right"],
        [0, "jump"],
        [2, "attack"],
        [1, "heavy"],
        [4, "guard"],
      ];
      for (const [index, action] of buttons)
        this.queue.set(
          `${prefix}${index}`,
          slot,
          action,
          pad.buttons[index]?.pressed ?? false,
        );
    }
  }

  cancel(): void {
    this.queue.cancelAll();
    for (const [id, button] of this.pointerButtons) {
      try {
        if (button.hasPointerCapture(id)) button.releasePointerCapture(id);
      } catch {
        /* Capture may already have been canceled by the browser. */
      }
    }
    this.pointerButtons.clear();
    this.suppressedPads.add(0);
    this.suppressedPads.add(1);
  }
  setActive(active: boolean): void {
    this.active = active;
    if (!active) this.cancel();
  }
  dispose(): void {
    this.setActive(false);
    this.abort.abort();
  }
}
