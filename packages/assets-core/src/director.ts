import type {
  AssetFamily as DirectorFamily,
  AssetVariant as DirectorVariant,
  Frame,
  MediaResource as DirectorMedia,
  PackManifest,
} from "../../director-core/src/types";
import type {
  AssetLibraryDocument,
  DirectorExportOptions,
  DirectorExportResult,
} from "./types";
import { assertAssetDocument } from "./validate";
import { bytesToDataUrl, encodeRgbaPng, frameToRgba } from "./pixels";
/** Catalog facings become action:direction clips. Canonical action aliases choose one declared facing. */
export function exportDirectorPack(
  document: AssetLibraryDocument,
  options: DirectorExportOptions = {},
): DirectorExportResult {
  assertAssetDocument(document);
  const warnings: string[] = [],
    media: DirectorMedia[] = [],
    assets: DirectorFamily[] = [];
  const wanted = options.familyIds ? new Set(options.familyIds) : undefined;
  if (
    wanted &&
    [...wanted].some((id) => !document.families.some((f) => f.id === id))
  )
    throw new Error("Selected family does not exist");
  const mediaIds = new Set(document.media.map((m) => m.id));
  function generatedMediaId(base: string): string {
    let id = base,
      n = 2;
    while (mediaIds.has(id)) id = `${base}~${n++}`;
    mediaIds.add(id);
    return id;
  }
  for (const family of document.families.filter(
    (f) => !wanted || wanted.has(f.id),
  )) {
    const source = document.sources.find((s) => s.id === family.sourcePackId);
    const provenance = {
      source: source?.source ?? "",
      license: source?.license ?? "",
      ...(source?.author ? { author: source.author } : {}),
    };
    const variants: DirectorVariant[] = [];
    for (const variant of family.variants) {
      const allFrames = variant.actions.flatMap((a) =>
        a.directions.flatMap((c) => c.frames),
      );
      if (allFrames.length > 4096)
        throw new Error(
          `${family.name}: Director supports at most 4096 frames per variant`,
        );
      const frames: Frame[] = [];
      let mediaId: string;
      const indexed = allFrames.every((f) => f.visual.kind === "indexed");
      if (indexed) {
        const cellWidth = Math.max(...allFrames.map((f) => f.visual.width)),
          cellHeight = Math.max(...allFrames.map((f) => f.visual.height));
        const columns = Math.min(
          Math.max(1, Math.ceil(Math.sqrt(allFrames.length))),
          Math.floor(8192 / cellWidth),
        );
        const width = columns * cellWidth,
          height = Math.ceil(allFrames.length / columns) * cellHeight;
        if (height > 8192 || width * height > 4 * 1024 * 1024)
          throw new Error(
            `${family.name}: indexed export atlas exceeds four million pixels`,
          );
        const pixels = new Uint8ClampedArray(width * height * 4);
        allFrames.forEach((frame, i) => {
          const x = (i % columns) * cellWidth,
            y = Math.floor(i / columns) * cellHeight,
            visual = frame.visual,
            rgba = frameToRgba(frame);
          for (let row = 0; row < visual.height; row++)
            pixels.set(
              rgba.subarray(
                row * visual.width * 4,
                (row + 1) * visual.width * 4,
              ),
              ((y + row) * width + x) * 4,
            );
          frames.push({
            x,
            y,
            width: visual.width,
            height: visual.height,
            duration: frame.durationTicks,
            ...(frame.anchors
              ? { sockets: structuredClone(frame.anchors) }
              : {}),
          });
        });
        mediaId = generatedMediaId(`${variant.id}:atlas`);
        const dataUrl = bytesToDataUrl(encodeRgbaPng(width, height, pixels));
        if (dataUrl.length > 12 * 1024 * 1024)
          throw new Error(
            `${family.name}: PNG atlas exceeds Director’s 12 MiB media limit; reduce frames or dimensions`,
          );
        media.push({
          id: mediaId,
          name: `${family.name} / ${variant.name}`,
          mime: "image/png",
          dataUrl,
          ...provenance,
        });
      } else {
        const sheets = new Set(
          allFrames.map((f) =>
            f.visual.kind === "raster" ? f.visual.mediaId : "__indexed",
          ),
        );
        if (sheets.size !== 1 || sheets.has("__indexed"))
          throw new Error(
            `${family.name}: Director needs one raster sheet per variant. Bake mixed/multiple sheets before export.`,
          );
        mediaId = [...sheets][0];
        const resource = document.media.find((m) => m.id === mediaId)!;
        if (!media.some((m) => m.id === mediaId))
          media.push({
            id: mediaId,
            name: resource.name,
            mime: resource.mime,
            dataUrl: resource.dataUrl,
            ...provenance,
          });
        allFrames.forEach((f) => {
          if (f.visual.kind !== "raster") throw new Error("Mixed sheet");
          frames.push({
            x: f.visual.x,
            y: f.visual.y,
            width: f.visual.width,
            height: f.visual.height,
            duration: f.durationTicks,
            ...(f.anchors ? { sockets: structuredClone(f.anchors) } : {}),
          });
        });
      }
      const clips: DirectorVariant["clips"] = [];
      let offset = 0;
      for (const action of variant.actions) {
        const facing =
          action.directions.find((c) => c.direction === options.direction) ??
          action.directions[0];
        if (options.direction && facing.direction !== options.direction)
          warnings.push(
            `${family.name} / ${action.name}: ${options.direction} unavailable; canonical clip uses ${facing.direction}`,
          );
        for (const clip of action.directions) {
          const indices = clip.frames.map((_, i) => offset + i);
          const definition = {
            frames: indices,
            loop: action.loop,
            fps: 60 / clip.frames[0].durationTicks,
          };
          clips.push({
            name: `${action.name}:${clip.direction}`,
            ...definition,
          });
          if (clip === facing) clips.push({ name: action.name, ...definition });
          offset += clip.frames.length;
        }
      }
      let style =
        options.styleMap?.[variant.style] ??
        (["8-bit", "16-bit", "realistic"].includes(variant.style)
          ? (variant.style as "8-bit" | "16-bit" | "realistic")
          : undefined);
      if (!style) {
        style = "16-bit";
        warnings.push(
          `${family.name}: catalog style “${variant.style}” maps to Director 16-bit`,
        );
      }
      const clipNames = new Set<string>();
      for (const clip of clips) {
        if (clipNames.has(clip.name))
          throw new Error(
            `Ambiguous exported clip name ${clip.name}; rename actions containing colons`,
          );
        clipNames.add(clip.name);
      }
      variants.push({
        id: variant.id,
        name: variant.name,
        style,
        revision: family.revision,
        mediaId,
        frames,
        clips,
        sockets: { ...structuredClone(variant.anchors) },
        logicalHeight: variant.logicalHeight,
        ready: true,
      });
    }
    assets.push({
      id: family.id,
      name: family.name,
      kind: family.kind,
      variants,
      ...provenance,
      ...(source ? { packId: source.id } : {}),
    });
  }
  const pack: PackManifest = {
    schemaVersion: 1,
    id: options.id ?? document.id,
    name: options.name ?? document.name,
    version: options.version ?? String(document.revision),
    source: "Pocket Assets",
    license: "",
    author: "",
    assets,
    media,
  };
  if (JSON.stringify(pack).length > 24 * 1024 * 1024)
    throw new Error(
      "Director pack exceeds its 24 MiB import limit; export fewer families",
    );
  return { pack, warnings };
}
