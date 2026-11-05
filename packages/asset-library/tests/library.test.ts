import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { type Score } from "@onepage/project";
import {
  createLibrary,
  StaleRevisionError,
  type AssetLibrary,
} from "../src/index";

// The canonical score fixture is supplied by project; storage treats its contents opaquely.
import { createBlankScore } from "@onepage/project";

const opened: AssetLibrary[] = [];
async function library(name = crypto.randomUUID()) {
  const result = await createLibrary(name);
  opened.push(result);
  return result;
}
function score(id = crypto.randomUUID()): Score {
  const result = createBlankScore();
  result.id = id;
  return result;
}
afterEach(() => {
  for (const item of opened.splice(0)) item.close();
});

describe("browser library", () => {
  it("saves a cloned draft and reopens it", async () => {
    const name = crypto.randomUUID();
    const first = await library(name);
    const input = score();
    const saved = await first.saveDraft(input, null);
    input.title = "Unsaved mutation";
    saved.score.title = "Returned mutation";
    first.close();
    const reopened = await library(name);
    expect((await reopened.readDraft(input.id))?.score.title).not.toBe(
      "Unsaved mutation",
    );
    expect((await reopened.readDraft(input.id))?.score.title).not.toBe(
      "Returned mutation",
    );
    expect(await reopened.list()).toEqual([
      expect.objectContaining({ id: input.id, revision: 1, versionCount: 0 }),
    ]);
  });

  it("serializes concurrent writers and returns the winning record for stale writes", async () => {
    const name = crypto.randomUUID();
    const a = await library(name);
    const b = await library(name);
    const input = score();
    await a.saveDraft(input, null);
    const result = await Promise.allSettled([
      a.saveDraft({ ...input, title: "A" }, 1),
      b.saveDraft({ ...input, title: "B" }, 1),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const failure = result.find(
      (item) => item.status === "rejected",
    ) as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(StaleRevisionError);
    expect(failure.reason.latest).toEqual(await a.readDraft(input.id));
    expect(failure.reason.latest.revision).toBe(2);
  });

  it("keeps version snapshots immutable and restores through revision checks", async () => {
    const store = await library();
    const input = score();
    await store.saveDraft(input, null);
    const snapshot = await store.saveVersion(input, "First");
    const originalTitle = input.title;
    input.title = "Edited";
    snapshot.score.title = "Mutated";
    await store.saveDraft(input, 1);
    expect((await store.readVersion(input.id, snapshot.id))?.score.title).toBe(
      originalTitle,
    );
    await expect(
      store.restoreVersion(input.id, snapshot.id, 1),
    ).rejects.toBeInstanceOf(StaleRevisionError);
    expect(
      (await store.restoreVersion(input.id, snapshot.id, 2)).score.title,
    ).toBe(originalTitle);
    expect(await store.readVersion("wrong-song", snapshot.id)).toBeUndefined();
  });

  it("restores a complete portable backup and rejects corrupt or colliding imports atomically", async () => {
    const source = await library();
    const input = score();
    await source.saveDraft(input, null);
    await source.saveVersion(input, "Backup");
    const backup = await source.exportLibrary();
    const target = await library();
    await target.importLibrary(backup);
    expect(await target.exportLibrary()).toEqual(backup);
    await expect(target.importLibrary(backup)).rejects.toThrow("collides");
    expect(await target.exportLibrary()).toEqual(backup);
    const empty = await library();
    const corrupt = structuredClone(backup);
    corrupt.versions[0]!.scoreId = "mismatched";
    await expect(empty.importLibrary(corrupt)).rejects.toThrow();
    expect(await empty.exportLibrary()).toEqual({
      schemaVersion: 1,
      drafts: [],
      versions: [],
    });
  });

  it("retains deleted songs for recovery and prevents stale autosaves resurrecting them", async () => {
    const store = await library();
    const input = score();
    await store.saveDraft(input, null);
    await store.saveVersion(input, "Retained");
    await store.deleteSong(input.id);
    expect(await store.list()).toEqual([]);
    await expect(store.saveDraft(input, null)).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
    expect((await store.exportLibrary()).drafts).toHaveLength(1);
    expect((await store.restoreDeletedSong(input.id))?.revision).toBe(2);
    expect(await store.listVersions(input.id)).toHaveLength(1);
  });
});
