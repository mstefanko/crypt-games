import {
  evaluateScene,
  validateScene,
  type SceneDocument,
} from "@onepage/director-core";
import {
  createPlaybackController,
  hydrateSceneMedia,
  renderScene,
  type PlaybackState,
} from "@onepage/director-runtime";

export interface CinematicSlot {
  instanceId: string;
  flowEpoch: number;
}
export type CinematicOutcome = "complete" | "skip";
export function readM2Scene(value: unknown): SceneDocument {
  const scene = value as SceneDocument;
  const errors = validateScene(scene).filter(
    (item) => item.severity === "error",
  );
  if (errors.length)
    throw new Error(
      `Cinematic rejected: ${errors.map((e) => e.message).join("; ")}`,
    );
  return structuredClone(scene);
}

/** Canvas presentation advanced only by the host's 60 Hz cinematic clock. */
export class M2Director {
  private readonly scene: SceneDocument;
  private player?: ReturnType<typeof createPlaybackController>;
  private images = new Map<string, HTMLImageElement>();
  private abort?: AbortController;
  private generation = 0;
  private disposed = false;
  private active = false;
  private preview = false;
  private paused = false;
  private loading = false;
  private slot?: CinematicSlot;
  private callback?: (outcome: CinematicOutcome, slot: CinematicSlot) => void;
  private lastDialogue?: string;
  private previewState?: PlaybackState;
  private submissions = 0;
  private submissionMs: number[] = [];
  constructor(
    private readonly options: {
      canvas: HTMLCanvasElement;
      scene: SceneDocument;
      onError?: (message: string) => void;
      onDialogue?: (id: string) => void;
      /** Test/device seam; default is the shared Director Canvas renderer. */
      render?: typeof renderScene;
      hydrate?: typeof hydrateSceneMedia;
    },
  ) {
    this.scene = readM2Scene(options.scene);
    options.canvas.width = this.scene.width;
    options.canvas.height = this.scene.height;
  }
  async start(
    slot: CinematicSlot,
    callback: (outcome: CinematicOutcome, slot: CinematicSlot) => void,
  ): Promise<boolean> {
    if (this.disposed) return false;
    this.cancel();
    const token = this.generation;
    this.slot = { ...slot };
    this.callback = callback;
    this.active = true;
    this.loading = true;
    this.abort = new AbortController();
    const images = this.images;
    const finish = (outcome: CinematicOutcome) => {
      if (
        this.disposed ||
        !this.active ||
        this.preview ||
        token !== this.generation
      )
        return;
      const slot = this.slot!;
      const callback = this.callback;
      this.active = false;
      this.loading = false;
      this.callback = undefined;
      this.previewState = this.player?.getState();
      this.player?.dispose();
      this.abort?.abort();
      this.images.clear();
      callback?.(outcome, { ...slot });
    };
    // Create before hydration, so skip during a slow image load still works once.
    this.player = createPlaybackController(this.scene, {
      onComplete: () => finish("complete"),
      onSkip: () => finish("skip"),
    });
    try {
      await (this.options.hydrate ?? hydrateSceneMedia)(this.scene, {
        images,
        signal: this.abort.signal,
      });
      if (this.disposed || !this.active || token !== this.generation) {
        images.clear();
        return false;
      }
      const missing = this.scene.media.filter(
        (m) => m.mime.startsWith("image/") && !images.has(m.dataUrl),
      );
      if (missing.length)
        throw new Error(
          `Missing cinematic images: ${missing.map((m) => m.id).join(", ")}`,
        );
      this.loading = false;
      if (!this.paused) this.player.play();
      this.render();
      return true;
    } catch (error) {
      if (!this.disposed && token === this.generation) {
        this.cancel();
        this.options.onError?.(
          `Cinematic unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
  }
  step(delta = 1): void {
    if (
      !this.active ||
      this.loading ||
      this.preview ||
      this.paused ||
      this.disposed
    )
      return;
    this.player?.step(delta);
    // Completion may synchronously cancel/restart via the host callback.
    if (this.active) this.render();
  }
  advanceDialogue(): void {
    if (
      !this.active ||
      this.loading ||
      this.paused ||
      this.preview ||
      this.disposed
    )
      return;
    this.player?.advance();
    if (this.active) this.render();
  }
  skip(): void {
    if (!this.active || this.preview || this.disposed) return;
    this.player?.skip();
  }
  pause(): void {
    this.paused = true;
    this.player?.pause();
  }
  resume(): void {
    this.paused = false;
    if (
      this.active &&
      !this.loading &&
      !this.preview &&
      !this.player?.getState().gate &&
      !this.player?.getState().revealed
    )
      this.player?.play();
  }
  /** Preview is outcome-free, including later advance/skip. Fresh start returns to live mode. */
  seek(tick: number): void {
    if (this.disposed || !this.player || !Number.isFinite(tick)) return;
    this.preview = true;
    this.callback = undefined;
    this.player.pause();
    this.player.seek(tick);
    this.previewState = this.player.getState();
    this.render();
  }
  private render(): void {
    if (this.disposed || !this.player) return;
    const state = this.getState();
    const start = performance.now();
    (this.options.render ?? renderScene)(
      this.options.canvas,
      this.scene,
      state.tick,
      { mediaImages: this.images, revealDialogue: state.revealed },
    );
    this.submissions++;
    this.submissionMs.push(performance.now() - start);
    if (this.submissionMs.length > 600) this.submissionMs.shift();
    if (!this.preview) {
      const line = evaluateScene(this.scene, state.tick).dialogue?.id;
      if (line && line !== this.lastDialogue) this.options.onDialogue?.(line);
      this.lastDialogue = line;
    }
  }
  getState(): PlaybackState {
    return (
      this.previewState ??
      this.player?.getState() ?? {
        tick: 0,
        playing: false,
        revealed: false,
        ended: false,
      }
    );
  }
  stats() {
    const times = [...this.submissionMs].sort((a, b) => a - b);
    return {
      active: this.active,
      loading: this.loading,
      images: this.images.size,
      submissions: this.submissions,
      submissionP95Ms: times[Math.floor(times.length * 0.95)] ?? 0,
      rafOwned: 0,
      disposed: this.disposed,
    };
  }
  cancel(): void {
    this.generation++;
    this.active = false;
    this.loading = false;
    this.preview = false;
    this.previewState = undefined;
    this.callback = undefined;
    this.slot = undefined;
    this.lastDialogue = undefined;
    this.player?.dispose();
    this.player = undefined;
    this.abort?.abort();
    this.abort = undefined;
    this.images.clear();
    this.images = new Map();
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
  }
}
export type { SceneDocument } from "@onepage/director-core";
