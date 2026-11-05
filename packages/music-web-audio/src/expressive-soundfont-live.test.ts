import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  ExpressiveSoundfontProcessor,
  GM_LIVE_SLOTS,
  type GmLiveVoice,
} from "./expressive-soundfont-processor";
import { createExpressiveAudioFixture } from "./expressive-fixture";
const bank = () =>
  Uint8Array.from(
    readFileSync(
      "apps/weather-fronts/public/instruments/generaluser/GeneralUser-GS.sf2",
    ),
  ).buffer;
function voice(
  slot = 0,
  start = 0,
  pitch = 69,
  drum = false,
  part = "lead",
  program = drum ? 0 : 73,
): GmLiveVoice {
  const take = createExpressiveAudioFixture();
  take.parts[0].id = part;
  take.bindings = [
    {
      id: "tone",
      kind: "soundfont",
      resourceId: "gm",
      gmProgram: program,
      drum,
    },
  ];
  take.resources = [{ id: "gm", kind: "soundfont" }];
  take.controls = [];
  const note = {
    ...take.notes[0],
    id: `note-${slot}`,
    partId: part,
    startSeconds: start,
    endSeconds: start + 0.1,
    keyReleaseSeconds: start + 0.1,
    pitch,
  };
  return { slot, note, take, offset: 0, output: 0 };
}
const outputs = () =>
  Array.from({ length: 4 }, () => [
    new Float32Array(128),
    new Float32Array(128),
  ]);
