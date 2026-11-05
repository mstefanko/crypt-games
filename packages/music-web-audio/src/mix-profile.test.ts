import { describe, expect, it } from "vitest";
import { LinkedPeakProtector, measureReconstructedPeak, PROTECTED_MIX_LATENCY_FRAMES } from "./mix-profile";
describe("versioned linked protection", () => {
  it("preserves stereo ratio, bounds overloaded output and reports reduction duty", () => {
    const limiter = new LinkedPeakProtector();
    const left = new Float32Array(24000), right = new Float32Array(24000);
    for (let i = 0; i < left.length; i++) {
      const input = 4 * Math.sin(i * 0.31) + 1.7 * Math.sin(i * 1.6);
      [left[i], right[i]] = limiter.process(input, input / 3);
      expect(Math.abs(left[i])).toBeLessThanOrEqual(0.700001);
      expect(right[i]).toBeCloseTo(left[i] / 3, 6);
    }
    expect(limiter.reducedFrames / limiter.frames).toBeGreaterThan(0.9);
    // This declared stress fixture qualifies the ceiling under the published QA estimator.
    expect(measureReconstructedPeak([left, right]).dbtp).toBeLessThanOrEqual(-1);
  });
  it("protects adversarial near-Nyquist and reconstructed step peaks", () => {
    for (const kind of [0,1,2,3]) {
      const limiter=new LinkedPeakProtector(), output=new Float32Array(16000);
      for(let i=0;i<output.length;i++) {
        const value=kind===0 ? (i%4<2?3:-3) : kind===1 ? Math.sin(i*Math.PI*.97)*6 : kind===2 ? (i%31<16?4:-4) : (i%17===0?8:0);
        output[i]=limiter.process(value,value)[0];
      }
      expect(measureReconstructedPeak([output]).dbtp).toBeLessThanOrEqual(-1);
    }
  });
  it("delays exactly 256 frames and preserves low-level samples", () => {
    const limiter = new LinkedPeakProtector();
    for (let i = 0; i < PROTECTED_MIX_LATENCY_FRAMES; i++)
      expect(limiter.process(i === 0 ? 0.2 : 0, 0)[0]).toBe(0);
    expect(limiter.process(0, 0)[0]).toBeCloseTo(0.2);
    expect(limiter.reducedFrames).toBe(0);
  });
  it("sanitizes nonfinite processor input without poisoning later samples", () => {
    const limiter = new LinkedPeakProtector();
    for (let i = 0; i < 600; i++) expect(limiter.process(i === 0 ? NaN : 0.1, Infinity).every(Number.isFinite)).toBe(true);
  });
});
