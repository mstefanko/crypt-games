import { AudioRecoveryControl } from "./audio-recovery.ts";
import { ProductionReadiness } from "./readiness.ts";
import { WebHost } from "./host/web.ts";
import {
  createViewportMapping,
  applyViewportStyle,
} from "./presentation/viewport.ts";
import type {
  CompatibilityIdentity,
  InputFrame,
} from "../../game-project/src/types.ts";
import type { FlowSignal } from "../../game-project/src/flow.ts";
import { BrowserInput } from "./input.ts";
import { BrowserLifecycle } from "./session/browser-lifecycle.ts";
import { GameView } from "./view.ts";
import { M2View } from "./m2-view.ts";
import type { PreparedSkin } from "./m2-assets.ts";
import { M2Game } from "./m2-game.ts";
import { M2Audio, type Score } from "./m2-audio.ts";
import { M2Director, readM2Scene } from "./m2-director.ts";

type Skin = PreparedSkin & { atlasUrl: string };
export interface M2Options {
  definitions: unknown;
  flow: unknown;
  identity: CompatibilityIdentity;
  flowRulesId: string;
  skins: Record<string, Skin>;
  skin?: string;
  score: Score;
  scene: unknown;
  placeholder?: boolean;
}
/** One scheduler owns gameplay, cinematic time, devices and all presentation adapters. */
export class M2Session {
  readonly ready: Promise<void>;
  readonly game: M2Game;
  readonly metrics = {
    simulationMs: 0,
    renderMs: 0,
    startupMs: 0,
    transitionMs: 0,
    transitions: 0,
    debtPauses: 0,
    rafFrames: 0,
  };
  private view: M2View | GameView;
  private audio: M2Audio;
  private soundRecovery?: AudioRecoveryControl;
  private director: M2Director;
  private input?: BrowserInput;
  private lifecycle: BrowserLifecycle;
  private abort = new AbortController();
  private resize?: ResizeObserver;
  private disposed = false;
  private loaded = false;
  private graphicsUnavailable = false;
  private resizeFailed = false;
  private host: WebHost;
  private cached = false;
  private fault = false;
  private epoch = 0;
  private previous: ReturnType<M2Game["observation"]>;
  private current: ReturnType<M2Game["observation"]>;
  private shell: HTMLElement;
  private readiness: ProductionReadiness;
  private stage: HTMLElement;
  private overlay: HTMLElement;
  private pauseOverlay: HTMLElement;
  private status: HTMLElement;
  private mirror: HTMLElement;
  private controls: HTMLElement;
  private pauseButton: HTMLButtonElement;
  private cinematicCanvas: HTMLCanvasElement;
  private saved?: string;
  private muted = false;
  private lastMirror = -Infinity;
  private inTick = false;
  private pendingEntry = false;
  private cinematicReady = false;
  private requestedPaused = true;
  private pauseVersion = 0;
  private resumePendingVersion?: number;
  private resumeBoundary = Infinity;
  constructor(
    root: HTMLElement,
    private options: M2Options,
  ) {
    const started = performance.now(),
      scene = readM2Scene(options.scene);
    this.game = new M2Game(
      options.definitions,
      options.flow,
      options.identity,
      options.flowRulesId,
      [scene.id],
    );
    this.current = this.game.observation();
    this.previous = this.current;
    const skins = Object.values(options.skins),
      skin = options.skins[options.skin ?? "copper"] ?? skins[0];
    if (!skin) throw Error("A prepared skin is required");
    this.view = options.placeholder
      ? new GameView(this.game.definitions)
      : new M2View(this.game.definitions, skin);
    this.shell = document.createElement("main");
    this.shell.className = "m2-shell";
    this.readiness = new ProductionReadiness(this.shell);
    this.host = new WebHost(this.shell);
    this.shell.innerHTML = `<header><a class="wordmark" href="./">POCKET <span>PLAY</span></a><span class="edition">A SHORT ORIGINAL GAME · M2</span></header>
      <section class="game-card" aria-label="Lantern Watch game"><div class="play-bar"><span class="light-dot"></span><strong>LANTERN WATCH</strong><label>Palette <select data-skin aria-label="Character palette"></select></label></div>
      <div class="m2-stage" tabindex="0" aria-label="Game. Arrows move, Z jumps, X strikes, C heavy strikes, V guards, Escape pauses."><canvas data-cinematic hidden aria-label="Full screen ending cinematic"></canvas><div class="flow-overlay" data-overlay></div><div class="pause-overlay" data-paused hidden><p class="eyebrow">TAKE A BREATH</p><h2>Paused</h2><p>Your next move can wait.</p><button data-resume>Resume</button></div></div>
      <div class="status-bar"><span data-mirror aria-live="polite"></span><button data-pause>Pause</button><button data-restart>Restart</button><button data-mute aria-pressed="false">Mute sound</button></div></section>
      <p class="notice" data-status role="status">Lighting the lanterns…</p>
      <section class="instructions"><div><p class="eyebrow">THE LAST WATCH</p><h1>Bring the light home.</h1><p>One path. One sentinel. Reach the lantern at the far right. Strike, guard, or jump past the watch.</p></div><div class="control-guide"><span><kbd>← →</kbd> Move</span><span><kbd>Z / Space</kbd> Jump</span><span><kbd>X</kbd> Quick strike</span><span><kbd>C</kbd> Heavy strike</span><span><kbd>V</kbd> Guard</span><span><kbd>Esc</kbd> Pause</span><small>Gamepad: stick / D-pad, A jump, X quick, B heavy, LB guard.</small></div></section>
      <div class="touch-controls" aria-label="Touch controls"><div><button data-action="left" aria-label="Move left">←</button><button data-action="right" aria-label="Move right">→</button></div><div><button data-action="guard">Guard</button><button data-action="jump">Jump</button><button data-action="attack">Quick</button><button data-action="heavy">Heavy</button></div></div>
      <details class="save-desk"><summary>Checkpoint desk</summary><p>Saves during the ending return to its beginning. Restore pauses the game.</p><button data-save>Save</button><button data-restore>Restore</button><textarea data-checkpoint aria-label="Checkpoint JSON" spellcheck="false"></textarea><button data-import>Restore JSON</button></details>
      <footer>Original art · Pocket Assets + Score + Director · 60 Hz deterministic rules</footer>`;
    const find = <T extends HTMLElement>(selector: string) =>
      this.shell.querySelector<T>(selector)!;
    this.stage = find(".m2-stage");
    this.overlay = find("[data-overlay]");
    this.pauseOverlay = find("[data-paused]");
    this.status = find("[data-status]");
    this.mirror = find("[data-mirror]");
    this.controls = find(".touch-controls");
    this.pauseButton = find("[data-pause]");
    this.cinematicCanvas = find("[data-cinematic]");
    this.audio = new M2Audio({
      score: options.score,
      onError: (message) => {
        this.message(message);
        this.soundRecovery?.sync();
      },
    });
    this.soundRecovery = new AudioRecoveryControl(
      this.shell.querySelector<HTMLElement>(".status-bar")!,
      this.audio,
      this.abort.signal,
      (message) => this.message(message),
    );
    this.director = new M2Director({
      canvas: this.cinematicCanvas,
      scene,
      onError: (message) => {
        this.pause(message);
      },
      onDialogue: (id) => {
        const patch = options.score.patches[0];
        if (patch)
          this.audio.dialogue(
            `${this.game.flow.epoch}:${this.game.flow.slotInstance}:${id}`,
            patch,
            76,
          );
      },
    });
    this.lifecycle = new BrowserLifecycle(
      {
        tick: () => this.tick(),
        frame: this.frame,
        cancelInput: () => {
          this.input?.setActive(false);
          this.input?.queue.cancelAll(true);
        },
        onPause: (reason) => {
          this.pause(reason);
        },
        onDebt: () => {
          this.metrics.debtPauses++;
          this.pause("Paused after a long frame. Resume when ready.");
        },
        onPageExit: () => this.dispose(),
        onPageCache: () => {
          this.cached = true;
          this.pause("Paused while the page is cached.");
        },
        onPageRestore: () => {
          if (!this.cached) return;
          this.cached = false;
          try {
            this.refitFromHost();
            this.draw(1);
            this.schedule();
          } catch (error) {
            this.fail(error);
          }
        },
      },
      this.host.lifecycle,
    );
    const select = find<HTMLSelectElement>("[data-skin]");
    for (const candidate of skins) {
      const option = document.createElement("option");
      option.value = candidate.id;
      option.textContent =
        candidate.id === "copper" ? "Copperlight" : "Moonwake";
      select.append(option);
    }
    select.value = skin.id;
    select.disabled = true;
    select.addEventListener(
      "change",
      () => {
        const next = options.skins[select.value];
        if (
          this.view instanceof M2View &&
          next &&
          this.loaded &&
          !this.disposed
        ) {
          const view = this.view;
          void view
            .setSkin(next)
            .then((installed) => {
              if (!this.disposed && installed) {
                select.value = view.skinId;
                this.message(
                  `Palette changed to ${select.selectedOptions[0]?.textContent ?? view.skinId}.`,
                );
              }
            })
            .catch((error) => {
              if (this.disposed) return;
              select.value = view.skinId;
              this.message(
                `Palette unavailable: ${error instanceof Error ? error.message : String(error)}. Continuing with the previous palette.`,
              );
            });
        }
      },
      { signal: this.abort.signal },
    );
    root.replaceChildren(this.shell);
    document.title = "Lantern Watch · Pocket Play";
    this.bind(find);
    this.ready = this.mount().then(() => {
      this.metrics.startupMs = performance.now() - started;
      if (!this.disposed) select.disabled = !!options.placeholder;
    });
  }
  private async mount() {
    try {
      await this.view.init();
      if (this.disposed) return;
      this.stage.prepend(this.view.app.canvas);
      this.view.app.canvas.addEventListener(
        "webglcontextlost",
        (event) => {
          event.preventDefault();
          this.resizeFailed = false;
          this.graphicsUnavailable = true;
          this.pause(
            "Graphics context lost. Wait for recovery, then Resume; reload if graphics stay unavailable.",
          );
        },
        { signal: this.abort.signal },
      );
      this.view.app.canvas.addEventListener(
        "webglcontextrestored",
        () => {
          if (this.disposed) return;
          this.graphicsUnavailable = false;
          this.refitFromHost(true);
          if (!this.graphicsUnavailable)
            this.message("Graphics restored. Resume when ready.");
        },
        { signal: this.abort.signal },
      );
      this.input = new BrowserInput(this.controls, (message) =>
        this.message(message),
      );
      this.input.setActive(false);
      if (typeof ResizeObserver !== "undefined") {
        this.resize = new ResizeObserver(() => this.refitFromHost());
        this.resize.observe(this.stage);
      }
      this.host.observeViewport((viewport) => {
        for (const [edge, value] of Object.entries(viewport.safeArea))
          this.shell.style.setProperty(
            `--host-safe-area-${edge}`,
            `${value}px`,
          );
        this.refitFromHost();
      });
      this.loaded = true;
      this.fit();
      this.enter();
      this.draw(1);
      this.readiness.submitted();
      this.readiness.ready();
      this.schedule();
    } catch (error) {
      if (this.disposed) return;
      this.fail(error);
      this.lifecycle.dispose();
      this.abort.abort();
      this.input?.dispose();
      this.view.dispose();
      this.director.dispose();
      void this.audio.dispose();
      this.loaded = false;
      this.resize?.disconnect();
      this.host.dispose();
      this.shell.dataset.readiness = "failed";
      for (const control of this.shell.querySelectorAll<
        HTMLButtonElement | HTMLSelectElement
      >("button, select"))
        control.disabled = true;
      this.pauseOverlay.hidden = true;
      this.message(
        `Player could not start: ${error instanceof Error ? error.message : String(error)}. Reload to try again.`,
      );
      const retry = document.createElement("a");
      retry.href = window.location.href;
      retry.textContent = "Reload player";
      retry.dataset.mountRetry = "";
      this.status.append(" ", retry);
      throw error;
    }
  }
  private bind(find: <T extends HTMLElement>(selector: string) => T) {
    const signal = this.abort.signal;
    this.shell.addEventListener(
      "click",
      (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
          "button",
        );
        if (!button || !this.loaded || this.disposed) return;
        try {
          if (button.dataset.signal) {
            this.dispatch(button.dataset.signal as FlowSignal);
            this.unlockGesture();
          } else if (
            button.hasAttribute("data-pause") ||
            button.hasAttribute("data-resume")
          ) {
            if (this.requestedPaused) {
              this.resume();
              this.unlockGesture();
            } else this.pause();
          } else if (button.hasAttribute("data-restart"))
            this.dispatch(
              this.game.kind === "cinematic" ? "cancel" : "restart",
            );
          else if (button.hasAttribute("data-skip")) this.director.skip();
          else if (button.hasAttribute("data-advance"))
            this.director.advanceDialogue();
          else if (button.hasAttribute("data-mute")) {
            this.muted = !this.muted;
            this.audio.setMuted(this.muted);
            this.soundRecovery?.sync();
            if (!this.muted) this.unlockGesture();
            button.setAttribute("aria-pressed", String(this.muted));
          } else if (button.hasAttribute("data-save")) {
            this.saved = this.checkpoint();
            find<HTMLTextAreaElement>("[data-checkpoint]").value = this.saved;
            this.message("Checkpoint saved in this session.");
          } else if (button.hasAttribute("data-restore")) {
            if (this.saved) this.restore(this.saved);
            else this.message("Save a checkpoint first.");
          } else if (button.hasAttribute("data-import"))
            this.restore(find<HTMLTextAreaElement>("[data-checkpoint]").value);
        } catch (error) {
          this.message(
            `Action rejected: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
      { signal },
    );
    window.addEventListener(
      "keydown",
      (event) => {
        if (
          !this.loaded ||
          this.disposed ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.repeat ||
          event.defaultPrevented ||
          (event.target instanceof Element &&
            event.target.closest(
              "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
            ))
        )
          return;
        if (event.code === "Escape") {
          event.preventDefault();
          this.requestedPaused ? this.resume() : this.pause();
          return;
        }
        if (
          this.game.kind === "cinematic" &&
          (event.code === "Enter" || event.code === "Space") &&
          !(
            event.target instanceof Element &&
            event.target.closest(
              "button, a[href], [role='button'], [role='link']",
            )
          )
        ) {
          event.preventDefault();
          this.director.advanceDialogue();
        }
      },
      { signal },
    );
  }
  private dispatch(signal: FlowSignal) {
    const transitions = this.game.signal(signal);
    if (!transitions.length) return;
    if (this.inTick) {
      this.lifecycle.stopClock();
      this.pendingEntry = true;
    } else {
      this.metrics.transitions += transitions.length;
      this.enter();
    }
  }
  private enter(keepPaused = false) {
    const started = performance.now();
    this.lifecycle.stopClock();
    this.director.cancel();
    this.input?.setActive(false);
    this.input?.queue.cancelAll(true);
    this.audio.transition(this.game.observation().tick);
    if (this.view instanceof M2View) this.view.setGuardSlots([]);
    this.epoch++;
    this.current = this.game.observation();
    this.previous = this.current;
    const kind = this.game.kind;
    this.requestedPaused = keepPaused || !["play", "cinematic"].includes(kind);
    this.pauseVersion++;
    this.cinematicReady = false;
    this.shell.dataset.flow = kind;
    this.cinematicCanvas.hidden = kind !== "cinematic";
    this.view.app.canvas.hidden = kind === "cinematic";
    this.pauseOverlay.hidden = true;
    this.overlay.hidden = kind === "play";
    const content: Record<string, string> = {
      title: `<p class="eyebrow">THE LAST WATCH</p><h2>Lantern<br>Watch</h2><p>Cross the path. Read the sentinel.<br>Bring the light home.</p><button data-signal="start">Begin the crossing <span>→</span></button>`,
      loss: `<p class="eyebrow">THE LIGHT CAN WAIT</p><h2>Try again.</h2><p>Guard with V. Quick strikes are fast;<br>heavy strikes reach farther.</p><button data-signal="retry">Retry the crossing <span>↻</span></button>`,
      result: `<p class="eyebrow">WATCH COMPLETE</p><h2>The light<br>is home.</h2><p>You reached the final lantern.<br>Thank you for playing.</p><button data-signal="restart">Back to title <span>↻</span></button>`,
      cinematic: `<div class="cinematic-controls"><button data-advance>Continue dialogue</button><button data-skip>Skip ending</button></div>`,
    };
    this.overlay.classList.toggle("cinematic-overlay", kind === "cinematic");
    this.overlay.innerHTML = content[kind] ?? "";
    this.pauseButton.disabled = kind !== "play" && kind !== "cinematic";
    for (const button of this.controls.querySelectorAll<HTMLButtonElement>(
      "button",
    ))
      button.disabled = kind !== "play";
    if (kind === "cinematic") {
      const slot = {
        instanceId: String(this.game.flow.slotInstance),
        flowEpoch: this.game.flow.epoch,
      };
      void this.director
        .start(slot, (outcome, callbackSlot) => {
          if (
            this.disposed ||
            this.game.kind !== "cinematic" ||
            callbackSlot.instanceId !== String(this.game.flow.slotInstance) ||
            callbackSlot.flowEpoch !== this.game.flow.epoch
          )
            return;
          this.dispatch(outcome);
        })
        .then((started) => {
          if (
            !started ||
            this.disposed ||
            this.game.kind !== "cinematic" ||
            slot.instanceId !== String(this.game.flow.slotInstance) ||
            slot.flowEpoch !== this.game.flow.epoch
          )
            return;
          this.cinematicReady = true;
          if (!this.requestedPaused) this.resume();
        });
      this.message(
        "The light is home. Continue the dialogue or skip the ending.",
      );
    } else if (kind === "play") {
      if (!keepPaused) this.resume();
      this.message(
        "Reach the lantern at the far right. X quick · C heavy · V guard.",
      );
    } else {
      // Screen changes retain the authored loop; device/lifecycle pauses still stop it.
      if (!keepPaused) void this.audio.resume();
      this.message(
        kind === "title"
          ? "Read the controls, then begin. Sound starts with your gesture."
          : kind === "loss"
            ? "The sentinel caught you. Retry when ready."
            : "Watch complete. Restart to play again.",
      );
    }
    this.draw(1);
    this.updateMirror(true);
    if (kind !== "play" && kind !== "cinematic")
      this.overlay
        .querySelector<HTMLButtonElement>("button")
        ?.focus({ preventScroll: true });
    this.metrics.transitionMs = performance.now() - started;
  }
  private tick(frame?: InputFrame) {
    const started = performance.now(),
      old = this.game.flow.slotInstance;
    this.inTick = true;
    try {
      if (this.game.kind === "play") {
        this.previous = this.current;
        const consumed = frame ?? this.input!.queue.consume();
        this.game.tick(consumed);
        if (this.view instanceof M2View)
          this.view.setGuardSlots(
            consumed.slots
              .filter((slot) => slot.held.guard)
              .map((slot) => slot.slot),
          );
        this.metrics.simulationMs = performance.now() - started;
        this.current = this.game.observation();
        const player = this.current.actors.find((actor) => actor.slot === 0),
          enemy = this.current.actors.find((actor) => actor.slot === null);
        this.audio.setEncounter(
          !!player &&
            !!enemy &&
            enemy.health > 0 &&
            Math.abs(player.x - enemy.x) < 180 * 256,
        );
        const patch = this.options.score.patches[0];
        if (
          patch &&
          this.current.actors.some(
            (actor) =>
              actor.health <
              (this.previous.actors.find((before) => before.id === actor.id)
                ?.health ?? actor.health),
          )
        )
          this.audio.effect(
            `hit:${this.game.flow.epoch}:${this.current.tick}`,
            patch,
            52,
            0.08,
            this.current.tick,
          );
      } else if (this.game.kind === "cinematic" && this.cinematicReady) {
        this.game.cinematicStep();
        this.director.step(1);
      }
      if (old !== this.game.flow.slotInstance) {
        // Includes outcomes dispatched synchronously by Director.step. Count
        // those here once, alongside outcomes generated by gameplay stepping.
        this.metrics.transitions += this.game.flow.slotInstance - old;
        this.lifecycle.stopClock();
        this.pendingEntry = true;
      }
    } finally {
      this.inTick = false;
    }
  }
  private schedule() {
    if (this.loaded && !this.disposed && !this.cached && !this.fault)
      this.lifecycle.schedule();
  }
  private frame = (time: number) => {
    if (this.disposed || this.cached || this.fault) return;
    try {
      this.metrics.rafFrames++;
      this.input?.poll();
      const alpha =
        time < this.resumeBoundary ? 0 : this.lifecycle.advance(time);
      this.flushEntry();
      this.draw(this.lifecycle.paused ? 1 : alpha);
      this.updateMirror(false, time);
      this.schedule();
    } catch (error) {
      this.fail(error);
    }
  };
  private flushEntry() {
    if (this.pendingEntry) {
      this.pendingEntry = false;
      this.enter();
    }
  }
  private unlockGesture() {
    const shouldWait =
      !this.audio.stats().unlocked &&
      ["play", "cinematic"].includes(this.game.kind);
    const wanted = !this.requestedPaused,
      slot = this.game.flow.slotInstance,
      epoch = this.game.flow.epoch;
    if (shouldWait) this.pause("Enabling sound…");
    const version = this.pauseVersion;
    void this.audio.unlock().then(() => {
      this.soundRecovery?.sync();
      if (
        shouldWait &&
        wanted &&
        !this.disposed &&
        version === this.pauseVersion &&
        slot === this.game.flow.slotInstance &&
        epoch === this.game.flow.epoch
      )
        this.resume();
    });
  }
  private draw(alpha: number) {
    if (
      !this.loaded ||
      this.disposed ||
      this.graphicsUnavailable ||
      this.game.kind === "cinematic"
    )
      return;
    const started = performance.now();
    this.view.render(
      this.previous,
      this.current,
      alpha,
      this.epoch,
      this.epoch,
    );
    this.metrics.renderMs = performance.now() - started;
  }
  /** External resize failures pause presentation without invalidating authority. */
  private refitFromHost(forceRedraw = false): void {
    if (this.disposed || (this.graphicsUnavailable && !this.resizeFailed))
      return;
    try {
      this.fit(forceRedraw);
      if (this.resizeFailed) {
        this.resizeFailed = false;
        this.graphicsUnavailable = false;
        this.message("Graphics resized. Resume when ready.");
      }
    } catch (error) {
      this.resizeFailed = true;
      this.graphicsUnavailable = true;
      this.pause(
        `Graphics resize failed: ${error instanceof Error ? error.message : String(error)}. Resume retries without changing your checkpoint.`,
      );
    }
  }
  private fit(forceRedraw = false) {
    if (!this.loaded || this.disposed) return;
    const { width, height } = this.view.logicalSize;
    // Global safe areas are consumed by shell CSS, not this local stage twice.
    const mapping = createViewportMapping({
      logicalWidth: width,
      logicalHeight: height,
      cssWidth: this.stage.clientWidth,
      cssHeight: this.stage.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      integerScale: true,
    });
    // Keep both surfaces aligned even if Pixi allocation fails and pauses play.
    applyViewportStyle(this.cinematicCanvas, mapping);
    this.view.resizeViewport(mapping, forceRedraw);
  }
  private updateMirror(force = false, time = performance.now()) {
    if (!force && time - this.lastMirror < 400) return;
    this.lastMirror = time;
    const player = this.current.actors.find((actor) => actor.slot === 0);
    this.mirror.textContent = `${this.game.kind === "play" ? `Health ${player?.health ?? 0} / ${player?.maxHealth ?? 0}` : this.game.kind === "cinematic" ? "The final lantern" : this.game.kind === "title" ? "Ready when you are" : this.game.kind === "result" ? "Crossing complete" : "Crossing ended"} · ${this.lifecycle.paused && ["play", "cinematic"].includes(this.game.kind) ? "Paused" : "Lantern Path"}`;
  }
  private message(message: string) {
    this.status.textContent = message;
  }
  private fail(error: unknown) {
    this.fault = true;
    this.pause(
      `Player stopped: ${error instanceof Error ? error.message : String(error)}. Reload or restore a saved checkpoint.`,
    );
    this.lifecycle.stopFrames();
  }
  pause(reason = "Paused. Resume when ready.") {
    if (this.disposed) return;
    this.requestedPaused = true;
    this.pauseVersion++;
    this.lifecycle.pause();
    this.input?.setActive(false);
    if (this.view instanceof M2View) this.view.setGuardSlots([]);
    this.audio.pause();
    this.director.pause();
    if (["play", "cinematic"].includes(this.game.kind))
      this.pauseOverlay.hidden = false;
    this.pauseButton.textContent = "Resume";
    this.message(reason);
    if (!this.fault) this.draw(1);
    this.updateMirror(true);
  }
  resume() {
    if (this.resizeFailed) this.refitFromHost();
    if (
      this.disposed ||
      !this.loaded ||
      this.graphicsUnavailable ||
      this.fault ||
      !["play", "cinematic"].includes(this.game.kind)
    )
      return;
    if (
      !this.requestedPaused &&
      this.resumePendingVersion === this.pauseVersion
    )
      return;
    this.requestedPaused = false;
    this.pauseVersion++;
    if (this.game.kind === "cinematic" && !this.cinematicReady) {
      this.pauseOverlay.hidden = true;
      return;
    }
    const version = this.pauseVersion,
      slot = this.game.flow.slotInstance,
      epoch = this.game.flow.epoch;
    this.resumePendingVersion = version;
    this.pauseOverlay.hidden = true;
    this.pauseButton.textContent = "Pause";
    void this.audio.resume().then(() => {
      if (
        this.disposed ||
        this.fault ||
        version !== this.pauseVersion ||
        slot !== this.game.flow.slotInstance ||
        epoch !== this.game.flow.epoch
      )
        return;
      this.resumePendingVersion = undefined;
      this.previous = this.current;
      this.input?.setActive(this.game.kind === "play");
      this.director.resume();
      this.resumeBoundary = performance.now();
      this.lifecycle.resume();
      if (!this.audio.stats().error)
        this.message("Playing. Escape pauses and cancels held controls.");
      this.stage.focus({ preventScroll: true });
      this.schedule();
    });
  }
  checkpoint(): string {
    if (this.fault)
      throw Error("Restore or reload before saving after a player fault");
    return this.game.kind === "cinematic"
      ? this.game.checkpointBeforeSlot()!
      : this.game.checkpoint();
  }
  restore(json: string) {
    if (this.disposed) return;
    // Runner validates both halves atomically. Then cancel presentation before entry of the new epoch.
    this.game.restore(json);
    this.fault = false;
    this.director.cancel();
    this.audio.pause();
    this.audio.reset(this.game.observation().tick);
    this.enter(true);
    this.pause("Checkpoint restored. Resume when ready.");
    this.schedule();
  }
  advance(frame: InputFrame = { slots: [] }) {
    if (this.disposed || !this.loaded) throw Error("Player unavailable");
    this.tick(frame);
    this.flushEntry();
    this.draw(1);
    this.updateMirror(true);
  }
  stats() {
    return {
      ...this.metrics,
      rafOwned: this.lifecycle.rafOwned,
      paused: this.lifecycle.paused,
      flow: { ...this.game.flow },
      audio: this.audio.stats(),
      director: this.director.stats(),
      view: this.view instanceof M2View ? { ...this.view.metrics } : null,
      disposed: this.disposed,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.loaded = false;
    this.lifecycle.dispose();
    this.abort.abort();
    this.resize?.disconnect();
    this.host.dispose();
    this.input?.dispose();
    this.director.dispose();
    void this.audio.dispose();
    this.view.dispose();
    this.shell.remove();
  }
}
export function mountM2(root: HTMLElement, options: M2Options) {
  return new M2Session(root, options);
}
