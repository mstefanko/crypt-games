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
  it('links actual command application to the first submitted render without linking physical events', () => {
    const d = createPerformanceDiagnostics({ enabled: true });
    d.captureInput('physical-event', 1, 2);
    d.onlineEvent({ kind: 'input-allocated', at: 3, fields: { seq: 7, tick: 40, epoch: 2, generation: 3, revision: 4 } }, 'session:1');
    d.onlineEvent({ kind: 'input-applied', at: 5, fields: { seq: 7, tick: 40 } }, 'session:1');
    d.submittedRender(undefined, 12); d.submittedRender(undefined, 20);
    const submissions = d.export().events.filter(e => e.kind === 'command-render-submission');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields).toEqual({ seq: 7, tick: 40, epoch: 2, generation: 3, revision: 4,
      allocatedAt: 3, commandId: 'session:1:2:3:7', source: 'predicted-command', physicalEventLinked: false, applicationToSubmissionMs: 7, allocationToSubmissionMs: 9 });
    expect(submissions[0].fields).not.toHaveProperty('captureToSubmissionMs');
    expect(d.export().events.filter(e => e.kind === 'input-render-submission')).toHaveLength(0);
  });
  it('does not measure allocation-only commands or carry an old timeline into a new render', () => {
    const d = createPerformanceDiagnostics({ enabled: true });
    const allocate = (scope: string, epoch: number) => d.onlineEvent({ kind: 'input-allocated', at: 1, fields: { seq: 1, tick: 8, epoch, generation: 1, revision: 0 } }, scope);
    const apply = (scope: string) => d.onlineEvent({ kind: 'input-applied', at: 2, fields: { seq: 1, tick: 8 } }, scope);
    allocate('a', 1); d.submittedRender(undefined, 3);
    expect(d.export().events.filter(e => e.kind === 'command-render-submission')).toHaveLength(0);
    apply('a'); allocate('a', 2); apply('a');
    allocate('b', 1); apply('b'); apply('b');
    d.submittedRender(undefined, 10);
    const submissions = d.export().events.filter(e => e.kind === 'command-render-submission');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.commandId).toBe('b:1:1:1');
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
