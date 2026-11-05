export interface CameraPoint {
  x: number;
  y: number;
}
export interface CameraBounds extends CameraPoint {
  width: number;
  height: number;
}
export interface CameraOptions {
  width: number;
  height: number;
  bounds: CameraBounds | null;
  zoom?: number;
  anchor?: CameraPoint;
  /** Logical screen pixels on either side of the follow anchor. */
  deadzone?: CameraPoint;
  reducedMotion?: boolean;
  /** Compatibility profiles may retain subpixel positioning and legacy Pixi shake. */
  roundPixels?: boolean;
  shakeMode?: "decay" | "pixi-legacy";
}
export interface CameraTransform {
  x: number;
  y: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
}
const finite = (n: number) => Number.isFinite(n) && Math.abs(n) <= 1e9;
/** One world camera. Explicit samples only: no ticker, wall clock or gameplay writes. */
export class Camera2D {
  private options!: Required<CameraOptions>;
  private origin = { x: 0, y: 0 };
  private following = false;
  private shakeAge = 0;
  private shakeDuration = 0;
  private shakeAmplitude = 0;
  private phase = 0;
  // Retain the old subtraction trace, including floating-point expiry boundaries.
  private legacyRemainingSeconds = 0;
  constructor(options: CameraOptions) {
    this.configure(options);
  }
  configure(options: CameraOptions): void {
    const next = {
      ...options,
      bounds: options.bounds ? { ...options.bounds } : null,
      zoom: options.zoom ?? 1,
      anchor: { ...(options.anchor ?? { x: 0.5, y: 0.5 }) },
      deadzone: { ...(options.deadzone ?? { x: 0, y: 0 }) },
      reducedMotion: options.reducedMotion ?? false,
      roundPixels: options.roundPixels ?? true,
      shakeMode: options.shakeMode ?? "decay",
    };
    if (
      options.bounds === undefined ||
      ![
        next.width,
        next.height,
        ...(next.bounds
          ? [
              next.bounds.x,
              next.bounds.y,
              next.bounds.width,
              next.bounds.height,
            ]
          : []),
        next.zoom,
        next.anchor.x,
        next.anchor.y,
        next.deadzone.x,
        next.deadzone.y,
      ].every(finite) ||
      next.width <= 0 ||
      next.height <= 0 ||
      (next.bounds !== null &&
        (next.bounds.width <= 0 || next.bounds.height <= 0)) ||
      next.zoom < (next.shakeMode === "pixi-legacy" ? 0.1 : 0.25) ||
      next.zoom > 4 ||
      next.anchor.x < 0 ||
      next.anchor.x > 1 ||
      next.anchor.y < 0 ||
      next.anchor.y > 1 ||
      next.deadzone.x < 0 ||
      next.deadzone.x > next.width ||
      next.deadzone.y < 0 ||
      next.deadzone.y > next.height ||
      typeof next.reducedMotion !== "boolean" ||
      typeof next.roundPixels !== "boolean" ||
      !["decay", "pixi-legacy"].includes(next.shakeMode)
    )
      throw new RangeError("Invalid camera options");
    this.options = next;
    this.clamp();
    if (next.reducedMotion) {
      this.shakeDuration = 0;
      this.legacyRemainingSeconds = 0;
    }
  }
  follow(target: CameraPoint, snap = false): CameraTransform {
    if (![target.x, target.y].every(finite))
      throw new RangeError("Invalid camera target");
    const { width, height, anchor, deadzone, zoom } = this.options;
    for (const axis of ["x", "y"] as const) {
      const size = axis === "x" ? width : height;
      const desired = target[axis] - (size * anchor[axis]) / zoom;
      const half = deadzone[axis] / zoom;
      if (!this.following || snap) this.origin[axis] = desired;
      else if (desired < this.origin[axis] - half)
        this.origin[axis] = desired + half;
      else if (desired > this.origin[axis] + half)
        this.origin[axis] = desired - half;
    }
    this.following = true;
    this.clamp();
    return this.inspect();
  }
  /** Explicit origin positioning; null bounds deliberately permits manual pan. */
  position(point: CameraPoint): CameraTransform {
    if (![point.x, point.y].every(finite))
      throw new RangeError("Invalid camera position");
    this.origin = { ...point };
    this.following = true;
    this.clamp();
    return this.inspect();
  }
  /** Unrounded origin for adapters retaining authored framing. */
  get positionValue(): CameraPoint {
    return { ...this.origin };
  }
  shake(amplitude: number, durationMs: number): boolean {
    if (
      !finite(amplitude) ||
      amplitude < 0 ||
      amplitude > 32 ||
      !finite(durationMs) ||
      durationMs < 0 ||
      durationMs > 1000
    )
      throw new RangeError("Invalid camera shake");
    if (this.options.reducedMotion) return false;
    this.shakeAmplitude = amplitude;
    this.shakeDuration = durationMs;
    this.shakeAge = 0;
    this.legacyRemainingSeconds = durationMs / 1000;
    return true;
  }
  advance(deltaMs: number): CameraTransform {
    if (
      !Number.isFinite(deltaMs) ||
      deltaMs < 0 ||
      deltaMs > (this.options.shakeMode === "pixi-legacy" ? 1e9 : 100)
    )
      throw new RangeError("Camera delta must be in [0, 100]ms");
    this.shakeAge = Math.min(this.shakeDuration, this.shakeAge + deltaMs);
    this.phase += (deltaMs / 1000) * 67;
    this.legacyRemainingSeconds = Math.max(
      0,
      this.legacyRemainingSeconds - deltaMs / 1000,
    );
    return this.inspect();
  }
  reset(): void {
    this.following = false;
    this.shakeDuration = 0;
    this.legacyRemainingSeconds = 0;
  }
  inspect(): CameraTransform {
    const { zoom, bounds, width, height } = this.options;
    const envelope =
      this.shakeDuration > this.shakeAge
        ? this.shakeAmplitude * (1 - this.shakeAge / this.shakeDuration)
        : 0;
    // Analytic, deterministic cosmetic offsets do not consume any RNG stream.
    const legacy = this.options.shakeMode === "pixi-legacy";
    const magnitude = this.legacyRemainingSeconds > 0 ? this.shakeAmplitude : 0;
    const offsetX = legacy
      ? Math.sin(this.phase) * magnitude
      : Math.round(Math.cos(this.shakeAge * 0.11) * envelope) || 0;
    const offsetY = legacy
      ? Math.cos(this.phase * 1.31) * magnitude
      : Math.round(Math.sin(this.shakeAge * 0.17) * envelope) || 0;
    const rounded = (value: number, min: number, max: number) =>
      value === min || value === max
        ? value
        : Math.max(min, Math.min(max, Math.round(value * zoom) / zoom));
    if (!bounds || !this.options.roundPixels)
      return { ...this.origin, zoom, offsetX, offsetY };
    const x = rounded(
      this.origin.x,
      bounds.x,
      bounds.x + Math.max(0, bounds.width - width / zoom),
    );
    const y = rounded(
      this.origin.y,
      bounds.y,
      bounds.y + Math.max(0, bounds.height - height / zoom),
    );
    return { x, y, zoom, offsetX, offsetY };
  }
  toWorld(screen: CameraPoint): CameraPoint {
    if (![screen.x, screen.y].every(finite))
      throw new RangeError("Invalid camera point");
    const t = this.inspect();
    return {
      x: (screen.x - t.offsetX) / t.zoom + t.x,
      y: (screen.y - t.offsetY) / t.zoom + t.y,
    };
  }
  private clamp(): void {
    const { bounds, width, height, zoom } = this.options;
    if (!bounds) return;
    this.origin.x = Math.max(
      bounds.x,
      Math.min(
        bounds.x + Math.max(0, bounds.width - width / zoom),
        this.origin.x,
      ),
    );
    this.origin.y = Math.max(
      bounds.y,
      Math.min(
        bounds.y + Math.max(0, bounds.height - height / zoom),
        this.origin.y,
      ),
    );
  }
}
