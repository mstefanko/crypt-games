import { describe, expect, it, vi } from "vitest";
import {
  CampaignPlatformSession,
  prepareCampaignPlatformRecovery,
  CampaignPlatformRecoveryError,
  type CampaignRoomLoad,
  type CampaignRoomResources,
  type CampaignRoomLoader,
} from "./campaign-platform";
import {
  CAMPAIGN_PLATFORM_FIXTURE as authored,
  CAMPAIGN_PLATFORM_FIXTURE_DEFINITIONS as definitions,
  CAMPAIGN_PLATFORM_FIXTURE_IDENTITY as identity,
} from "@onepage/game-simulation/campaign-platform-fixture";
import { neutralHeld } from "@onepage/game-simulation/platform";
const fixture = () =>
  new CampaignPlatformSession(definitions, identity, authored);
const move = (owner: CampaignPlatformSession, axis: number, ticks: number) => {
  for (let i = 0; i < ticks; i++)
    owner.step({
      slots: [
        { slot: 0, held: neutralHeld(), axes: { moveX: axis }, edges: [] },
      ],
    });
};
const prepared = (
  request: CampaignRoomLoad,
  released: string[],
): CampaignRoomResources => ({
  ...request,
  dispose() {
    released.push(request.roomId);
  },
});
const loader =
  (released: string[] = []): CampaignRoomLoader =>
  async (request) =>
    prepared(request, released);
