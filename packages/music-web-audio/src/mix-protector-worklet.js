class LinkedPeakProtector {
  left = new Float32Array(257);
  right = new Float32Array(257);
  position = 0;
  coefficients = Array.from({ length: 3 }, (_, phase) => {
    const weights = Array.from({ length: 32 }, (_2, i) => {
      const x = i - 15 - (phase + 1) / 4;
      return (
        (Math.sin(Math.PI * x) / (Math.PI * x)) *
        (0.5 + 0.5 * Math.cos((Math.PI * x) / 16))
      );
    });
    const norm = weights.reduce((sum, value) => sum + value, 0);
    return weights.map((value) => value / norm);
  });
  gain = 1;
  reducedFrames = 0;
  frames = 0;
  outputLeft = 0;
  outputRight = 0;
  peaks = new Float64Array(258);
  indices = new Float64Array(258);
  front = 0;
  back = 0;
  processInto(left, right) {
    const p = this.position;
    this.left[p] = Number.isFinite(left) ? left : 0;
    this.right[p] = Number.isFinite(right) ? right : 0;
    const index = this.frames;
    while (this.front !== this.back && this.indices[this.front] <= index - 257)
      this.front = (this.front + 1) % 258;
    let peak = Math.max(Math.abs(this.left[p]), Math.abs(this.right[p]));
    for (const weights of this.coefficients) {
      let l = 0,
        r = 0;
      for (let tap = 0; tap < 32; tap++) {
        const at = (p - 31 + tap + 257) % 257;
        l += this.left[at] * weights[tap];
        r += this.right[at] * weights[tap];
      }
      peak = Math.max(peak, Math.abs(l), Math.abs(r));
    }
    while (
      this.front !== this.back &&
      this.peaks[(this.back + 257) % 258] <= peak
    )
      this.back = (this.back + 257) % 258;
    this.peaks[this.back] = peak;
    this.indices[this.back] = index;
    this.back = (this.back + 1) % 258;
    const maximum = this.peaks[this.front];
    const target = maximum > 0.7 ? 0.7 / maximum : 1;
    this.gain = Math.min(target, this.gain + (1 - this.gain) * 4e-4);
    this.position = (p + 1) % 257;
    this.frames++;
    if (this.gain < 0.999) this.reducedFrames++;
    this.outputLeft = this.left[this.position] * this.gain;
    this.outputRight = this.right[this.position] * this.gain;
  }
  process(left, right) {
    this.processInto(left, right);
    return [this.outputLeft, this.outputRight];
  }
}
export { LinkedPeakProtector };

if (typeof registerProcessor !== "undefined")
  registerProcessor(
    "linked-peak-protector-1",
    class extends AudioWorkletProcessor {
      constructor() {
        super();
        this.protector = new LinkedPeakProtector();
        this.port.onmessage = () => {
          this.protector = new LinkedPeakProtector();
        };
      }
      process(inputs, outputs) {
        const input = inputs[0],
          output = outputs[0];
        for (let i = 0; i < output[0].length; i++) {
          this.protector.processInto(
            input[0]?.[i] ?? 0,
            input[1]?.[i] ?? input[0]?.[i] ?? 0,
          );
          output[0][i] = this.protector.outputLeft;
          output[1][i] = this.protector.outputRight;
        }
        if (this.protector.frames % 4096 === 0)
          this.port.postMessage({
            frames: this.protector.frames,
            reducedFrames: this.protector.reducedFrames,
          });
        return true;
      }
    },
  );
