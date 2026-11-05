import workletUrl from "./expressive-soundfont-worklet.ts?worker&url";
import { SoundBankLoader } from "spessasynth_core";
import {
  assertPerformanceTakeV3,
  type CompiledExpressiveNote,
  type PerformanceTakeV3,
} from "@onepage/music-core/expressive-performance";
import type {
  ExpressiveVoiceHandle,
  ExpressiveVoiceRenderer,
} from "./expressive-synth";
import {
  GM_LIVE_SLOTS,
  GM_LIVE_TAIL_SECONDS,
} from "./expressive-soundfont-processor";

const ROLES = ["melody", "bass", "harmony", "drums"];
interface State {
  node: AudioWorkletNode;
  error?: string;
  disposed: boolean;
  entries: Map<number, { id: string; end: number; deadline: number }>;
  routes: Map<number, AudioNode>;
  pending: number;
  pendingBytes: number;
  cancelPreparation?: () => void;
}
function post(state: State, message: object) {
  const bytes = JSON.stringify(message).length * 2;
  if (state.pending >= 4096 || state.pendingBytes + bytes > 16 * 1024 * 1024) {
    state.error = "GM live message queue budget exceeded";
    throw Error(state.error);
  }
  state.pending++;
  state.pendingBytes += bytes;
  state.node.port.postMessage({ ...message, messageBytes: bytes });
}
function compact(
  take: PerformanceTakeV3,
  note: CompiledExpressiveNote,
): PerformanceTakeV3 {
  return {
    ...take,
    provenance: { gainCurve: "cc-square-v1", diagnostics: [] },
    instruments: [],
    tempoMap: [],
    meterMap: [],
    deviations: [],
    notes: [],
    resources: [],
    bindings: take.bindings.filter((b) => b.id === note.bindingId),
    parts: take.parts.filter((p) => p.id === note.partId),
    controls: take.controls.filter(
      (c) => c.partId === note.partId && (!c.noteId || c.noteId === note.id),
    ),
  };
}
/** Explicit prepared live backend: 256 note slots, 1024 SF sample voices, one
 * bank/processor per context. Actual natural tails occupy slots until silent.
 * Stream admission reserves held notes; tail capacity is enforced by processor,
 * with failures surfaced to the engine instead of stealing/truncating voices.
 * Offline export remains renderPerformanceTakeV3Soundfont.
 */
