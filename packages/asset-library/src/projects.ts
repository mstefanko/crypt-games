import { openDB, type DBSchema } from "idb";
export interface ProjectRecord {
  id: string;
  revision: number;
  updatedAt: number;
  manifest: unknown;
}
interface ProjectDB extends DBSchema {
  projects: { key: string; value: ProjectRecord };
}
async function database(name: string) {
  return openDB<ProjectDB>(name, 1, {
    upgrade(db) {
      db.createObjectStore("projects", { keyPath: "id" });
    },
  });
}
export async function readAudioProject(
  id: string,
  name = "pocket-score-projects",
): Promise<ProjectRecord | undefined> {
  const db = await database(name);
  try {
    return await db.get("projects", id);
  } finally {
    db.close();
  }
}
/** Caller validates the domain-specific manifest before committing. Revision check and write are atomic. */
export async function saveAudioProject(
  id: string,
  manifest: unknown,
  expectedRevision: number | null,
  name = "pocket-score-projects",
): Promise<ProjectRecord> {
  if (!id || JSON.stringify(manifest).length > 4_000_000)
    throw new Error("Invalid project dimensions");
  const db = await database(name);
  try {
    const tx = db.transaction("projects", "readwrite");
    const old = await tx.store.get(id);
    if ((old?.revision ?? null) !== expectedRevision) {
      await tx.done;
      throw new Error(
        "Project changed in another tab. Export your local assignments before reloading.",
      );
    }
    const record = {
      id,
      revision: (old?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      manifest: structuredClone(manifest),
    };
    await tx.store.put(record);
    await tx.done;
    return record;
  } finally {
    db.close();
  }
}
