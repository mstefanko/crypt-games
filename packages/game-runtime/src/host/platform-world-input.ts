import { ActionMap, HeldKeyState } from "../action-map";
/** Physical keys stay blocked after cancellation until released. */
const actions = [
  "left",
  "right",
  "jump",
  "attack",
  "heavy",
  "guard",
  "drop",
] as const;
export class PlatformWorldInput {
  private keys = new HeldKeyState();
  private edges: { action: string; kind: string }[] = [];
  private bindingValues: Record<string, string> = {
    ArrowLeft: "left",
    ArrowRight: "right",
    Space: "jump",
    KeyX: "attack",
    ShiftLeft: "heavy",
    KeyZ: "guard",
    ArrowDown: "drop",
  };
  /** Read-only current bindings; rebind() is the supported mutation path so changes cancel input. */
  get bindings(): Readonly<Record<string, string>> {
    return this.bindingView;
  }
  private bindingView = Object.freeze({ ...this.bindingValues });
  private map = new ActionMap(
    Object.entries(this.bindingValues).map(([code, action]) => ({ code, action })),
  );
  press(code: string) {
    const action = this.map.lookup(code)[0]?.action;
    if (!action || !this.keys.press(code)) return;
    this.edges.push({ action, kind: "pressed" });
  }
  release(code: string) {
    if (this.keys.release(code))
      this.edges.push({ action: this.bindings[code], kind: "released" });
  }
  cancel() {
    this.keys.cancel();
    this.edges = actions.map((action) => ({ action, kind: "cancel" }));
  }
  frame() {
    const held = Object.fromEntries(actions.map((action) => [action, false]));
    for (const action of this.map.project({
      held: this.keys.down,
      pressed: new Set(),
    }).held)
      held[action] = true;
    const edges = this.edges;
    this.edges = [];
    return { slots: [{ slot: 0, held, axes: { moveX: 0 }, edges }] };
  }
  suppress(code: string) {
    this.keys.suppress(code);
  }
  rebind(action: string, code: string) {
    if (
      !Object.values(this.bindings).includes(action) ||
      !/^(Key[A-Z]|Arrow(Left|Right|Up|Down)|Space|Shift(Left|Right))$/.test(
        code,
      )
    )
      throw Error("Unsupported control binding");
    if (this.bindings[code] && this.bindings[code] !== action)
      throw Error("That key already controls another action");
    this.cancel();
    for (const key of Object.keys(this.bindings))
      if (this.bindings[key] === action || key === code)
        delete this.bindingValues[key];
    this.bindingValues[code] = action;
    this.bindingView = Object.freeze({ ...this.bindingValues });
    this.map = new ActionMap(
      Object.entries(this.bindingValues).map(([code, action]) => ({ code, action })),
    );
  }
}
