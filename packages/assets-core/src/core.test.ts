import { describe, expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import { importAssetPack } from "../../director-io/src/index";
import {
  acceptAssetCandidate,
  assertImmutableVersions,
  assertAssetDocument,
  capabilityReport,
  createAssetCandidate,
  createDemoLibrary,
  encodeRgbaPng,
  exportDirectorPack,
  frameAtTick,
  frameToRgba,
  installAssetVersion,
  publishAssetVersion,
  resolveAnchors,
  validateAssetDocument,
} from "./index";
const fixture = () => createDemoLibrary();
describe("portable asset library", () => {
  it("has original playable actions and explicit capability coverage", () => {
    const doc = fixture();
    expect(validateAssetDocument(doc)).toEqual([]);
    const v = doc.families[0].variants[0];
    expect(
      capabilityReport(v, {
        actions: ["idle", "walk", "run", "jump", "sit", "wave"],
        directions: ["front", "back", "left", "right"],
      }).ready,
    ).toBe(true);
    expect(capabilityReport(v, { actions: ["attack"] }).missing).toEqual([
      "attack action",
    ]);
    const sit = v.actions.find((a) => a.name === "sit")!.directions[0]
      .frames[0];
    expect(resolveAnchors(v, sit)).toEqual({
      ground: { x: 10, y: 27 },
      hand: { x: 15, y: 23 },
      speech: { x: 10, y: 6 },
    });
    expect(v.anchors.hand).toEqual({ x: 16, y: 18 });
  });
  it("uses real duration boundaries and one-shot clamping", () => {
    const clip = fixture().families[0].variants[0].actions.find(
      (a) => a.name === "walk",
    )!.directions[0];
    expect(frameAtTick(clip, 9)?.id).toBe(clip.frames[0].id);
    expect(frameAtTick(clip, 10)?.id).toBe(clip.frames[1].id);
    expect(frameAtTick(clip, 40)?.id).toBe(clip.frames[0].id);
    expect(frameAtTick(clip, 100, false)?.id).toBe(clip.frames[3].id);
    expect(frameAtTick(clip, Number.NaN)).toBeUndefined();
  });
  it("forks by default, retains originals and remaps nested identities", () => {
    const doc = fixture(),
      original = structuredClone(doc);
    const proposed = structuredClone(doc.families[0]);
    proposed.name = "Green hat courier";
    const v = proposed.variants[0].actions[0].directions[0].frames[0].visual;
    if (v.kind === "indexed") v.palette[3] = "#318653";
    const candidate = createAssetCandidate(doc.families[0], proposed);
    const accepted = acceptAssetCandidate(doc, candidate);
    expect(accepted.conflicts).toEqual([]);
    expect(doc).toEqual(original);
    expect(accepted.document.families[0]).toEqual(original.families[0]);
    expect(accepted.family?.id).toBe("juniper-copy");
    expect(accepted.family?.variants[0].id).not.toBe(proposed.variants[0].id);
    expect(accepted.document.revision).toBe(doc.revision + 1);
    proposed.name = "Later modification";
    expect(candidate.proposed.name).toBe("Green hat courier");
  });
  it("checks full base content and expected revision before explicit updates", () => {
    const doc = fixture(),
      proposed = structuredClone(doc.families[0]);
    proposed.name = "Edited";
    const candidate = createAssetCandidate(doc.families[0], proposed);
    const current = structuredClone(doc);
    current.families[0].name = "Concurrent edit without bump";
    expect(
      acceptAssetCandidate(current, candidate, { mode: "update" }).conflicts[0],
    ).toContain("changed");
    expect(
      acceptAssetCandidate(doc, candidate, {
        mode: "update",
        expectedRevision: 8,
      }).conflicts[0],
    ).toContain("revision");
    const result = acceptAssetCandidate(doc, candidate, { mode: "update" });
    expect(result.family?.revision).toBe(2);
    expect(result.document.families).toHaveLength(doc.families.length);
    expect(result.document.families[0].name).toBe("Edited");
  });
  it("pins immutable independent snapshots through edits and deletion", () => {
    const doc = fixture();
    const saved = publishAssetVersion(doc, "juniper", {
      id: "version-1",
      name: "First",
    });
    expect(Object.isFrozen(saved.version.family.variants[0].actions)).toBe(
      true,
    );
    const installed = installAssetVersion(saved.document, "version-1", {
      projectId: "story",
      projectName: "Forest story",
    });
    installed.document.families[0].name = "Draft changed";
    expect(installed.installation.family.name).toBe("Juniper the courier");
    installed.document.families = [];
    installed.document.versions = [];
    installed.document.collections = [];
    expect(validateAssetDocument(installed.document)).toEqual([]);
    expect(installed.document.installations[0].family.name).toBe(
      "Juniper the courier",
    );
    expect(saved.document.revision).toBe(doc.revision + 1);
    expect(installed.document.revision).toBe(doc.revision + 2);
    expect(() =>
      publishAssetVersion(saved.document, "juniper", { id: "version-1" }),
    ).toThrow("immutable");
  });
  it("enforces append-only immutable versions at persistence boundaries", () => {
    const first = publishAssetVersion(fixture(), "juniper", {
      id: "first",
    }).document;
    const appended = publishAssetVersion(first, "moss", {
      id: "second",
    }).document;
    expect(() => assertImmutableVersions(first, appended)).not.toThrow();
    const changed = structuredClone(first);
    changed.versions[0].family.name = "Tampered snapshot";
    expect(() => assertImmutableVersions(first, changed)).toThrow("immutable");
    const removed = structuredClone(first);
    removed.versions = [];
    expect(() => assertImmutableVersions(first, removed)).toThrow(
      "cannot be removed",
    );
    const bytes = structuredClone(first);
    bytes.versions[0].media.push({
      id: "injected",
      name: "new bytes",
      mime: "text/plain",
      dataUrl: "data:text/plain;base64,YQ==",
    });
    expect(() => assertImmutableVersions(first, bytes)).toThrow("immutable");
  });
  it("rejects malformed pixel indices, timing, dimensions, anchors and raster dependencies", () => {
    const doc = fixture(),
      frame = doc.families[0].variants[0].actions[0].directions[0].frames[0];
    if (frame.visual.kind !== "indexed") throw new Error("fixture");
    frame.visual.rows[0] = "f".repeat(frame.visual.width);
    expect(
      validateAssetDocument(doc).some((d) =>
        d.message.includes("palette indices"),
      ),
    ).toBe(true);
    expect(() => frameToRgba(frame)).toThrow("palette");
    frame.durationTicks = 0;
    frame.anchors = { ground: { x: Infinity, y: 0 } };
    expect(validateAssetDocument(doc).length).toBeGreaterThanOrEqual(3);
    frame.visual = {
      kind: "raster",
      mediaId: "missing",
      x: 0,
      y: 0,
      width: 20,
      height: 28,
    };
    expect(
      validateAssetDocument(doc).some((d) =>
        d.message.includes("requires embedded"),
      ),
    ).toBe(true);
    expect(() => assertAssetDocument(doc)).toThrow();
  });
  it("returns diagnostics rather than throwing when raster media records are malformed", () => {
    const doc = fixture();
    doc.families[0].variants[0].actions[0].directions[0].frames[0].visual = {
      kind: "raster",
      mediaId: "bad",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
    (doc.media as unknown[]) = [null];
    expect(() => validateAssetDocument(doc)).not.toThrow();
    expect(validateAssetDocument(doc).length).toBeGreaterThan(0);
  });
  it("preserves source SVG bytes but prevents rendering them as raster frames", () => {
    const doc = fixture();
    doc.media.push({
      id: "svg",
      name: "Original vector source",
      mime: "image/svg+xml",
      dataUrl: "data:image/svg+xml;base64,PHN2Zy8+",
    });
    expect(validateAssetDocument(doc)).toEqual([]);
    doc.families[0].variants[0].actions[0].directions[0].frames[0].visual = {
      kind: "raster",
      mediaId: "svg",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    };
    expect(
      validateAssetDocument(doc).some((d) =>
        d.message.includes("requires embedded PNG"),
      ),
    ).toBe(true);
  });
  it("treats palette zero as transparent and retains nonzero alpha", () => {
    expect([
      ...frameToRgba({
        kind: "indexed",
        width: 2,
        height: 1,
        palette: ["#ffffff", "#11223380"],
        rows: ["01"],
      }),
    ]).toEqual([0, 0, 0, 0, 17, 34, 51, 128]);
  });
  it("encodes genuine PNG scanlines across stored deflate block boundaries", () => {
    const rgba = new Uint8Array(128 * 128 * 4).fill(173);
    const png = encodeRgbaPng(128, 128, rgba);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(128);
    expect(view.getUint32(20)).toBe(128);
    let offset = 8,
      compressed = new Uint8Array();
    while (offset < png.length) {
      const length = view.getUint32(offset),
        type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      if (type === "IDAT")
        compressed = png.slice(offset + 8, offset + 8 + length);
      offset += length + 12;
    }
    const decoded = inflateSync(compressed);
    expect(decoded.length).toBe(128 * (128 * 4 + 1));
    expect(decoded[0]).toBe(0);
    expect(decoded[1]).toBe(173);
    expect(decoded[128 * 4 + 1]).toBe(0);
  });
  it("exports a real atlas accepted by existing Director I/O without schema changes", () => {
    const doc = fixture();
    doc.families[0].variants[0].style = "handmade";
    const result = exportDirectorPack(doc, {
      familyIds: ["juniper"],
      direction: "right",
    });
    const pack = importAssetPack(JSON.stringify(result.pack));
    expect(pack.assets).toHaveLength(1);
    expect(pack.media).toHaveLength(1);
    const variant = pack.assets[0].variants[0];
    expect(variant.clips.find((c) => c.name === "sit")?.loop).toBe(false);
    expect(variant.clips.find((c) => c.name === "walk")?.frames).toEqual(
      variant.clips.find((c) => c.name === "walk:right")?.frames,
    );
    expect(variant.frames[0].duration).toBe(10);
    expect(result.warnings[0]).toContain("16-bit");
    expect(
      pack.media[0].dataUrl.startsWith("data:image/png;base64,iVBOR"),
    ).toBe(true);
  });
  it("preserves raster source rectangles and refuses mixed-sheet export", () => {
    const doc = fixture();
    doc.families = [doc.families[2]];
    doc.collections = [];
    const f = doc.families[0].variants[0].actions[0].directions[0].frames[0];
    const png = exportDirectorPack(doc).pack.media[0].dataUrl;
    doc.media = [
      {
        id: "raster",
        name: "Original",
        mime: "image/png",
        dataUrl: png,
        width: 10,
        height: 14,
      },
    ];
    f.visual = {
      kind: "raster",
      mediaId: "raster",
      x: 0,
      y: 0,
      width: 10,
      height: 14,
    };
    const result = exportDirectorPack(doc);
    expect(
      importAssetPack(JSON.stringify(result.pack)).assets[0].variants[0]
        .frames[0].width,
    ).toBe(10);
    const other = structuredClone(f);
    other.id = "second";
    other.visual = {
      kind: "indexed",
      width: 1,
      height: 1,
      palette: ["#00000000"],
      rows: ["0"],
    };
    doc.families[0].variants[0].actions[0].directions[0].frames.push(other);
    expect(() => exportDirectorPack(doc)).toThrow("one raster sheet");
  });
});
