/** Opt-in, bounded event recorder. Render submission is not display/photon latency. */
export type DiagnosticFields = Record<string, string | number | boolean | null>;
export interface DiagnosticEvent { kind: string; at: number; fields: DiagnosticFields }
export interface PerformanceMetadata { [key: string]: string | number | boolean | null }
export function createPerformanceDiagnostics(options: {
  enabled: boolean; maxEvents?: number; metadata?: PerformanceMetadata;
}) {
  const requestedCapacity = options.maxEvents;
  const capacity = typeof requestedCapacity === "number" && Number.isFinite(requestedCapacity) && requestedCapacity >= 1
    ? Math.min(100_000, Math.floor(requestedCapacity)) : 12_000;
  const events: DiagnosticEvent[] = [];
  const metadata = { ...options.metadata };
  let cursor = 0, dropped = 0, inputId = 0, lastFrame: number | undefined;
  const pending = new Map<number, number>();
  const captures = new Map<number, { eventAt: number; capturedAt: number }>();
  const now = () => performance.now();
  function record(kind: string, fields: DiagnosticFields = {}, at = now()) {
    if (!options.enabled || !Number.isFinite(at)) return;
    const event = { kind, at, fields: { ...fields } };
    if (events.length < capacity) events.push(event);
    else { events[cursor] = event; cursor = (cursor + 1) % capacity; dropped++; }
  }
  return {
    enabled: options.enabled,
    record,
    setMetadata(value: PerformanceMetadata) { Object.assign(metadata, value); },
    captureInput(source: 'physical-event' | 'synthetic', eventAt = now(), capturedAt = now()) {
      if (!options.enabled) return 0;
      const id = ++inputId;
      // Browser event timestamps are document-relative; epoch timestamps need normalization.
      const normalized = eventAt > 1e12 ? eventAt - performance.timeOrigin : eventAt;
      if (captures.size >= 256) captures.delete(captures.keys().next().value!);
      captures.set(id, { eventAt: normalized, capturedAt });
      record('input-capture', { id, source, eventAt: normalized, captureDelayMs: Math.max(0, capturedAt - normalized) }, capturedAt);
      return id;
    },
    appliedInput(id: number, tick: number, at = now()) {
      if (!options.enabled || !id) return;
      if (pending.size >= 256) pending.delete(pending.keys().next().value!);
      pending.set(id, at);
      record('input-application', { id, tick }, at);
    },
    submittedRender(ids?: readonly number[], at = now()) {
      if (!options.enabled) return;
      for (const id of ids ?? pending.keys()) {
        const appliedAt = pending.get(id);
        if (appliedAt === undefined) continue;
        const capture = captures.get(id);
        record('input-render-submission', { id, applicationToSubmissionMs: Math.max(0, at - appliedAt),
          ...(capture ? { captureToSubmissionMs: Math.max(0, at - capture.capturedAt), eventToSubmissionMs: Math.max(0, at - capture.eventAt) } : {}) }, at);
        captures.delete(id);
        pending.delete(id);
      }
    },
    frame(at: number, steps: number, workMs: number) {
      record('frame', { intervalMs: lastFrame === undefined ? 0 : at - lastFrame, steps, workMs }, at);
      lastFrame = at;
    },
    export() {
      return { schema: 1, metadata: { ...metadata }, enabled: options.enabled, dropped,
        limitation: 'Browser event to render submission only; no physical input-to-photon measurement.',
        events: [...events.slice(cursor), ...events.slice(0, cursor)].map(e => ({ ...e, fields: { ...e.fields } })) };
    },
    download() {
      const blob = new Blob([JSON.stringify(this.export())], { type: 'application/json' });
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `cryptball-performance-${Date.now()}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
export type PerformanceDiagnostics = ReturnType<typeof createPerformanceDiagnostics>;
/** Call once at host startup; no listeners, observers, or DOM when disabled. */
export function installPerformanceDiagnostics(metadata: PerformanceMetadata = {}) {
  const query = new URLSearchParams(location.search);
  const enabled = query.get('diagnostics') === '1';
  const requestedEvents = query.get('diagnosticEvents');
  const maxEvents = requestedEvents && /^\d+$/.test(requestedEvents) ? Number(requestedEvents) : undefined;
  const recorder = createPerformanceDiagnostics({ enabled, maxEvents, metadata: {
    userAgent: navigator.userAgent, devicePixelRatio, viewportWidth: innerWidth,
    viewportHeight: innerHeight, timeOrigin: performance.timeOrigin, ...metadata,
  } });
  let button: HTMLButtonElement | undefined;
  if (enabled) {
    Object.assign(globalThis, { __cryptballPerformance: recorder });
    button = document.createElement('button');
    button.textContent = 'Export performance';
    button.setAttribute('aria-label', 'Export performance diagnostics');
    button.style.cssText = 'position:fixed;right:8px;top:8px;z-index:10000;font-size:12px';
    button.addEventListener('click', () => recorder.download());
    document.body.append(button);
  }
  return Object.assign(recorder, { dispose() {
    button?.remove();
    const scope = globalThis as typeof globalThis & { __cryptballPerformance?: PerformanceDiagnostics };
    if (scope.__cryptballPerformance === recorder) delete scope.__cryptballPerformance;
  } });
}
