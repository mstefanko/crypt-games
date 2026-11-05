import type {
  AssetDiagnostic,
  AssetFamily,
  AssetLibraryDocument,
  MediaResource,
} from "./types";
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 65536): v is string =>
  typeof v === "string" && v.length <= max;
const id = (v: unknown) => text(v, 256) && v.trim().length > 0;
const integer = (v: unknown, min: number, max: number) =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
export const SAFE_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"];
export function validateAssetFamily(
  value: unknown,
  media: MediaResource[] = [],
): AssetDiagnostic[] {
  const diagnostics: AssetDiagnostic[] = [];
  const error = (path: string, message: string) =>
    diagnostics.push({
      code: "invalid-family",
      path,
      message,
      severity: "error",
    });
  const list = (v: unknown, path: string, max: number, min = 1): v is any[] => {
    if (!Array.isArray(v) || v.length < min || v.length > max) {
      error(path, `Expected ${min}–${max} items`);
      return false;
    }
    return true;
  };
  const ident = (v: unknown, path: string) => {
    if (!id(v))
      error(path, "Expected a nonempty ID or name up to 256 characters");
  };
  const points = (v: unknown, path: string, partial = false) => {
    if (!object(v)) {
      error(path, "Expected anchors");
      return;
    }
    if (Object.keys(v).some((k) => !["ground", "hand", "speech"].includes(k)))
      error(path, "Unknown anchor");
    for (const key of ["ground", "hand", "speech"]) {
      if (partial && v[key] === undefined) continue;
      if (
        !object(v[key]) ||
        !Number.isFinite(v[key].x) ||
        !Number.isFinite(v[key].y) ||
        Math.abs(v[key].x) > 8192 ||
        Math.abs(v[key].y) > 8192
      )
        error(`${path}.${key}`, "Expected finite x/y coordinates within ±8192");
    }
  };
  if (!object(value)) {
    error("family", "Expected asset family");
    return diagnostics;
  }
  ident(value.id, "id");
  ident(value.name, "name");
  if (!integer(value.revision, 1, Number.MAX_SAFE_INTEGER))
    error("revision", "Expected positive revision");
  if (!["character", "prop", "set"].includes(value.kind))
    error("kind", "Unsupported family kind");
  if (value.sourcePackId !== undefined)
    ident(value.sourcePackId, "sourcePackId");
  if (value.description !== undefined && !text(value.description))
    error("description", "Invalid description");
  if (
    value.tags !== undefined &&
    (!Array.isArray(value.tags) ||
      value.tags.length > 64 ||
      !value.tags.every((t: unknown) => id(t)))
  )
    error("tags", "Invalid tags");
  const variantIds = new Set<string>(),
    actionIds = new Set<string>(),
    frameIds = new Set<string>();
  let pixelCount = 0;
  if (list(value.variants, "variants", 64))
    value.variants.forEach((variant, vi) => {
      const path = `variants.${vi}`;
      if (!object(variant)) {
        error(path, "Expected variant");
        return;
      }
      ident(variant.id, `${path}.id`);
      ident(variant.name, `${path}.name`);
      ident(variant.style, `${path}.style`);
      if (variantIds.has(variant.id)) error(path, "Duplicate variant ID");
      variantIds.add(variant.id);
      if (
        typeof variant.logicalHeight !== "number" ||
        !Number.isFinite(variant.logicalHeight) ||
        variant.logicalHeight <= 0 ||
        variant.logicalHeight > 8192
      )
        error(path, "Invalid logical height");
      points(variant.anchors, `${path}.anchors`);
      const actionNames = new Set<string>();
      if (list(variant.actions, `${path}.actions`, 64))
        variant.actions.forEach((action, ai) => {
          const ap = `${path}.actions.${ai}`;
          if (!object(action)) {
            error(ap, "Expected action");
            return;
          }
          ident(action.id, `${ap}.id`);
          ident(action.name, `${ap}.name`);
          if (actionIds.has(action.id)) error(ap, "Duplicate action ID");
          actionIds.add(action.id);
          if (actionNames.has(action.name)) error(ap, "Duplicate action name");
          actionNames.add(action.name);
          if (typeof action.loop !== "boolean")
            error(ap, "Expected loop boolean");
          const directions = new Set<string>();
          if (list(action.directions, `${ap}.directions`, 32))
            action.directions.forEach((clip, di) => {
              const cp = `${ap}.directions.${di}`;
              if (!object(clip)) {
                error(cp, "Expected directional clip");
                return;
              }
              ident(clip.direction, `${cp}.direction`);
              if (directions.has(clip.direction))
                error(cp, "Duplicate direction");
              directions.add(clip.direction);
              if (list(clip.frames, `${cp}.frames`, 256))
                clip.frames.forEach((frame, fi) => {
                  const fp = `${cp}.frames.${fi}`;
                  if (!object(frame)) {
                    error(fp, "Expected frame");
                    return;
                  }
                  ident(frame.id, `${fp}.id`);
                  if (frameIds.has(frame.id)) error(fp, "Duplicate frame ID");
                  frameIds.add(frame.id);
                  if (!integer(frame.durationTicks, 1, 36000))
                    error(fp, "Duration must be 1–36000 integer 60 Hz ticks");
                  if (frame.anchors !== undefined)
                    points(frame.anchors, `${fp}.anchors`, true);
                  const visual = frame.visual;
                  if (
                    !object(visual) ||
                    !integer(visual.width, 1, 8192) ||
                    !integer(visual.height, 1, 8192)
                  ) {
                    error(fp, "Invalid frame visual/dimensions");
                    return;
                  }
                  if (visual.kind === "indexed") {
                    pixelCount += visual.width * visual.height;
                    if (visual.width > 128 || visual.height > 128)
                      error(fp, "Editable pixel frames are limited to 128×128");
                    const validPalette =
                      Array.isArray(visual.palette) &&
                      visual.palette.length > 0 &&
                      visual.palette.length <= 16 &&
                      visual.palette.every(
                        (c: unknown) =>
                          typeof c === "string" &&
                          /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(c),
                      );
                    if (!validPalette)
                      error(
                        fp,
                        "Palette requires 1–16 hex colors; index zero is transparent",
                      );
                    if (
                      !Array.isArray(visual.rows) ||
                      visual.rows.length !== visual.height ||
                      !visual.rows.every(
                        (row: unknown) =>
                          typeof row === "string" &&
                          row.length === visual.width &&
                          /^[0-9a-f]+$/i.test(row) &&
                          (!validPalette ||
                            [...row].every(
                              (c) => parseInt(c, 16) < visual.palette.length,
                            )),
                      )
                    )
                      error(
                        fp,
                        "Pixel rows must match dimensions and palette indices",
                      );
                  } else if (visual.kind === "raster") {
                    const image = media.find(
                      (m) => object(m) && m.id === visual.mediaId,
                    );
                    if (!image || !SAFE_IMAGE_MIMES.includes(image.mime))
                      error(
                        fp,
                        "Raster frame requires embedded PNG/JPEG/WebP media",
                      );
                    if (
                      !integer(visual.x, 0, 8192) ||
                      !integer(visual.y, 0, 8192)
                    )
                      error(
                        fp,
                        "Raster coordinates must be nonnegative integers",
                      );
                    if (
                      image &&
                      ((image.width !== undefined &&
                        visual.x + visual.width > image.width) ||
                        (image.height !== undefined &&
                          visual.y + visual.height > image.height))
                    )
                      error(fp, "Raster rectangle exceeds source dimensions");
                  } else error(fp, "Unsupported visual kind");
                });
            });
        });
    });
  if (pixelCount > 4 * 1024 * 1024)
    error("variants", "Family exceeds four million editable pixels");
  return diagnostics;
}
export function validateAssetDocument(value: unknown): AssetDiagnostic[] {
  const out: AssetDiagnostic[] = [];
  const fail = (path: string, message: string) =>
    out.push({ code: "invalid-document", path, message, severity: "error" });
  if (!object(value)) {
    fail("", "Expected library document");
    return out;
  }
  if (
    value.schemaVersion !== 1 ||
    !id(value.id) ||
    !id(value.name) ||
    !integer(value.revision, 1, Number.MAX_SAFE_INTEGER)
  )
    fail("", "Invalid library identity, schema or revision");
  const limits: Record<string, number> = {
    sources: 512,
    media: 512,
    families: 512,
    versions: 4096,
    collections: 256,
    installations: 4096,
  };
  for (const [key, max] of Object.entries(limits))
    if (!Array.isArray(value[key]) || value[key].length > max)
      fail(key, `Expected at most ${max} records`);
  if (out.length) return out;
  let bytes = 0;
  const records = (items: any[], path: string) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (!object(item) || !id(item.id) || seen.has(item.id))
        fail(`${path}.${i}`, "Invalid or duplicate record ID");
      else seen.add(item.id);
    });
  };
  for (const key of Object.keys(limits)) records(value[key], key);
  function mediaValid(items: any[], path: string) {
    if (items.length > 512) fail(path, "Too many media resources");
    records(items, path);
    for (const [i, m] of items.entries()) {
      if (!object(m)) continue;
      bytes += typeof m.dataUrl === "string" ? m.dataUrl.length : 0;
      if (
        !id(m.name) ||
        typeof m.mime !== "string" ||
        !/^(?:(?:image|audio|text)\/[a-z0-9.+-]+|application\/(?:octet-stream|json))$/.test(
          m.mime,
        ) ||
        typeof m.dataUrl !== "string" ||
        m.dataUrl.length > 12 * 1024 * 1024 ||
        !m.dataUrl.startsWith(`data:${m.mime};base64,`) ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          m.dataUrl.slice(m.dataUrl.indexOf(",") + 1),
        )
      )
        fail(
          `${path}.${i}`,
          "Media must use a supported embedded base64 payload (max 12 MiB)",
        );
      for (const key of ["width", "height"])
        if (m[key] !== undefined && !integer(m[key], 1, 8192))
          fail(`${path}.${i}.${key}`, "Invalid media dimensions");
      if (m.width && m.height && m.width * m.height > 32 * 1024 * 1024)
        fail(`${path}.${i}`, "Image dimensions exceed decode budget");
    }
  }
  mediaValid(value.media, "media");
  const mediaIds = new Set(value.media.map((m: any) => m?.id));
  const sourceIds = new Set(value.sources.map((s: any) => s?.id));
  value.sources.forEach((s: any, i: number) => {
    if (!object(s)) return;
    if (
      !id(s.name) ||
      !Array.isArray(s.mediaIds) ||
      !s.mediaIds.every((m: unknown) => mediaIds.has(m))
    )
      fail(`sources.${i}`, "Invalid source pack/media membership");
    for (const key of ["source", "license", "author"])
      if (s[key] !== undefined && !text(s[key]))
        fail(`sources.${i}.${key}`, "Invalid optional source metadata");
  });
  const families = (items: any[], path: string, media: MediaResource[]) =>
    items.forEach((f, i) =>
      out.push(
        ...validateAssetFamily(f, media).map((d) => ({
          ...d,
          path: `${path}.${i}.${d.path}`,
        })),
      ),
    );
  families(value.families, "families", value.media);
  for (const [i, f] of value.families.entries())
    if (f?.sourcePackId && !sourceIds.has(f.sourcePackId))
      fail(`families.${i}.sourcePackId`, "Missing source pack");
  const globalVariantIds = new Set<string>();
  for (const [fi, family] of value.families.entries()) {
    if (!object(family) || !Array.isArray(family.variants)) continue;
    for (const variant of family.variants) {
      if (!object(variant)) continue;
      if (globalVariantIds.has(variant.id))
        fail(
          `families.${fi}.variants`,
          "Variant IDs must be unique across the library",
        );
      globalVariantIds.add(variant.id);
    }
  }
  const familyIds = new Set(value.families.map((f: any) => f?.id));
  value.collections.forEach((c: any, i: number) => {
    if (
      object(c) &&
      (!id(c.name) ||
        !Array.isArray(c.familyIds) ||
        !c.familyIds.every((f: unknown) => familyIds.has(f)))
    )
      fail(`collections.${i}`, "Invalid collection");
  });
  const versionNumbers = new Set<string>();
  value.versions.forEach((v: any, i: number) => {
    if (!object(v)) return;
    if (
      !id(v.familyId) ||
      v.familyId !== v.family?.id ||
      !integer(v.number, 1, Number.MAX_SAFE_INTEGER) ||
      !id(v.name) ||
      !text(v.createdAt, 64) ||
      !Number.isFinite(Date.parse(v.createdAt)) ||
      !Array.isArray(v.media)
    ) {
      fail(`versions.${i}`, "Invalid saved version");
      return;
    }
    const versionKey = `${v.familyId}:${v.number}`;
    if (versionNumbers.has(versionKey))
      fail(`versions.${i}`, "Duplicate family version number");
    versionNumbers.add(versionKey);
    if (
      v.source !== undefined &&
      (!object(v.source) ||
        !id(v.source.id) ||
        !id(v.source.name) ||
        !Array.isArray(v.source.mediaIds) ||
        !v.source.mediaIds.every((m: unknown) => id(m)) ||
        ["source", "license", "author"].some(
          (key) => v.source[key] !== undefined && !text(v.source[key]),
        ))
    )
      fail(`versions.${i}.source`, "Invalid saved provenance");
    mediaValid(v.media, `versions.${i}.media`);
    families([v.family], `versions.${i}.family`, v.media);
  });
  value.installations.forEach((v: any, i: number) => {
    if (!object(v)) return;
    if (
      !id(v.projectId) ||
      !id(v.projectName) ||
      !id(v.versionId) ||
      v.familyId !== v.family?.id ||
      !Array.isArray(v.media)
    ) {
      fail(`installations.${i}`, "Invalid installation");
      return;
    }
    mediaValid(v.media, `installations.${i}.media`);
    families([v.family], `installations.${i}.family`, v.media);
  });
  if (bytes > 64 * 1024 * 1024)
    fail("media", "Library exceeds 64 MiB embedded-media budget");
  return out;
}
export function assertAssetDocument(
  value: unknown,
): asserts value is AssetLibraryDocument {
  const errors = validateAssetDocument(value).filter(
    (d) => d.severity === "error",
  );
  if (errors.length)
    throw new Error(
      errors
        .slice(0, 8)
        .map((d) => `${d.path}: ${d.message}`)
        .join("; "),
    );
}
export function assertAssetFamily(
  value: unknown,
  media: MediaResource[] = [],
): asserts value is AssetFamily {
  const errors = validateAssetFamily(value, media);
  if (errors.length)
    throw new Error(
      errors
        .slice(0, 8)
        .map((d) => `${d.path}: ${d.message}`)
        .join("; "),
    );
}
