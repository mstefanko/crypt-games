import type { CommandFrame } from "./contract";

type Point = { x: number; y: number };
type Contact = Point & { id: number; start: Point; since: number; maximum: number };
type Action = Contact & { phase: "pending" | "shoot" | "flick" | "cancelled" | "catch" | "revive"; target?: string };
export const TOUCH = { deadzone: 8, radius: 48, tap: 14, flick: 32, holdMs: 160, retouchMs: 250, retouchRadius: 40 } as const;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Pointer IDs own roles until lifted; UI contacts never enter this recognizer.
 * Coordinates and timing are CSS pixels / monotonic milliseconds, independent of
 * render scale or simulation ticks. Only consume() drains one-shot commands. */
export class CourtTouchControls {
  private context: { catch: boolean; revive: boolean; preparedThrow?: boolean } = { catch: false, revive: false };
  setContext(context: { catch: boolean; revive: boolean; preparedThrow?: boolean }) {
    if (this.context.catch !== context.catch || this.context.revive !== context.revive) this.disarmAction();
    this.context = context;
  }
  private movement?: Contact;
  private action?: Action;
  private ignored = new Set<number>();
  private previous?: { at: number; anchor: Point };
  private dashEligible = false;
  private edges: CommandFrame = {};
  private edgeAim?: Point;
  private move: Point = { x: 0, y: 0 };
  private aim?: Point;

  down(id: number, x: number, y: number, now: number, target?: string) {
    if (this.has(id)) return;
    const contact: Contact = { id, x, y, start: { x, y }, since: now, maximum: 0 };
    if (!this.movement) {
      this.movement = contact;
      this.dashEligible = !!this.previous && now - this.previous.at <= TOUCH.retouchMs && distance(contact, this.previous.anchor) <= TOUCH.retouchRadius;
      this.previous = undefined;
      this.move = { x: 0, y: 0 };
    } else if (!this.action) {
      this.action = { ...contact, phase: "pending", target };
      this.aim = undefined;
      if (!target && this.context.catch) { this.action.phase = "catch"; this.edges.strikePressed = true; }
      else if (!target && this.context.revive) this.action.phase = "revive";
    } else this.ignored.add(id);
  }
  has(id: number) { return this.movement?.id === id || this.action?.id === id || this.ignored.has(id); }
  movePointer(id: number, x: number, y: number, now: number) {
    const p = this.movement?.id === id ? this.movement : this.action?.id === id ? this.action : undefined;
    if (!p) return;
    p.x = x; p.y = y; p.maximum = Math.max(p.maximum, distance(p, p.start));
    if (p === this.movement) {
      let dx = x - p.start.x, dy = y - p.start.y, n = Math.hypot(dx, dy);
      // The anchor follows only beyond full throw; returning to it is neutral.
      if (n > TOUCH.radius) {
        p.start = { x: x - dx / n * TOUCH.radius, y: y - dy / n * TOUCH.radius };
        dx = x - p.start.x; dy = y - p.start.y; n = TOUCH.radius;
      }
      const magnitude = Math.max(0, Math.min(1, (n - TOUCH.deadzone) / (TOUCH.radius - TOUCH.deadzone)));
      this.move = n ? { x: dx / n * magnitude, y: dy / n * magnitude } : { x: 0, y: 0 };
      if (this.dashEligible && n >= TOUCH.flick) { this.edges.dash = true; this.dashEligible = false; }
    } else {
      const a = this.action!;
      if ((a.phase === "pending" || a.phase === "catch") && now - a.since < TOUCH.holdMs && a.maximum >= TOUCH.flick) {
        a.phase = "flick"; this.edges.slide = true;
        this.edgeAim = { x: x - a.start.x, y: y - a.start.y };
      }
      this.advance(now);
      if (a.phase === "shoot" && distance(a, a.start) >= TOUCH.deadzone)
        this.aim = { x: x - a.start.x, y: y - a.start.y };
    }
  }
  private advance(now: number) {
    const a = this.action;
    if (a?.phase === "pending" && now - a.since >= TOUCH.holdMs) {
      a.phase = "shoot"; this.edges.strikePressed = true;
      if (distance(a, a.start) >= TOUCH.deadzone) this.aim = { x: a.x - a.start.x, y: a.y - a.start.y };
    }
  }
  up(id: number, x: number, y: number, now: number) {
    this.movePointer(id, x, y, now);
    if (this.movement?.id === id) {
      this.previous = { at: now, anchor: { ...this.movement.start } };
      this.movement = undefined; this.move = { x: 0, y: 0 }; this.dashEligible = false;
      // A movement lift always disarms the other thumb, including a release
      // queued earlier in the same browser event batch.
      if (this.context.preparedThrow || this.action?.phase === "shoot" || this.edges.strikeReleased || this.edges.strikePressed) this.edges = { cancel: true };
      else this.edges = {};
      if (this.action) this.action.phase = "cancelled";
      this.edgeAim = undefined;
    } else if (this.action?.id === id) {
      const a = this.action;
      if (this.movement && a.phase === "pending" && a.maximum < TOUCH.tap) {
        if (a.target) { this.edges.switch = true; this.edges.switchTarget = a.target; }
        else this.edges.pass = true;
      } else if (this.movement && a.phase === "shoot") {
        this.edges.strikeReleased = true;
        if (this.aim) this.edgeAim = this.aim;
      }
      this.action = undefined; this.aim = undefined;
    }
    this.ignored.delete(id);
  }
  cancel() {
    const wasShooting = this.action?.phase === "shoot" || this.edges.strikePressed || this.edges.strikeReleased;
    this.movement = undefined; this.action = undefined; this.ignored.clear();
    this.previous = undefined; this.dashEligible = false;
    this.move = { x: 0, y: 0 }; this.aim = undefined; this.edgeAim = undefined;
    this.edges = wasShooting ? { cancel: true } : {};
  }
  disarmAction() {
    if (this.action) this.action.phase = "cancelled";
    this.aim = undefined; this.edgeAim = undefined; this.edges = {};
  }
  consume(now: number) {
    this.advance(now);
    const result = { edges: this.edges, move: this.move, aim: this.edgeAim ?? this.aim,
      aiming: !!this.action && this.action.phase !== "cancelled" || !!this.edgeAim,
      passHeld: this.action?.phase === "revive",
      strikeHeld: this.action?.phase === "shoot" };
    this.edges = {}; this.edgeAim = undefined;
    return result;
  }
  get visual() {
    return { movement: this.movement ? { anchor: this.movement.start, point: { x: this.movement.x, y: this.movement.y } } : undefined,
      action: this.action && this.action.phase !== "cancelled" ? { anchor: this.action.start, point: { x: this.action.x, y: this.action.y }, phase: this.action.phase } : undefined };
  }
}
