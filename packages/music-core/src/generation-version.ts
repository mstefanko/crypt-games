import { sha256Content } from "./generation-hash";
/** Manual algorithm identity, deliberately independent of source bytes, formatting
 * and checkout line endings. Bump this identity and recipe version together for
 * changes to generation, validation or provenance semantics. This is not a source
 * integrity hash; reviewed fixtures pin realized Score/provenance behavior. */
export const MUSIC_GENERATOR_IDENTITY =
  "pocket-score/music-g0/symbolic-g0-v2/algorithm-v2";
export const MUSIC_GENERATOR_SOURCE = `sha256:${sha256Content(MUSIC_GENERATOR_IDENTITY)}`;
