import { expect, it } from "vitest";
import { createKartRaceSession } from "./kart-race-session";
import { createKartTrack } from "./kart-track";
import { racingLineControl } from "./kart-race";
import { canonicalJson } from "./session-protocol";
it("finishes three real laps through discretized racing-line drive commands and replays checkpoint branches", () => {
  const seed = 419,
    a = createKartRaceSession(seed),
    b = createKartRaceSession(seed),
    track = createKartTrack(seed);
  let branches = 0;
  for (let i = 0; i < 16000; i++) {
    const state = a.snapshot();
    const control = racingLineControl(track, state.karts[0]!, state.karts, 0, [
      ...state.items.oil,
      ...state.items.projectiles,
    ]);
    const command = {
      kind: "drive" as const,
      throttle: control.throttle > 0.2,
      brake: control.brake > 0.2,
      steer: control.steer > 0.12 ? 1 : control.steer < -0.12 ? -1 : 0,
      drift: control.drift,
      useItem: i % 71 === 0,
      rescue: state.karts[0]!.stuck > 5,
    };
    a.command(command);
    b.command(command);
    if (i % 600 === 0) {
      b.restore(JSON.parse(JSON.stringify(a.snapshot())));
      branches++;
    }
    a.step(0.05);
    b.step(0.05);
    if (i % 600 === 0)
      expect(canonicalJson(b.snapshot())).toBe(canonicalJson(a.snapshot()));
    a.drainEvents();
    b.drainEvents();
    if (a.observe().phase === "finish") break;
  }
  const final = a.observe();
  expect(final.phase).toBe("finish");
  expect(final.progress[0]!.lap).toBe(3);
  expect(final.progress[0]!.finishTime).not.toBeNull();
  expect(final.progress[0]!.splits).toHaveLength(3);
  expect(b.snapshot()).toEqual(a.snapshot());
  expect(branches).toBeGreaterThan(2);
  console.log(
    JSON.stringify({
      seed,
      phase: final.phase,
      time: final.time,
      finishTime: final.progress[0]!.finishTime,
      splits: final.progress[0]!.splits,
      ticks: final.tick,
      branches,
      scope:
        "Discretized AI reference policy through public commands; not human play",
    }),
  );
}, 30000);
