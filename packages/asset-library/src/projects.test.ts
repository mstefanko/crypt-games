import "fake-indexeddb/auto";
import { it, expect } from "vitest";
import { readAudioProject, saveAudioProject } from "./projects";
it("persists independent project snapshots and rejects stale project assignments", async () => {
  const db = `projects-${crypto.randomUUID()}`;
  const manifest = { assets: [{ id: "cue", revision: 1 }] };
  const saved = await saveAudioProject("demo", manifest, null, db);
  manifest.assets[0]!.revision = 99;
  expect((await readAudioProject("demo", db))?.manifest).toEqual({
    assets: [{ id: "cue", revision: 1 }],
  });
  expect(saved.revision).toBe(1);
  await expect(
    saveAudioProject("demo", { assets: [] }, null, db),
  ).rejects.toThrow("another tab");
  expect((await readAudioProject("demo", db))?.revision).toBe(1);
  expect((await saveAudioProject("demo", { assets: [] }, 1, db)).revision).toBe(
    2,
  );
});
