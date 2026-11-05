import { GameView } from "../view.ts";
import type { GameDefinitions } from "@onepage/game-project/runtime";
import { M3View } from "../m3/view.ts";
import { BrowserGraphicsOwner } from "../session/browser-graphics.ts";
import { createViewportMapping, type ViewportMapping } from "./viewport.ts";

export type ProductionPreviewSkin = ConstructorParameters<typeof M3View>[0];
export type ProductionPreviewDefinitions = ConstructorParameters<
  typeof M3View
>[1];
export interface DuelPreviewState {
  readonly observation: Parameters<M3View["duel"]>[0];
  readonly guardSlots: Parameters<M3View["duel"]>[4];
}
export interface ProductionPreviewScene {
  readonly profile: string;
  readonly state: unknown;
}
export interface ProductionPreviewResource {
  readonly canvas: HTMLCanvasElement;
  readonly logicalSize: Readonly<{ width: number; height: number }>;
  init(): Promise<void>;
  arena(state: Parameters<M3View["arena"]>[0]): void;
  duel?(...args: Parameters<M3View["duel"]>): void;
  adventure?(...args: Parameters<M3View["adventure"]>): void;
  platform?(state: Parameters<GameView["render"]>[0]): void;
  board(state: Parameters<M3View["board"]>[0]): void;
  resizeViewport(mapping: ViewportMapping): void;
  stats(): unknown;
  dispose(): void;
}
export interface ProductionPreviewStatus {
  readonly state: "preparing" | "ready" | "unsupported" | "error" | "disposed";
  readonly profile: string;
  readonly message: string;
}
export interface ProductionPreviewOptions {
  readonly platformDefinitions?: GameDefinitions;
  readonly skin: ProductionPreviewSkin;
  readonly duelDefinitions: ProductionPreviewDefinitions;
  readonly onStatus?: (status: ProductionPreviewStatus) => void;
  /** Resource injection also permits alternate renderer backends with the same ownership contract. */
  readonly createView?: (
    profile: "arena" | "grid" | "duel" | "adventure" | "platform",
  ) => ProductionPreviewResource;
}

