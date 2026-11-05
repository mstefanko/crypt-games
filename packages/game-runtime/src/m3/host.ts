import { WebHost, type HostReadiness } from "../host/web.ts";
import {
  WEB_GAME_DECLARATION,
  type HostDeclaration,
} from "../host/capabilities.ts";
import { snapshotDefinitions } from "./project.ts";
import {
  createPhoneWorkload,
  WORKLOAD_CONTROLS,
  WORKLOAD_SEGMENT_TICKS,
} from "../m6/workload-fixture.ts";
import { WorkloadDiagnostics } from "../m6/workload-diagnostics.ts";
import {
  SaveDesk,
  SAVE_DESK_MARKUP,
  type SaveDeskCommand,
} from "./save-desk.ts";
import { AudioRecoveryControl } from "../audio-recovery.ts";
import { ProductionReadiness } from "../readiness.ts";
import { acceptsRewardBoundary, rewardSlot } from "./host-commands";
import { BrowserLifecycle } from "../session/browser-lifecycle.ts";
import { BrowserGraphicsOwner } from "../session/browser-graphics.ts";
import {
  AdventureSession,
  AdventureRecoveryError,
} from "../session/adventure-session.ts";
import {
  createArenaExecution,
  executeArenaFrame,
  restoreArenaExact,
  createGridExecution,
  executeGridCommand,
  restoreGridExact,
} from "../session/execution.ts";
import { M2Audio, type Score } from "../m2-audio.ts";
import { M2Director, readM2Scene } from "../m2-director.ts";
import type { PreparedSkin } from "../m2-assets.ts";
import { M3Input, type Profile, type Direction } from "./input.ts";
import { M3View } from "./view.ts";
import {
  applyViewportStyle,
  createViewportMapping,
} from "../presentation/viewport.ts";
import { CampaignStorage } from "./storage.ts";
import { BACKUP_BYTES, inputBytes } from "../m5/campaign-codec";
import { DuelSession } from "../session/duel-session.ts";
import {
  restoreArenaCheckpoint,
  observeArena,
  encodeArenaCheckpoint,
} from "../../../game-simulation/src/m3/arena.ts";
import { quantizeArenaAim } from "../../../game-simulation/src/m3/aim.ts";
import {
  gridWon,
  serializeGridCheckpoint,
} from "../../../game-simulation/src/m3/grid.ts";
import {
  adventureDialogue,
  type AdventureState,
} from "../../../game-simulation/src/m3/adventure.ts";
import type { M3ProjectDefinitions } from "../../../game-project/src/m3-project.ts";
import type { InputFrame } from "../../../game-project/src/types.ts";
export interface M3Options {
  project: M3ProjectDefinitions;
  identities: Record<
    Profile,
    { gameId: string; rulesBuildId: string; contentId: string }
  >;
  skin: PreparedSkin & { atlasUrl: string };
  score: Score;
  scene: unknown;
  profile?: Profile;
  /** Selected distribution policy; omitted uses the web demo's explicit memory fallback. */
  hostDeclaration?: HostDeclaration;
  /** Read-only playback starts without probing or accessing the live campaign store. */
  replay?: boolean;
  /** Fixed public release measurement fixture; no arbitrary source or count loader. */
  workload?: {
    kind: "arena-40-20";
    definition: import("../../../game-simulation/src/m3/arena-types.ts").ArenaDefinition;
    identity: { gameId: string; rulesBuildId: string; contentId: string };
    sourceHashes: Record<string, string>;
  };
  /** Resource staging seam used by failure/cancellation fixtures. No committed state is passed. */
  loadMap?: (id: string, signal: AbortSignal) => Promise<string>;
}
const PROFILES: Profile[] = ["arena", "grid", "duel", "adventure"];
const copy = <T>(value: T): T => structuredClone(value);
/** One RAF, one fixed accumulator, two semantic input slots and one Score owner for all examples. */
export class M3Session {
  readonly ready: Promise<void>;
  readonly metrics = {
    frames: 0,
    steps: 0,
    debtPauses: 0,
    switches: 0,
    viewDisposals: 0,
    simulationMs: 0,
    renderMs: 0,
    startupMs: 0,
  };
  private arena;
  private workloadCheckpoint?: string;
  private workloadSegmentSteps = 0;
  private workloadResetCount = 0;
  private workloadDiagnostics?: WorkloadDiagnostics;
  private workloadDebtStart = 0;
  private grid;
  private adventureSession;
  /** Detached presentation snapshot; gameplay changes stay inside the session owner. */
  private get adventure() {
    return this.adventureSession.observation();
  }
  private duel;
  private profile: Profile;
  private graphics: BrowserGraphicsOwner<M3View>;
  private stagedView?: M3View;
  private get view() {
    return this.stagedView ?? this.graphics.active;
  }
  private get pendingView() {
    return this.graphics.pending;
  }
  private graphicsUnavailable = false;
  private generation = 0;
  private epoch = 0;
  private lifecycle: BrowserLifecycle;
  private host: WebHost;
  private replaying = false;
  private storageBlocked = false;
  private input: M3Input;
  private audio: M2Audio;
  private soundRecovery?: AudioRecoveryControl;
  private director: M2Director;
  private storage: CampaignStorage;
  private saveDesk: SaveDesk;
  private abort = new AbortController();
  private disposed = false;
  private paused = true;
  private pauseStarted = performance.now();
  private pausedMs = 0;
  private pauseCount = 0;
  private ending = false;
  private mapLoading = false;
  private shell: HTMLElement;
  private readiness: ProductionReadiness;
  private stage: HTMLElement;
  private status: HTMLElement;
  private mirror: HTMLElement;
  private actions: HTMLElement;
  private cinematic: HTMLCanvasElement;
  private hostCommands: {
    epoch: number;
    slot: string;
    kind: "complete" | "skip";
  }[] = [];
  private lastMirrorUpdate = -Infinity;
  private lastDiagnostics = -Infinity;
  private pendingMirror = "";
  private lastActions?: string;
  private resize?: ResizeObserver;
  constructor(
    root: HTMLElement,
    private options: M3Options,
  ) {
    this.options = options = {
      ...options,
      project: snapshotDefinitions(options.project),
      identities: snapshotDefinitions(options.identities),
      ...(options.workload
        ? { workload: snapshotDefinitions(options.workload) }
        : {}),
    };
    const started = performance.now();
    this.profile = options.workload ? "arena" : (options.profile ?? "arena");
    this.arena = createArenaExecution(
      options.project.arena,
      options.identities.arena,
      123456789,
    );
    if (options.workload) this.prepareWorkload();
    this.grid = createGridExecution(options.project.grid);
    this.adventureSession = new AdventureSession(
      options.project.adventure,
      options.identities.adventure,
    );
    this.duel = new DuelSession(options.project.duel, options.identities.duel);
    this.graphics = new BrowserGraphicsOwner<M3View>({
      onContextLost: () => this.graphicsLost(),
      onActiveRelease: () => this.metrics.viewDisposals++,
    });
    this.shell = document.createElement("main");
    this.shell.className = "m3-shell";
    this.readiness = new ProductionReadiness(this.shell);
    this.shell.innerHTML = `<header><a href="./">POCKET PLAY</a><span>FOUR SMALL WORLDS · M3</span></header><h1>Choose your next move.</h1><nav aria-label="Playable examples">${PROFILES.map((p) => `<button data-profile="${p}">${p[0].toUpperCase() + p.slice(1)}</button>`).join("")}</nav><section class="game-card"><div class="m3-stage" tabindex="0" aria-label="Game controls"><canvas data-cinematic hidden aria-label="Adventure reward cinematic"></canvas><div data-pause-overlay hidden><h2>Paused</h2><button data-resume>Resume</button></div></div><p data-mirror aria-live="polite"></p><div class="toolbar"><button data-pause>Resume</button><button data-restart>Restart</button><button data-sound aria-pressed="false">Mute sound</button></div></section><p data-status role="status">Preparing the example…</p><p data-help></p><section data-actions aria-label="Game actions"></section><section class="controls" aria-label="Pointer and keyboard controls">${[0, 1].map((slot) => `<fieldset data-slot-controls="${slot}"><legend>Player ${slot + 1}</legend>${["left", "up", "down", "right", "jump", "attack", "heavy", "guard"].map((a) => `<button data-control="${a}" data-slot="${slot}">${a}</button>`).join("")}</fieldset>`).join("")}</section>${SAVE_DESK_MARKUP}<footer>Pixi + pinned Assets · Score audio · host-driven Director</footer>`;
    const find = <T extends HTMLElement>(s: string) =>
      this.shell.querySelector<T>(s)!;
    this.stage = find(".m3-stage");
    this.status = find("[data-status]");
    this.mirror = find("[data-mirror]");
    this.actions = find("[data-actions]");
    this.cinematic = find("[data-cinematic]");
    this.host = new WebHost(
      this.shell,
      options.hostDeclaration ?? WEB_GAME_DECLARATION,
    );
    this.replaying = options.replay === true;
    this.host.setReplay(this.replaying);
    const hostReadiness = this.replaying
      ? this.host.currentReadiness()
      : this.host.readiness();
    if (!this.replaying && !hostReadiness.ready)
      throw new Error(
        hostReadiness.reason ?? "Required host capability unavailable",
      );
    this.saveDesk = new SaveDesk(
      this.shell,
      this.abort.signal,
      (command) => this.saveDeskCommand(command),
      (message) => this.message(message),
    );
    this.storage = new CampaignStorage(
      (m) => this.message(m),
      this.host.storage,
      {
        definitions: options.project.adventure,
      },
    );
    window.addEventListener(
      "storage",
      (event) => {
        if (!this.replaying) this.storage.changed(event.key, event.newValue);
      },
      { signal: this.abort.signal },
    );
    this.audio = new M2Audio({
      score: options.score,
      onError: (m) => {
        this.message(m);
        this.soundRecovery?.sync();
      },
    });
    this.soundRecovery = new AudioRecoveryControl(
      this.shell.querySelector<HTMLElement>(".toolbar")!,
      this.audio,
      this.abort.signal,
      (message) => this.message(message),
      () => !this.replaying && !this.disposed,
    );
    this.director = new M2Director({
      canvas: this.cinematic,
      scene: readM2Scene(options.scene),
      onError: (m) => this.pause(m),
      onDialogue: (id) => {
        const patch = options.score.patches[0];
        if (patch && !this.replaying)
          this.audio.dialogue(`${this.epoch}:${id}`, patch, 76);
      },
    });
    this.input = new M3Input(
      this.shell,
      () => this.profile,
      (m) => this.message(m),
    );
    this.lifecycle = new BrowserLifecycle(
      {
        tick: () => this.tick(),
        frame: (time) => this.frame(time),
        cancelInput: () => this.input.cancel(),
        onPause: (reason) => this.pause(reason),
        onDebt: () => {
          this.metrics.debtPauses++;
          this.pause("Paused after a long frame. Resume when ready.");
        },
        onPageExit: () => this.dispose(),
      },
      this.host.lifecycle,
    );
    root.replaceChildren(this.shell);
    if (options.workload) {
      this.shell
        .querySelectorAll<HTMLButtonElement>(
          "[data-profile],[data-control],[data-restart]",
        )
        .forEach((button) => (button.disabled = true));
      this.saveDesk.hide();
      this.workloadDiagnostics = new WorkloadDiagnostics(
        this.shell,
        (metadata) => this.startWorkloadCapture(metadata),
      );
    }
    const recovery = document.createElement("button");
    recovery.dataset.recoverGraphics = "";
    recovery.textContent = "Recover graphics";
    recovery.hidden = true;
    this.shell.querySelector(".toolbar")!.append(recovery);
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(() => this.refitFromHost());
      this.resize.observe(this.stage);
    }
    this.host.observeViewport((viewport) => {
      this.shell.dataset.hostViewport = JSON.stringify(viewport);
      for (const [edge, value] of Object.entries(viewport.safeArea))
        this.shell.style.setProperty(`--host-safe-area-${edge}`, `${value}px`);
      this.refitFromHost();
    });
    this.host.subscribeReadiness((state) => this.syncHostReadiness(state));
    const signal = this.abort.signal;
    this.shell.addEventListener(
      "pointerdown",
      (event) => {
        if ((event.target as Element).closest("[data-control]"))
          this.shell.dataset.inputEventAt = String(performance.now());
      },
      { signal, capture: true },
    );
    this.shell.addEventListener(
      "click",
      (e) => {
        const b = (e.target as Element).closest<HTMLButtonElement>("button");
        if (!b) return;
        if (b.dataset.control && e.detail === 0)
          this.shell.dataset.inputEventAt = String(performance.now());
        void this.click(b, e.detail === 0).catch((error) =>
          this.message(
            `Action rejected: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
      { signal },
    );
    window.addEventListener(
      "keydown",
      (e) => {
        if (
          e.code === "Escape" &&
          !e.repeat &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !(
            e.target instanceof Element &&
            e.target.closest("input,textarea,select,[contenteditable]")
          )
        ) {
          e.preventDefault();
          this.paused ? this.resume() : this.pause();
        }
      },
      { signal },
    );
    this.stage.addEventListener(
      "pointermove",
      (e) => {
        if (
          this.replaying ||
          this.graphicsUnavailable ||
          this.profile !== "arena"
        )
          return;
        const point = this.view?.pick(e.clientX, e.clientY);
        if (!point) return;
        const player = observeArena(this.arena).actors.find(
          (a) => a.kind === "player",
        );
        if (!player) return;
        const x = point.x - (player.x + player.width / 2) / 256,
          y = point.y - (player.y + player.height / 2) / 256;
        this.input.aim = quantizeArenaAim(
          Math.max(-16777216, Math.min(16777216, Math.round(x * 256))),
          Math.max(-16777216, Math.min(16777216, Math.round(y * 256))),
        );
      },
      { signal },
    );
    this.ready = this.switchProfile(this.profile).then(() => {
      this.metrics.startupMs = performance.now() - started;
      this.workloadDiagnostics?.setReady();
      this.schedule();
    });
  }
  private prepareWorkload() {
    const prepared = createPhoneWorkload(
      this.options.workload!.definition,
      this.options.workload!.identity,
    );
    this.arena = prepared.world;
    this.workloadCheckpoint = prepared.checkpoint;
    this.workloadSegmentSteps = 0;
  }
  private workloadCounts() {
    const visible = (body: {
      x: number;
      y: number;
      width: number;
      height: number;
    }) =>
      body.x + body.width > 0 &&
      body.x < 320 * 256 &&
      body.y + body.height > 0 &&
      body.y < 180 * 256;
    return {
      actors: this.arena.actors.filter((actor) => actor.hp > 0).length,
      projectiles: this.arena.projectiles.length,
      visibleActors: this.arena.actors.filter(
        (actor) => actor.hp > 0 && visible(actor),
      ).length,
      visibleProjectiles: this.arena.projectiles.filter(visible).length,
    };
  }
  private startWorkloadCapture(metadata: Record<string, unknown>) {
    this.prepareWorkload();
    this.workloadResetCount = 0;
    this.workloadDebtStart = this.metrics.debtPauses;
    const capture = this.workloadDiagnostics!.start(performance.now(), {
      ...metadata,
      identity: this.options.workload!.identity,
      definition: this.arena.definition,
      sourceHashes: this.options.workload!.sourceHashes,
      baseline: {
        totalSteps: this.metrics.steps,
        pauseCount: this.pauseCount,
        debtPauses: this.metrics.debtPauses,
      },
    });
    this.resume();
    return capture;
  }
  /** Observer callbacks cannot let renderer failures escape the recovery owner. */
  private refitFromHost() {
    if (this.disposed || this.graphicsUnavailable) return;
    try {
      this.fit();
    } catch (error) {
      this.graphicsLost(
        `Graphics resize failed: ${error instanceof Error ? error.message : String(error)}. Recover graphics to keep this game, then Resume.`,
      );
    }
  }
  private fit() {
    const size = this.view?.logicalSize ?? { width: 320, height: 180 };
    // D0 reports global safe-area insets. The shell consumes them in CSS;
    // this local stage must not subtract those insets a second time.
    const mapping = createViewportMapping({
      logicalWidth: size.width,
      logicalHeight: size.height,
      cssWidth: this.stage.clientWidth,
      cssHeight: this.stage.clientHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      integerScale: true,
    });
    this.view?.resizeViewport(mapping);
    applyViewportStyle(this.cinematic, mapping);
  }
  private syncHostReadiness(state: HostReadiness) {
    if (this.disposed) return;
    this.storageBlocked = !this.replaying && !state.ready;
    this.shell.dataset.hostSaving = this.replaying ? "replay" : state.saving;
    this.shell.dataset.hostReady = String(!this.storageBlocked);
    this.shell.dataset.executionMode = this.replaying ? "replay" : "live";
    const notice = this.saveDesk.readiness(
      state,
      this.replaying,
      this.storageBlocked,
    );
    if (this.storageBlocked) this.pause(notice, false);
    for (const button of this.shell.querySelectorAll<HTMLButtonElement>(
      "[data-pause],[data-resume],[data-control]",
    ))
      button.disabled =
        this.replaying ||
        this.storageBlocked ||
        (!!this.options.workload && button.hasAttribute("data-control"));
    for (const control of this.shell.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >("[data-profile],[data-restart],[data-sound],[data-resume-sound]"))
      control.disabled =
        this.replaying ||
        (!!this.options.workload &&
          control.matches("[data-profile],[data-restart]"));
  }
  /** Explicit replay boundary: callers drive recorded commands while live services stay stopped. */
  setReplay(replay: boolean): void {
    if (typeof replay !== "boolean") throw Error("Invalid replay mode");
    if (this.disposed || replay === this.replaying) return;
    if (this.pendingView)
      throw Error("Wait for scene preparation before changing replay mode");
    this.pause("Changing execution mode.", false);
    this.generation++;
    this.cancelTransition();
    this.stopEnding();
    this.replaying = replay;
    this.host.setReplay(replay);
    this.syncHostReadiness(
      replay ? this.host.currentReadiness() : this.host.readiness(),
    );
    this.message(
      replay
        ? "Replay mode. Apply recorded commands to advance."
        : "Live mode. Resume when ready.",
    );
  }
  /** Device requests remain UI effects, and the replay boundary cancels them before dispatch. */
  requestDevice(
    operation: import("../host/capabilities.ts").DeviceOperation,
    payload = "",
  ) {
    return this.host.requests.request(operation, payload);
  }
  private message(text: string) {
    this.status.textContent = text;
  }
  private async click(b: HTMLButtonElement, native = true) {
    if (
      this.replaying &&
      !b.matches("[data-checkpoint],[data-restore],[data-recover-graphics]")
    )
      throw Error("Live actions are disabled during replay");
    if (
      this.storageBlocked &&
      b.matches(
        "[data-control],[data-undo],[data-dialogue],[data-pickup],[data-travel],[data-advance],[data-skip],[data-pause],[data-resume]",
      )
    )
      throw Error("Durable storage is required before play can resume");
    if (
      this.pendingView &&
      b.matches(
        "[data-control],[data-undo],[data-dialogue],[data-pickup],[data-travel],[data-advance],[data-skip]",
      )
    )
      return;
    if (b.hasAttribute("data-recover-graphics")) {
      await this.recoverGraphics();
      return;
    }
    if (b.dataset.profile) {
      try {
        await this.switchProfile(b.dataset.profile as Profile);
      } catch {
        /* switchProfile reports the recoverable failure once. */
      }
      return;
    }
    if (b.hasAttribute("data-pause") || b.hasAttribute("data-resume")) {
      if (this.paused) {
        void this.audio.unlock().then(() => this.soundRecovery?.sync());
        this.resume();
      } else this.pause();
      return;
    }
    if (b.dataset.control) {
      if (!native) return;
      if (b.dataset.slot === "1" && this.profile !== "duel") return;
      this.input.pulse(Number(b.dataset.slot ?? 0), b.dataset.control);
      return;
    }
    if (b.hasAttribute("data-restart")) {
      await this.restart();
      return;
    }
    if (b.hasAttribute("data-sound")) {
      const muted = b.getAttribute("aria-pressed") !== "true";
      b.setAttribute("aria-pressed", String(muted));
      this.audio.setMuted(muted);
      this.soundRecovery?.sync();
      if (!muted)
        void this.audio.unlock().then(() => this.soundRecovery?.sync());
      return;
    }
    if (b.hasAttribute("data-undo")) {
      this.gridCommand("undo");
      return;
    }
    if (b.hasAttribute("data-skip")) {
      this.director.skip();
      return;
    }
    if (b.hasAttribute("data-advance")) {
      this.director.advanceDialogue();
      return;
    }
    if (b.dataset.pickup) {
      this.adventureCommand({
        kind: "pickup",
        placementId: b.dataset.pickup,
        token: `pickup:${this.adventure.active.mapId}:${b.dataset.pickup}`,
      });
      return;
    }
    if (b.dataset.dialogue) {
      const map = this.map(),
        dialogue = map.dialogues.find((d) => d.id === b.dataset.dialogue)!;
      this.adventureCommand({
        kind: "dialogue",
        dialogueId: dialogue.id,
        choiceId: dialogue.choiceId,
        token: `dialogue:${map.id}:${dialogue.id}`,
      });
      return;
    }
    if (b.dataset.travel) {
      await this.travel(b.dataset.travel);
      return;
    }
    const command = this.saveDesk.command(b);
    if (command) await this.saveDeskCommand(command);
  }
  /** The single desk dispatch retains replay and all campaign mutation authority. */
  private async saveDeskCommand(command: SaveDeskCommand) {
    if (
      this.replaying &&
      command.kind !== "file" &&
      command.kind !== "checkpoint" &&
      command.kind !== "restore"
    )
      throw Error("Live actions are disabled during replay");
    switch (command.kind) {
      case "file":
        await this.importCampaignFile(command.file);
        break;
      case "save":
        try {
          this.storage.write(this.adventureSession.campaignBytes());
        } finally {
          this.showOriginal();
        }
        this.saveDesk.writeBytes(this.storage.memoryBytes!);
        break;
      case "load": {
        let bytes;
        try {
          bytes = this.storage.read();
        } catch (error) {
          this.showOriginal();
          throw error;
        }
        this.showOriginal();
        if (!bytes) throw Error("No campaign save in this browser");
        await this.loadCampaign(bytes, this.storage.needsMigration, false);
        break;
      }
      case "import":
        await this.loadCampaign(this.saveDesk.readBytes(), true);
        break;
      case "previous":
        try {
          await this.loadCampaign(this.storage.previous(), true, false);
        } finally {
          this.showOriginal();
        }
        break;
      case "backup":
        this.saveDesk.download(
          this.storage.exportBackup(),
          "pocket-adventure-backup-v2.json",
        );
        break;
      case "checkpoint":
        this.saveDesk.writeBytes(this.checkpoint());
        break;
      case "restore":
        this.restore(this.saveDesk.readBytes());
        break;
      case "export":
        this.saveDesk.download(
          this.adventureSession.campaignBytes(),
          "pocket-adventure-v1.json",
        );
        break;
      case "export-stored-original":
        this.saveDesk.download(
          this.storage.exportStoredOriginal()!,
          "pocket-adventure-stored-original.json",
        );
        break;
      case "export-original":
        this.saveDesk.download(
          this.storage.exportOriginal()!,
          "pocket-adventure-rejected-original.json",
        );
        break;
    }
  }
  private showOriginal() {
    this.saveDesk.showOriginal(
      this.storage.exportOriginal() !== null,
      this.storage.exportStoredOriginal() !== null,
    );
  }
  private async importCampaignFile(file: File) {
    if (this.replaying)
      throw Error("Campaign imports are disabled during replay");
    if (this.profile !== "adventure" || this.disposed)
      throw Error("Select adventure before importing a campaign.");
    if (file.size > BACKUP_BYTES)
      throw Error(
        `Import exceeds ${BACKUP_BYTES} bytes. Keep the original externally.`,
      );
    const generation = this.generation;
    this.cancelTransition();
    const bytes = await this.adventureSession.readImport(
      async () => new Uint8Array(await file.arrayBuffer()),
      {
        isCurrent: () =>
          !this.disposed &&
          generation === this.generation &&
          this.profile === "adventure",
        receive: (original) => {
          this.storage.preserveRejected(original);
          this.showOriginal();
        },
      },
    );
    if (bytes) await this.loadCampaign(bytes, true);
  }
  private async loadCampaign(
    bytes: string | Uint8Array,
    publish = false,
    retainInput = publish,
  ) {
    if (this.replaying)
      throw Error("Live campaign storage is disabled during replay");
    if (this.profile !== "adventure" || this.disposed)
      throw Error("Select adventure before loading a campaign.");
    // Bounds precede retention and decoding. Invalid UTF-8 files retain exact raw bytes.
    const bounded = inputBytes(bytes);
    if (retainInput) {
      this.storage.preserveRejected(bounded);
      this.showOriginal();
    }
    const generation = this.generation,
      previousEnding = this.ending;
    let previousPaused = this.paused;
    try {
      await this.adventureSession.recover(bounded, {
        loadMap: this.options.loadMap,
        isCurrent: () =>
          !this.disposed &&
          generation === this.generation &&
          this.profile === "adventure",
        onStart: () => {
          this.mapLoading = true;
          this.input.setActive(false);
          this.message("Preparing saved campaign map…");
          this.render();
        },
        preflight: (next) => {
          // A bad first frame fails before durable publication or state adoption.
          if (this.view && !this.graphicsUnavailable)
            this.drawView(this.view, "adventure", 1, next);
        },
        stage: () => {
          previousPaused = this.paused;
          this.ending = false;
          // Preflight UI without changing scheduler/audio ownership.
          this.paused = true;
          this.render(1, false);
          this.paused = previousPaused;
        },
        publish: publish
          ? (payload, original) =>
              this.storage.commit(payload, retainInput ? original : undefined)
          : undefined,
        adopt: (durable) => {
          this.host.sceneChanged();
          this.pause("Preparing campaign presentation…", false);
          this.stopEnding();
          this.message(
            durable === "memory"
              ? "Campaign loaded in memory only. Export it to keep it; Resume to continue."
              : "Campaign loaded. Resume to continue.",
          );
        },
        rollback: () => {
          this.ending = previousEnding;
          this.paused = previousPaused;
        },
        onFinish: () => {
          this.mapLoading = false;
          this.input.setActive(!this.disposed && !this.paused && !this.ending);
          this.render(1, false);
        },
      });
    } catch (error) {
      // Invalid payloads fail before an operation starts, preserving codec diagnostics.
      if (!(error instanceof AdventureRecoveryError)) throw error;
      if (error.published) {
        this.graphicsUnavailable = true;
        this.shell.querySelector<HTMLElement>(
          "[data-recover-graphics]",
        )!.hidden = false;
        throw Error(
          `Campaign loaded, but presentation failed. Recover graphics. ${error.message}`,
        );
      }
      this.render();
      throw Error(
        `Campaign recovery unavailable; previous campaign preserved. Retry Load campaign. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  private cancelTransition() {
    this.adventureSession.cancelPending();
    this.mapLoading = false;
    this.input?.setActive(!this.disposed && !this.paused && !this.ending);
  }
  async switchProfile(profile: Profile): Promise<boolean> {
    if (this.options.workload && profile !== "arena")
      throw Error("Workload mode is fixed to arena-40-20.");
    if (!PROFILES.includes(profile) || this.disposed)
      throw Error("Unknown or unavailable example");
    this.host.sceneChanged();
    this.generation++;
    this.readiness.loading();
    this.pause(
      "Preparing the example. Gameplay controls are paused until ready.",
    );
    this.graphics.cancelPending();
    const candidate = new M3View(
      this.options.skin,
      this.options.project.duel,
      profile,
    );
    const lease = this.graphics.begin(candidate);
    let cleanupError: unknown;
    try {
      if (
        !(await this.graphics.ready(lease)) ||
        !this.graphics.isCurrent(lease)
      )
        return false;
      this.prepareView(candidate, profile, false, this.epoch + 1, () =>
        this.graphics.publish(lease),
      );
    } catch (error) {
      if (this.graphics.active === candidate) cleanupError = error;
      else {
        const current = this.graphics.isCurrent(lease);
        this.graphics.discard(lease);
        if (current && !this.disposed) {
          if (this.view && !this.graphicsUnavailable) this.readiness.ready();
          this.message(
            `Example unavailable: ${error instanceof Error ? error.message : String(error)}. Previous example remains available; retry the selector.`,
          );
        }
        if (this.disposed || !current) return false;
        throw error;
      }
    }
    this.cancelTransition();
    this.stopEnding();
    this.input.cancel();
    this.graphicsUnavailable = false;
    this.shell.querySelector<HTMLElement>("[data-recover-graphics]")!.hidden =
      true;
    this.metrics.switches++;
    this.schedule();
    this.shell.dataset.profile = profile;
    for (const b of this.shell.querySelectorAll<HTMLButtonElement>(
      "[data-profile]",
    ))
      b.setAttribute("aria-pressed", String(b.dataset.profile === profile));
    this.resourceDiagnostics();
    this.readiness.submitted();
    this.readiness.ready();
    this.message(
      cleanupError
        ? `Ready. Previous graphics cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        : this.replaying
          ? "Replay mode. Apply recorded commands to advance."
          : this.storageBlocked
            ? "Durable storage is required before play can resume."
            : "Ready. Press Resume to play.",
    );
    return true;
  }
  private runtimeDiagnostics() {
    const now = performance.now();
    if (now - this.lastDiagnostics < 1000) return;
    this.lastDiagnostics = now;
    const arena =
      this.profile === "arena" ? observeArena(this.arena) : undefined;
    this.shell.dataset.runtimeSample = JSON.stringify({
      at: now,
      pausedDurationMs:
        this.pausedMs + (this.paused ? now - this.pauseStarted : 0),
      pauseCount: this.pauseCount,
      profile: this.profile,
      paused: this.paused,
      ending: this.ending,
      graphicsUnavailable: this.graphicsUnavailable,
      mapLoading: this.mapLoading,
      frames: this.metrics.frames,
      steps: this.metrics.steps,
      debtPauses: this.metrics.debtPauses,
      simulationMs: this.metrics.simulationMs,
      renderSubmitMs: this.metrics.renderMs,
      liveActors: arena?.actors.filter((actor) => actor.hp > 0).length ?? null,
      liveProjectiles: arena?.projectiles.length ?? null,
      visibleProjectiles:
        arena?.projectiles.filter(
          (projectile) =>
            projectile.x + projectile.width > 0 &&
            projectile.x < 320 * 256 &&
            projectile.y + projectile.height > 0 &&
            projectile.y < 180 * 256,
        ).length ?? null,
      visibleActors:
        arena?.actors.filter(
          (actor) =>
            actor.hp > 0 &&
            actor.x + actor.width > 0 &&
            actor.x < 320 * 256 &&
            actor.y + actor.height > 0 &&
            actor.y < 180 * 256,
        ).length ?? null,
      view: this.view?.stats() ?? null,
      director: { ...this.director.stats(), state: this.director.getState() },
      audio: this.audio.stats(),
      rafOwned: this.lifecycle.rafOwned,
      pendingViews: this.pendingView ? 1 : 0,
    });
  }
  private resourceDiagnostics() {
    const stats = this.view?.stats();
    if (!stats) return;
    this.shell.dataset.resources = JSON.stringify({
      fetchMs: stats.fetchMs,
      preparationMs: stats.preparationMs,
      decodeMs: stats.decodeMs,
      textureSetupMs: stats.textureSetupMs,
      rendererSetupMs: stats.rendererSetupMs,
      activeTextures: stats.activeTextures,
      closedBitmaps: stats.closedBitmaps,
      staticTileCacheRgbaBytes: 0,
    });
  }
  private graphicsLost(
    message = "Graphics context lost. Recover graphics to keep this game, then Resume.",
  ) {
    if (this.disposed) return;
    this.graphicsUnavailable = true;
    this.readiness.loading();
    this.generation++;
    this.graphics.cancelPending();
    this.cancelTransition();
    this.pause(message);
    this.shell.querySelector<HTMLElement>("[data-recover-graphics]")!.hidden =
      false;
  }
  private async recoverGraphics() {
    if (this.disposed || !this.graphicsUnavailable) return;
    this.generation++;
    this.cancelTransition();
    this.pause("Recovering graphics…");
    this.graphics.cancelPending();
    const candidate = new M3View(
      this.options.skin,
      this.options.project.duel,
      this.profile,
    );
    const lease = this.graphics.begin(candidate);
    let cleanupError: unknown;
    try {
      if (
        !(await this.graphics.ready(lease)) ||
        !this.graphics.isCurrent(lease)
      )
        return;
      this.prepareView(candidate, this.profile, this.ending, this.epoch, () =>
        this.graphics.publish(lease),
      );
    } catch (error) {
      if (this.graphics.active === candidate) cleanupError = error;
      else {
        const current = this.graphics.isCurrent(lease);
        this.graphics.discard(lease);
        if (!this.disposed && current)
          this.message(
            `Graphics recovery failed: ${error instanceof Error ? error.message : String(error)}. Retry Recover graphics.`,
          );
        return;
      }
    }
    this.graphicsUnavailable = false;
    this.shell.querySelector<HTMLElement>("[data-recover-graphics]")!.hidden =
      true;
    this.resourceDiagnostics();
    this.readiness.submitted();
    this.readiness.ready();
    this.message(
      cleanupError
        ? `Graphics recovered. Previous graphics cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        : "Graphics recovered. Game preserved. Resume when ready.",
    );
  }
  private configure() {
    this.lastActions = undefined;
    const help: Record<Profile, string> = {
      arena:
        "Move with arrows or WASD. Aim with the pointer (east initially). Space / X fires; C / Shift dashes; V shoves. Clear the sentinel. You begin on the left; the sentinel approaches from the right.",
      grid: "Push the orange crate onto the green goal. Arrow keys / WASD move one cell per press. Use Undo after solving, or Restart.",
      duel: "Player 1: ← →, Z / Space jump, X quick, C heavy, V guard. Player 2: A D, F jump, G quick, H heavy, R guard. Face your opponent to guard. Rematch resets both slots.",
      adventure:
        "Arrows / WASD move one cell per press. Stand on the gold pickup to collect it. Green cells lead between maps. Talk to the violet keeper. Save progression, reload, then Load campaign.",
    };
    this.shell.querySelector("[data-help]")!.textContent =
      help[this.profile] +
      " Click the playfield to return keyboard control after using a button.";
    for (const field of this.shell.querySelectorAll<HTMLElement>(
      "[data-slot-controls]",
    ))
      field.hidden =
        field.dataset.slotControls === "1" && this.profile !== "duel";
    for (const b of this.shell.querySelectorAll<HTMLButtonElement>(
      "[data-control]",
    )) {
      b.textContent =
        this.profile === "arena"
          ? ((
              { attack: "Fire", heavy: "Dash", guard: "Shove" } as Record<
                string,
                string
              >
            )[b.dataset.control!] ?? b.dataset.control!)
          : b.dataset.control!;
      b.hidden =
        this.profile === "duel"
          ? ["up", "down"].includes(b.dataset.control!)
          : this.profile === "arena"
            ? b.dataset.control === "jump"
            : !["up", "down", "left", "right"].includes(b.dataset.control!);
    }
    this.shell.querySelector<HTMLButtonElement>("[data-restart]")!.textContent =
      this.profile === "duel" ? "Rematch" : "Restart";
  }
  private gridCommand(
    kind: "move" | "undo" | "restart",
    direction?: Direction,
  ) {
    if (this.storageBlocked)
      throw Error("Durable storage is required before play can resume");
    const command =
      kind === "move"
        ? {
            kind,
            direction: direction!,
            revision: this.grid.revision,
            sequence: this.grid.sequence + 1,
          }
        : {
            kind,
            revision: this.grid.revision,
            sequence: this.grid.sequence + 1,
          };
    const result = executeGridCommand(this.grid, command);
    if (result.ok) {
      this.grid = result.state;
      this.shell.dataset.inputSequence = String(this.grid.sequence);
      this.shell.dataset.inputConsumedAt = String(performance.now());
    } else this.message(result.error);
    this.render();
  }
  private map(adventure = this.adventure) {
    return this.options.project.adventure.maps.find(
      (m) => m.id === adventure.active.mapId,
    )!;
  }
  private adventureCommand(
    command:
      | { kind: "move"; direction: Direction }
      | { kind: "pickup"; placementId: string; token: string }
      | {
          kind: "dialogue";
          dialogueId: string;
          choiceId: string;
          token: string;
        },
  ) {
    if (this.storageBlocked)
      throw Error("Durable storage is required before play can resume");
    if (this.mapLoading || this.ending) return;
    const result = this.adventureSession.command(command);
    if (result.ok) {
      this.shell.dataset.inputSequence = String(result.sequence);
      this.shell.dataset.inputConsumedAt = String(performance.now());
      if (result.rewardStarted) void this.startEnding();
    } else this.message(result.error);
    this.render();
  }
  async travel(exitId: string) {
    if (this.storageBlocked)
      throw Error("Durable storage is required before play can resume");
    if (this.mapLoading || this.ending) return;
    let started = false,
      adopted = false;
    try {
      await this.adventureSession.travel(exitId, {
        loadMap: this.options.loadMap,
        // Speculative profile staging does not transfer adventure ownership.
        isCurrent: () => !this.disposed && this.profile === "adventure",
        onStart: () => {
          started = true;
          this.mapLoading = true;
          this.input.setActive(false);
          this.message("Preparing the next map…");
          this.render();
        },
        onReady: () => {
          adopted = true;
          this.epoch++;
          this.host.sceneChanged();
          this.message("Map ready. Your progression travelled with you.");
        },
        onFinish: () => {
          this.mapLoading = false;
          this.input.setActive(!this.disposed && !this.paused && !this.ending);
          this.render();
        },
      });
    } catch (error) {
      // Travel adopts before its final render; presentation failure cannot undo it.
      if (adopted) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      this.message(
        started
          ? `Map unavailable: ${detail}. Previous map preserved. Use the entrance button to retry.`
          : detail,
      );
    }
  }
  private async startEnding() {
    // The reward is already authoritative; replay does not start a live cinematic.
    if (this.replaying) return;
    this.shell.dataset.directorTick = "0";
    this.ending = true;
    if (!this.paused) this.lifecycle.resume();
    this.input.setActive(false);
    this.cinematic.hidden = false;
    this.view!.canvas.hidden = true;
    const epoch = this.epoch,
      slot = rewardSlot(this.adventure.campaign.revision);
    this.render();
    let started = false;
    try {
      started = await this.director.start(
        { flowEpoch: epoch, instanceId: slot },
        (kind, stamp) => {
          this.hostCommands.push({
            epoch: stamp.flowEpoch,
            slot: stamp.instanceId,
            kind,
          });
        },
      );
    } catch (error) {
      this.message(
        `Reward scene unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      this.disposed ||
      !this.ending ||
      this.epoch !== epoch ||
      this.profile !== "adventure" ||
      slot !== rewardSlot(this.adventure.campaign.revision)
    )
      return;
    if (
      !started &&
      !this.hostCommands.some(
        (command) => command.epoch === epoch && command.slot === slot,
      )
    ) {
      const reason = this.status.textContent?.includes("unavailable")
        ? this.status.textContent
        : "Reward scene unavailable.";
      this.stopEnding();
      this.pause(
        `${reason} Quest reward preserved. Resume to continue your adventure.`,
      );
      return;
    }
    this.render();
  }
  private stopEnding() {
    this.director.cancel();
    this.ending = false;
    if (this.profile === "grid" || this.profile === "adventure")
      this.lifecycle.stopClock();
    this.hostCommands = [];
    this.cinematic.hidden = true;
    if (this.view) this.view.canvas.hidden = false;
  }
  private tick(frame?: InputFrame) {
    if (this.storageBlocked || this.replaying) return;
    if (this.ending) {
      this.director.step(1);
      this.shell.dataset.directorTick = String(this.director.getState().tick);
      return;
    }
    if (this.profile === "arena" || this.profile === "duel") {
      const start = performance.now(),
        input = this.input.consume();
      if (this.profile === "arena") {
        const { frame: _frame, ...controls } = input;
        if (this.options.workload && this.workloadCheckpoint) {
          if (this.workloadSegmentSteps >= WORKLOAD_SEGMENT_TICKS) {
            const resetAt = performance.now(),
              fromTick = this.arena.tick;
            restoreArenaCheckpoint(this.arena, this.workloadCheckpoint);
            this.workloadDiagnostics?.reset(
              resetAt,
              performance.now() - resetAt,
              fromTick,
              this.arena.tick,
            );
            this.workloadResetCount++;
            this.workloadSegmentSteps = 0;
          }
          executeArenaFrame(this.arena, WORKLOAD_CONTROLS);
          this.workloadSegmentSteps++;
          if (this.workloadDiagnostics?.hasCapture)
            this.workloadDiagnostics.tick(this.workloadCounts());
        } else executeArenaFrame(this.arena, controls);
      } else this.duel.step(frame ?? input.frame);
      this.metrics.simulationMs = performance.now() - start;
      this.metrics.steps++;
    }
  }
  private schedule() {
    this.lifecycle.schedule();
  }
  private frame = (time: number) => {
    if (this.disposed) return;
    try {
      this.metrics.frames++;
      this.workloadDiagnostics?.beginFrame(time);
      const workloadStart = this.workloadDiagnostics?.capturing
        ? performance.now()
        : undefined;
      const stepsBefore = this.metrics.steps;
      if (!this.replaying) {
        try {
          this.input.poll();
        } catch (error) {
          this.pause(error instanceof Error ? error.message : String(error));
        }
      }
      if (!this.replaying && !this.paused && !this.mapLoading && !this.ending)
        for (const direction of this.input.drainCommands()) {
          if (this.profile === "grid") this.gridCommand("move", direction);
          if (this.profile === "adventure")
            this.adventureCommand({ kind: "move", direction });
        }
      if (
        !this.replaying &&
        (this.profile === "grid" || this.profile === "adventure")
      )
        this.input.consume();
      if (
        this.workloadDiagnostics?.capturing &&
        (document.hidden || !document.hasFocus())
      )
        this.workloadDiagnostics.invalidate(
          "Capture page was hidden or unfocused.",
        );
      const alpha = this.lifecycle.advance(time);
      for (const command of this.hostCommands.splice(0)) {
        if (
          acceptsRewardBoundary(command, {
            epoch: this.epoch,
            ending: this.ending,
            revision: this.adventure.campaign.revision,
          })
        ) {
          this.stopEnding();
          this.input.setActive(!this.paused && !this.mapLoading);
          this.message(
            "Quest complete. Return to the garden, then save your campaign.",
          );
          this.render();
        }
      }
      if (
        !this.paused &&
        !this.ending &&
        (this.profile === "arena" || this.profile === "duel")
      )
        this.render(alpha);
      if (workloadStart !== undefined && this.workloadDiagnostics) {
        const workMs = performance.now() - workloadStart;
        this.workloadDiagnostics.frame({
          at: time,
          workMs,
          steps: this.metrics.steps - stepsBefore,
          tick: this.arena.tick,
          totalSteps: this.metrics.steps,
          resets: this.workloadResetCount,
          paused: this.paused,
          debtPauses: this.metrics.debtPauses - this.workloadDebtStart,
          ...this.workloadCounts(),
        });
      }
      this.workloadDiagnostics?.update(time);
      this.flushMirror();
      this.schedule();
      this.runtimeDiagnostics();
    } catch (error) {
      this.pause(
        `Player stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.schedule();
    }
  };
  /** Submit candidate graphics before changing ownership or durable campaign state. */
  private drawView(
    view: M3View,
    profile: Profile,
    alpha = 1,
    adventure?: AdventureState,
    epoch = this.epoch,
  ) {
    if (profile === "arena") view.arena(observeArena(this.arena), epoch);
    else if (profile === "duel") {
      const { previous, current, guardSlots } = this.duel.presentation();
      view.duel(previous, current, alpha, epoch, guardSlots);
    } else if (profile === "grid") view.board(copy(this.grid));
    else {
      const state = adventure ?? this.adventure;
      const map = this.options.project.adventure.maps.find(
        (m) => m.id === state.active.mapId,
      )!;
      view.adventure(
        { ...map, npcs: map.dialogues },
        state.active.player,
        state.campaign.removedPickups
          .filter((p) => p.mapId === map.id)
          .map((p) => p.placementId),
      );
    }
  }
  /** Roll back all host/UI preparation while the previous renderer is still owned. */
  private prepareView(
    candidate: M3View,
    profile: Profile,
    ending: boolean,
    epoch: number,
    publish: () => boolean,
  ) {
    this.drawView(candidate, profile, 1, this.adventure, epoch);
    const previous = {
      profile: this.profile,
      ending: this.ending,
      epoch: this.epoch,
      graphicsUnavailable: this.graphicsUnavailable,
      mapLoading: this.mapLoading,
    };
    try {
      this.stagedView = candidate;
      this.profile = profile;
      this.ending = ending;
      this.epoch = epoch;
      this.graphicsUnavailable = false;
      this.mapLoading = false;
      this.fit();
      this.configure();
      this.render(1, false);
      candidate.canvas.hidden = ending;
      this.stage.prepend(candidate.canvas);
      if (!publish()) throw Error("Graphics preparation canceled");
    } catch (error) {
      // A cleanup failure after resource publication cannot restore old ownership.
      if (this.graphics.active === candidate) throw error;
      candidate.canvas.remove();
      this.stagedView = undefined;
      Object.assign(this, previous);
      this.configure();
      this.render(1, false);
      throw error;
    } finally {
      this.stagedView = undefined;
    }
  }
  private render(alpha = 1, submit = true) {
    if (!this.view || this.disposed || this.graphicsUnavailable) return;
    const start = performance.now(),
      adventure = this.profile === "adventure" ? this.adventure : undefined;
    if (submit && !(this.profile === "adventure" && this.ending))
      this.drawView(this.view, this.profile, alpha, adventure);
    let text = "";
    if (this.profile === "arena") {
      const observation = observeArena(this.arena);
      text = `Arena · ${observation.result} · Health ${observation.actors.find((a) => a.kind === "player")?.hp ?? 0}`;
      this.setActions("");
    } else if (this.profile === "duel") {
      const current = this.duel.observation();
      text = `Duel · ${this.duel.result === "playing" ? "Round in progress" : this.duel.result === "draw" ? "Draw" : `Player ${this.duel.result === "slot-0" ? 1 : 2} wins`} · ${current.actors.map((a) => `P${a.slot! + 1} ${a.health}/${a.maxHealth}`).join(" · ")}`;
      this.setActions("");
    } else if (this.profile === "grid") {
      text = `Grid · ${gridWon(this.grid) ? "Solved! Undo to explore another route." : "Push the crate onto the green goal"} · Move ${this.grid.revision}`;
      this.setActions("<button data-undo>Undo</button>");
    } else {
      const state = adventure!,
        map = this.map(state);
      text = `${map.name} · Inventory ${state.campaign.inventory.map((i) => `${i.quantity} ${i.itemId}`).join(", ") || "empty"} · Quest ${Object.values(state.campaign.quests).join(", ")}`;
      const markup = this.ending
        ? "<button data-advance>Continue dialogue</button><button data-skip>Skip reward scene</button>"
        : map.pickups
            .filter(
              (p) =>
                p.cell === state.active.player &&
                !state.campaign.removedPickups.some(
                  (r) => r.mapId === map.id && r.placementId === p.id,
                ),
            )
            .map(
              (p) => `<button data-pickup="${p.id}">Collect ${p.id}</button>`,
            )
            .join("") +
          map.dialogues
            .filter(
              (d) =>
                Math.abs(
                  (d.cell % map.width) - (state.active.player % map.width),
                ) +
                  Math.abs(
                    Math.floor(d.cell / map.width) -
                      Math.floor(state.active.player / map.width),
                  ) <=
                1,
            )
            .map((d) => {
              const line = adventureDialogue(
                this.options.project.adventure,
                state,
                d.id,
              );
              return `<p>${line.text}</p>${line.choiceId ? `<button data-dialogue="${d.id}">Accept the quest reward</button>` : ""}`;
            })
            .join("") +
          map.exits
            .filter((e) => e.cell === state.active.player)
            .map((e) => {
              const missing = (e.requiresFlags ?? []).filter(
                (flag) => state.campaign.flags[flag] !== true,
              );
              return `<button data-travel="${e.id}" ${missing.length ? 'data-gate-locked=""' : ""} ${this.mapLoading || missing.length ? "disabled" : ""}>Travel to ${this.options.project.adventure.maps.find((m) => m.id === e.mapId)?.name ?? e.mapId}${missing.length ? ` · Locked: requires ${missing.join(", ")}` : ""}</button>`;
            })
            .join("");
      this.setActions(markup);
    }
    for (const button of this.actions.querySelectorAll<HTMLButtonElement>(
      "button",
    ))
      button.disabled =
        this.replaying ||
        this.storageBlocked ||
        button.hasAttribute("data-gate-locked") ||
        (this.mapLoading && button.hasAttribute("data-travel"));
    this.pendingMirror = `${text}${this.paused ? " · Paused" : ""}`;
    this.flushMirror();
    this.metrics.renderMs = performance.now() - start;
  }
  private flushMirror() {
    const now = performance.now();
    if (
      this.mirror.textContent !== this.pendingMirror &&
      now - this.lastMirrorUpdate >= 500
    ) {
      this.mirror.textContent = this.pendingMirror;
      this.lastMirrorUpdate = now;
    }
  }
  private setActions(markup: string) {
    if (this.lastActions === markup) return;
    this.lastActions = markup;
    const focused =
      document.activeElement instanceof HTMLElement &&
      this.actions.contains(document.activeElement)
        ? document.activeElement
        : null;
    const key = (element: Element) =>
      [
        "data-undo",
        "data-advance",
        "data-skip",
        "data-pickup",
        "data-dialogue",
        "data-travel",
      ].find((name) => element.hasAttribute(name));
    const template = document.createElement("template");
    template.innerHTML = markup;
    const existing = [
      ...this.actions.querySelectorAll<HTMLButtonElement>("button"),
    ];
    const desired = [...template.content.childNodes].map((node) => {
      if (!(node instanceof HTMLButtonElement)) return node;
      const attribute = key(node),
        previous =
          attribute &&
          existing.find(
            (button) =>
              button.getAttribute(attribute) === node.getAttribute(attribute) &&
              button.hasAttribute(attribute),
          );
      if (!previous) return node;
      for (const name of previous.getAttributeNames())
        if (!node.hasAttribute(name)) previous.removeAttribute(name);
      for (const attribute of [...node.attributes])
        previous.setAttribute(attribute.name, attribute.value);
      if (previous.textContent !== node.textContent)
        previous.textContent = node.textContent;
      return previous;
    });
    for (let index = 0; index < desired.length; index++)
      if (this.actions.childNodes[index] !== desired[index])
        this.actions.insertBefore(
          desired[index],
          this.actions.childNodes[index] ?? null,
        );
    for (const node of [...this.actions.childNodes])
      if (!desired.includes(node)) node.remove();
    if (
      focused &&
      (!focused.isConnected ||
        (focused instanceof HTMLButtonElement && focused.disabled) ||
        document.activeElement !== focused)
    ) {
      const next =
        focused.isConnected &&
        !(focused instanceof HTMLButtonElement && focused.disabled)
          ? focused
          : (this.actions.querySelector<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? this.stage);
      next.focus({ preventScroll: true });
    }
  }
  pause(reason = "Paused. Resume when ready.", submit = true) {
    if (this.disposed) return;
    if (this.workloadDiagnostics?.capturing)
      this.workloadDiagnostics.pause(performance.now(), reason);
    if (!this.paused) {
      this.pauseStarted = performance.now();
      this.pauseCount++;
    }
    this.paused = true;
    this.duel.cancelControls();
    this.lifecycle.pause();
    this.input.setActive(false);
    this.audio.pause();
    this.director.pause();
    this.shell.querySelector<HTMLElement>("[data-pause-overlay]")!.hidden =
      false;
    this.shell.querySelector("[data-pause]")!.textContent = "Resume";
    this.message(reason);
    this.render(1, submit);
  }
  resume() {
    if (
      this.replaying ||
      this.storageBlocked ||
      this.disposed ||
      !this.view ||
      this.graphicsUnavailable ||
      this.pendingView
    )
      return;
    if (this.paused) this.pausedMs += performance.now() - this.pauseStarted;
    this.paused = false;
    this.input.setActive(!this.ending && !this.mapLoading);
    this.director.resume();
    void this.audio.resume();
    if (this.profile === "arena" || this.profile === "duel" || this.ending)
      this.lifecycle.resume();
    else this.lifecycle.stopClock();
    this.shell.querySelector<HTMLElement>("[data-pause-overlay]")!.hidden =
      true;
    this.shell.querySelector("[data-pause]")!.textContent = "Pause";
    this.stage.focus({ preventScroll: true });
    this.message(
      this.mapLoading
        ? "Preparing the next map. Gameplay controls resume after loading."
        : "Playing. Escape pauses and cancels held controls.",
    );
    this.render();
  }
  async restart() {
    this.generation++;
    this.graphics.cancelPending();
    if (!this.graphicsUnavailable) this.readiness.ready();
    this.cancelTransition();
    this.stopEnding();
    this.epoch++;
    this.host.sceneChanged();
    if (this.options.workload) {
      this.workloadDiagnostics?.invalidate(
        "Workload restarted during capture.",
      );
      this.prepareWorkload();
    } else if (this.profile === "arena")
      this.arena = createArenaExecution(
        this.options.project.arena,
        this.options.identities.arena,
        123456789,
      );
    else if (this.profile === "grid")
      this.grid = createGridExecution(this.options.project.grid);
    else if (this.profile === "duel") this.duel.restart();
    else this.adventureSession.reset();
    this.input.cancel();
    this.pause("Restarted. Resume when ready.");
  }
  checkpoint() {
    if (this.ending)
      throw Error(
        "Wait for or skip the reward scene before saving an exact checkpoint",
      );
    if (this.profile === "arena") return encodeArenaCheckpoint(this.arena);
    if (this.profile === "grid")
      return serializeGridCheckpoint(this.grid, this.options.identities.grid);
    if (this.profile === "duel") return this.duel.checkpoint();
    return this.adventureSession.checkpoint();
  }
  restore(bytes: string) {
    if (this.options.workload)
      throw Error("Workload mode does not accept checkpoint imports.");
    if (this.profile === "arena") restoreArenaExact(this.arena, bytes);
    else if (this.profile === "grid")
      this.grid = restoreGridExact(
        this.options.project.grid,
        this.options.identities.grid,
        bytes,
      );
    else if (this.profile === "duel") this.duel.restore(bytes);
    else this.adventureSession.restore(bytes);
    this.cancelTransition();
    this.stopEnding();
    this.epoch++;
    this.host.sceneChanged();
    this.pause("Exact checkpoint restored. Resume when ready.");
  }
  advance(frame?: InputFrame) {
    if (this.replaying) {
      this.replayFrame(frame);
      return;
    }
    this.tick(frame);
    this.render();
  }
  /** Timed replay frames use the same validated execution adapters, never device queues. */
  replayFrame(frame: unknown): void {
    if (!this.replaying || this.disposed)
      throw Error("Enter replay mode before applying a recorded frame");
    if (this.profile === "arena") executeArenaFrame(this.arena, frame);
    else if (this.profile === "duel") this.duel.step(frame);
    else throw Error("Command profiles require ordered commands, not frames");
    this.metrics.steps++;
    this.render();
  }
  command(direction: Direction) {
    if (this.profile === "grid") this.gridCommand("move", direction);
    else if (this.profile === "adventure")
      this.adventureCommand({ kind: "move", direction });
  }
  observation() {
    return this.profile === "arena"
      ? observeArena(this.arena)
      : this.profile === "duel"
        ? this.duel.observation()
        : this.profile === "grid"
          ? copy(this.grid)
          : this.adventure;
  }
  stats() {
    return {
      ...this.metrics,
      profile: this.profile,
      paused: this.paused,
      replay: this.replaying,
      host: this.host.currentReadiness(),
      rafOwned: this.lifecycle.rafOwned,
      view: this.view?.stats(),
      audio: this.audio.stats(),
      director: this.director.stats(),
      mapLoading: this.mapLoading,
      pendingViews: this.pendingView ? 1 : 0,
      graphicsUnavailable: this.graphicsUnavailable,
      disposed: this.disposed,
    };
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.adventureSession.dispose();
    this.cancelTransition();
    this.lifecycle.dispose();
    this.host.dispose();
    this.abort.abort();
    this.resize?.disconnect();
    this.workloadDiagnostics?.dispose();
    this.input.dispose();
    this.director.dispose();
    void this.audio.dispose();
    this.graphics.dispose();
    this.shell.remove();
  }
}
export function mountM3(root: HTMLElement, options: M3Options) {
  return new M3Session(root, options);
}
