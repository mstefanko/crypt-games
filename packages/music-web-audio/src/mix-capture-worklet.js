registerProcessor(
  "mixed-capture-1",
  class extends AudioWorkletProcessor {
    constructor(o) {
      super();
      this.frames = o.processorOptions.frames;
      this.offset = 0;
      this.chunk = 0;
      this.cancelled = false;
      this.port.onmessage = () => {
        this.cancelled = true;
      };
      this.buffers = Array.from({ length: 12 }, () => new Float32Array(4096));
    }
    process(inputs, outputs) {
      if (this.cancelled) return false;
      for (
        let i = 0;
        i < outputs[0][0].length && this.offset < this.frames;
        i++
      ) {
        if (this.offset === 0) this.startFrame = currentFrame + i;
        for (let s = 0; s < 6; s++)
          for (let c = 0; c < 2; c++)
            this.buffers[s * 2 + c][this.chunk] = inputs[s]?.[c]?.[i] ?? 0;
        this.chunk++;
        this.offset++;
        if (this.chunk === 4096 || this.offset === this.frames) {
          const data = this.buffers.map((b) => b.slice(0, this.chunk));
          this.port.postMessage(
            {
              offset: this.offset - this.chunk,
              startFrame: this.startFrame,
              data,
              done: this.offset === this.frames,
            },
            data.map((b) => b.buffer),
          );
          this.chunk = 0;
        }
      }
      return this.offset < this.frames;
    }
  },
);
