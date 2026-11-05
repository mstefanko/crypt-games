import { expect, it } from "vitest";
import {
  assertPerformanceTakeV3,
  evaluateExpression,
  createTempoMap,
} from "@onepage/music-core/expressive-performance";
import { ExpressiveStreamQueue } from "./expressive-stream";
import { createExpressiveAudioFixture } from "./expressive-fixture";
const fixture = () => {
  const take = createExpressiveAudioFixture();
  return { take, header: { ...take, notes: [], controls: [] } };
};
it("commits onset-owned curves and replaces future part controls without another onset", () => {
  const { take, header } = fixture(),
    queue = new ExpressiveStreamQueue(1, header);
  expect(
    queue.submit({
      epoch: 1,
      revision: 0,
      startSeconds: 0,
      endSeconds: 2,
      notes: take.notes,
      controls: take.controls.filter((c) => c.noteId || c.timeSeconds < 2),
    }).status,
  ).toBe("accepted");
  const committed = queue.take(0.4);
  expect(committed.notes.map((n) => n.id)).toEqual(["held"]);
  expect(committed.controls.map((c) => c.id)).toEqual(["bend"]);
  expect(
    queue.submit({
      epoch: 1,
      revision: 1,
      startSeconds: 0.5,
      endSeconds: 4,
      notes: [],
      controls: [{ ...take.controls[1], id: "new-swell", timeSeconds: 0.8 }],
    }).status,
  ).toBe("accepted");
  expect(queue.take(4).notes).toEqual([]);
  expect(queue.getCapturedTake().controls.map((c) => c.id)).toEqual([
    "bend",
    "new-swell",
  ]);
});
it("rejects a bad atomic window without dropping its prior pending suffix", () => {
  const { take, header } = fixture(),
    queue = new ExpressiveStreamQueue(3, header);
  expect(
    queue.submit({
      epoch: 3,
      revision: 0,
      startSeconds: 0,
      endSeconds: 4,
      notes: take.notes,
      controls: take.controls,
    }).status,
  ).toBe("accepted");
  const before = structuredClone(queue.notes);
  expect(
    queue.submit({
      epoch: 3,
      revision: 1,
      startSeconds: 0,
      endSeconds: 4,
      notes: [],
      controls: [{ ...take.controls[1], partId: "missing" }],
    }).status,
  ).toBe("rejected");
  expect(queue.notes).toEqual(before);
  expect(queue.preparedThroughSeconds).toBe(4);
});
it("stale epochs, post-stop controls, same-pitch occupancy and dense controls fail before mutation", () => {
  const { take, header } = fixture(),
    queue = new ExpressiveStreamQueue(7, header, { maxVoices: 1 });
  const w = {
    epoch: 7,
    revision: 0,
    startSeconds: 0,
    endSeconds: 4,
    notes: take.notes,
    controls: take.controls,
  };
  expect(queue.submit({ ...w, epoch: 6 }).reason).toBe("stale-or-stopped");
  expect(
    queue.submit({
      ...w,
      notes: [take.notes[0], { ...take.notes[0], id: "overlap" }],
    }).reason,
  ).toBe("voice-budget");
  expect(
    queue.submit({
      ...w,
      controls: Array.from({ length: 257 }, (_, i) => ({
        ...take.controls[1],
        id: `dense-${i}`,
      })),
    }).reason,
  ).toBe("control-density-budget");
  expect(queue.notes).toEqual([]);
  queue.stop();
  expect(queue.submit(w).status).toBe("rejected");
  expect(queue.addControls(7, []).status).toBe("rejected");
});
it("immediate controls supersede only uncommitted controls of the same part lane", () => {
  const { take, header } = fixture(),
    queue = new ExpressiveStreamQueue(1, header);
  queue.submit({
    epoch: 1,
    revision: 0,
    startSeconds: 0,
    endSeconds: 4,
    notes: take.notes,
    controls: take.controls,
  });
  queue.take(0.4);
  const now = {
    ...take.controls[1],
    id: "urgent",
    timeSeconds: 0.45,
    value: 0.8,
    rampSeconds: 0.1,
  };
  expect(queue.addControls(1, [now]).status).toBe("accepted");
  expect(queue.controls.map((c) => c.id)).toEqual(["urgent", "pan"]);
  expect(queue.getCapturedTake().controls.map((c) => c.id)).toEqual(["bend"]);
});
it("rolls a 30-minute stream into a bounded self-contained take while retaining interrupted ramps", async () => {
  const { take } = fixture();
  take.lengthTicks = 576000;
  take.durationSeconds = 600;
  take.notes = [];
  take.controls = [];
  const queue = new ExpressiveStreamQueue(1, take, {
    rollingCaptureSeconds: 120,
  });
  const allControls: typeof take.controls = [];
  for (let start = 0; start < 1800; start += 10) {
    const note = {
      ...createExpressiveAudioFixture().notes[0],
      id: `held-${start}`,
      startTick: (start + 1) * 960,
      keyReleaseTick: (start + 4) * 960,
      endTick: (start + 4) * 960,
      startSeconds: start + 1,
      keyReleaseSeconds: start + 4,
      endSeconds: start + 4,
    };
    const control = {
      id: `expression-${start}`,
      partId: "lead",
      parameter: "expression" as const,
      timeSeconds: start + 2,
      value: start % 20 === 0 ? 0.25 : 0.8,
      rampSeconds: 20,
    };
    allControls.push(control);
    const receipt = queue.submit({
      epoch: 1,
      revision: 0,
      startSeconds: start,
      endSeconds: start + 10,
      notes: [note],
      controls: [control],
    });
    expect(receipt.status, `window ${start}: ${receipt.reason}`).toBe(
      "accepted",
    );
    queue.take(start + 10);
  }
  const captured = queue.getCapturedTake();
  assertPerformanceTakeV3(captured);
  expect(captured.notes.length).toBeLessThan(15);
  expect(captured.controls.length).toBeLessThan(15);
  expect(captured.durationSeconds).toBeLessThan(150);
  const origin = captured.provenance.captureOriginSeconds as number;
  expect(origin).toBeGreaterThan(1600);
  for (const seconds of [0, 1, 10, 30, 119]) {
    const actual = evaluateExpression(
      captured,
      { id: "probe", partId: "lead" },
      seconds,
    ).expression;
    const expected = evaluateExpression(
      { parts: take.parts, controls: allControls },
      { id: "probe", partId: "lead" },
      origin + seconds,
    ).expression;
    expect(actual).toBeCloseTo(expected, 10);
  }
});
it("idempotent retries cannot reattack a committed onset; rolling can resume beyond the frozen take cap", () => {
  const { take, header } = fixture(),
    queue = new ExpressiveStreamQueue(4, header);
  const window = {
    epoch: 4,
    revision: 0,
    startSeconds: 0,
    endSeconds: 4,
    notes: take.notes,
    controls: take.controls,
  };
  expect(queue.submit(window).status).toBe("accepted");
  queue.take(0.4);
  expect(queue.submit(window).reason).toBe("duplicate");
  expect(queue.take(1).notes).toEqual([]);
  header.lengthTicks = 576000;
  header.durationSeconds = 600;
  const resumed = new ExpressiveStreamQueue(
    5,
    header,
    { rollingCaptureSeconds: 120 },
    1800,
  );
  const note = {
    ...take.notes[0],
    startTick: 1800 * 960,
    keyReleaseTick: 1803 * 960,
    endTick: 1803 * 960,
    startSeconds: 1800,
    keyReleaseSeconds: 1803,
    endSeconds: 1803,
  };
  expect(
    resumed.submit({
      epoch: 5,
      revision: 0,
      startSeconds: 1800,
      endSeconds: 1804,
      notes: [note],
      controls: [],
    }).status,
  ).toBe("accepted");
  resumed.take(1801);
  const capture = resumed.getCapturedTake();
  assertPerformanceTakeV3(capture);
  expect(capture.notes[0].startSeconds).toBe(0);
  expect(capture.durationSeconds).toBe(4);
});
it("retains notes inside rolling preroll and declares the faithful boundary when earlier tails are omitted", () => {
  const take = createExpressiveAudioFixture();
  take.lengthTicks = 43200;
  take.durationSeconds = 45;
  take.notes = [];
  take.controls = [];
  const note = (id: string, start: number, end: number) => ({
    ...createExpressiveAudioFixture().notes[0],
    id,
    startTick: start * 960,
    startSeconds: start,
    keyReleaseTick: end * 960,
    endTick: end * 960,
    keyReleaseSeconds: end,
    endSeconds: end,
  });
  const queue = new ExpressiveStreamQueue(1, take, {
    rollingCaptureSeconds: 30,
  });
  expect(
    queue.submit({
      epoch: 1,
      revision: 0,
      startSeconds: 0,
      endSeconds: 20,
      notes: [
        note("earlier-tail", 8, 11),
        note("held", 10, 35),
        note("preroll-melody", 12, 13),
      ],
      controls: [
        {
          id: "prior-ramp",
          partId: "lead",
          parameter: "expression",
          timeSeconds: 7,
          value: 0.5,
          rampSeconds: 5,
          sourceTick: 6720,
        },
      ],
    }).status,
  ).toBe("accepted");
  queue.take(20);
  expect(
    queue.submit({
      epoch: 1,
      revision: 0,
      startSeconds: 20,
      endSeconds: 45,
      notes: [],
      controls: [],
    }).status,
  ).toBe("accepted");
  queue.take(45);
  const captured = queue.getCapturedTake();
  assertPerformanceTakeV3(captured);
  expect(captured.notes.map((n) => n.id)).toEqual(["held", "preroll-melody"]);
  expect(captured.provenance.captureOriginSeconds).toBe(10);
  expect(captured.provenance.captureFaithfulFromSeconds).toBe(5);
  expect(
    captured.provenance.diagnostics.some(
      (d) => d.code === "rolling-capture-preroll",
    ),
  ).toBe(true);
  expect(captured.controls[0].sourceTick).toBeUndefined();
  expect(captured.provenance.capturePriorSourceTicks).toEqual({
    "prior-ramp": 6720,
  });
});
it("declines hidden pre-onset note state in the rolling profile before any notes commit", () => {
  const take = createExpressiveAudioFixture();
  take.lengthTicks = 57600;
  take.durationSeconds = 60;
  const queue = new ExpressiveStreamQueue(
    1,
    { ...take, notes: [], controls: [] },
    { rollingCaptureSeconds: 30 },
  );
  expect(
    queue.submit({
      epoch: 1,
      revision: 0,
      startSeconds: 0,
      endSeconds: 4,
      notes: take.notes,
      controls: [{ ...take.controls[0], timeSeconds: 0 }],
    }).reason,
  ).toBe("rolling-note-control-precedes-onset");
  expect(queue.notes).toEqual([]);
});

