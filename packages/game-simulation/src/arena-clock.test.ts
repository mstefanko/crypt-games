import { describe, expect, it } from "vitest";
import { ArenaSession, type ArenaInput } from "./arena-session";
import { underworldContent } from "../../../apps/audio-arcade/src/games/underworld/content";
import { canonicalJson } from "./session-protocol";
const idle: ArenaInput = { x: 0, y: 0, aimX: 12, aimY: 6, attack: false, attackHeld: false, attackReleased: false, dash: false, special: false, cast: false };
function create(clock: "legacy-delta-v1" | "fixed-60-v2" = "fixed-60-v2") {
  const owner = new ArenaSession(underworldContent, 1, clock);
  owner.command("start");
  return owner;
}
const state = (owner: ArenaSession) => { const { checkpoint: _, ...s } = owner.snapshot(); return s; };
describe("Arena versioned 60Hz clock and complete checkpoints", () => {
  it("preserves the production 1/60 stream including hit-stop, edge priority and events", () => {
    const fixed = create(), legacy = create("legacy-delta-v1");
    for (let tick = 0; tick < 360; tick++) {
      const input = { ...idle, x: tick < 100 ? 1 : -1, attack: tick % 17 === 0, attackHeld: tick % 17 < 8, dash: tick % 100 === 0, cast: tick % 83 === 0 };
      fixed.step(1 / 60, input); legacy.step(1 / 60, input);
      expect(state(fixed), `tick ${tick}`).toEqual(state(legacy));
      expect(fixed.drainEvents(), `events tick ${tick}`).toEqual(legacy.drainEvents());
    }
  });
  it("retains a sub-tick edge once and matches split host schedules", () => {
    const whole = create(), split = create();
    for (let tick = 0; tick < 90; tick++) {
      const input = { ...idle, cast: tick === 0, attack: tick === 50, x: 0.2 };
      whole.step(1 / 60, input);
      split.step(1 / 120, input);
      split.step(1 / 120, { ...input, attack: false });
      expect(split.snapshot()).toEqual(whole.snapshot());
      expect(split.drainEvents()).toEqual(whole.drainEvents());
    }
  });
  it("dispatches an attack edge only once in a multi-tick host call", () => {
    const grouped = create(), separate = create();
    grouped.step(0.05, { ...idle, attack: true });
    separate.step(1 / 60, { ...idle, attack: true });
    separate.step(1 / 60, idle); separate.step(1 / 60, idle);
    expect(grouped.snapshot()).toEqual(separate.snapshot());
    expect(grouped.state.commandOrder).toBe(1);
  });
  it("branches before event drain with fractional remainder and pending input", () => {
    const owner = create();
    owner.step(1 / 60, { ...idle, dash: true });
    owner.step(1 / 120, { ...idle, attack: true });
    const saved = JSON.parse(canonicalJson(owner.snapshot()));
    expect(saved.checkpoint.events.length).toBeGreaterThan(0);
    expect(saved.checkpoint.pendingInput.attack).toBe(true);
    const restored = create(); restored.restore(saved);
    expect(restored.drainEvents()).toEqual(owner.drainEvents());
    for (let tick = 0; tick < 30; tick++) {
      restored.step(1 / 120, idle); owner.step(1 / 120, idle);
      expect(restored.snapshot()).toEqual(owner.snapshot());
      expect(restored.drainEvents()).toEqual(owner.drainEvents());
    }
  });
  it("snapshots are detached and do not write bookkeeping into authoritative state", () => {
    const owner = create(); owner.step(1 / 60, { ...idle, dash: true });
    const before = structuredClone(owner.state);
    const snapshot = owner.snapshot(); snapshot.player.hp = 0; snapshot.checkpoint.events.length = 0;
    expect(owner.state).toEqual(before);
    expect(owner.snapshot().checkpoint.events.length).toBeGreaterThan(0);
  });
  it("rejects corrupt or mismatched checkpoints without changing state or pending events", () => {
    const owner = create(); owner.step(1 / 60, { ...idle, cast: true });
    const before = owner.snapshot();
    const mutations = [
      (s: any) => { delete s.checkpoint; }, (s: any) => { s.checkpoint.seed++; },
      (s: any) => { s.checkpoint.rulesBuildId = "legacy-delta-v1"; },
      (s: any) => { s.checkpoint.contentId = "other"; },
      (s: any) => { s.checkpoint.remainder = 1; }, (s: any) => { s.checkpoint.ticks = -1; },
      (s: any) => { s.player.hp = NaN; }, (s: any) => { s.room = 999; },
      (s: any) => { s.player.action.timing.active = -1; },
      (s: any) => { s.triggerMemory.uses = []; },
      (s: any) => { s.enemies = [{}]; }, (s: any) => { s.checkpoint.events = [{}]; },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(before); mutate(bad);
      expect(() => owner.restore(bad)).toThrow(); expect(owner.snapshot()).toEqual(before);
    }
    for (const dt of [NaN, Infinity, -0.01]) {
      expect(() => owner.step(dt, idle)).toThrow(); expect(owner.snapshot()).toEqual(before);
    }
  });
  it("pause cancellation clears queued edges without stepping clocks or hit-stop", () => {
    const owner = create(); owner.step(1 / 120, { ...idle, attack: true });
    const before = owner.snapshot();
    owner.step(0, { ...idle, cancelled: true });
    const after = owner.snapshot();
    expect(after.checkpoint.pendingInput).toBeNull();
    expect(after.checkpoint.ticks).toBe(before.checkpoint.ticks);
    expect(after.checkpoint.remainder).toBe(before.checkpoint.remainder);
    expect(after.scaleElapsed).toBe(before.scaleElapsed);
    owner.step(1 / 120, idle); expect(owner.state.player.action).toBeUndefined();
  });
  it("keeps input expiry on unscaled ticks through hit-stop", () => {
    const owner = create();
    const saved = owner.snapshot(); saved.scaleElapsed = -0.025; saved.scaleCooldown = 0.12;
    saved.nextId = 91;
    saved.player.action = { id: 90, elapsed: 0, timing: { tell: 1, active: 1, recover: 1 }, hits: [] };
    owner.restore(saved);
    owner.step(1 / 60, { ...idle, special: true });
    expect(owner.state.time).toBe(0); expect(owner.state.inputClock).toBe(1 / 60);
    expect(owner.state.commands).toHaveLength(1);
    for (let i = 0; i < 8; i++) owner.step(1 / 60, idle);
    expect(owner.state.commands).toEqual([]);
  });
  it("rejects an overflowing multi-tick batch before changing queued input or clocks", () => {
    const owner = create();
    const saved = owner.snapshot(); saved.checkpoint.ticks = Number.MAX_SAFE_INTEGER - 1;
    owner.restore(saved);
    const before = owner.snapshot();
    expect(() => owner.step(0.05, { ...idle, attack: true, cancelled: true })).toThrow("tick overflow");
    expect(owner.snapshot()).toEqual(before);
  });
  it("validates queued contact metadata, projectile identity and command ordering atomically", () => {
    const owner = create(); owner.step(1 / 60, { ...idle, cast: true });
    const before = owner.snapshot();
    const mutations = [
      (s: any) => { s.time = 1e308; },
      (s: any) => { s.inputClock = 1e308; },
      (s: any) => { s.player.id = "enemy"; },
      (s: any) => { s.nextId = 0; },
      (s: any) => { s.nextId = s.player.action.id; },
      (s: any) => { s.commands=[{kind:"dash",at:0,order:1,aim:0,heading:0},{kind:"cast",at:0,order:1,aim:0,heading:0}]; s.commandOrder=1; },
      (s: any) => { s.checkpoint.events[0].payload.heading = "invalid"; },
      (s: any) => { s.checkpoint.events[0].payload.outcome = "invalid"; },
      (s: any) => { const p={id:5,x:1,y:1,vx:1,vy:0,life:1,damage:1,owner:"player",hits:[]}; s.projectiles=[p,{...p}]; },
      (s: any) => { s.commands=[{kind:"dash",at:1e6,order:99,aim:0,heading:0}]; },
      (s: any) => { s.impacts=[{id:1,x:0,y:0,life:1,shake:0,sparks:0,color:0,moveId:{}}]; },
    ];
    for(const mutate of mutations) {
      const bad=structuredClone(before); mutate(bad);
      expect(() => owner.restore(bad)).toThrow(); expect(owner.snapshot()).toEqual(before);
    }
  });

  it("retains only the newest 512 events and restores the dropped-event count", () => {
    const owner = create(); owner.step(1 / 60, { ...idle, cast: true });
    const saved = owner.snapshot();
    const event = saved.checkpoint.events[0]!;
    saved.sequence = 512;
    saved.checkpoint.events = Array.from({length:512},(_,i)=>({...event,sequence:i+1}));
    saved.cast = 0; saved.player.action = undefined;
    saved.inputEdges = {dash:false,special:false,cast:false};
    owner.restore(saved);
    owner.step(1 / 60,{...idle,cast:true});
    const after = owner.snapshot();
    expect(after.sequence).toBeGreaterThan(512);
    expect(after.checkpoint.events).toHaveLength(512);
    expect(after.checkpoint.droppedEvents).toBe(after.sequence - 512);
    expect(after.checkpoint.events[0]!.sequence).toBe(after.checkpoint.droppedEvents+1);
    const restored=create(); restored.restore(JSON.parse(canonicalJson(after)));
    expect(restored.snapshot()).toEqual(after);
    expect(restored.drainEvents()).toEqual(owner.drainEvents());
  });
  it("rejects malformed input fields before mutation", () => {
    const owner=create(); const before=owner.snapshot();
    for(const input of [{...idle,cast:"yes"},{...idle,command:{}},{...idle,cancelled:1}]) {
      expect(()=>owner.step(1/60,input as unknown as ArenaInput)).toThrow("Invalid arena input");
      expect(owner.snapshot()).toEqual(before);
    }
  });

  it("stamps events with unscaled owner ticks through hit-stop and JSON restore", () => {
    for (const clock of ["fixed-60-v2", "legacy-delta-v1"] as const) {
      const owner = create(clock);
      const saved = owner.snapshot(); saved.scaleElapsed = -0.025; saved.scaleCooldown = 0.12;
      owner.restore(saved);
      owner.step(1 / 60, { ...idle, dash: true });
      expect(owner.state.time).toBe(0);
      expect(owner.drainEvents().map(event => event.tick)).toEqual([1]);
      const branch = create(clock); branch.restore(JSON.parse(canonicalJson(owner.snapshot())));
      owner.step(0, { ...idle, cancelled: true }); branch.step(0, { ...idle, cancelled: true });
      expect(owner.snapshot().checkpoint.ticks).toBe(1);
      for (const session of [owner, branch]) session.step(1 / 60, { ...idle, dash: true });
      expect(branch.drainEvents()).toEqual(owner.drainEvents());
      expect(branch.snapshot().checkpoint.ticks).toBe(2);
    }
  });
  it("rejects future event ticks and the former elapsed-time event rules identity atomically", () => {
    const owner = create(); owner.step(1 / 60, { ...idle, dash: true });
    const before = owner.snapshot();
    for (const mutate of [
      (s: typeof before) => { s.checkpoint.events[0]!.tick = s.checkpoint.ticks + 1; },
      (s: typeof before) => { s.checkpoint.rulesBuildId = "fixed-60-v2"; },
    ]) {
      const invalid = structuredClone(before); mutate(invalid);
      expect(() => owner.restore(invalid)).toThrow(); expect(owner.snapshot()).toEqual(before);
    }
  });

  it("keeps held dash, cast and special edge-triggered across grouped and sub-tick input", () => {
    for (const kind of ["dash", "cast", "special"] as const) {
      const grouped = create(), split = create();
      const held = { ...idle, [kind]: true };
      grouped.step(0.05, held);
      for (let i = 0; i < 6; i++) split.step(1 / 120, held);
      expect(grouped.state.commandOrder, kind).toBe(1);
      expect(split.snapshot(), kind).toEqual(grouped.snapshot());
    }
  });

});
