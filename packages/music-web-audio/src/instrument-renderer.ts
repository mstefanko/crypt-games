import {
  validateInstrumentPalette,
  type InstrumentPalette,
} from "@onepage/music-core/instrument-palette";
export interface InstrumentRendererCapabilities {
  readonly instruments: readonly string[];
  readonly maxVoices: number;
  readonly maxTailSeconds: number;
  readonly native: boolean;
  readonly offline: boolean;
}
/** Fail at preparation, before an admitted note can request unsupported acoustic identity. */
export function prepareInstrumentBindings(
  palette: InstrumentPalette,
  capabilities: InstrumentRendererCapabilities,
): void {
  validateInstrumentPalette(palette);
  if (
    !capabilities.offline ||
    capabilities.maxVoices < palette.profile.maxVoices ||
    capabilities.maxTailSeconds < palette.maxReleaseSeconds
  )
    throw Error("Renderer cannot satisfy palette timing/profile");
  for (const b of palette.bindings)
    if (
      b.rendering !== "synth" && !capabilities.instruments.includes(
        `${b.instrumentId}/${b.articulationId}`,
      )
    )
      throw Error(
        `Missing acoustic binding: ${b.instrumentId}/${b.articulationId}`,
      );
}

/** Own a validated deep-frozen snapshot so later host edits cannot retarget notes. */
export function snapshotInstrumentPalette(
  palette: InstrumentPalette,
): InstrumentPalette {
  validateInstrumentPalette(palette);
  const owned = structuredClone(palette);
  const freeze = (value: unknown): void => {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(owned);
  return owned;
}