export async function prepareExpressiveSoundfontLiveRenderer(
  take: PerformanceTakeV3,
  options: { bank: ArrayBuffer },
): Promise<ExpressiveVoiceRenderer> {
  assertPerformanceTakeV3(take);
  if (
    options.bank.byteLength < 12 ||
    options.bank.byteLength > 64 * 1024 * 1024
  )
    throw Error("GM bank exceeds 64 MiB budget");
  const bytes = options.bank.slice(0),
    digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
  const bank = SoundBankLoader.fromArrayBuffer(bytes.slice(0));
  const states = new Map<BaseAudioContext, State>();
  const generations = new WeakMap<BaseAudioContext, number>();
  const validate = (current: PerformanceTakeV3) => {
    for (const binding of current.bindings) {
      const resource = current.resources.find(
        (r) => r.id === binding.resourceId,
      );
      if (
        binding.kind !== "soundfont" ||
        binding.gmProgram === undefined ||
        resource?.kind !== "soundfont"
      )
        throw Error(`GM live binding unavailable: ${binding.id}`);
      if (resource.sha256 && resource.sha256.toLowerCase() !== digest)
        throw Error("GM bank does not match frozen take resource identity");
      if (
        !bank.presets.some(
          (p) =>
            p.program === binding.gmProgram &&
            p.bankMSB === (binding.bankMsb ?? 0) &&
            p.bankLSB === (binding.bankLsb ?? 0) &&
            p.isGMGSDrum === !!binding.drum,
        )
      )
        throw Error(`GM bank has no exact preset for ${binding.id}`);
    }
    if (
      current.parts.some(
        (p) =>
          p.initialState?.brightness !== undefined &&
          p.initialState.brightness !== 1,
      ) ||
      current.controls.some(
        (c) => c.parameter === "brightness" && c.value !== 1,
      )
    )
      throw Error("GM brightness mapping is not qualified in this profile");
    if (current.parts.some((p) => !ROLES.includes(p.role)))
      throw Error("GM live role unavailable");
    if (
      current.controls.some(
        (c) => c.parameter === "pitchCents" && Math.abs(c.value) > 9600,
      ) ||
      current.parts.some(
        (p) => Math.abs(p.initialState?.pitchCents ?? 0) > 9600,
      )
    )
      throw Error("GM live pitch range exceeds 96 semitones");
  };
  validate(take);
  const renderer: ExpressiveVoiceRenderer = {
    id: "expressive-gm-live-1",
    maxVoices: GM_LIVE_SLOTS,
    validateTake: validate,
    // Acoustic tails are separately bounded in the worklet, not silently stolen.
    admissionReleaseSeconds: () => 0,
    releaseSeconds(current, note) {
      if (
        !current.bindings.some(
          (b) => b.id === note.bindingId && b.kind === "soundfont",
        )
      )
        throw Error("GM live binding unavailable");
      return note.termination === "kill" ? 0 : GM_LIVE_TAIL_SECONDS;
    },
    async prepareContext(context, current) {
      validate(current);
      if (states.has(context)) {
        this.checkHealth?.(context);
        return;
      }
      if ("startRendering" in context)
        throw Error(
          "GM live renderer requires an AudioContext; use the GM offline export API",
        );
      const generation = (generations.get(context) ?? 0) + 1;
      generations.set(context, generation);
      await context.audioWorklet.addModule(workletUrl);
      if (generations.get(context) !== generation)
        throw Error("GM live preparation disposed");
      const node = new AudioWorkletNode(context, "expressive-gm-live-1", {
        numberOfInputs: 0,
        numberOfOutputs: ROLES.length,
        outputChannelCount: ROLES.map(() => 2),
      });
      const state: State = {
        node,
        disposed: false,
        entries: new Map(),
        routes: new Map(),
        pending: 0,
        pendingBytes: 0,
      };
      states.set(context, state);
      try {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            state.error = "GM live preparation timeout";
            reject(Error(state.error));
          }, 30000);
          state.cancelPreparation = () => {
            clearTimeout(timeout);
            reject(Error("GM live preparation disposed"));
          };
          node.onprocessorerror = () => {
            state.error = "GM live worklet processor failed";
            clearTimeout(timeout);
            reject(Error(state.error));
          };
          node.port.onmessage = ({ data }) => {
            if (data.type === "ack") {
              state.pending = Math.max(0, state.pending - 1);
              state.pendingBytes = Math.max(
                0,
                state.pendingBytes - data.messageBytes,
              );
            } else if (data.type === "ready") {
              clearTimeout(timeout);
              state.cancelPreparation = undefined;
              resolve();
            } else if (data.type === "error") {
              state.error = data.reason;
              clearTimeout(timeout);
              reject(Error(data.reason));
            } else if (data.type === "done") {
              const entry = state.entries.get(data.slot);
              if (entry && entry.id === data.id) {
                entry.end = data.end;
                state.entries.delete(data.slot);
              }
            }
          };
          node.port.postMessage({ type: "init", bank: bytes.slice(0) });
        });
        if (state.disposed) throw Error("GM live preparation disposed");
      } catch (error) {
        this.releaseContext?.(context);
        throw error;
      }
    },
    checkHealth(context) {
      const state = states.get(context);
      if (!state || state.disposed)
        throw Error("GM live renderer requires explicit context preparation");
      if (
        [...state.entries.values()].some(
          (e) => context.currentTime > e.deadline,
        )
      )
        state.error = "GM live voice completion exceeded natural-tail budget";
      if (state.error) throw Error(state.error);
    },
    renderVoice(context, destination, current, note, offset) {
      this.checkHealth!(context);
      const state = states.get(context)!;
      let slot = 0;
      while (state.entries.has(slot)) slot++;
      if (slot >= GM_LIVE_SLOTS)
        throw Error("GM live natural-tail slot capacity exceeded");
      const part = current.parts.find((p) => p.id === note.partId)!,
        output = ROLES.indexOf(part.role);
      const route = state.routes.get(output);
      if (route && route !== destination)
        throw Error("GM live role destination changed during context lifetime");
      if (!route) {
        state.node.connect(destination, output, 0);
        state.routes.set(output, destination);
      }
      const entry = {
        id: note.id,
        end: Infinity,
        deadline:
          note.endSeconds + offset + this.releaseSeconds(current, note) + 0.01,
      };
      state.entries.set(slot, entry);
      post(state, {
        type: "add",
        voice: { slot, note, take: compact(current, note), offset, output },
      });
      let stopped = false;
      return {
        get endContextTime() {
          return entry.end;
        },
        updateControls(next) {
          if (!stopped)
            post(state, {
              type: "update",
              slot,
              id: note.id,
              take: compact(next, note),
            });
        },
        stop() {
          if (stopped) return;
          stopped = true;
          entry.end = context.currentTime;
          if (!state.disposed)
            state.node.port.postMessage({ type: "stop", slot, id: note.id });
        },
      } satisfies ExpressiveVoiceHandle;
    },
    releaseContext(context) {
      generations.set(context, (generations.get(context) ?? 0) + 1);
      const state = states.get(context);
      if (!state) return;
      state.disposed = true;
      state.cancelPreparation?.();
      state.cancelPreparation = undefined;
      state.node.port.postMessage({ type: "dispose" });
      state.node.port.close();
      state.node.disconnect();
      state.entries.clear();
      state.routes.clear();
      states.delete(context);
    },
  };
  return renderer;
}
