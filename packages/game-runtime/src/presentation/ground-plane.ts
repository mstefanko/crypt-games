const GROUND_FOG = [60, 48, 88] as const;

/** CPU Mode-7 plane; buffers and row distances are allocated once per viewport. */
export interface GroundCamera {
  x: number;
  y: number;
  heading: number;
  height: number;
  horizon: number;
  focal: number;
}
export interface GroundTexture {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  outside: readonly [number, number, number];
  unitsPerPixel?: number;
}
export class GroundPlaneRenderer {
  private image: ImageData;
  private distances: Float64Array;
  private key = "";
  constructor(
    readonly width: number,
    readonly height: number,
    readonly horizon: number,
  ) {
    this.image = new ImageData(width, height - horizon);
    this.distances = new Float64Array(height - horizon);
  }
  render(
    ctx: CanvasRenderingContext2D,
    camera: GroundCamera,
    texture: GroundTexture,
  ): void {
    const key = `${camera.height}:${camera.focal}:${camera.horizon}`;
    if (key !== this.key) {
      for (let y = this.horizon; y < this.height; y++)
        this.distances[y - this.horizon] =
          (camera.height * camera.focal) / Math.max(0.5, y - camera.horizon);
      this.key = key;
    }
    const cos = Math.cos(camera.heading),
      sin = Math.sin(camera.heading),
      out = this.image.data;
    for (let row = 0; row < this.distances.length; row++) {
      const distance = this.distances[row]!,
        span = distance / camera.focal,
        stepX = -sin * span,
        stepY = cos * span;
      let x = camera.x + cos * distance - (stepX * this.width) / 2,
        y = camera.y + sin * distance - (stepY * this.width) / 2;
      const fog = Math.min(0.7, distance / 1700);
      for (let col = 0; col < this.width; col++, x += stepX, y += stepY) {
        const px = Math.floor(x / (texture.unitsPerPixel ?? 1)),
          py = Math.floor(y / (texture.unitsPerPixel ?? 1)),
          dst = (row * this.width + col) * 4,
          src = (py * texture.width + px) * 4,
          inside =
            px >= 0 && py >= 0 && px < texture.width && py < texture.height;
        for (let c = 0; c < 3; c++) {
          const color = inside ? texture.pixels[src + c]! : texture.outside[c]!;
          out[dst + c] = Math.round(color * (1 - fog) + GROUND_FOG[c]! * fog);
        }
        out[dst + 3] = 255;
      }
    }
    ctx.putImageData(this.image, 0, this.horizon);
  }
}
export interface GroundBillboard {
  id: string;
  x: number;
  y: number;
  z?: number;
  width: number;
  height: number;
  heading?: number;
}
export interface ProjectedBillboard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
  frame: number;
}
export function projectBillboards(
  objects: readonly GroundBillboard[],
  camera: GroundCamera,
  width: number,
  height: number,
  frames = 16,
): ProjectedBillboard[] {
  const cos = Math.cos(camera.heading),
    sin = Math.sin(camera.heading),
    result: ProjectedBillboard[] = [];
  for (const o of objects) {
    const dx = o.x - camera.x,
      dy = o.y - camera.y,
      depth = dx * cos + dy * sin;
    if (depth < 8) continue;
    const scale = camera.focal / depth,
      x = width / 2 + (-dx * sin + dy * cos) * scale,
      y = camera.horizon + (camera.height - (o.z ?? 0)) * scale,
      w = o.width * scale,
      h = o.height * scale;
    if (
      x + w / 2 < 0 ||
      x - w / 2 > width ||
      y - h > height ||
      y < camera.horizon - 40
    )
      continue;
    const angle =
      ((o.heading ?? 0) - camera.heading + Math.PI * 2) % (Math.PI * 2);
    result.push({
      id: o.id,
      x,
      y,
      width: w,
      height: h,
      depth,
      frame: Math.round((angle / (Math.PI * 2)) * frames) % frames,
    });
  }
  return result.sort((a, b) => b.depth - a.depth || a.id.localeCompare(b.id));
}
