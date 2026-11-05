/** Immutable acoustic identity, separate from the oscillator fallback Patch schema. */
export interface InstrumentBinding {
  readonly patchId: string;
  /** Explicit hybrid synthesis route, never a missing-sample fallback. */
  readonly rendering?: "synth";
  readonly instrumentId: string;
  readonly articulationId: string;
  readonly playable: readonly [number, number];
  readonly tessitura: readonly [number, number];
  readonly attackSeconds: number;
  readonly releaseSeconds: number;
  readonly maxSustainSeconds: number;
  /** Minimum written note length where shortening would destroy a natural one-shot tail. */
  readonly minSustainSeconds?: number;
  readonly calibratedGain: number;
  readonly velocityPolicy: "recorded-layers" | "single-layer";
  readonly nativeInstrument: string;
  readonly soundfontProgram: number;
  readonly gmProgram?: number;
  readonly gmDrumPitch?: number;
  readonly synthApproximation: string;
}
export interface InstrumentResource {
  readonly id: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly license: string;
  readonly source: string;
  readonly revision: string;
}
export interface InstrumentPalette {
  readonly version: 1;
  readonly id: string;
  readonly hash: string;
  readonly bindings: readonly InstrumentBinding[];
  readonly resources: readonly InstrumentResource[];
  readonly maxReleaseSeconds: number;
  readonly profile: {
    readonly id: string;
    readonly maxVoices: number;
    readonly maxPackagedBytes: number;
    readonly maxDecodedBytes: number;
    readonly worklets: number;
  };
}
export function validateInstrumentPalette(palette: InstrumentPalette): void {
  if (
    palette.version !== 1 ||
    !palette.id ||
    !/^[a-f0-9]{64}$/.test(palette.hash)
  )
    throw Error("Invalid instrument palette identity");
  if (
    !Number.isFinite(palette.maxReleaseSeconds) ||
    palette.maxReleaseSeconds < 0 ||
    palette.maxReleaseSeconds > 1 ||
    !Number.isInteger(palette.profile.maxVoices) ||
    palette.profile.maxVoices < 1 ||
    palette.profile.maxVoices > 64 ||
    !Number.isInteger(palette.profile.worklets) ||
    palette.profile.worklets < 1 ||
    palette.profile.worklets > 4 ||
    !Number.isSafeInteger(palette.profile.maxPackagedBytes) ||
    palette.profile.maxPackagedBytes <= 0 ||
    !Number.isSafeInteger(palette.profile.maxDecodedBytes) ||
    palette.profile.maxDecodedBytes <= 0
  )
    throw Error("Invalid instrument profile");
  const ids = new Set<string>();
  for (const binding of palette.bindings) {
    if (
      (binding.rendering !== undefined && binding.rendering !== "synth") ||
      !binding.patchId ||
      !binding.instrumentId ||
      !binding.articulationId ||
      !binding.synthApproximation ||
      !binding.nativeInstrument ||
      !["recorded-layers", "single-layer"].includes(binding.velocityPolicy) ||
      !Number.isInteger(binding.soundfontProgram) ||
      binding.soundfontProgram < 0 ||
      binding.soundfontProgram > 127 ||
      (binding.gmProgram !== undefined &&
        (!Number.isInteger(binding.gmProgram) ||
          binding.gmProgram < 0 ||
          binding.gmProgram > 127)) ||
      (binding.gmDrumPitch !== undefined &&
        (!Number.isInteger(binding.gmDrumPitch) ||
          binding.gmDrumPitch < 0 ||
          binding.gmDrumPitch > 127))
    )
      throw Error("Invalid instrument identity");
    if (ids.has(binding.patchId))
      throw Error("Duplicate instrument patch binding");
    ids.add(binding.patchId);
    if (
      binding.minSustainSeconds !== undefined &&
      (!Number.isFinite(binding.minSustainSeconds) ||
        binding.minSustainSeconds <= 0 ||
        binding.minSustainSeconds > binding.maxSustainSeconds)
    )
      throw Error("Invalid instrument minimum sustain");
    const [lo, hi] = binding.playable,
      [tl, th] = binding.tessitura;
    if (
      ![lo, hi, tl, th].every(Number.isInteger) ||
      lo < 0 ||
      hi > 127 ||
      lo > tl ||
      tl > th ||
      th > hi
    )
      throw Error("Invalid instrument range");
    if (
      ![
        binding.attackSeconds,
        binding.releaseSeconds,
        binding.maxSustainSeconds,
        binding.calibratedGain,
      ].every(Number.isFinite) ||
      binding.attackSeconds < 0 ||
      binding.releaseSeconds < 0 ||
      binding.releaseSeconds > palette.maxReleaseSeconds ||
      binding.maxSustainSeconds <= 0 ||
      binding.calibratedGain <= 0
    )
      throw Error("Invalid instrument timing/gain");
  }
  for (const r of palette.resources)
    if (
      !/^[a-f0-9]{64}$/.test(r.sha256) ||
      !Number.isSafeInteger(r.bytes) ||
      r.bytes <= 0 ||
      !r.license ||
      !r.source ||
      !r.revision
    )
      throw Error("Invalid instrument resource provenance");
  if (
    palette.maxReleaseSeconds > 1 ||
    palette.profile.maxVoices > 64 ||
    palette.resources.reduce((sum, r) => sum + r.bytes, 0) >
      palette.profile.maxPackagedBytes
  )
    throw Error("Instrument palette budget exceeded");
}
export function paletteBinding(
  palette: InstrumentPalette,
  patchId: string,
): InstrumentBinding {
  const binding = palette.bindings.find((b) => b.patchId === patchId);
  if (!binding) throw Error(`No instrument binding for ${patchId}`);
  return binding;
}

