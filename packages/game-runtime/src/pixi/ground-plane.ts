import { Mesh, MeshGeometry, Texture } from "pixi.js";
import type { GroundCamera } from "../presentation/ground-plane";

/** Inverse projection shared by the GPU mesh and its CPU-math regression oracle. */
export function groundSample(
  camera: GroundCamera,
  x: number,
  y: number,
  width: number,
) {
  const depth =
    (camera.height * camera.focal) / Math.max(0.5, y - camera.horizon);
  const lateral = ((x - width / 2) * depth) / camera.focal;
  return {
    x:
      camera.x +
      Math.cos(camera.heading) * depth -
      Math.sin(camera.heading) * lateral,
    y:
      camera.y +
      Math.sin(camera.heading) * depth +
      Math.cos(camera.heading) * lateral,
  };
}

/** One retained strip per logical scanline. Only UVs change; the static track is
 * uploaded once, and sampling/rasterization stays on the GPU. */
export class GroundPlaneMesh {
  readonly geometry: MeshGeometry;
  readonly mesh: Mesh;
  private readonly uv: Float32Array;
  private disposed = false;
  constructor(
    readonly texture: Texture,
    readonly width: number,
    readonly height: number,
    readonly horizon: number,
    readonly worldWidth: number,
    readonly worldHeight: number,
  ) {
    const rows = height - horizon;
    const positions = new Float32Array((rows + 1) * 4);
    this.uv = new Float32Array(positions.length);
    const indices = new Uint32Array(rows * 6);
    for (let row = 0; row <= rows; row++) {
      positions.set([0, horizon + row, width, horizon + row], row * 4);
      if (row < rows)
        indices.set(
          [
            row * 2,
            row * 2 + 1,
            row * 2 + 2,
            row * 2 + 1,
            row * 2 + 3,
            row * 2 + 2,
          ],
          row * 6,
        );
    }
    this.geometry = new MeshGeometry({ positions, uvs: this.uv, indices });
    this.mesh = new Mesh({ geometry: this.geometry, texture });
  }
  update(camera: GroundCamera) {
    for (let row = 0; row <= this.height - this.horizon; row++) {
      const left = groundSample(camera, 0, this.horizon + row, this.width);
      const right = groundSample(
        camera,
        this.width,
        this.horizon + row,
        this.width,
      );
      this.uv.set(
        [
          left.x / this.worldWidth,
          left.y / this.worldHeight,
          right.x / this.worldWidth,
          right.y / this.worldHeight,
        ],
        row * 4,
      );
    }
    this.geometry.getBuffer("aUV").update();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.destroy();
    // These three buffers belong exclusively to this plane. Pixi defaults to
    // retaining buffers when a geometry is destroyed for shared-buffer callers.
    this.geometry.destroy(true);
    this.texture.destroy(true);
  }
}
