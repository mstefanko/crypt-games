import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "./cryptball-matchmaking-motion.mjs";

function trace(
  sport,
  {
    jumpAt,
    faded = false,
    contactAt,
    scoreAt,
    ordinary = false,
    samePhase = false,
    protection = 0,
  } = {},
) {
  return Array.from({ length: 80 }, (_, i) => {
    const launch = i >= 10;
    const touched = ordinary || launch;
    const b = {
      tick: i,
      x: launch ? (i - 9) * 2 : 0,
      y: 0,
      z: 0,
      vx: launch ? 120 : 0,
      vy: 0,
      vz: 0,
      lastTouch: touched ? "p0" : null,
      restartTeam: 0,
      protection,
      serving: sport === "rift-volley" ? !launch : undefined,
      contactTick:
        sport === "rift-volley"
          ? i >= (contactAt ?? Infinity)
            ? 20
            : launch
              ? 10
              : 0
          : undefined,
    };
    if (i >= (jumpAt ?? Infinity)) b.x += 80;
    if (i >= (contactAt ?? Infinity)) b.lastTouch = "p1";
    return {
      at: i * 17,
      tick: i,
      screen: "play",
      phase: !samePhase && i === 9 ? "ready" : "play",
      epoch: 1,
      round: 1,
      score: i >= (scoreAt ?? Infinity) ? "1-0" : "0-0",
      covered: false,
      balls: [],
      bodies: [],
      pendingAuthorityTick: 0,
      ballAlpha: faded ? 0.5 : 1,
      evidence: {
        raw: { ...b, x: b.x + 3 },
        authority: { ...b },
        submitted: b,
      },
    };
  });
}
const launchFailures = (r) =>
  r.failures.filter((f) => f.kind.startsWith("excessive "));
for (const sport of ["cryptkick", "rift-volley"]) {
  test(`${sport}: benign ready/play and same-phase launches count once`, () => {
    for (const samePhase of [false, true]) {
      const r = inspect(sport, trace(sport, { samePhase }));
      assert.equal(r.launchOpportunities.length, 1);
      assert.equal(launchFailures(r).length, 0);
      assert.ok(r.launchOpportunities[0].samples.length > 5);
    }
  });
  test(`${sport}: deferred visible jumps fail once per opportunity`, () => {
    const f = trace(sport, { jumpAt: 14 });
    f[16].evidence.submitted.x += 100;
    const r = inspect(sport, f);
    assert.equal(r.launchOpportunities.length, 1);
    assert.equal(launchFailures(r).length, 1);
    assert.equal(launchFailures(r)[0].frame, 14);
  });
  test(`${sport}: faded fallback is separate and retains raw/drawn evidence`, () => {
    const r = inspect(sport, trace(sport, { jumpAt: 14, faded: true }));
    assert.equal(launchFailures(r).length, 0);
    assert.equal(r.launchOpportunities[0].fadedJumps, 1);
    const s = r.launchOpportunities[0].samples.find((s) => s.frame === 14);
    assert.equal(s.classification, "softened fallback");
    assert.equal(s.rawToDrawn, 3);
  });
  test(`${sport}: contact and score resets end launch window`, () => {
    for (const opts of [{ contactAt: 14 }, { scoreAt: 14 }]) {
      const r = inspect(sport, trace(sport, { jumpAt: 14, ...opts }));
      assert.equal(launchFailures(r).length, 0);
    }
  });
  test(`${sport}: jump outside window is excluded`, () => {
    assert.equal(
      launchFailures(inspect(sport, trace(sport, { jumpAt: 27 }))).length,
      0,
    );
  });
}
test("kick restart anchor survives expired protection; ordinary possession release excluded", () => {
  assert.equal(
    inspect("cryptkick", trace("cryptkick", { protection: 0 }))
      .launchOpportunities.length,
    1,
  );
  assert.equal(
    inspect("cryptkick", trace("cryptkick", { ordinary: true, protection: 30 }))
      .launchOpportunities.length,
    0,
  );
});
test("historical trace lacking evidence is labeled insufficient", () => {
  const f = trace("rift-volley");
  for (const frame of f) delete frame.evidence;
  const r = inspect("rift-volley", f);
  assert.ok(
    r.failures.some(
      (f) =>
        f.kind ===
        "insufficient historical evidence for restart/serve launch gate",
    ),
  );
});

test("focused free-kick scenario requires actual remote contact and waives unrelated pending-point coverage", () => {
  const f = trace("cryptkick");
  for (const frame of f) {
    delete frame.pendingAuthorityTick;
    const b = frame.evidence.submitted;
    b.possessionId = null;
    if (b.lastTouch) b.lastTouch = "player-2";
  }
  assert.ok(
    inspect("cryptkick", f, "kick-restart").failures.some(
      (f) =>
        f.kind ===
        "remote free kick did not exercise a late prediction correction",
    ),
  );
  for (const frame of f.slice(10)) frame.evidence.raw.x += 60;
  const r = inspect("cryptkick", f, "kick-restart");
  assert.equal(r.failures.length, 0);
  for (const frame of f)
    if (frame.evidence.submitted.lastTouch)
      frame.evidence.submitted.possessionId = "player-2";
  assert.ok(
    inspect("cryptkick", f, "kick-restart").failures.some(
      (f) =>
        f.kind === "focused fixture did not produce actual remote free kick",
    ),
  );
});
