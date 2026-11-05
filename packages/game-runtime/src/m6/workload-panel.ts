import type { WorkloadCapture } from "./workload-capture.ts";
/** Visible observer controls; no arbitrary simulation mutation or hidden bridge. */
export class WorkloadPanel {
  private root = document.createElement("section");
  private abort = new AbortController();
  private capture?: WorkloadCapture;
  private lastUpdate = -Infinity;
  private ready = false;
  constructor(
    parent: HTMLElement,
    start: (metadata: Record<string, unknown>) => WorkloadCapture,
  ) {
    this.root.dataset.workloadPanel = "arena-40-20";
    this.root.setAttribute("aria-label", "Production performance workload");
    this.root.innerHTML = `<h2>Production performance workload · 40 actors / 20 projectiles</h2><p>This fixed arena uses the production scheduler, renderer and existing rules. It is a measurement scene, not another game. Keep this page foreground for 10 seconds warmup and 60 seconds capture. Counts, exact fixture resets and reset CPU cost are recorded. Pauses or missing actors invalidate the run. CPU submission is not GPU completion.</p><label>Observer classification <select data-workload-classification><option value="desktop-or-emulated">Desktop or emulated observation</option><option value="physical-device-observation">Observer reports a physical device</option></select></label><label>Device, OS/browser, network, battery, temperature and comfort observations <textarea data-workload-notes maxlength="4000" rows="4" placeholder="Record actual setup and observations. Selecting physical does not establish acceptance."></textarea></label><button type="button" data-workload-start disabled>Start 70-second capture</button><button type="button" data-workload-download disabled>Download workload JSON</button><p data-workload-status role="status">Preparing the fixed workload…</p>`;
    const card = parent.querySelector(".game-card");
    if (!card) throw Error("Workload panel requires the production game card.");
    card.before(this.root);
    parent.dataset.workloadMode = "arena-40-20";
    const signal = this.abort.signal;
    this.root.querySelector("[data-workload-start]")!.addEventListener(
      "click",
      () => {
        const classification = this.root.querySelector<HTMLSelectElement>(
          "[data-workload-classification]",
        )!.value;
        this.capture = start({
          observerClassification: classification,
          initialObserverNotes: this.notes(),
          userAgent: navigator.userAgent,
          viewport: {
            width: innerWidth,
            height: innerHeight,
            devicePixelRatio,
          },
          visibility: document.visibilityState,
          route: location.pathname + location.search,
        });
        this.lastUpdate = -Infinity;
        this.update(performance.now());
        // Keep the measured playfield on screen even when setup notes fill a phone viewport.
        card.scrollIntoView({ block: "start" });
      },
      { signal },
    );
    this.root.querySelector("[data-workload-download]")!.addEventListener(
      "click",
      () => {
        if (!this.capture) return;
        const report = {
          ...this.capture.report(),
          observerNotesAtDownload: this.notes(),
        };
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(report, null, 2) + "\n"], {
            type: "application/json",
          }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "phone-workload-40-20.json";
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      },
      { signal },
    );
  }
  private notes() {
    return this.root
      .querySelector<HTMLTextAreaElement>("[data-workload-notes]")!
      .value.slice(0, 4000);
  }
  setReady() {
    this.ready = true;
    this.update(performance.now());
  }
  update(now: number) {
    if (now - this.lastUpdate < 1000) return;
    this.lastUpdate = now;
    const report = this.capture?.report();
    this.root.querySelector<HTMLButtonElement>(
      "[data-workload-start]",
    )!.disabled = !this.ready || Boolean(report && !report.complete);
    this.root.querySelector<HTMLButtonElement>(
      "[data-workload-download]",
    )!.disabled = !this.capture;
    this.root.dataset.workloadState = report?.status ?? "ready";
    this.root.querySelector("[data-workload-status]")!.textContent = report
      ? `${report.status} · ${report.measuredTicks} measured ticks · ${report.cpuUpdateRenderSubmit.samples} RAF samples${report.complete ? ` · ${report.valid ? "Valid workload evidence" : "Invalid workload evidence"} · CPU p95 ${report.cpuUpdateRenderSubmit.p95ms?.toFixed(3) ?? "unavailable"} ms` : ""}${report.failures.length ? ` · ${report.failures.join(" ")}` : ""}. Physical acceptance requires verified hardware and the full observer protocol.`
      : this.ready
        ? "Ready. Enter setup notes, then start capture."
        : "Preparing the fixed workload…";
  }
  dispose() {
    this.abort.abort();
    this.root.remove();
  }
}