const deferred = () => {
  let resolve!: (value: CampaignRoomResources) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<CampaignRoomResources>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const unlock = async (owner: CampaignPlatformSession) => {
  move(owner, 127, 26);
  await owner.travel("to-shrine", loader());
  move(owner, 127, 26);
  owner.pickup("phase");
  move(owner, -127, 26);
  await owner.travel("to-hall", loader());
};

describe("campaign platform runtime resource staging", () => {
  it("rejects invalid recovery inputs without reading fields or loading resources", async () => {
    const target = fixture(),
      before = target.checkpoint(),
      load = vi.fn(loader());
    let reads = 0;
    const hostile = {
      get length() {
        reads++;
        throw Error("getter");
      },
    };
    for (const input of [null, undefined, 42, {}, [], hostile]) {
      const result = prepareCampaignPlatformRecovery(
        definitions,
        identity,
        authored,
        input,
      );
      expect(result.status).toBe("rejected");
      expect(result.original).toBe(input);
      const error = await target
        .restoreProgress(input, load)
        .catch((error) => error);
      expect(error).toBeInstanceOf(CampaignPlatformRecoveryError);
      expect(error.original).toBe(input);
      expect(target.checkpoint()).toBe(before);
    }
    expect(reads).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
  it("detaches retained Node Buffer bytes from the caller", () => {
    const input = Buffer.from([255, 254, 0]);
    const result = prepareCampaignPlatformRecovery(
      definitions,
      identity,
      authored,
      input,
    );
    expect(result.status).toBe("rejected");
    input.fill(0);
    expect(result.original).toEqual(new Uint8Array([255, 254, 0]));
    if (result.status === "rejected")
      expect(result.error.original).toEqual(result.original);
  });
  it("publishes prepared resources and campaign together, then disposes the previous handle", async () => {
    const owner = fixture(),
      released: string[] = [];
    move(owner, 127, 26);
    const pending = deferred(),
      before = owner.checkpoint();
    const request = owner.travel("to-shrine", () => pending.promise);
    expect(owner.checkpoint()).toBe(before);
    expect(released).toEqual([]);
    pending.resolve(
      prepared({ roomId: "shrine", assetIds: ["shrine-palette"] }, released),
    );
    expect(await request).toEqual({ status: "committed", roomId: "shrine" });
    await owner.travel("to-hall", loader(released));
    expect(released).toEqual(["shrine"]);
    owner.dispose();
    owner.dispose();
    expect(released).toEqual(["shrine", "hall"]);
  });
  it("retains all authority on failed load, and retry commits a gate reward exactly once", async () => {
    const owner = fixture();
    await unlock(owner);
    const before = owner.checkpoint();
    await expect(
      owner.travel("sealed-door", async () => {
        throw Error("asset fetch failed");
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(owner.checkpoint()).toBe(before);
    expect(await owner.travel("sealed-door", loader())).toEqual({
      status: "committed",
      roomId: "vault",
    });
    expect(owner.observation().transactions.resources).toEqual([
      { id: "coins", quantity: 1 },
    ]);
    await owner.travel("to-hall", loader());
    await owner.travel("sealed-door", loader());
    expect(owner.observation().transactions.resources).toEqual([
      { id: "coins", quantity: 1 },
    ]);
    expect(owner.observation().transactions.outcomes).toEqual([
      "phase-shrine",
      "vault-opened",
    ]);
  });
  it("rejects wrong/missing/duplicated assets and releases the staged handle", async () => {
    for (const variant of [
      { roomId: "hall", assetIds: ["shrine-palette"] },
      { roomId: "shrine", assetIds: [] },
      { roomId: "shrine", assetIds: ["shrine-palette", "shrine-palette"] },
    ]) {
      const owner = fixture(),
        released: string[] = [];
      move(owner, 127, 26);
      const before = owner.checkpoint();
      await expect(
        owner.travel("to-shrine", async () => prepared(variant, released)),
      ).rejects.toThrow(/mismatch/);
      expect(owner.checkpoint()).toBe(before);
      expect(released).toEqual([variant.roomId]);
    }
  });
  it("discards a completion after input changed the source revision", async () => {
    const owner = fixture(),
      pending = deferred(),
      released: string[] = [];
    move(owner, 127, 26);
    const request = owner.travel("to-shrine", () => pending.promise);
    move(owner, 0, 1);
    const before = owner.checkpoint();
    pending.resolve(
      prepared({ roomId: "shrine", assetIds: ["shrine-palette"] }, released),
    );
    expect(await request).toEqual({ status: "stale", roomId: "shrine" });
    expect(owner.checkpoint()).toBe(before);
    expect(released).toEqual(["shrine"]);
  });
  it("lets the latest load win and releases older late completions without duplicate outcomes", async () => {
    const owner = fixture();
    await unlock(owner);
    const first = deferred(),
      second = deferred(),
      released: string[] = [];
    const a = owner.travel("sealed-door", () => first.promise),
      b = owner.travel("sealed-door", () => second.promise);
    second.resolve(
      prepared({ roomId: "vault", assetIds: ["vault-palette"] }, released),
    );
    expect((await b).status).toBe("committed");
    const before = owner.checkpoint();
    first.resolve(
      prepared({ roomId: "vault", assetIds: ["vault-palette"] }, released),
    );
    expect((await a).status).toBe("stale");
    expect(owner.checkpoint()).toBe(before);
    expect(released).toEqual(["vault"]);
    expect(owner.observation().transactions.resources[0].quantity).toBe(1);
  });
  it("newer failed load still supersedes older completion and leaves the source intact", async () => {
    const owner = fixture();
    move(owner, 127, 26);
    const first = deferred(),
      released: string[] = [];
    const before = owner.checkpoint();
    const a = owner.travel("to-shrine", () => first.promise);
    await expect(
      owner.travel("to-shrine", async () => {
        throw Error("failed");
      }),
    ).rejects.toThrow(/failed/);
    first.resolve(
      prepared({ roomId: "shrine", assetIds: ["shrine-palette"] }, released),
    );
    expect((await a).status).toBe("stale");
    expect(owner.checkpoint()).toBe(before);
    await owner.travel("to-shrine", loader());
    expect(owner.observation().roomId).toBe("shrine");
  });
  it("validates imports before loading and keeps current state recoverable on load failure", async () => {
    const owner = fixture();
    await unlock(owner);
    await owner.travel("sealed-door", loader());
    owner.setCheckpoint();
    move(owner, 127, 26);
    owner.pickup("chest");
    const saved = owner.checkpoint();
    const fresh = fixture(),
      before = fresh.checkpoint();
    let calls = 0;
    await expect(
      fresh.restore("{}", async (request) => {
        calls++;
        return prepared(request, []);
      }),
    ).rejects.toThrow();
    expect(calls).toBe(0);
    expect(fresh.checkpoint()).toBe(before);
    await expect(
      fresh.restore(saved, async () => {
        throw Error("failed");
      }),
    ).rejects.toThrow();
    expect(fresh.checkpoint()).toBe(before);
    await fresh.restore(saved, loader());
    expect(fresh.checkpoint()).toBe(saved);
    move(owner, 127, 32);
    move(fresh, 127, 32);
    expect(fresh.checkpoint()).toBe(owner.checkpoint());
  });
  it("stales restore completion on source changes and disposes resources on session disposal", async () => {
    const owner = fixture(),
      pending = deferred(),
      released: string[] = [];
    const saved = owner.checkpoint();
    const request = owner.restore(saved, () => pending.promise);
    owner.dispose();
    pending.resolve(
      prepared({ roomId: "hall", assetIds: ["hall-palette"] }, released),
    );
    expect((await request).status).toBe("stale");
    expect(released).toEqual(["hall"]);
    expect(owner.checkpoint()).toBe(saved);
    expect(() => owner.step({ slots: [] })).toThrow(/disposed/);
    expect(() => owner.pickup("phase")).toThrow(/disposed/);
  });
  it("stages recovery/reset and preserves durable state on their failed loads", async () => {
    const owner = fixture();
    await unlock(owner);
    await owner.travel("sealed-door", loader());
    owner.setCheckpoint();
    move(owner, 127, 26);
    owner.pickup("chest");
    move(owner, 127, 32);
    // Kill the ordinary blocking enemy with the existing platform strike.
    owner.step({
      slots: [
        {
          slot: 0,
          held: { ...neutralHeld(), attack: true },
          axes: { moveX: 0 },
          edges: [{ action: "attack", kind: "pressed" }],
        },
      ],
    });
    owner.step({
      slots: [
        {
          slot: 0,
          held: neutralHeld(),
          axes: { moveX: 0 },
          edges: [{ action: "attack", kind: "released" }],
        },
      ],
    });
    move(owner, 0, 4);
    move(owner, 127, 90);
    expect(owner.observation().platform.status).toBe("lost");
    const dead = owner.checkpoint();
    await expect(
      owner.recover(async () => {
        throw Error("failed");
      }),
    ).rejects.toThrow();
    expect(owner.checkpoint()).toBe(dead);
    await owner.recover(loader());
    expect(owner.observation().roomId).toBe("vault");
    expect(owner.observation().platform.status).toBe("playing");
    const recovered = owner.checkpoint();
    await expect(
      owner.reset(async () => {
        throw Error("failed");
      }),
    ).rejects.toThrow();
    expect(owner.checkpoint()).toBe(recovered);
    await owner.reset(loader());
    expect(owner.observation().roomId).toBe("hall");
    expect(owner.observation().transactions.revision).toBe(0);
  });
  it("bounds unresolved loads and prevents destructor failure from changing committed authority", async () => {
    const owner = fixture();
    move(owner, 127, 26);
    const waits = Array.from({ length: 4 }, () => deferred()),
      released: string[] = [];
    const requests = waits.map((p) =>
      owner.travel("to-shrine", () => p.promise),
    );
    const before = owner.checkpoint();
    await expect(owner.travel("to-shrine", loader())).rejects.toThrow(/cap/);
    expect(owner.checkpoint()).toBe(before);
    for (const p of waits)
      p.resolve(
        prepared({ roomId: "shrine", assetIds: ["shrine-palette"] }, released),
      );
    expect((await Promise.all(requests)).map((r) => r.status)).toEqual([
      "stale",
      "stale",
      "stale",
      "committed",
    ]);
    expect(released).toHaveLength(3);
    await owner.travel("to-hall", async (request) => ({
      ...request,
      dispose() {
        throw Error("cleanup failed");
      },
    }));
    move(owner, 127, 26);
    await owner.travel("to-shrine", loader());
    expect(owner.observation().roomId).toBe("shrine");
  });
});

it("times out four stuck loaders, rejects before replay at capacity, and releases late handles", async () => {
  vi.useFakeTimers();
  try {
    const owner = new CampaignPlatformSession(
      definitions,
      identity,
      authored,
      50,
    );
    const waits = Array.from({ length: 4 }, () => deferred());
    const signals: AbortSignal[] = [];
    const requests = waits.map((wait) =>
      owner.reset((request) => {
        signals.push(request.signal!);
        return wait.promise;
      }),
    );
    const settled = Promise.allSettled(requests);
    await expect(owner.restore("invalid JSON", loader())).rejects.toThrow(
      /pending load cap/,
    );
    const before = owner.checkpoint();
    await vi.advanceTimersByTimeAsync(50);
    expect(
      (await settled).every(
        (result) =>
          result.status === "rejected" && /timeout/.test(String(result.reason)),
      ),
    ).toBe(true);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(owner.checkpoint()).toBe(before);
    await owner.reset(loader());
    const released: string[] = [];
    for (const wait of waits)
      wait.resolve(
        prepared({ roomId: "hall", assetIds: ["hall-palette"] }, released),
      );
    await vi.advanceTimersByTimeAsync(0);
    expect(released).toEqual(Array(4).fill("hall"));
    expect(owner.checkpoint()).toBe(before);
    owner.dispose();
    await expect(owner.travel("missing", loader())).rejects.toThrow(/disposed/);
    await expect(owner.recover(loader())).rejects.toThrow(/disposed/);
    await expect(owner.reset(loader())).rejects.toThrow(/disposed/);
    await expect(owner.restore(before, loader())).rejects.toThrow(/disposed/);
  } finally {
    vi.useRealTimers();
  }
});

describe("portable campaign recovery", () => {
  const portable = async () => {
    const owner = fixture();
    await unlock(owner);
    await owner.travel("sealed-door", loader());
    owner.setCheckpoint();
    move(owner, 127, 26);
    owner.pickup("chest");
    return owner;
  };
  it("loads portable progress resources atomically at the checkpoint entrance", async () => {
    const source = await portable();
    const target = fixture();
    const before = target.checkpoint();
    const pending = deferred();
    const request = target.restoreProgress(
      source.progress(),
      () => pending.promise,
    );
    expect(target.checkpoint()).toBe(before);
    pending.resolve(
      prepared({ roomId: "vault", assetIds: ["vault-palette"] }, []),
    );
    expect(await request).toEqual({ status: "committed", roomId: "vault" });
    expect(target.progress()).toBe(source.progress());
    expect(target.observation().platform.tick).toBe(0);
    expect(target.checkpoint()).not.toBe(source.checkpoint());
  });
  it("keeps exact original rejected bytes and text, without loading or replacing committed resources", async () => {
    const target = await portable();
    const before = target.checkpoint();
    const rejected =
      ' { "kind": "campaign-platform-progress", "version": 999 }\n';
    const result = prepareCampaignPlatformRecovery(
      definitions,
      identity,
      authored,
      rejected,
    );
    expect(result.status).toBe("rejected");
    expect(result.original).toBe(rejected);
    const invalidUTF8 = new Uint8Array([255, 254, 0]);
    const bytesResult = prepareCampaignPlatformRecovery(
      definitions,
      identity,
      authored,
      invalidUTF8,
    );
    expect(bytesResult.status).toBe("rejected");
    invalidUTF8[0] = 0;
    expect(bytesResult.original).toEqual(new Uint8Array([255, 254, 0]));
    const load = vi.fn(loader());
    await expect(target.restoreProgress(rejected, load)).rejects.toMatchObject({
      name: "CampaignPlatformRecoveryError",
      original: rejected,
    });
    expect(load).not.toHaveBeenCalled();
    expect(target.checkpoint()).toBe(before);
    const future = JSON.parse(target.progress());
    future.version = 2;
    const futureResult = prepareCampaignPlatformRecovery(
      definitions,
      identity,
      authored,
      JSON.stringify(future),
    );
    expect(futureResult.status).toBe("rejected");
    if (futureResult.status === "rejected")
      expect(futureResult.error.message).toMatch(/no migration/);
    const oversized = new Uint8Array(2 * 1024 * 1024 + 1);
    const oversizedResult = prepareCampaignPlatformRecovery(
      definitions,
      identity,
      authored,
      oversized,
    );
    expect(oversizedResult.original).toBe(oversized);
    expect(oversizedResult.status).toBe("rejected");
  });
  it("retains the committed exact save on failed/mismatched portable resource loading", async () => {
    const source = await portable();
    const target = fixture();
    const before = target.checkpoint();
    await expect(
      target.restoreProgress(source.progress(), async () => {
        throw Error("failed resources");
      }),
    ).rejects.toThrow(/failed resources/);
    expect(target.checkpoint()).toBe(before);
    const released: string[] = [];
    await expect(
      target.restoreProgress(source.progress(), async () =>
        prepared({ roomId: "hall", assetIds: [] }, released),
      ),
    ).rejects.toThrow(/mismatch/);
    expect(released).toEqual(["hall"]);
    expect(target.checkpoint()).toBe(before);
  });
  it("stales portable completion on input, compaction, supersession and disposal", async () => {
    const source = await portable();
    for (const change of ["input", "compact", "supersede", "dispose"]) {
      const target = fixture();
      const pending = deferred();
      const released: string[] = [];
      const request = target.restoreProgress(
        source.progress(),
        () => pending.promise,
      );
      if (change === "input") target.step({ slots: [] });
      if (change === "compact")
        for (let i = 0; i < 17; i++) target.step({ slots: [] }, 256);
      if (change === "supersede") await target.reset(loader());
      if (change === "dispose") target.dispose();
      const before = target.checkpoint();
      pending.resolve(
        prepared({ roomId: "vault", assetIds: ["vault-palette"] }, released),
      );
      expect((await request).status).toBe("stale");
      expect(target.checkpoint()).toBe(before);
      expect(released).toEqual(["vault"]);
    }
  }, 30_000);
  it("lets a later failed portable request supersede an earlier accepted one", async () => {
    const source = await portable();
    const target = fixture();
    const pending = deferred();
    const released: string[] = [];
    const before = target.checkpoint();
    const first = target.restoreProgress(
      source.progress(),
      () => pending.promise,
    );
    await expect(
      target.restoreProgress(source.progress(), async () => {
        throw Error("new failure");
      }),
    ).rejects.toThrow(/new failure/);
    pending.resolve(
      prepared({ roomId: "vault", assetIds: ["vault-palette"] }, released),
    );
    expect((await first).status).toBe("stale");
    expect(target.checkpoint()).toBe(before);
    expect(released).toEqual(["vault"]);
  });
  it("reports capacity/disposal asynchronously and times out portable imports with late cleanup", async () => {
    vi.useFakeTimers();
    try {
      const source = fixture().progress();
      const target = new CampaignPlatformSession(
        definitions,
        identity,
        authored,
        50,
      );
      const waits = Array.from({ length: 4 }, () => deferred());
      const requests = waits.map((wait) =>
        target.restoreProgress(source, () => wait.promise),
      );
      const settled = Promise.allSettled(requests);
      await expect(target.restoreProgress("invalid", loader())).rejects.toThrow(
        /pending load cap/,
      );
      const before = target.checkpoint();
      await vi.advanceTimersByTimeAsync(50);
      expect(
        (await settled).every(
          (r) => r.status === "rejected" && /timeout/.test(String(r.reason)),
        ),
      ).toBe(true);
      const released: string[] = [];
      for (const wait of waits)
        wait.resolve(
          prepared({ roomId: "hall", assetIds: ["hall-palette"] }, released),
        );
      await vi.advanceTimersByTimeAsync(0);
      expect(released).toHaveLength(4);
      expect(target.checkpoint()).toBe(before);
      target.dispose();
      await expect(target.restoreProgress(source, loader())).rejects.toThrow(
        /disposed/,
      );
    } finally {
      vi.useRealTimers();
    }
    expect(
      new CampaignPlatformRecoveryError("source", Error("broken")).original,
    ).toBe("source");
  });
});
