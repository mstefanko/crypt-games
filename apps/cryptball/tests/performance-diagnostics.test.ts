import { describe, expect, it } from 'vitest';
import { createPerformanceDiagnostics } from '../src/online/performance-diagnostics';
describe('performance diagnostic event recording', () => {
  it('bounds storage and preserves event order across ring rollover', () => {
    const d = createPerformanceDiagnostics({ enabled: true, maxEvents: 2 });
    for (let i = 0; i < 5; i++) d.record('snapshot', { bytes: i }, i);
    expect(d.export().events.map(e => e.fields.bytes)).toEqual([3, 4]);
    expect(d.export().dropped).toBe(3);
  });
  it('uses a bounded fallback for non-finite capacity', () => {
    const d = createPerformanceDiagnostics({ enabled: true, maxEvents: NaN });
    for (let i = 0; i < 12_001; i++) d.record('frame', {}, i);
    expect(d.export().events).toHaveLength(12_000);
    expect(d.export().dropped).toBe(1);
  });
  it('records each input application/submission once and labels synthetic capture', () => {
    const d = createPerformanceDiagnostics({ enabled: true });
    const id = d.captureInput('synthetic', 10, 11);
    d.appliedInput(id, 42, 12); d.submittedRender(undefined, 16); d.submittedRender(undefined, 32);
    expect(d.export().events.map(e => e.kind)).toEqual(['input-capture', 'input-application', 'input-render-submission']);
    expect(d.export().events[0].fields.source).toBe('synthetic');
    expect(d.export().events[2].fields.applicationToSubmissionMs).toBe(4);
    expect(d.export().events[2].fields.captureToSubmissionMs).toBe(5);
    expect(d.export().events[2].fields.eventToSubmissionMs).toBe(6);
  });
  it('does no event recording when disabled and detaches exports', () => {
    const d = createPerformanceDiagnostics({ enabled: false });
    d.record('snapshot'); expect(d.captureInput('physical-event')).toBe(0);
    expect(d.export().events).toEqual([]);
    const active = createPerformanceDiagnostics({ enabled: true });
    active.record('snapshot', { bytes: 20 });
    active.export().events[0].fields.bytes = 99;
    expect(active.export().events[0].fields.bytes).toBe(20);
  });
});