it("bounds note slots, cancels future onsets and reuses stopped slots without stale updates", async () => {
  const completed: unknown[] = [],
    core = await ExpressiveSoundfontProcessor.create(22050, bank(), (...x) =>
      completed.push(x),
    );
  try {
    for (let i = 0; i < GM_LIVE_SLOTS; i++) core.add(voice(i, 10));
    expect(() => core.add(voice(GM_LIVE_SLOTS))).toThrow("slot capacity");
    core.stop(0, "note-0", 0);
    core.add({ ...voice(), note: { ...voice().note, id: "replacement" } });
    core.update(0, "note-0", voice().take); // Stale identity cannot change the replacement.
    const out = outputs();
    core.process(out, 0);
    expect(out[0][0].some((x) => Math.abs(x) > 1e-8)).toBe(true);
    expect(completed).toContainEqual([0, "note-0", 0]);
  } finally {
    core.dispose();
  }
});
it("reserves simultaneous SF layers before the pinned core can silently steal", async () => {
  const core = await ExpressiveSoundfontProcessor.create(
    22050,
    bank(),
    () => {},
  );
  try {
    // The pinned core refreshes voiceCount only after processSplit. Force a layered
    // preset to prove a second same-frame onset sees the first one's reservation.
    const internal = core as unknown as {
      bank: {
        presets: {
          program: number;
          isGMGSDrum: boolean;
          getVoiceParameters: (pitch: number, velocity: number) => unknown[];
        }[];
      };
    };
    const preset = internal.bank.presets.find(
      (p) => p.program === 73 && !p.isGMGSDrum,
    )!;
    const original = preset.getVoiceParameters.bind(preset),
      parameters = original(69, 100);
    preset.getVoiceParameters = () =>
      Array.from({ length: 513 }, () => parameters[0]);
    core.add(voice(0));
    core.add(voice(1));
    expect(() => core.process(outputs(), 0)).toThrow("sample-voice capacity");
  } finally {
    core.dispose();
  }
});
it("live exclusive-class choking crosses patches but preserves other parts and simultaneous starts", async () => {
  const render = async (mode: "same" | "other" | "simultaneous") => {
    const core = await ExpressiveSoundfontProcessor.create(
        22050,
        bank(),
        () => {},
      ),
      out = outputs();
    let energy = 0;
    try {
      core.add(voice(0, 0, 46, true));
      core.add(
        voice(
          1,
          mode === "simultaneous" ? 0 : 0.2,
          42,
          true,
          mode === "other" ? "other" : "lead",
          8,
        ),
      );
      for (let frame = 0; frame < 33075; frame += 128) {
        for (const pair of out) for (const x of pair) x.fill(0);
        core.process(out, frame / 22050);
        if (frame > 11025) for (const x of out[0][0]) energy += x * x;
      }
      return energy;
    } finally {
      core.dispose();
    }
  };
  const same = await render("same"),
    other = await render("other"),
    simultaneous = await render("simultaneous");
  expect(other).toBeGreaterThan(0.001);
  expect(same / other).toBeLessThan(0.03);
  expect(simultaneous / other).toBeGreaterThan(0.5);
});
it("rejects an unfinished natural release beyond its explicit ending budget", async () => {
  const core = await ExpressiveSoundfontProcessor.create(
    22050,
    bank(),
    () => {},
  );
  try {
    core.add(voice());
    core.process(outputs(), 0);
    expect(() => core.process(outputs(), 65)).toThrow("64-second budget");
  } finally {
    core.dispose();
  }
});
it("mandatory stop remains available after optional control messages exhaust their quota", async () => {
  const { vi } = await import("vitest");
  const { prepareExpressiveSoundfontLiveRenderer } = await import(
    "./expressive-soundfont-live"
  );
  const sent: { type: string }[] = [];
  class Worklet {
    port = {
      onmessage: undefined as undefined | ((event: { data: unknown }) => void),
      postMessage: (message: { type: string }) => {
        sent.push(message);
        if (message.type === "init")
          queueMicrotask(() =>
            this.port.onmessage?.({ data: { type: "ready" } }),
          );
      },
      close: vi.fn(),
    };
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("AudioWorkletNode", Worklet);
  const message = voice(),
    renderer = await prepareExpressiveSoundfontLiveRenderer(message.take, {
      bank: bank(),
    });
  const context = {
    currentTime: 0,
    audioWorklet: { addModule: async () => {} },
  } as unknown as AudioContext;
  try {
    await renderer.prepareContext!(context, message.take);
    const handle = renderer.renderVoice(
      context,
      {} as AudioNode,
      message.take,
      message.note,
      0,
    );
    for (let i = 0; i < 4095; i++) handle.updateControls(message.take, 0);
    expect(() => handle.updateControls(message.take, 0)).toThrow(
      "message queue budget",
    );
    expect(() => handle.stop()).not.toThrow();
    expect(sent.at(-1)?.type).toBe("stop");
    renderer.releaseContext!(context);
    expect(() => handle.stop()).not.toThrow();
  } finally {
    renderer.releaseContext!(context);
    vi.unstubAllGlobals();
  }
});
it("disposing while the module is loading prevents a late worklet allocation", async () => {
  const { vi } = await import("vitest");
  const { prepareExpressiveSoundfontLiveRenderer } = await import(
    "./expressive-soundfont-live"
  );
  const constructor = vi.fn();
  vi.stubGlobal("AudioWorkletNode", constructor);
  let finish!: () => void;
  const loading = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    context = {
      audioWorklet: { addModule: () => loading },
    } as unknown as AudioContext;
  const message = voice(),
    renderer = await prepareExpressiveSoundfontLiveRenderer(message.take, {
      bank: bank(),
    });
  try {
    const pending = renderer.prepareContext!(context, message.take);
    renderer.releaseContext!(context);
    finish();
    await expect(pending).rejects.toThrow("preparation disposed");
    expect(constructor).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("disposing during bank initialization rejects preparation promptly", async () => {
  const { vi } = await import("vitest");
  const { prepareExpressiveSoundfontLiveRenderer } = await import(
    "./expressive-soundfont-live"
  );
  class PendingWorklet {
    port = { onmessage: undefined, postMessage: vi.fn(), close: vi.fn() };
    disconnect = vi.fn();
  }
  vi.stubGlobal("AudioWorkletNode", PendingWorklet);
  const context = {
      audioWorklet: { addModule: async () => {} },
    } as unknown as AudioContext,
    message = voice(),
    renderer = await prepareExpressiveSoundfontLiveRenderer(message.take, {
      bank: bank(),
    });
  try {
    const pending = renderer.prepareContext!(context, message.take);
    await Promise.resolve();
    renderer.releaseContext!(context);
    await expect(pending).rejects.toThrow("preparation disposed");
  } finally {
    renderer.releaseContext!(context);
    vi.unstubAllGlobals();
  }
});