it("rebases a predeclared changing tempo and meter across rolling origins with faithful note times and ramps", () => {
  const take = createExpressiveAudioFixture();
  take.tempoMap = [
    { tick: 0, microsecondsPerBeat: 500000 },
    { tick: 19200, microsecondsPerBeat: 1000000 },
    { tick: 33600, microsecondsPerBeat: 250000 },
  ];
  take.meterMap = [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 19200, numerator: 3, denominator: 4 },
    { tick: 33600, numerator: 4, denominator: 4 },
  ];
  const clock = createTempoMap(take.ppq, take.tempoMap);
  take.lengthTicks = clock.secondsToTick(60);
  take.durationSeconds = 60;
  take.notes = [];
  take.controls = [];
  const makeNote = (id: string, start: number, end: number) => ({
    ...createExpressiveAudioFixture().notes[0],
    id,
    startTick: clock.secondsToTick(start),
    startSeconds: start,
    keyReleaseTick: clock.secondsToTick(end),
    endTick: clock.secondsToTick(end),
    keyReleaseSeconds: end,
    endSeconds: end,
  });
  const controls = [
    {
      id: "cross-tempo-ramp",
      partId: "lead",
      parameter: "expression" as const,
      timeSeconds: 10,
      value: 0.25,
      rampSeconds: 60,
      sourceTick: clock.secondsToTick(10),
    },
  ];
  const queue = new ExpressiveStreamQueue(1, take, {
    rollingCaptureSeconds: 30,
  });
  for (let start = 0; start < 80; start += 20) {
    const notes =
      start === 0
        ? [makeNote("held", 15, 40)]
        : start === 40
          ? [makeNote("later", 45, 65)]
          : [];
    expect(
      queue.submit({
        epoch: 1,
        revision: 0,
        startSeconds: start,
        endSeconds: start + 20,
        notes,
        controls: start === 0 ? controls : [],
      }).status,
    ).toBe("accepted");
    queue.take(start + 20);
    if (start < 40) continue;
    const capture = queue.getCapturedTake();
    assertPerformanceTakeV3(capture);
    const origin = start === 40 ? 15 : 45;
    expect(queue.captureOriginSeconds).toBe(origin);
    expect(capture.provenance.captureOriginSeconds).toBe(origin);
    expect(capture.provenance.captureFaithfulFromSeconds).toBe(
      start + 20 - 30 - origin,
    );
    expect(capture.notes[0].startSeconds).toBe(0);
    expect(capture.tempoMap[0].microsecondsPerBeat).toBe(
      start === 40 ? 500000 : 1000000,
    );
    expect(capture.meterMap[0].numerator).toBe(start === 40 ? 4 : 3);
    const rebased = createTempoMap(capture.ppq, capture.tempoMap);
    for (const note of capture.notes)
      expect(rebased.tickToSeconds(note.endTick)).toBeCloseTo(
        note.endSeconds,
        10,
      );
    for (const seconds of [0, 5, 10, 15]) {
      expect(
        evaluateExpression(capture, { id: "probe", partId: "lead" }, seconds)
          .expression,
      ).toBeCloseTo(
        evaluateExpression(
          { parts: take.parts, controls },
          { id: "probe", partId: "lead" },
          origin + seconds,
        ).expression,
        10,
      );
    }
  }
});

