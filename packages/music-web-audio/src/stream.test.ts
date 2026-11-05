import { expect, it } from "vitest";
import { createBlankScore } from "@onepage/project";
import { StreamQueue } from "./stream";
const score = createBlankScore();
const config = { bpm: 120, tracks: score.tracks, patches: score.patches };
const note = (id: string, startTick: number, durationTicks = 2400) => ({
  id,
  trackId: score.tracks[0].id,
  patchId: score.patches[0].id,
  startTick,
  durationTicks,
  pitch: 60,
  velocity: 0.5,
  gain: score.tracks[0].gain,
  pan: score.tracks[0].pan,
  priority: 1,
  optional: false,
});
it("owns onset once and preserves true duration across windows", () => {
  const q = new StreamQueue(1, config);
  expect(
    q.submit({
      epoch: 1,
      id: "a",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: [note("held", 1800)],
    }).status,
  ).toBe("accepted");
  expect(q.take(1920)).toEqual([note("held", 1800)]);
  expect(
    q.submit({
      epoch: 1,
      id: "b",
      revision: 0,
      startTick: 1920,
      endTick: 3840,
      notes: [],
    }).status,
  ).toBe("accepted");
  expect(q.take(3840)).toEqual([]);
});
it("atomically replaces only complete unscheduled bar suffixes", () => {
  const q = new StreamQueue(4, config);
  q.submit({
    epoch: 4,
    id: "a",
    revision: 0,
    startTick: 0,
    endTick: 3840,
    notes: [note("old", 1920)],
  });
  q.take(100);
  expect(
    q.submit({
      epoch: 4,
      id: "race",
      revision: 1,
      startTick: 0,
      endTick: 1920,
      notes: [],
    }).status,
  ).toBe("rejected");
  expect(
    q.submit({
      epoch: 4,
      id: "replace",
      revision: 1,
      startTick: 1920,
      endTick: 3840,
      notes: [note("new", 1920)],
    }).status,
  ).toBe("accepted");
  expect(q.notes.map((n) => n.id)).toEqual(["new"]);
  const before = structuredClone(q.notes);
  expect(
    q.submit({
      epoch: 4,
      id: "bad",
      revision: 2,
      startTick: 1920,
      endTick: 3840,
      notes: [note("bad", 4000)],
    }).status,
  ).toBe("rejected");
  expect(q.notes).toEqual(before);
  expect(
    q.submit({
      epoch: 3,
      id: "stale",
      revision: 2,
      startTick: 3840,
      endTick: 5760,
      notes: [],
    }).status,
  ).toBe("rejected");
});
it("repeated window IDs are idempotent and changed reuse is rejected", () => {
  const q = new StreamQueue(1, config),
    w = {
      epoch: 1,
      id: "a",
      revision: 0,
      startTick: 0,
      endTick: 1920,
      notes: [note("n", 0)],
    };
  expect(q.submit(w).status).toBe("accepted");
  expect(q.submit(w).reason).toBe("duplicate");
  expect(q.submit({ ...w, notes: [] }).status).toBe("rejected");
});
it("admits a qualified long one-shot without expanding onset coverage or legacy bounds", () => {
  const window = {epoch:1,id:"one-shot",revision:0,startTick:0,endTick:1920,notes:[note("natural",0,5376)]};
  expect(new StreamQueue(1,config).submit(window).status).toBe("rejected");
  const qualified = new StreamQueue(1,{...config,maxNoteDurationTicksByPatch:{[score.patches[0].id]:5760}});
  expect(qualified.submit(window).status).toBe("accepted");
  expect(qualified.take(1)[0].durationTicks).toBe(5376);
  expect(qualified.submit({...window,id:"too-far",startTick:1920,endTick:7680,notes:[]}).status).toBe("rejected");
  expect(()=>new StreamQueue(1,{...config,maxNoteDurationTicksByPatch:{[score.patches[0].id]:9601}})).toThrow();
});
