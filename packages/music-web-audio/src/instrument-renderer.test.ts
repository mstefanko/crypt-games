import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { InstrumentPalette } from "@onepage/music-core/instrument-palette";
import type { Patch } from "@onepage/project";
import {
  createNativeInstrumentRenderer,
  selectInstrumentSample,
} from "./native-instrument-renderer";
import { SoundfontInstrumentRenderer } from "./soundfont-instrument-renderer";
const data = new Uint8Array([1, 2, 3, 4]);
const sha256 = createHash("sha256").update(data).digest("hex");
function fixture(): InstrumentPalette {
  return {
    version: 1,
    id: "custom-library",
    hash: "a".repeat(64),
    maxReleaseSeconds: 0.2,
    profile: {
      id: "custom-32",
      maxVoices: 32,
      worklets: 2,
      maxPackagedBytes: 1024,
      maxDecodedBytes: 1024,
    },
    resources: [
      {
        id: "one.wav",
        sha256,
        bytes: 4,
        license: "CC0-1.0",
        source: "https://example.com/library",
        revision: "fixed-revision",
      },
    ],
    bindings: [
      {
        patchId: "custom-patch",
        instrumentId: "custom",
        articulationId: "hit",
        playable: [0, 127],
        tessitura: [48, 84],
        attackSeconds: 0.01,
        releaseSeconds: 0.2,
        maxSustainSeconds: 1,
        calibratedGain: 1,
        velocityPolicy: "single-layer",
        nativeInstrument: "custom",
        soundfontProgram: 5,
        synthApproximation: "triangle approximation",
      },
    ],
  };
}
const capabilities = {
  instruments: ["custom/hit"],
  maxVoices: 32,
  maxTailSeconds: 0.2,
  native: true,
  offline: true,
};
const patch = {
  id: "custom-patch",
  name: "custom",
  waveform: "triangle",
  attack: 0.01,
  release: 0.2,
  brightness: 0.5,
  duty: 0.5,
} as Patch;
afterEach(() => vi.unstubAllGlobals());
it("prepares injected native resources without an app asset dependency and snapshots identity", async () => {
  const channel = new Float32Array([0.1, -0.2, 0.15]);
  class Decoder {
    decodeAudioData = vi.fn(async () => ({
      numberOfChannels: 1,
      length: 3,
      duration: 2,
      getChannelData: () => channel,
    }));
  }
  vi.stubGlobal("OfflineAudioContext", Decoder);
  const fetcher = vi.fn(async (_url: string, _options?: unknown) => ({
    ok: true,
    arrayBuffer: async () => data.buffer.slice(0),
  }));
  vi.stubGlobal("fetch", fetcher);
  const palette = fixture();
  const renderer = await createNativeInstrumentRenderer({
    id: "native-custom",
    palette,
    sampleSets: [
      {
        baseUrl: "/other-library/",
        samples: [
          {
            instrument: "custom",
            root: 60,
            velocity: 1,
            alternate: 1,
            file: "one.wav",
            bytes: 4,
            sha256,
          },
        ],
      },
    ],
    capabilities,
  });
  expect(fetcher.mock.calls[0][0]).toBe("/other-library/one.wav");
  expect(renderer.id).toBe("native-custom");
  expect(renderer.memoryDiagnostics?.()).toMatchObject({ retainedDecodedPcmBytes: 12, decodedSampleCount: 1, requestedDecodeSampleRate: 22050, maxFetchedCompressedBufferBytes: 4, maxDecodedSampleBytes: 12 });
  expect(renderer.paletteIdentity).toEqual({
    id: palette.id,
    hash: palette.hash,
  });
  expect(Object.isFrozen(renderer.paletteIdentity)).toBe(true);
  const mutable = palette as unknown as {
    bindings: { releaseSeconds: number }[];
    hash: string;
  };
  mutable.bindings[0].releaseSeconds = 0.1;
  mutable.hash = "b".repeat(64);
  expect(renderer.releaseSeconds(patch)).toBe(0.2);
  expect(renderer.paletteIdentity?.hash).toBe("a".repeat(64));
  const calibrated = [...channel];
  const reused = await createNativeInstrumentRenderer({
    palette: fixture(), capabilities,
    sampleSets: [{ baseUrl: "/same-recording/", samples: [{ instrument: "custom", root: 60, velocity: 1, alternate: 1, file: "one.wav", bytes: 4, sha256 }] }],
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect([...channel]).toEqual(calibrated);
  expect(reused.memoryDiagnostics?.().sharedProfileDecodedPcmBytes).toBe(12);

});
it("retains deterministic layer/root/alternate selection for arbitrary instruments", () => {
  const samples = [1, 2].flatMap((alternate) =>
    [60, 72].map((root) => ({
      instrument: "custom",
      root,
      velocity: 1,
      alternate,
      file: `${root}-${alternate}`,
      bytes: 4,
      sha256,
    })),
  );
  expect(selectInstrumentSample(samples, "custom", 70, 0.1, 1).file).toBe(
    "72-2",
  );
  expect(() => selectInstrumentSample(samples, "absent", 60, 0.5)).toThrow(
    "Unknown sampled instrument",
  );
});
it("snapshots injected SoundFont configuration and verifies its bytes before worklet preparation", async () => {
  const palette = fixture();
  const renderer = new SoundfontInstrumentRenderer({
    id: "sf-custom",
    palette,
    capabilities: { ...capabilities, native: false },
    bankUrl: "/custom/bank.sf2",
    bankSha256: "0".repeat(64),
    workletUrl: "/custom/processor.js",
    worklets: 2,
  });
  const mutable = palette as unknown as {
    bindings: { releaseSeconds: number }[];
  };
  mutable.bindings[0].releaseSeconds = 0.1;
  expect(renderer.releaseSeconds(patch)).toBe(0.2);
  expect(renderer.paletteIdentity).toEqual({
    id: "custom-library",
    hash: "a".repeat(64),
  });
  const fetcher = vi.fn(async (_url: string, _options?: unknown) => ({
    ok: true,
    arrayBuffer: async () => data.buffer.slice(0),
  }));
  vi.stubGlobal("fetch", fetcher);
  await expect(renderer.prepareContext({} as BaseAudioContext)).rejects.toThrow(
    "hash mismatch",
  );
  expect(fetcher.mock.calls[0][0]).toBe("/custom/bank.sf2");
});
