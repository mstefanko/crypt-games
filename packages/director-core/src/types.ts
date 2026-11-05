/** Portable director contracts. Integer ticks at 60 Hz; no executable asset data.
 * Shot.start and AudioCue.start are scene-global. Motion.start, Dialogue.start,
 * and CameraKey.start are local to their referenced shot. Durations are tick counts.
 * Absolute track time = referenced shot.start + track.start.
 */
export type StyleId = "8-bit" | "16-bit" | "realistic";
export type Weather = "clear" | "rain" | "storm";
export interface Point {
  x: number;
  y: number;
}
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Frame hold in integer 60 Hz ticks. */ duration: number;
  sockets?: Record<string, Point>;
}
export interface Clip {
  name: string;
  frames: number[];
  loop: boolean;
  /** Import/default-rate metadata; frame durations govern playback. */ fps: number;
}
export interface AssetVariant {
  id: string;
  name: string;
  style: StyleId;
  revision: number;
  mediaId?: string;
  frames: Frame[];
  clips: Clip[];
  sockets: Record<string, Point>;
  logicalHeight: number;
  ready: boolean;
  missing?: string[];
  renderKey?: string; // Bounded built-in fixture renderer identifier, never script.
}
export interface AssetFamily {
  id: string;
  name: string;
  kind: "character" | "set" | "prop" | "audio";
  variants: AssetVariant[];
  source: string;
  license: string;
  author?: string;
  packId?: string;
}
export interface MediaResource {
  id: string;
  name: string;
  mime: string;
  dataUrl: string;
  source: string;
  license: string;
  author?: string;
}
export interface PackManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  author: string;
  license: string;
  source: string;
  assets: AssetFamily[];
  media: MediaResource[];
}
export interface Shot {
  id: string;
  name: string;
  start: number;
  duration: number;
  environment?: Partial<Environment>;
}
export interface Actor {
  id: string;
  name: string;
  familyId: string;
  x: number;
  y: number;
  scale: number;
  variantId?: string;
}
export type LayerKind =
  | "sky"
  | "facade"
  | "platform"
  | "lamp"
  | "foreground"
  | "rain-back"
  | "rain-front"
  | "mist";
export interface Layer {
  id: string;
  name: string;
  kind: LayerKind;
  x: number;
  y: number;
  z: number;
  visible: boolean;
  output: boolean;
  opacity: number;
  manualOverride?: boolean;
  familyId?: string;
}
export interface Motion {
  id: string;
  shotId: string;
  actorId: string;
  action: string;
  start: number;
  duration: number;
  from: Point;
  to: Point;
  ease: "linear" | "ease-out";
  endLink?: string;
}
export interface Dialogue {
  id: string;
  shotId: string;
  actorId: string;
  text: string;
  start: number;
  duration: number;
  revealRate: number;
  waitForInput: boolean;
  voiceMediaId?: string;
  transcript?: string;
  voiceNeedsReview: boolean;
  style: "bubble" | "caption" | "portrait" | "title";
}
export interface CameraKey {
  id: string;
  shotId: string;
  start: number;
  duration: number;
  from: Point;
  to: Point;
  zoom: number;
  /** Optional starting zoom, defaulting to zoom for legacy constant zoom keys. */ fromZoom?: number;
}
export interface AudioCue {
  id: string;
  kind: "music" | "voice" | "sfx" | "ambience";
  start: number;
  duration: number;
  mediaId?: string;
  title: string;
  volume: number;
}
export interface Environment {
  weather: Weather;
  timeOfDay: "night" | "day";
  frontRain: number;
  backRain: number;
  lantern: number;
  wetness: number;
  ambience: boolean;
  abandoned: boolean;
}
export interface PreservationLock {
  id: string;
  target: CommandTarget;
  targetId?: string;
  property: string;
  label: string;
}
export interface SceneDocument {
  schemaVersion: 1;
  id: string;
  revision: number;
  title: string;
  width: number;
  height: number;
  fps: 60;
  style: StyleId;
  brief: string;
  shots: Shot[];
  actors: Actor[];
  layers: Layer[];
  motions: Motion[];
  dialogue: Dialogue[];
  camera: CameraKey[];
  audio: AudioCue[];
  environment: Environment;
  locks: PreservationLock[];
  assets: AssetFamily[];
  media: MediaResource[];
  slot: { id: string; name: string; onComplete: string; onSkip: string };
}
export type CommandTarget =
  | "scene"
  | "actor"
  | "layer"
  | "motion"
  | "dialogue"
  | "shot"
  | "environment"
  | "camera"
  | "audio";
export interface SceneCommand {
  type: "set";
  target: CommandTarget;
  targetId?: string;
  property: string;
  value: unknown;
}
export interface Diagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
  targetId?: string;
}
export interface Candidate {
  id: string;
  name: string;
  base: SceneDocument;
  commands: SceneCommand[];
  createdAt: string;
  source: "manual" | "agent";
  diagnostics: Diagnostic[];
}
export interface MergeConflict {
  key: string;
  command: SceneCommand;
  baseValue: unknown;
  currentValue: unknown;
  proposedValue: unknown;
  reason: string;
}
export interface MergeResult {
  scene: SceneDocument;
  conflicts: MergeConflict[];
  diagnostics: Diagnostic[];
  applied: SceneCommand[];
}
export interface EvaluatedActor extends Actor {
  action: string;
  phase: number;
  variant?: AssetVariant;
  frameIndex: number;
}
export interface EvaluatedFrame {
  tick: number;
  shot?: Shot;
  actors: EvaluatedActor[];
  dialogue?: Dialogue;
  revealedText: string;
  environment: Environment;
  camera: { x: number; y: number; zoom: number };
  gate?: string;
}
export interface Coverage {
  familyId: string;
  name: string;
  variantId?: string;
  ready: boolean;
  missing: string[];
}
