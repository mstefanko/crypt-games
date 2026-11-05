import { openDB, type DBSchema } from "idb";
import { assertScore, type Score } from "@onepage/project";

export interface DraftRecord {
  score: Score;
  revision: number;
  updatedAt: number;
}
export interface LibraryEntry {
  id: string;
  title: string;
  updatedAt: number;
  revision: number;
  versionCount: number;
}
export interface SavedVersion {
  id: string;
  scoreId: string;
  name: string;
  createdAt: number;
  score: Score;
}
export interface LibraryBackup {
  schemaVersion: 1;
  drafts: DraftRecord[];
  versions: SavedVersion[];
}
export interface AssetLibrary {
  list(): Promise<LibraryEntry[]>;
  readDraft(id: string): Promise<DraftRecord | undefined>;
  saveDraft(
    score: Score,
    expectedRevision: number | null,
  ): Promise<DraftRecord>;
  saveVersion(score: Score, name: string): Promise<SavedVersion>;
  listVersions(id: string): Promise<SavedVersion[]>;
  readVersion(id: string, versionId: string): Promise<SavedVersion | undefined>;
  restoreVersion(
    id: string,
    versionId: string,
    expectedRevision: number | null,
  ): Promise<DraftRecord>;
  deleteSong(id: string): Promise<void>;
  restoreDeletedSong(id: string): Promise<DraftRecord | undefined>;
  exportLibrary(): Promise<LibraryBackup>;
  importLibrary(value: unknown): Promise<void>;
  close(): void;
}
export class StaleRevisionError extends Error {
  constructor(public readonly latest: DraftRecord | undefined) {
    super("This song has changed. Reload or save a copy before saving again.");
    this.name = "StaleRevisionError";
  }
}
interface LibraryDB extends DBSchema {
  drafts: { key: string; value: DraftRecord };
  versions: { key: string; value: SavedVersion; indexes: { scoreId: string } };
  trash: { key: string; value: DraftRecord };
}
const clone = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function validateBackup(value: unknown): LibraryBackup {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.drafts) ||
    !Array.isArray(value.versions)
  )
    throw new Error("Invalid library backup");
  const draftIds = new Set<string>();
  const versionIds = new Set<string>();
  for (const draft of value.drafts) {
    if (
      !object(draft) ||
      !Number.isSafeInteger(draft.revision) ||
      (draft.revision as number) < 1 ||
      !timestamp(draft.updatedAt)
    )
      throw new Error("Invalid draft record");
    assertScore(draft.score);
    if (draftIds.has(draft.score.id))
      throw new Error("Duplicate song in backup");
    draftIds.add(draft.score.id);
  }
  for (const version of value.versions) {
    if (
      !object(version) ||
      typeof version.id !== "string" ||
      !version.id ||
      typeof version.name !== "string" ||
      !version.name.trim() ||
      !timestamp(version.createdAt)
    )
      throw new Error("Invalid saved version");
    assertScore(version.score);
    if (version.scoreId !== version.score.id || versionIds.has(version.id))
      throw new Error("Invalid version identity");
    versionIds.add(version.id);
  }
  return value as unknown as LibraryBackup;
}

