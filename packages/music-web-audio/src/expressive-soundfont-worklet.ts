import { ExpressiveSoundfontProcessor } from "./expressive-soundfont-processor";
declare const sampleRate: number, currentTime: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: typeof AudioWorkletProcessor,
): void;
class ExpressiveGmWorklet extends AudioWorkletProcessor {
  private core?: ExpressiveSoundfontProcessor;
  private closed = false;
  constructor() {
    super();
    this.port.onmessage = async ({ data }) => {
      try {
        if (data.type === "init") {
          const core = await ExpressiveSoundfontProcessor.create(
            sampleRate,
            data.bank,
            (slot, id, end) =>
              this.port.postMessage({ type: "done", slot, id, end }),
          );
          if (this.closed) core.dispose();
          else {
            this.core = core;
            this.port.postMessage({ type: "ready" });
          }
        } else if (data.type === "dispose") {
          this.closed = true;
          this.core?.dispose();
          this.core = undefined;
        } else if (data.type === "add") this.core!.add(data.voice);
        else if (data.type === "update")
          this.core!.update(data.slot, data.id, data.take);
        else if (data.type === "stop")
          this.core!.stop(data.slot, data.id, currentTime);
      } catch (error) {
        this.fail(error);
      } finally {
        if (data.messageBytes)
          this.port.postMessage({
            type: "ack",
            messageBytes: data.messageBytes,
          });
      }
    };
  }
  private fail(error: unknown) {
    this.port.postMessage({ type: "error", reason: String(error) });
    this.closed = true;
    this.core?.dispose();
    this.core = undefined;
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    try {
      this.core?.process(outputs, currentTime);
    } catch (error) {
      this.fail(error);
    }
    return !this.closed;
  }
}
registerProcessor("expressive-gm-live-1", ExpressiveGmWorklet);
