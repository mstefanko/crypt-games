import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { CampaignStorage } from "./storage";
import {
  prepareCampaignRecovery,
  makeBackup,
  encodeBackup,
  BACKUP_BYTES,
  CampaignError,
} from "../m5/campaign-codec";
import { ADVENTURE_FIXTURE as defs } from "../../../../examples/game-m3/project";
const minimal = readFileSync(
  "tests/game/fixtures/m5-campaign/minimal-v1.json",
  "utf8",
);
const rewarded = readFileSync(
  "tests/game/fixtures/m5-campaign/reward-return-v1.json",
  "utf8",
);
function fixture() {
  const data = new Map<string, string>(),
    messages: string[] = [];
  let denied = false;
  const store = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (denied) throw Error("Quota");
      data.set(key, value);
    },
  };
  return {
    data,
    messages,
    store,
    deny: () => (denied = true),
    allow: () => (denied = false),
    adapter: new CampaignStorage(
      (m) => messages.push(m),
      () => store,
      { definitions: defs },
    ),
  };
}
describe("M5 atomic bounded campaign storage", () => {
  it("publishes one record with one previous and preserves legacy input untouched", () => {
    const { data, adapter } = fixture();
    data.set(adapter.legacyKey, minimal);
    expect(adapter.read()).toBe(minimal);
    expect(adapter.needsMigration).toBe(true);
    expect(adapter.write(rewarded)).toBe(true);
    expect(data.get(adapter.legacyKey)).toBe(minimal);
    const saved = prepareCampaignRecovery(defs, data.get(adapter.key)!);
    expect(saved.payload).toBe(rewarded);
    expect(saved.previous).toBe(minimal);
    expect(saved.original).toBe(minimal);
    expect(adapter.key).toContain(":campaign:v2:");
    expect(adapter.write(minimal)).toBe(true);
    expect(prepareCampaignRecovery(defs, data.get(adapter.key)!).previous).toBe(
      rewarded,
    );
  });
  it("keeps latest dirty memory after denial/quota and never rereads older persisted bytes over it", () => {
    const f = fixture();
    f.adapter.write(minimal);
    const prior = f.data.get(f.adapter.key);
    f.deny();
    expect(f.adapter.write(rewarded)).toBe(false);
    expect(f.data.get(f.adapter.key)).toBe(prior);
    expect(f.adapter.read()).toBe(rewarded);
    expect(f.messages.join()).toMatch(/memory/);
    expect(
      prepareCampaignRecovery(defs, f.adapter.exportBackup()).payload,
    ).toBe(rewarded);
    f.allow();
    expect(f.adapter.write(rewarded)).toBe(true);
    const denied = new CampaignStorage(
      () => {},
      () => {
        throw Error("Denied");
      },
      { definitions: defs },
    );
    expect(denied.commit(minimal)).toBe("memory");
    expect(denied.read()).toBe(minimal);
  });
  it("rejects malformed imports before storage mutation and retains exact bounded invalid UTF8 bytes", () => {
    const f = fixture();
    f.adapter.write(minimal);
    const prior = f.data.get(f.adapter.key);
    const raw = new Uint8Array([0xff, 0x00, 0x80]);
    f.adapter.preserveRejected(raw);
    raw[0] = 0;
    expect(f.adapter.exportOriginal()).toEqual(
      new Uint8Array([0xff, 0x00, 0x80]),
    );
    expect(() => f.adapter.commit('{"version":99}')).toThrow();
    expect(f.data.get(f.adapter.key)).toBe(prior);
    expect(f.adapter.memoryBytes).toBe(minimal);
    expect(() =>
      f.adapter.preserveRejected(new Uint8Array(BACKUP_BYTES + 1)),
    ).toThrow();
    expect(f.adapter.exportOriginal()).toEqual(
      new Uint8Array([0xff, 0x00, 0x80]),
    );
  });
  it("detects competing writer and storage-event conflicts without clobbering either durable or dirty progress", () => {
    const f = fixture(),
      second = new CampaignStorage(
        () => {},
        () => f.store,
        { definitions: defs },
      );
    f.adapter.write(minimal);
    second.read();
    f.adapter.write(rewarded);
    const prior = f.data.get(f.adapter.key);
    expect(() => second.commit(minimal)).toThrow(/CONFLICT/);
    expect(f.data.get(f.adapter.key)).toBe(prior);
    expect(second.write(rewarded)).toBe(false);
    expect(() => second.read()).toThrow(/CONFLICT/);
    expect(second.memoryBytes).toBe(rewarded);
    const third = new CampaignStorage(
      () => {},
      () => f.store,
      { definitions: defs },
    );
    third.read();
    third.changed(third.key, "different");
    expect(() => third.commit(minimal)).toThrow(/CONFLICT/);
  });
  it("refuses fresh Save over corrupt current and preserves recoverable previous across retries", () => {
    const f = fixture();
    const record = makeBackup(defs, rewarded, minimal);
    record.current.hash = "sha256:" + "0".repeat(64);
    const raw = encodeBackup(record);
    f.data.set(f.adapter.key, raw);
    for (let i = 0; i < 2; i++) {
      expect(() => f.adapter.write(rewarded)).toThrow(/HASH/);
      expect(f.data.get(f.adapter.key)).toBe(raw);
      expect(new TextDecoder().decode(f.adapter.exportOriginal()!)).toBe(raw);
    }
    expect(f.adapter.previous()).toBe(minimal);
    expect(f.adapter.write(rewarded)).toBe(true);
    expect(
      prepareCampaignRecovery(defs, f.data.get(f.adapter.key)!).previous,
    ).toBe(minimal);
  });
  it("reports a conflict when Load has no local campaign", () => {
    const f = fixture();
    expect(f.adapter.read()).toBe(null);
    f.data.set(f.adapter.key, encodeBackup(makeBackup(defs, minimal)));
    expect(() => f.adapter.read()).toThrow(/CONFLICT/);
  });
  it("explicitly validates/replaces a corrupt primary from a good previous without changing primary during preparation", () => {
    const f = fixture();
    f.adapter.write(minimal);
    f.adapter.write(rewarded);
    const record = JSON.parse(f.data.get(f.adapter.key)!);
    record.current.hash = "sha256:" + "0".repeat(64);
    f.data.set(f.adapter.key, JSON.stringify(record));
    const fresh = new CampaignStorage(
      () => {},
      () => f.store,
      { definitions: defs },
    );
    expect(() => fresh.read()).toThrow(/HASH/);
    const before = f.data.get(f.adapter.key);
    expect(fresh.previous()).toBe(minimal);
    expect(f.data.get(f.adapter.key)).toBe(before);
    expect(fresh.commit(minimal)).toBe("durable");
    expect(
      prepareCampaignRecovery(defs, f.data.get(f.adapter.key)!).payload,
    ).toBe(minimal);
    expect(new TextDecoder().decode(fresh.exportOriginal()!)).toBe(before);
    fresh.read();
    expect(new TextDecoder().decode(fresh.exportStoredOriginal()!)).toBe(
      before,
    );
    expect(new TextDecoder().decode(fresh.exportOriginal()!)).toBe(before);
  });
  it("retains exact whitespace legacy originals and imported verified backup provenance", () => {
    const f = fixture(),
      legacy = " \n" + minimal + "\n ";
    f.data.set(f.adapter.legacyKey, legacy);
    f.adapter.read();
    f.adapter.commit(minimal);
    expect(new TextDecoder().decode(f.adapter.exportOriginal()!)).toBe(legacy);
    f.adapter.read();
    expect(new TextDecoder().decode(f.adapter.exportStoredOriginal()!)).toBe(
      legacy,
    );
    expect(
      prepareCampaignRecovery(defs, f.data.get(f.adapter.key)!).original,
    ).toBe(legacy);
    const imported = encodeBackup(makeBackup(defs, rewarded, minimal, legacy));
    f.adapter.preserveRejected(imported);
    const candidate = prepareCampaignRecovery(defs, imported);
    f.adapter.commit(candidate.payload, candidate.original);
    expect(new TextDecoder().decode(f.adapter.exportOriginal()!)).toBe(
      imported,
    );
    f.adapter.read();
    f.adapter.previous();
    expect(new TextDecoder().decode(f.adapter.exportOriginal()!)).toBe(
      imported,
    );
    expect(
      prepareCampaignRecovery(defs, f.adapter.exportBackup()).original,
    ).toBe(legacy);
  });
  it("refuses external recovery over a malformed primary and retains both exact inputs", () => {
    const f = fixture();
    f.data.set(f.adapter.key, "{broken");
    const original = " \n" + rewarded + "\n ";
    f.adapter.preserveRejected(original);
    expect(() => f.adapter.commit(rewarded, original)).toThrow(/JSON/);
    expect(() => f.adapter.commit(rewarded, original)).toThrow(/JSON/);
    expect(new TextDecoder().decode(f.adapter.exportStoredOriginal()!)).toBe(
      "{broken",
    );
    expect(new TextDecoder().decode(f.adapter.exportOriginal()!)).toBe(
      original,
    );
    expect(f.data.get(f.adapter.key)).toBe("{broken");
  });
  it("reports malformed durable entries as corruption and retains original without replacing prior memory", () => {
    const f = fixture();
    f.adapter.write(minimal);
    const trusted = f.adapter.memoryBytes;
    for (const entry of [
      null,
      [],
      {},
      { ...makeBackup(defs, rewarded).current, extra: true },
    ]) {
      const record = makeBackup(defs, rewarded, minimal);
      record.current = entry as any;
      const original = JSON.stringify(record);
      f.data.set(f.adapter.key, original);
      const fresh = new CampaignStorage(
        (message) => f.messages.push(message),
        () => f.store,
        { definitions: defs },
      );
      let caught: unknown;
      try {
        fresh.read();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CampaignError);
      expect((caught as CampaignError).code).toBe("CAMPAIGN_ENTRY");
      expect(f.messages.at(-1)).toMatch(/CAMPAIGN_ENTRY/);
      expect(f.messages.at(-1)).not.toMatch(/storage denied/i);
      expect(new TextDecoder().decode(fresh.exportOriginal()!)).toBe(original);
      expect(f.data.get(f.adapter.key)).toBe(original);
      expect(fresh.memoryBytes).toBe(null);
      expect(f.adapter.memoryBytes).toBe(trusted);
    }
  });
  it("separates stable game/slot namespaces and rejects invalid IDs", () => {
    const f = fixture();
    const other = new CampaignStorage(
      () => {},
      () => f.store,
      { definitions: { ...defs, gameId: "other-game" }, slot: "main" },
    );
    expect(other.key).not.toBe(f.adapter.key);
    expect(other.read()).toBe(null);
    expect(f.adapter.legacyKey).toBe(
      `pocket-game:${defs.gameId}:campaign:v1:main`,
    );
    for (const version of ["v1", "v2"]) {
      const left = new CampaignStorage(
        () => {},
        () => f.store,
        {
          definitions: { ...defs, gameId: "a" },
          slot: `b:campaign:${version}:c`,
        },
      );
      const right = new CampaignStorage(
        () => {},
        () => f.store,
        {
          definitions: { ...defs, gameId: `a:campaign:${version}:b` },
          slot: "c",
        },
      );
      expect(left.key).not.toBe(right.key);
      expect(left.legacyKey).not.toBe(right.legacyKey);
      f.data.set(
        `pocket-game:a:campaign:${version}:b:campaign:${version}:c`,
        minimal,
      );
      expect(left.read()).toBe(null);
      expect(right.read()).toBe(null);
    }
    expect(
      () =>
        new CampaignStorage(
          () => {},
          () => f.store,
          { definitions: defs, slot: "../bad" },
        ),
    ).toThrow(/SLOT/);
  });
});