/** Browser-local storage. Backups reject identity collisions atomically; they never overwrite songs. */
export async function createLibrary(
  name = "onepage-asset-library",
): Promise<AssetLibrary> {
  const db = await openDB<LibraryDB>(name, 1, {
    upgrade(database) {
      database.createObjectStore("drafts", { keyPath: "score.id" });
      database.createObjectStore("trash", { keyPath: "score.id" });
      database
        .createObjectStore("versions", { keyPath: "id" })
        .createIndex("scoreId", "scoreId");
    },
    blocking() {
      db.close();
    },
  });
  async function saveDraft(
    input: Score,
    expectedRevision: number | null,
  ): Promise<DraftRecord> {
    const score = clone(input);
    assertScore(score);
    const tx = db.transaction(["drafts", "trash"], "readwrite");
    const current = await tx.objectStore("drafts").get(score.id);
    const deleted = await tx.objectStore("trash").get(score.id);
    if ((current?.revision ?? null) !== expectedRevision || deleted) {
      await tx.done;
      throw new StaleRevisionError(clone(current ?? deleted));
    }
    const record = {
      score,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await tx.objectStore("drafts").put(record);
    await tx.done;
    return clone(record);
  }
  const api: AssetLibrary = {
    async list() {
      const tx = db.transaction(["drafts", "versions"]);
      const drafts = await tx.objectStore("drafts").getAll();
      const entries = await Promise.all(
        drafts.map(async (draft) => ({
          id: draft.score.id,
          title: draft.score.title,
          revision: draft.revision,
          updatedAt: draft.updatedAt,
          versionCount: await tx
            .objectStore("versions")
            .index("scoreId")
            .count(draft.score.id),
        })),
      );
      await tx.done;
      return entries.sort(
        (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
      );
    },
    async readDraft(id) {
      return db.get("drafts", id);
    },
    saveDraft,
    async saveVersion(input, name) {
      const score = clone(input);
      assertScore(score);
      if (!name.trim()) throw new Error("A version name is required");
      const version: SavedVersion = {
        id: crypto.randomUUID(),
        scoreId: score.id,
        name: name.trim(),
        createdAt: Date.now(),
        score,
      };
      await db.add("versions", version);
      return clone(version);
    },
    async listVersions(id) {
      return (await db.getAllFromIndex("versions", "scoreId", id)).sort(
        (a, b) => b.createdAt - a.createdAt,
      );
    },
    async readVersion(id, versionId) {
      const version = await db.get("versions", versionId);
      return version?.scoreId === id ? version : undefined;
    },
    async restoreVersion(id, versionId, expectedRevision) {
      const version = await api.readVersion(id, versionId);
      if (!version) throw new Error("Saved version not found");
      return saveDraft(version.score, expectedRevision);
    },
    async deleteSong(id) {
      const tx = db.transaction(["drafts", "trash"], "readwrite");
      const draft = await tx.objectStore("drafts").get(id);
      if (draft) {
        await tx.objectStore("trash").put(draft);
        await tx.objectStore("drafts").delete(id);
      }
      await tx.done;
    },
    async restoreDeletedSong(id) {
      const tx = db.transaction(["drafts", "trash"], "readwrite");
      const draft = await tx.objectStore("trash").get(id);
      if (draft) {
        draft.revision += 1;
        draft.updatedAt = Date.now();
        await tx.objectStore("drafts").add(draft);
        await tx.objectStore("trash").delete(id);
      }
      await tx.done;
      return draft;
    },
    async exportLibrary() {
      const tx = db.transaction(["drafts", "versions", "trash"]);
      // Include trashed songs in portable recovery backups.
      const drafts = [
        ...(await tx.objectStore("drafts").getAll()),
        ...(await tx.objectStore("trash").getAll()),
      ];
      const versions = await tx.objectStore("versions").getAll();
      await tx.done;
      return { schemaVersion: 1, drafts, versions };
    },
    async importLibrary(value) {
      const backup = validateBackup(clone(value));
      const tx = db.transaction(["drafts", "versions", "trash"], "readwrite");
      const existingIds = new Set([
        ...(await tx.objectStore("drafts").getAllKeys()),
        ...(await tx.objectStore("trash").getAllKeys()),
        ...(await tx.objectStore("versions").getAll()).map(
          (version) => version.scoreId,
        ),
      ]);
      const collision =
        backup.drafts.some((draft) => existingIds.has(draft.score.id)) ||
        backup.versions.some((version) => existingIds.has(version.scoreId));
      const versionCollision = (
        await Promise.all(
          backup.versions.map((version) =>
            tx.objectStore("versions").getKey(version.id),
          ),
        )
      ).some((key) => key !== undefined);
      if (collision || versionCollision) {
        await tx.done;
        throw new Error(
          "Library backup collides with existing songs or versions; import into an empty library",
        );
      }
      for (const draft of backup.drafts)
        await tx.objectStore("drafts").add(draft);
      for (const version of backup.versions)
        await tx.objectStore("versions").add(version);
      await tx.done;
    },
    close() {
      db.close();
    },
  };
  return api;
}

export async function getStorageInfo(): Promise<{
  supported: boolean;
  persisted: boolean | undefined;
  usage?: number;
  quota?: number;
}> {
  const storage =
    typeof navigator === "undefined" ? undefined : navigator.storage;
  if (!storage) return { supported: false, persisted: undefined };
  const estimate = storage.estimate ? await storage.estimate() : {};
  return {
    supported: true,
    persisted: storage.persisted ? await storage.persisted() : undefined,
    ...estimate,
  };
}
export async function requestPersistence(): Promise<boolean | undefined> {
  return typeof navigator !== "undefined" && navigator.storage?.persist
    ? navigator.storage.persist()
    : undefined;
}
export { readAudioProject, saveAudioProject } from "./projects";
