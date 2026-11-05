import { expect, it, vi } from "vitest";
import {
  NarrativePresenter,
  validateNarrativePresentation,
} from "./narrative-presenter";
import type { NarrativeSession } from "@onepage/game-simulation/narrative";

function fixture() {
  const state = {
    scene: "room",
    revision: 8,
    cues: [{ id: 1, kind: "discovery" }],
    reveal: { success: true, remaining: 0.8 },
    player: { x: 0, y: 0 },
    path: [],
  };
  const session = { state, scene: { id: "room", hotspots: [] } };
  const cue = vi.fn();
  const presenter = new NarrativePresenter(
    session as unknown as NarrativeSession,
    cue,
    {
      atlasUrl: "unused",
      scenes: {
        room: {
          bounds: { x: 0, y: 0, width: 1, height: 1 },
          grid: { x: 0, y: 0, cellWidth: 1, cellHeight: 1 },
          background: 0,
          tileLayers: [],
          props: [],
          hotspots: {},
          actors: {
            investigator: {
              role: "investigator",
              scale: 1,
              facing: "down",
              clips: { idle: "idle", walk: "walk", interact: "interact" },
            },
          },
        },
      },
    },
    () => true,
  );
  const internal = presenter as any;
  internal.ready = true;
  internal.scene = () => {};
  internal.controls = () => {};
  internal.atlas.clip = () => undefined;
  internal.actor.sample = () => {};
  return { presenter, cue, state };
}

it("preserves pending cues before mount and plays each unstarted cue once after restore", () => {
  const { presenter, cue } = fixture();
  const saved = {
    queue: {
      epoch: 0,
      paused: [],
      seen: ["narrative:1", "dice:8"],
      pending: [
        { id: "narrative:1", time: 0, started: false },
        { id: "dice:8", time: 0, started: false },
      ],
    },
    cueCursor: 1,
    revealId: 8,
    textScale: 18,
  };
  presenter.restore(saved);
  expect(presenter.snapshot()).toMatchObject(saved);
  presenter.render(0.01);
  expect(cue.mock.calls).toEqual([["discovery"], ["check-success"]]);
  presenter.render(0.01);
  expect(cue).toHaveBeenCalledTimes(2);
  const resumed = fixture();
  resumed.presenter.restore(presenter.snapshot());
  resumed.presenter.render(0.01);
  expect(resumed.cue).not.toHaveBeenCalled();
});

it("does not replay started audio or a historical save's acknowledged reveal", () => {
  const { presenter, cue } = fixture();
  presenter.restore({
    queue: {
      epoch: 0,
      paused: [],
      seen: ["narrative:1"],
      pending: [{ id: "narrative:1", time: 0.1, started: true }],
    },
    cueCursor: 1,
    textScale: 18,
  });
  presenter.render(0.01);
  expect(cue).not.toHaveBeenCalled();
});

it("keeps unseen post-save cues and rejects invalid reveal acknowledgement atomically", () => {
  const { presenter, cue } = fixture();
  presenter.restore({
    queue: { epoch: 0, paused: [], seen: [], pending: [] },
    cueCursor: 0,
    revealId: -1,
  });
  const before = presenter.snapshot();
  expect(() => presenter.restore({ revealId: -2 })).toThrow();
  expect(presenter.snapshot()).toEqual(before);
  expect(() => validateNarrativePresentation({ revealId: NaN })).toThrow();
  presenter.render(0.01);
  expect(cue.mock.calls).toEqual([["discovery"], ["check-success"]]);
});

it("rebinds a pending cue after the bounded simulation trace has forgotten it", () => {
  const { presenter, cue, state } = fixture();
  state.cues = [];
  presenter.restore({
    queue: {
      epoch: 0,
      paused: [],
      seen: ["narrative:1"],
      pending: [{ id: "narrative:1", time: 0, started: false }],
    },
    pendingCues: [{ id: "narrative:1", kind: "discovery" }],
    cueCursor: 1,
    revealId: 8,
  });
  const saved = presenter.snapshot();
  expect(saved).toMatchObject({
    pendingCues: [{ id: "narrative:1", kind: "discovery" }],
  });
  expect(() =>
    presenter.restore({
      ...(saved as object),
      pendingCues: [{ id: "missing", kind: "discovery" }],
    }),
  ).toThrow();
  expect(presenter.snapshot()).toEqual(saved);
  presenter.render(0.01);
  expect(cue.mock.calls).toEqual([["discovery"]]);
});

it("resets queue acknowledgements when rewinding without presentation and reusing cue ids", () => {
  const { presenter, cue, state } = fixture();
  presenter.render(0.01);
  expect(cue.mock.calls).toEqual([["discovery"], ["check-success"]]);
  presenter.restore(undefined);
  state.cues = [{ id: 1, kind: "new-branch" }];
  presenter.render(0.01);
  expect(cue.mock.calls).toEqual([
    ["discovery"],
    ["check-success"],
    ["new-branch"],
    ["check-success"],
  ]);
});