export const WEATHER_INSTRUMENT_PALETTE: InstrumentPalette = deepFreeze({
  version: 1,
  id: "weather-orchestra-compact-v1",
  bindings: [
    {
      patchId: "weather-flute",
      instrumentId: "flute",
      articulationId: "sustain",
      playable: [60, 84],
      tessitura: [64, 81],
      attackSeconds: 0.025,
      releaseSeconds: 0.25,
      maxSustainSeconds: 4,
      calibratedGain: 1,
      velocityPolicy: "single-layer",
      nativeInstrument: "flute",
      soundfontProgram: 73,
      synthApproximation: "Oscillator approximation; no acoustic recording",
      gmProgram: 73,
    },
    {
      patchId: "weather-violin",
      instrumentId: "violin",
      articulationId: "sustain",
      playable: [55, 79],
      tessitura: [60, 76],
      attackSeconds: 0.04,
      releaseSeconds: 0.3,
      maxSustainSeconds: 4,
      calibratedGain: 1.8,
      velocityPolicy: "recorded-layers",
      nativeInstrument: "violin",
      soundfontProgram: 40,
      synthApproximation: "Oscillator approximation; no acoustic recording",
      gmProgram: 40,
    },
    {
      patchId: "weather-cello",
      instrumentId: "cello",
      articulationId: "sustain",
      playable: [36, 60],
      tessitura: [40, 55],
      attackSeconds: 0.04,
      releaseSeconds: 0.3,
      maxSustainSeconds: 4,
      calibratedGain: 1.2,
      velocityPolicy: "recorded-layers",
      nativeInstrument: "cello",
      soundfontProgram: 42,
      synthApproximation: "Oscillator approximation; no acoustic recording",
      gmProgram: 42,
    },
    {
      patchId: "weather-piano",
      instrumentId: "piano",
      articulationId: "hit",
      playable: [36, 84],
      tessitura: [48, 76],
      attackSeconds: 0.003,
      releaseSeconds: 0.18,
      maxSustainSeconds: 4,
      calibratedGain: 1,
      velocityPolicy: "recorded-layers",
      nativeInstrument: "piano",
      soundfontProgram: 0,
      synthApproximation: "Oscillator approximation; no acoustic recording",
      gmProgram: 0,
    },
    {
      patchId: "weather-marimba",
      instrumentId: "marimba",
      articulationId: "hit",
      playable: [48, 96],
      tessitura: [60, 84],
      attackSeconds: 0.003,
      releaseSeconds: 0.18,
      maxSustainSeconds: 2,
      calibratedGain: 1,
      velocityPolicy: "recorded-layers",
      nativeInstrument: "marimba",
      soundfontProgram: 12,
      synthApproximation: "Oscillator approximation; no acoustic recording",
      gmProgram: 12,
    },
    {
      patchId: "weather-deep-drum",
      gmDrumPitch: 36,
      instrumentId: "kick",
      articulationId: "hit",
      playable: [36, 42],
      tessitura: [36, 42],
      attackSeconds: 0.003,
      releaseSeconds: 0.18,
      maxSustainSeconds: 1,
      calibratedGain: 1,
      velocityPolicy: "recorded-layers",
      nativeInstrument: "kick",
      soundfontProgram: 115,
      synthApproximation: "Oscillator approximation; no acoustic recording",
    },
  ],
  resources: [
    {
      id: "vsco/flute-60-1-1.wav",
      sha256:
        "7c4e06cd8ce4773c42bc858451f605f6ae0987d0e05e16d8acad32dcec5569d1",
      bytes: 352996,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/flute-64-1-1.wav",
      sha256:
        "4244f27739ff61ee2c0a4676ac6ad23729dce13165543b2b4875c634a70a6347",
      bytes: 352996,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/flute-69-1-1.wav",
      sha256:
        "13a8f2193b557dc237f5ede31eaa3e7e45729b9cb44f4f18a164ba2e8a11b661",
      bytes: 352996,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/flute-72-1-1.wav",
      sha256:
        "6cb623c6e725064789eb400cdc0e27710e862980900db5c223c6294d19599ce2",
      bytes: 352996,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/flute-76-1-1.wav",
      sha256:
        "48d883bf1449d18c5f1bf2f41e6c7b611464fa38d3d900c9f735aaa187bd130d",
      bytes: 352996,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/flute-81-1-1.wav",
      sha256:
        "3dcb824b634db7a4bef7dccd47eeefb4d05a8d7de2f011b3fbc41b952065cb25",
      bytes: 352996,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-55-1-1.wav",
      sha256:
        "ad962ffab6bec8a242c2844daa41ddc80633029caef9b396fc64fa63416ebbb6",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-55-3-1.wav",
      sha256:
        "1acc062f2ed3912c3f9917d6fa2c7fea7ea0ed261f3d63918c19d18bdd208036",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-60-1-1.wav",
      sha256:
        "dc9645033f8054ac50c1b3fb64e52ec04711f251e0b7114668d01df2825a5683",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-60-3-1.wav",
      sha256:
        "cd0793369c03eb65d06b30c62f662efb323cf2f7e9921b702db1cfd1f50ee89f",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-64-1-1.wav",
      sha256:
        "cfe624f699520cda411665ea17029d98f63a17c07f1d0c0d008829d880827c10",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-64-3-1.wav",
      sha256:
        "1de9ac1505ecd723f7805156ec04e56df0bc8a55971222130faecdc89c31bbd5",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-69-1-1.wav",
      sha256:
        "0d938aabbc19d53d4760ccedca90950f8faeb389693e50d45a69d30cbecdc30c",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-69-3-1.wav",
      sha256:
        "7fd90a3f337dff4629eea51f8e2c8e876871e004a3076ef8112fe8b36c652e18",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-72-1-1.wav",
      sha256:
        "cda2ccb4295036a9fa1c99a96b183612881a5277094f6b2f26948404511b2cf9",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-72-3-1.wav",
      sha256:
        "d2ac31d6af16d6fc8f838f4f196a9a1390eea3d7f5ced0649303ae54b2065a42",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-76-1-1.wav",
      sha256:
        "bbb8d612a6320de03630b10754e9d6da5c185c4d402647d04844ac8b821a31dc",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/violin-76-3-1.wav",
      sha256:
        "de340e799882658edad96c7b9abfe59a34ef62f0ca32cde8bcb59564d9875867",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-36-1-1.wav",
      sha256:
        "fba555bfef8250ba8b54f5567d1823eb58b30848189a57c529895ea0d0e2cdd7",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-36-3-1.wav",
      sha256:
        "97a2b5fefb4d289fa77d03acc9c9e9c995628be117862511585ba02f21f3db75",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-43-1-1.wav",
      sha256:
        "68820c0cfd0d5cfe237075623b2e6a235dbeb074c1db09709ede711de46680d9",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-43-3-1.wav",
      sha256:
        "ac7ab57666fb91fa332b8d7a61043cce197ca0abd1890eeeaf0f31e97164aa79",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-50-1-1.wav",
      sha256:
        "89281d3b3c85bdda6aa1695e3f1e9f046eb8dcc998e8f5b4e5aef432aa45743a",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-50-3-1.wav",
      sha256:
        "b53f2b32dbac1b63a622eb35152074a4b41e80ee1cf80532a92f9c3b66c7711a",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-57-1-1.wav",
      sha256:
        "23b3aea1d3a2d6fb66068db28c308a4dc1476caea54f4fe4a805bd90c23e3b8c",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vsco/cello-57-3-1.wav",
      sha256:
        "7c06039da0ed8a824213bc311e7aa76f821e439c1cbd5979468178e8be264a98",
      bytes: 352878,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VSCO-2-CE",
      revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
    },
    {
      id: "vcsl/piano-36-1-1.wav",
      sha256:
        "75cbbe7551c7dfd79f9be563a0fb58f484e001caf6bb615ebd7e80d63b6d7674",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-36-3-1.wav",
      sha256:
        "0ea62454120d12cc016fc9a5bf47b6124ce708643a6392fb90ab41319189f240",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-48-1-1.wav",
      sha256:
        "433515d2ef5272c35f483eb5351837e78537c174034dc29a653ae3613d04a8c7",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-48-3-1.wav",
      sha256:
        "26c16a970c917374ff2ba381fbc13562fcd58cae9f18a6536f3c676945f44e04",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-60-1-1.wav",
      sha256:
        "e4365be145b67f3aa3f9b2aa3c103b4e33ff4891f3edd385616a9f92861c3121",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-60-3-1.wav",
      sha256:
        "043fda9c0fff0f2af7df8d1a43b95a2797596e05aef08983db4d4cfd406f950c",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-72-1-1.wav",
      sha256:
        "1f474a5b872a776c36ba8852f7648cd522c1262579e873151cceed2703f3c0e2",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-72-3-1.wav",
      sha256:
        "2c5253a1609d989bc34bf46f7038fc58f955be094a7e98ca26a720ad17791afd",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-84-1-1.wav",
      sha256:
        "6332e9f39c91b28a49281b4992e1c4f7cd8afbd8144e29df151908f88722c4d5",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/piano-84-3-1.wav",
      sha256:
        "1b027960061c4f1e70ef1c45466bd9cdf7012cbfecb7fdbd68aea71c0bd5c5de",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/marimba-48-1-1.wav",
      sha256:
        "ec64b4d8671734ef51fb882fa16fae12373feefe7baaa94c5c3ade60ebd46f2e",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/marimba-48-3-1.wav",
      sha256:
        "76499c9d35a9da1e1c763d415af9ec394d8e85c4c85d3f2d6207175dcdeef502",
      bytes: 384078,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/marimba-72-1-1.wav",
      sha256:
        "de2d6418f3dbe90398e4cfabd499de71c5c0a65ceeaf1594ab48d6c3c8a6c665",
      bytes: 221492,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/marimba-72-3-1.wav",
      sha256:
        "86ef4518c72b1d78764c81f88294efdfcf96574f35f09f755ec33c3fefcf4246",
      bytes: 245950,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/marimba-96-1-1.wav",
      sha256:
        "05f6b28760fee6d2a303a322ac0bc1052889450e7c7403673672d7c99884f757",
      bytes: 160570,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/marimba-96-3-1.wav",
      sha256:
        "b22d89c8f35ae3a3e8439c9bcec4eafd46b0f16adf6ee578992273d0d914c848",
      bytes: 114268,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/kick-36-2-1.wav",
      sha256:
        "f8ebb463d4e4600efc01de7f03920184fa8cf8fedd360cc280840804df8b91d1",
      bytes: 102236,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/kick-36-2-2.wav",
      sha256:
        "6f4954b65394768953a7cd298cda8eff5943a0643e9c148f7e8e633dcd979333",
      bytes: 109776,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/kick-36-5-1.wav",
      sha256:
        "e4049d16537a5eb8cc3e6b472936fa57140c4ab9d23b1fa0d2b63da1cd2927d7",
      bytes: 213430,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/kick-36-5-2.wav",
      sha256:
        "81a4809427deda155d3b2ee8c6fd9751235d8db31552a82da621d2bd7f044674",
      bytes: 222970,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/snare-38-3-1.wav",
      sha256:
        "41f694f8a1cb8da06cb1040ad3e3a6785ace35493acb452cb5f543f07a904738",
      bytes: 110830,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/snare-38-3-2.wav",
      sha256:
        "e75ea5cb95367684d7bf7981b6ec75c6f74b305e1d8e5e4655ffa49b8ccbde72",
      bytes: 83968,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/snare-38-7-1.wav",
      sha256:
        "6d3033a9a29ca54def00f5fdae60f6563f03856d0d177f26bab84fc7264eb8a2",
      bytes: 98560,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/snare-38-7-2.wav",
      sha256:
        "9978a0d739fe2fbf8551485b33a73379c157ce144dea0c40a4904050a7705977",
      bytes: 93820,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/hat-42-1-1.wav",
      sha256:
        "a3fceaeb2c16f5284c8a6aca98845113731ba6f968aa88e38e5113538fb7f2b0",
      bytes: 76488,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/hat-42-1-2.wav",
      sha256:
        "c042e8ae14decc01ede3a43911449d08ae8807454532ab52dfe47ca9e17d5ad1",
      bytes: 85172,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/hat-42-3-1.wav",
      sha256:
        "93b084a2ddb4801175105fd5ef2a80ce12c222d0469e70481238b972478903ab",
      bytes: 79422,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
    {
      id: "vcsl/hat-42-3-2.wav",
      sha256:
        "6b24e407cd621c6f4e3b67a055a4c528350e88dc49247deb6c4d7eb99534cdc0",
      bytes: 101274,
      license: "CC0-1.0",
      source: "https://github.com/sgossner/VCSL",
      revision: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
    },
  ],
  maxReleaseSeconds: 0.3,
  profile: {
    id: "compact-32-v1",
    maxVoices: 32,
    maxPackagedBytes: 25165824,
    maxDecodedBytes: 50331648,
    worklets: 2,
  },
  hash: "41f339c0d151e55bc55b6707287dfc4c55748c8927d0faaeb970fef37b19306d",
});
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Versioned song palette: historical compact identity above remains unchanged. */
export const WEATHER_SONG_INSTRUMENT_PALETTE: InstrumentPalette =
  deepFreeze<InstrumentPalette>({
    ...WEATHER_INSTRUMENT_PALETTE,
    id: "weather-orchestra-song-v1",
    hash: "c63d0aec2a16ddc4bac59a43d6c228bd7eb92b0a6a23d48da9d51ddae53dadbd",
    bindings: [
      ...WEATHER_INSTRUMENT_PALETTE.bindings.map(binding => binding.patchId === "weather-cello" ? { ...binding, synthApproximation: "Triangle bass with upper harmonics; no acoustic recording" } : binding),
      ...([
        {
          patchId: "weather-snare",
          gmDrumPitch: 38,
          instrumentId: "snare",
          articulationId: "hit",
          playable: [38, 38],
          tessitura: [38, 38],
          attackSeconds: 0.003,
          releaseSeconds: 0.18,
          maxSustainSeconds: 1,
          calibratedGain: 1,
          velocityPolicy: "recorded-layers",
          nativeInstrument: "snare",
          soundfontProgram: 115,
          synthApproximation: "Oscillator approximation; no acoustic recording",
        },
        {
          patchId: "weather-closed-hat",
          gmDrumPitch: 42,
          instrumentId: "hat",
          articulationId: "hit",
          playable: [42, 42],
          tessitura: [42, 42],
          attackSeconds: 0.003,
          releaseSeconds: 0.18,
          maxSustainSeconds: 1,
          calibratedGain: 1,
          velocityPolicy: "recorded-layers",
          nativeInstrument: "hat",
          soundfontProgram: 115,
          synthApproximation: "Oscillator approximation; no acoustic recording",
        },
        {
          patchId: "weather-bassoon",
          instrumentId: "bassoon",
          articulationId: "sustain",
          playable: [41, 69],
          tessitura: [48, 65],
          attackSeconds: 0.025,
          releaseSeconds: 0.3,
          maxSustainSeconds: 4,
          calibratedGain: 1,
          velocityPolicy: "single-layer",
          nativeInstrument: "bassoon",
          soundfontProgram: 70,
          gmProgram: 70,
          synthApproximation:
            "Reedy sawtooth approximation; no acoustic recording",
        },
        {
          patchId: "weather-timpani-hit",
          instrumentId: "timpani-unpitched",
          articulationId: "hit",
          playable: [36, 36],
          tessitura: [36, 36],
          attackSeconds: 0.003,
          releaseSeconds: 0.3,
          minSustainSeconds: 5.6,
          maxSustainSeconds: 5.6,
          calibratedGain: 1,
          velocityPolicy: "single-layer",
          nativeInstrument: "timpani-unpitched",
          soundfontProgram: 47,
          synthApproximation:
            "Exponentially decaying sine percussion approximation; fixed mapping key, no pitched timpani claim",
        },
      ] satisfies readonly InstrumentBinding[]),
    ],
    resources: [
      ...WEATHER_INSTRUMENT_PALETTE.resources,
      ...[
        {
          id: "vsco-song/bassoon-41-1-1.wav",
          sha256:
            "cce8b9fbed4ef14bfa55b3d40e1542e862d026a36195624e3e5bf9e8831a77ec",
          bytes: 437968,
          license: "CC0-1.0",
          source: "https://github.com/sgossner/VSCO-2-CE",
          revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
        },
        {
          id: "vsco-song/bassoon-48-1-1.wav",
          sha256:
            "850903790ad5138e4b8ade75b65ca76c9e1262a9efe2d06c862923a74ec5d418",
          bytes: 280418,
          license: "CC0-1.0",
          source: "https://github.com/sgossner/VSCO-2-CE",
          revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
        },
        {
          id: "vsco-song/bassoon-55-1-1.wav",
          sha256:
            "d26c3bb0ae4b4dbdafb7499174a7f63978c7d316517d85751867ee3754a23ba7",
          bytes: 377478,
          license: "CC0-1.0",
          source: "https://github.com/sgossner/VSCO-2-CE",
          revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
        },
        {
          id: "vsco-song/bassoon-60-1-1.wav",
          sha256:
            "eb7aad7eea12fc9db698cf7a9fe2cc0e52313843465a2b53196b76f796443067",
          bytes: 385204,
          license: "CC0-1.0",
          source: "https://github.com/sgossner/VSCO-2-CE",
          revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
        },
        {
          id: "vsco-song/bassoon-69-1-1.wav",
          sha256:
            "b23156cf2a8be092f31809e4c9a089ab10b941dddc628988c0773a684bfa9fbb",
          bytes: 428388,
          license: "CC0-1.0",
          source: "https://github.com/sgossner/VSCO-2-CE",
          revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
        },
        {
          id: "vsco-song/timpani-unpitched-36-3-1.wav",
          sha256:
            "61bc3bfd7dec8c673bae2af621f17fc22591dfc88b3287abd995e587485baad4",
          bytes: 259184,
          license: "CC0-1.0",
          source: "https://github.com/sgossner/VSCO-2-CE",
          revision: "440300901dfe9275fd84e0b7763af1f8443ae62e",
        },
      ],
    ],
  });

/** Song v2 retains acoustic asset tuning; the extra low part is explicitly synthesized. */
export const WEATHER_SONG_V2_INSTRUMENT_PALETTE: InstrumentPalette = {
  ...WEATHER_SONG_INSTRUMENT_PALETTE,
  id: "weather-orchestra-song-v2",
  hash: "1885c8c36d65df3b6d9d0a0b6c06011534998b6cb2c9e59a69771266fcabe900",
  // Fixed MIDI36/38/41/43,2.5s,master0.25/gain0.35/velocity0.57 browser fixture:
  // native cello was -51.9224dBFS vs triangle -49.5820dBFS. +2.34dB is an
  // engineering RMS reference, not a listening preference or master increase.
  bindings: [...WEATHER_SONG_INSTRUMENT_PALETTE.bindings.map(binding =>
    binding.patchId === "weather-cello" ? { ...binding, calibratedGain: binding.calibratedGain * 1.309 } : binding
  ), {
    patchId: "weather-low-foundation-v1", instrumentId: "harmonic-bass", articulationId: "sustain",
    rendering: "synth", playable: [29, 43], tessitura: [29, 43], attackSeconds: 0.035,
    releaseSeconds: 0.3, maxSustainSeconds: 3, calibratedGain: 1,
    velocityPolicy: "single-layer", nativeInstrument: "harmonic-bass", soundfontProgram: 38,
    synthApproximation: "Explicit centered 80% sine fundamental + 20% triangle octave; shared synthesis in every renderer",
  }],
};
validateInstrumentPalette(WEATHER_SONG_V2_INSTRUMENT_PALETTE);
WEATHER_SONG_V2_INSTRUMENT_PALETTE.bindings.forEach(Object.freeze);
Object.freeze(WEATHER_SONG_V2_INSTRUMENT_PALETTE.bindings);
Object.freeze(WEATHER_SONG_V2_INSTRUMENT_PALETTE);
