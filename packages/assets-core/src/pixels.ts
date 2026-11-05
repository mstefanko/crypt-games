import type {
  Anchors,
  AssetFrame,
  AssetVariant,
  DirectionalClip,
  IndexedPixelFrame,
} from "./types";
export function resolveAnchors(
  variant: AssetVariant,
  frame?: AssetFrame,
): Anchors {
  return structuredClone({ ...variant.anchors, ...frame?.anchors });
}
export function frameAtTick(
  clip: DirectionalClip,
  tick: number,
  loop = true,
): AssetFrame | undefined {
  if (!Number.isFinite(tick) || !clip.frames.length) return undefined;
  const duration = clip.frames.reduce(
    (sum, frame) => sum + frame.durationTicks,
    0,
  );
  if (!(duration > 0)) return undefined;
  let local = loop
    ? ((Math.floor(tick) % duration) + duration) % duration
    : Math.max(0, Math.min(duration - 1, Math.floor(tick)));
  for (const frame of clip.frames) {
    if (local < frame.durationTicks) return frame;
    local -= frame.durationTicks;
  }
  return clip.frames.at(-1);
}
export function frameToRgba(
  input: AssetFrame | IndexedPixelFrame,
): Uint8ClampedArray {
  const frame = "visual" in input ? input.visual : input;
  if (frame.kind !== "indexed")
    throw new Error(
      "Raster pixels require image decoding in the browser; use the source sheet and frame rectangle",
    );
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width < 1 ||
    frame.height < 1 ||
    frame.width > 128 ||
    frame.height > 128 ||
    frame.rows.length !== frame.height ||
    frame.palette.length < 1 ||
    frame.palette.length > 16 ||
    !frame.palette.every((c) => /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(c))
  )
    throw new Error("Invalid indexed frame");
  const colors = frame.palette.map((color, i) =>
    i === 0
      ? [0, 0, 0, 0]
      : [
          parseInt(color.slice(1, 3), 16),
          parseInt(color.slice(3, 5), 16),
          parseInt(color.slice(5, 7), 16),
          color.length === 9 ? parseInt(color.slice(7, 9), 16) : 255,
        ],
  );
  const rgba = new Uint8ClampedArray(frame.width * frame.height * 4);
  frame.rows.forEach((row, y) => {
    if (row.length !== frame.width || !/^[a-f\d]+$/i.test(row))
      throw new Error("Invalid indexed pixel row");
    [...row].forEach((char, x) => {
      const color = colors[parseInt(char, 16)];
      if (!color) throw new Error("Pixel index exceeds palette");
      rgba.set(color, (y * frame.width + x) * 4);
    });
  });
  return rgba;
}
export function capabilityReport(
  variant: AssetVariant,
  required: { actions?: string[]; directions?: string[] } = {},
): { ready: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const name of required.actions ?? [])
    if (!variant.actions.some((a) => a.name === name))
      missing.push(`${name} action`);
  for (const action of variant.actions)
    for (const direction of required.directions ?? [])
      if (
        !action.directions.some(
          (c) => c.direction === direction && c.frames.length,
        )
      )
        missing.push(`${action.name}: ${direction}`);
  return { ready: missing.length === 0, missing };
}
const uint32 = (n: number) =>
  new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let b = 0; b < 8; b++)
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = join([
    Uint8Array.from([...type].map((c) => c.charCodeAt(0))),
    data,
  ]);
  return join([uint32(data.length), body, uint32(crc32(body))]);
}
/** Deterministic PNG encoder. Stored DEFLATE blocks avoid browser/Node dependencies. */
export function encodeRgbaPng(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): Uint8Array {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 4 * 1024 * 1024 ||
    rgba.length !== width * height * 4
  )
    throw new Error("PNG exceeds bounded atlas dimensions");
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(
      rgba.subarray(y * width * 4, (y + 1) * width * 4),
      y * (width * 4 + 1) + 1,
    );
  const blocks: Uint8Array[] = [new Uint8Array([0x78, 0x01])];
  let a = 1,
    b = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const size = Math.min(65535, raw.length - offset);
    blocks.push(
      new Uint8Array([
        offset + size === raw.length ? 1 : 0,
        size & 255,
        size >>> 8,
        ~size & 255,
        (~size >>> 8) & 255,
      ]),
      raw.subarray(offset, offset + size),
    );
  }
  blocks.push(uint32((b * 65536 + a) >>> 0));
  const header = join([
    uint32(width),
    uint32(height),
    new Uint8Array([8, 6, 0, 0, 0]),
  ]);
  return join([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", join(blocks)),
    chunk("IEND", new Uint8Array()),
  ]);
}
export function bytesToDataUrl(bytes: Uint8Array, mime = "image/png"): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}