/** Read-only production rendering. The caller supplies snapshots and owns all game clocks. */
export class ProductionPreview {
  private owner: BrowserGraphicsOwner<ProductionPreviewResource>;
  private observer?: ResizeObserver;
  private readonly abort = new AbortController();
  private snapshot?: ProductionPreviewScene;
  private activeScene?: ProductionPreviewScene;
  private profile?: string;
  private pendingProfile?: string;
  private pendingTask?: Promise<boolean>;
  private generation = 0;
  private disposed = false;
  private failed = false;
  private created = 0;
  private released = 0;
  private readonly adoptedCanvases = new WeakMap<
    ProductionPreviewResource,
    HTMLCanvasElement
  >();
  private currentStatus: ProductionPreviewStatus = {
    state: "unsupported",
    profile: "",
    message: "Choose a supported family scenario.",
  };
  constructor(
    private readonly surface: HTMLElement,
    private readonly options: ProductionPreviewOptions,
  ) {
    this.owner = this.makeOwner();
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(surface);
    }
    for (const type of ["resize", "orientationchange"])
      window.addEventListener(type, () => this.resize(), {
        signal: this.abort.signal,
      });
    window.visualViewport?.addEventListener("resize", () => this.resize(), {
      signal: this.abort.signal,
    });
  }
  private makeOwner() {
    return new BrowserGraphicsOwner<ProductionPreviewResource>({
      onActiveRelease: (view) => {
        this.released++;
        // GraphicsOwner calls this after dispose; Pixi may already have cleared
        // its renderer, so retain the DOM handle while initialization is live.
        this.adoptedCanvases.get(view)?.remove();
        this.adoptedCanvases.delete(view);
      },
      onContextLost: (view) => {
        view.canvas.hidden = true;
        this.failed = true;
        this.status(
          "error",
          "Graphics context lost. Refresh the preview to recover.",
        );
      },
    });
  }
  private status(
    state: ProductionPreviewStatus["state"],
    message: string,
    profile = this.snapshot?.profile ?? "",
  ) {
    this.currentStatus = Object.freeze({ state, profile, message });
    // Status observers are presentation code too; contain their failures.
    try {
      this.options.onStatus?.(this.currentStatus);
    } catch {
      /* The status remains available through stats(). */
    }
  }
  private fit(view: ProductionPreviewResource) {
    view.resizeViewport(
      createViewportMapping({
        logicalWidth: view.logicalSize.width,
        logicalHeight: view.logicalSize.height,
        cssWidth: this.surface.clientWidth,
        cssHeight: this.surface.clientHeight,
        integerScale: true,
        devicePixelRatio: window.devicePixelRatio || 1,
      }),
    );
  }
  private draw(view: ProductionPreviewResource, scene: ProductionPreviewScene) {
    // A faulty presenter can mutate only its own copy, including on resize/retry.
    const state = structuredClone(scene.state);
    if (scene.profile === "arena")
      view.arena(state as Parameters<M3View["arena"]>[0]);
    else if (scene.profile === "platform") {
      if (!view.platform) throw Error("Presenter lacks platform adapter");
      view.platform(state as Parameters<GameView["render"]>[0]);
    } else if (scene.profile === "duel") {
      if (!view.duel) throw Error("Presenter lacks duel adapter");
      const frame = state as DuelPreviewState;
      if (!frame?.observation || !Array.isArray(frame.guardSlots))
        throw Error("Duel preview requires observation and guardSlots");
      view.duel(frame.observation, frame.observation, 0, 0, frame.guardSlots);
    } else if (scene.profile === "adventure") {
      if (!view.adventure) throw Error("Presenter lacks adventure adapter");
      const frame = state as {
        map: Parameters<M3View["adventure"]>[0];
        player: number;
        removed: string[];
      };
      view.adventure(frame.map, frame.player, frame.removed);
    } else if (scene.profile === "grid")
      view.board(state as Parameters<M3View["board"]>[0]);
  }
  /** False means unsupported, superseded or failed. Errors never reach the authority caller. */
  async present(
    scene: ProductionPreviewScene,
    replace = false,
  ): Promise<boolean> {
    if (this.disposed) return false;
    let generation = this.generation;
    try {
      this.snapshot = structuredClone({
        profile: scene.profile,
        state: scene.state,
      });
      if (
        !replace &&
        this.owner.pending &&
        this.pendingProfile === scene.profile &&
        this.pendingTask
      )
        return await this.pendingTask;
      generation = ++this.generation;
      if (
        !["arena", "grid", "duel", "adventure", "platform"].includes(
          scene.profile,
        )
      ) {
        try {
          this.owner.dispose();
        } finally {
          // Disposal marks the old owner terminal even when a backend throws.
          // Always permit a later supported profile to allocate a fresh owner.
          this.owner = this.makeOwner();
          this.profile = undefined;
          this.activeScene = undefined;
          this.pendingProfile = undefined;
          this.pendingTask = undefined;
        }
        this.status(
          "unsupported",
          `Production preview is available for platform, arena, grid, duel and adventure; ${scene.profile} uses the diagnostic view.`,
        );
        return false;
      }
      if (
        !replace &&
        !this.failed &&
        this.profile === scene.profile &&
        this.owner.active
      ) {
        this.owner.cancelPending();
        this.draw(this.owner.active, this.snapshot);
        this.activeScene = this.snapshot;
        this.status(
          "ready",
          `Production ${scene.profile} presenter · read-only`,
        );
        return true;
      }
      const owner = this.owner;
      const view =
        this.options.createView?.(
          scene.profile as "arena" | "grid" | "duel" | "adventure" | "platform",
        ) ??
        (scene.profile === "platform"
          ? platformResource(this.options.platformDefinitions)
          : new M3View(
              this.options.skin,
              this.options.duelDefinitions,
              scene.profile,
            ));
      this.created++;
      const lease = owner.begin(view);
      const discard = () => {
        try {
          owner.discard(lease);
        } finally {
          if (owner.active !== view) {
            this.adoptedCanvases.get(view)?.remove();
            this.adoptedCanvases.delete(view);
          }
        }
      };
      this.status(
        "preparing",
        `Preparing production ${scene.profile} presenter…`,
      );
      const prepare = async () => {
        try {
          if (
            !(await owner.ready(lease)) ||
            this.disposed ||
            generation !== this.generation
          ) {
            discard();
            return false;
          }
          const snapshot = this.snapshot;
          if (!snapshot) {
            discard();
            return false;
          }
          this.fit(view);
          this.draw(view, snapshot);
          if (!owner.isCurrent(lease)) {
            discard();
            return false;
          }
          const canvas = view.canvas;
          this.adoptedCanvases.set(view, canvas);
          this.surface.append(canvas);
          let cleanupError: unknown;
          try {
            if (!owner.publish(lease)) {
              discard();
              return false;
            }
          } catch (error) {
            if (owner.active !== view) throw error;
            cleanupError = error;
          } finally {
            // Publication can transfer ownership before old-resource cleanup throws.
            if (owner.active === view) {
              this.profile = scene.profile;
              this.activeScene = snapshot;
              this.failed = false;
            }
          }
          this.status(
            "ready",
            `Production ${scene.profile} presenter · read-only${cleanupError ? `; previous cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : "renderer failure"}` : ""}`,
          );
          return true;
        } catch (error) {
          if (owner.active !== view) {
            // A failed init may not expose a canvas at all. Disposal owns every
            // partially allocated resource; do not inspect the candidate first.
            discard();
          }
          if (this.disposed || generation !== this.generation) return false;
          throw error;
        }
      };
      const task = prepare();
      this.pendingProfile = scene.profile;
      this.pendingTask = task;
      try {
        return await task;
      } finally {
        if (this.pendingTask === task) {
          this.pendingTask = undefined;
          this.pendingProfile = undefined;
        }
      }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      this.failed = true;
      this.status(
        "error",
        `Production preview unavailable: ${error instanceof Error ? error.message : "renderer failure"}`,
      );
      return false;
    }
  }
  /** Retry the last detached observation without requiring another caller copy. */
  refresh(): Promise<boolean> {
    return this.snapshot
      ? this.present(this.snapshot, true)
      : Promise.resolve(false);
  }
  /** Redraw the retained detached frame without stepping or scheduling the game. */
  resize(): void {
    if (this.disposed || !this.owner.active || !this.activeScene || this.failed)
      return;
    try {
      this.fit(this.owner.active);
      this.draw(this.owner.active, this.activeScene);
    } catch (error) {
      this.failed = true;
      this.status(
        "error",
        `Production preview unavailable: ${error instanceof Error ? error.message : "resize failure"}`,
      );
    }
  }
  stats() {
    return {
      status: this.currentStatus,
      created: this.created,
      released: this.released,
      pending: this.owner.pending ? 1 : 0,
      active: this.owner.active ? 1 : 0,
      view: this.owner.active?.stats() ?? null,
      disposed: this.disposed,
    };
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.observer?.disconnect();
    this.abort.abort();
    try {
      this.owner.dispose();
      this.status("disposed", "Production preview disposed.");
    } catch (error) {
      this.status(
        "disposed",
        `Production preview disposed; cleanup failed: ${error instanceof Error ? error.message : "renderer failure"}`,
      );
    } finally {
      this.snapshot = this.activeScene = undefined;
      this.profile = this.pendingProfile = undefined;
      this.pendingTask = undefined;
    }
  }
}

/** The First Light production presenter, under the same graphics lease as M3. */
function platformResource(
  definitions?: GameDefinitions,
): ProductionPreviewResource {
  if (!definitions)
    throw Error("Platform preview requires validated definitions");
  const view = new GameView(structuredClone(definitions));
  return {
    get canvas() {
      return view.app.canvas;
    },
    logicalSize: view.logicalSize,
    init: () => view.init(),
    arena() {
      throw Error("Wrong platform presenter adapter");
    },
    board() {
      throw Error("Wrong platform presenter adapter");
    },
    platform(state) {
      view.render(state, state, 0, 0, 0);
    },
    resizeViewport: (mapping) => view.resizeViewport(mapping),
    stats: () => ({ presenter: "GameView" }),
    dispose: () => view.dispose(),
  };
}
