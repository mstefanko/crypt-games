import { FixedScheduler } from "../scheduler.ts";

export interface BrowserLifecyclePlatform {
  window: EventTarget;
  document: EventTarget & { readonly hidden: boolean };
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
}
export interface BrowserLifecycleOptions {
  /** Browser interruptions can suspend controls while an online authority continues. */
  interruptionPolicy?: "pause" | "suspend-input";
  onInputSuspension?: (suspended: boolean, reason?: string) => void;
  tick: () => void;
  frame: (time: number) => void;
  cancelInput: () => void;
  onPause: (reason?: string) => void;
  onDebt: () => void;
  onPageExit: () => void;
  onPageCache?: () => void;
  onPageRestore?: () => void;
}

/** Browser clock and discontinuity ownership; resources and presentation stay with the host. */
export class BrowserLifecycle {
  private readonly scheduler: FixedScheduler;
  private readonly abort = new AbortController();
  private raf?: number;
  private disposed = false;
  private frameGeneration = 0;
  private focused = true;
  private suspended = false;

  constructor(
    private readonly options: BrowserLifecycleOptions,
    private readonly platform: BrowserLifecyclePlatform = {
      window,
      document,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    },
  ) {
    this.scheduler = new FixedScheduler(options.tick, () => {
      this.pause();
      options.onDebt();
    });
    const signal = this.abort.signal;
    const interrupt = (reason?: string) => {
      if (this.disposed) return;
      if (options.interruptionPolicy === "suspend-input") {
        options.cancelInput();
        this.reportInputSuspension(true, reason);
      } else {
        this.pause();
        options.onPause(reason);
      }
    };
    platform.window.addEventListener(
      "blur",
      () => {
        this.focused = false;
        interrupt("Paused while the window is unfocused.");
      },
      { signal },
    );
    platform.window.addEventListener(
      "focus",
      () => {
        this.focused = true;
        if (!platform.document.hidden) this.reportInputSuspension(false);
      },
      { signal },
    );
    platform.document.addEventListener(
      "visibilitychange",
      () => {
        if (platform.document.hidden)
          interrupt("Paused while the page is hidden.");
        else if (this.focused) this.reportInputSuspension(false);
      },
      { signal },
    );
    platform.window.addEventListener(
      "orientationchange",
      () => {
        interrupt("Paused after orientation changed. Resume when ready.");
        if (this.focused && !platform.document.hidden)
          this.reportInputSuspension(false);
      },
      { signal },
    );
    platform.window.addEventListener(
      "pagehide",
      (event) => {
        if (this.disposed) return;
        this.pause();
        if ((event as PageTransitionEvent).persisted) {
          if (options.onPageCache) {
            this.stopFrames();
            options.onPageCache();
          } else options.onPause();
        } else options.onPageExit();
      },
      { signal },
    );
    platform.window.addEventListener(
      "pageshow",
      (event) => {
        if (!this.disposed && (event as PageTransitionEvent).persisted)
          options.onPageRestore?.();
      },
      { signal },
    );
  }

  private reportInputSuspension(suspended: boolean, reason?: string): void {
    if (
      this.disposed ||
      this.options.interruptionPolicy !== "suspend-input" ||
      this.suspended === suspended
    )
      return;
    this.suspended = suspended;
    this.options.onInputSuspension?.(suspended, reason);
  }
  get inputSuspended(): boolean {
    return this.suspended;
  }
  get paused(): boolean {
    return this.scheduler.paused;
  }
  /** Cancel presentation scheduling without disposing browser listeners. */
  stopFrames(): void {
    this.frameGeneration++;
    if (this.raf !== undefined) this.platform.cancelFrame(this.raf);
    this.raf = undefined;
  }
  get rafOwned(): number {
    return this.raf === undefined ? 0 : 1;
  }
  schedule(): void {
    if (this.disposed || this.raf !== undefined) return;
    const generation = this.frameGeneration;
    this.raf = this.platform.requestFrame((time) => {
      if (generation !== this.frameGeneration) return;
      this.raf = undefined;
      if (!this.disposed) this.options.frame(time);
    });
  }
  advance(time: number, rate = 1): number {
    return this.disposed ? 0 : this.scheduler.advance(time, rate);
  }
  /** Stop semantic time without interrupting held device controls. */
  stopClock(): void {
    this.scheduler.pause();
  }
  /** A user/browser interruption also cancels input. */
  pause(): void {
    this.stopClock();
    this.options.cancelInput();
  }
  resume(): void {
    if (!this.disposed) this.scheduler.resume();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.abort.abort();
    if (this.raf !== undefined) this.platform.cancelFrame(this.raf);
    this.raf = undefined;
  }
}