it("resumes a rolling stream beyond the finite capture domain using the last declared tempo", () => {
  const take = createExpressiveAudioFixture();
  take.notes = [];
  take.controls = [];
  take.tempoMap.push({ tick: 1920, microsecondsPerBeat: 1000000 });
  take.durationSeconds = 6;
  const queue = new ExpressiveStreamQueue(
    1,
    take,
    { rollingCaptureSeconds: 30 },
    1800,
  );
  const at = (seconds: number) => 1920 + (seconds - 2) * 480;
  const note = {
    ...createExpressiveAudioFixture().notes[0],
    startTick: at(1800),
    startSeconds: 1800,
    endTick: at(1803),
    keyReleaseTick: at(1803),
    endSeconds: 1803,
    keyReleaseSeconds: 1803,
  };
  expect(
    queue.submit({
      epoch: 1,
      revision: 0,
      startSeconds: 1800,
      endSeconds: 1804,
      notes: [note],
      controls: [],
    }).status,
  ).toBe("accepted");
  queue.take(1801);
  const capture = queue.getCapturedTake();
  assertPerformanceTakeV3(capture);
  expect(capture.durationSeconds).toBe(4);
  expect(capture.tempoMap).toEqual([{ tick: 0, microsecondsPerBeat: 1000000 }]);
  expect(capture.notes[0].endSeconds).toBe(3);
});
