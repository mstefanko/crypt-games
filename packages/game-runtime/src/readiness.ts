/** Bounded production diagnostics. Times are CPU submission/readiness, never GPU completion. */
export class ProductionReadiness {
  private firstRender?: number;
  private firstReady?: number;
  private generation = 0;
  constructor(private root: HTMLElement) {
    root.dataset.readiness = "loading";
  }
  loading() {
    this.generation++;
    this.root.dataset.readiness = "loading";
    this.root.dataset.readyGeneration = String(this.generation);
  }
  submitted() {
    if (this.firstRender !== undefined) return;
    this.firstRender = performance.now();
    this.root.dataset.firstRenderMs = String(this.firstRender);
    // Fixed names: one mark each per owner, no per-frame/per-restart history.
    performance.clearMarks("pocket:first-render");
    performance.mark("pocket:first-render");
  }
  ready() {
    if (this.firstRender === undefined) return;
    const now = performance.now();
    this.root.dataset.readiness = "ready";
    this.root.dataset.currentReadyMs = String(now);
    if (this.firstReady !== undefined) return;
    this.firstReady = now;
    this.root.dataset.controlsReadyMs = String(now);
    performance.clearMarks("pocket:controls-ready");
    performance.mark("pocket:controls-ready");
  }
}
