import { expect, it } from "vitest";
import { CosmeticLedger } from "../src/online/cosmetics";
const event = (seq = 1, participantId = "p0", type = "swing", ordinal = 0) => ({
  type,
  tick: 10,
  origin: {
    epoch: 1,
    generation: 1,
    participantId,
    seq,
    eventKind: type,
    ordinal,
  },
});
it("predicts each local onset once and confirms against exact successful action origins", () => {
  const l = new CosmeticLedger(),
    e = event();
  expect(l.predict(e, "p0", 0)).toBe(true);
  expect(l.predict(e, "p0", 0)).toBe(false);
  expect(l.authority({ ...e, tick: 12 }, 100)).toBe(false);
  expect(l.confirmed).toBe(1);
  expect(l.authority(event(1, "p1"), 100)).toBe(true);
  expect(l.predict(event(1, "p0", "dash"), "p0", 0)).toBe(true);
  expect(l.predict(event(1, "p0", "swing", 1), "p0", 0)).toBe(true);
});
it("keeps contact and opponents authoritative, expires bounded unconfirmed predictions", () => {
  const l = new CosmeticLedger();
  expect(l.predict(event(1, "p1"), "p0", 0)).toBe(false);
  expect(l.predict(event(1, "p0", "goal"), "p0", 0)).toBe(false);
  for (let seq = 0; seq < 140; seq++) l.predict(event(seq), "p0", seq);
  expect(l.size).toBe(128);
  expect(l.expired).toBe(12);
  l.reject(139);
  expect(l.expired).toBe(13);
  l.reset();
  expect(l.size).toBe(0);
});
