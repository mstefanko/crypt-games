import {
  WorkloadCapture,
  type WorkloadCounts,
  type WorkloadFrame,
} from "./workload-capture.ts";
import { WorkloadPanel } from "./workload-panel.ts";

/** Passive evidence sink. The host owns fixture mutation, scheduling and CPU boundaries. */
export class WorkloadDiagnostics {
  private capture?: WorkloadCapture;
  private panel: WorkloadPanel;
  private longTasks?: PerformanceObserver;
  constructor(
    parent: HTMLElement,
    start: (metadata: Record<string, unknown>) => WorkloadCapture,
  ) {
    this.panel = new WorkloadPanel(parent, start);
  }
  get hasCapture() {
    return this.capture !== undefined;
  }
  get capturing() {
    return Boolean(this.capture && !this.capture.complete);
  }
  start(at: number, metadata: Record<string, unknown>) {
    this.longTasks?.disconnect();
    const supported =
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes.includes("longtask");
    this.capture = new WorkloadCapture(at, metadata, supported);
    if (supported) {
      this.longTasks = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          this.capture?.longTask(entry.startTime, entry.duration);
      });
      this.longTasks.observe({ type: "longtask" });
    }
    if (document.hidden || !document.hasFocus())
      this.capture.invalidate(
        "Capture started while page was hidden or unfocused.",
      );
    return this.capture;
  }
  setReady() {
    this.panel.setReady();
  }
  beginFrame(at: number) {
    this.capture?.beginFrame(at);
  }
  tick(counts: WorkloadCounts) {
    this.capture?.tick(counts);
  }
  reset(at: number, milliseconds: number, fromTick: number, toTick: number) {
    this.capture?.reset(at, milliseconds, fromTick, toTick);
  }
  invalidate(reason: string) {
    this.capture?.invalidate(reason);
  }
  pause(at: number, reason: string) {
    if (this.capturing) this.capture!.pause(at, reason);
  }
  frame(sample: WorkloadFrame) {
    this.capture?.frame(sample);
    if (this.capture?.complete) this.longTasks?.disconnect();
  }
  update(at: number) {
    this.panel.update(at);
  }
  dispose() {
    this.longTasks?.disconnect();
    this.panel.dispose();
  }
}
