import type { ActionInstance } from "@onepage/game-simulation/action-timeline";
export type Team = 0 | 1;
export type SportId =
  | "cryptball"
  | "cryptkick"
  | "rift-volley"
  | "cryptcheck"
  | "crypt-dodge"
  | "crypt-guardian";
export interface HockeySkaterState {
  carryHeading: number;
  receiveUntil: number;
  recaptureUntil: number;
  pokeHeld: boolean;
  checkHeld: boolean;
  check: {
    origin?: CommandOrigin;
    id: number;
    heading: number;
    elapsed: number;
    hits: string[];
  } | null;
  downTicks: number;
  downHeading: number;
}
export interface HockeyState {
  faceoffLead: [string, string];
  checkHits: Record<string, string[]>;
  pokeActions: Record<string, number>;
  skaters: Record<string, HockeySkaterState>;
  aiTeams: [
    {
      collectorId: string | null;
      until: number;
      progressTick: number;
      progressDistance: number;
      approachSide: -1 | 1;
    },
    {
      collectorId: string | null;
      until: number;
      progressTick: number;
      progressDistance: number;
      approachSide: -1 | 1;
    },
  ];
  contestUntil: number;
  contestSide: -1 | 1;
  dropSide: -1 | 0 | 1;
}
export interface VolleyState {
  serveTeam: Team;
  serving: boolean;
  teamContacts: number;
  lastContactId: string | null;
  lastContactTeam: Team | null;
  rally: number;
  contactTick: number;
  serveTicks: number;
}
export interface CommandOrigin {
  epoch: number;
  generation: number;
  participantId: string;
  seq: number;
}
export interface EventOrigin extends CommandOrigin {
  eventKind: string;
  ordinal: number;
}
export interface CommandFrame {
  origin?: CommandOrigin;
  moveX?: number;
  moveY?: number;
  aim?: number;
  pointerAim?: boolean;
  strikePressed?: boolean;
  strikeHeld?: boolean;
  strikeReleased?: boolean;
  pass?: boolean;
  passHeld?: boolean;
  dash?: boolean;
  special?: boolean;
  switch?: boolean;
  switchTarget?: string;
  cancel?: boolean;
  slide?: boolean;
  guard?: boolean; // Legacy input alias.
  check?: boolean;
}
export interface Swing extends ActionInstance {
  origin?: CommandOrigin;
  kind: "strike" | "pass";
  targetId?: string;
  prepareUntil?: number;
}
export interface Player {
  motionOrigin?: CommandOrigin;
  chargeOrigin?: CommandOrigin;
  id: string;
  team: Team;
  role: "field" | "keeper";
  slideTicks: number;
  slideBallHit: boolean;
  slideHeading: number;
  slideRecovery: number;
  slideReady: number;
  actionReady: number;
  archetype: "warrior" | "knight";
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  action: Swing | null;
  chargeTicks: number;
  charging: boolean;
  dashTicks: number;
  dashCooldown: number;
  dashHeading: number;
  checked: boolean;
  staggerTicks: number;
  immunityTicks: number;
  distance: number;
  aiRole: string;
  aiX: number;
  aiY: number;
  aiAim: number;
  aiNext: number;
  roleUntil: number;
  roleTouch: number;
  aiPass: boolean;
  aiSlideStart: number;
  aiSlideUntil: number;
  buffer: {
    origin?: CommandOrigin;
    kind: "strike" | "pass";
    charge: number;
    until: number;
  } | null;
  rx: number;
  ry: number;
}
export interface Ball {
  z: number;
  vz: number;
  rz: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  rx: number;
  ry: number;
  dragCarry: number;
  lastTouch: string | null;
  passFrom: string | null;
  passTarget: string | null;
  passTeam: Team | null;
  passTick: number;
  powerTeam: Team | null;
  powerActionKey: number | null;
  bankBonusRemaining: number;
  powerExpires: number;
}
export interface CryptballEvent {
  origin?: EventOrigin;
  type: string;
  tick: number;
  playerId?: string;
  team?: Team;
  x?: number;
  y?: number;
  [key: string]: unknown;
}
export interface Stats {
  shots: number;
  goals: number;
  passes: number;
}
export interface TeamSpecialState {
  cooldownTicks: number;
  rechargeTicks: number;
  active: {
    origin?: CommandOrigin;
    playerId: string;
    remainingTicks: number;
    elapsedTicks: number;
    heading: number;
    burstStart: number;
    secondBurstAvailable: boolean;
    contactUsed: boolean;
    receptionUsed: boolean;
    stoppedTicks: number;
  } | null;
}
export interface Observation {
  specials: [TeamSpecialState, TeamSpecialState];
  teamIds: import("./team-identities").TeamSelection;
  sportId: SportId;
  possessionId: string | null;
  volley: VolleyState | null;
  hockey: HockeyState | null;
  dodge: import("./modes/crypt-dodge/index").CryptDodgeState | null;
  guardian: import("./modes/crypt-guardian/index").CryptGuardianState | null;
  tick: number;
  mode: "match" | "practice";
  phase: "ready" | "play" | "goal" | "results";
  phaseTicks: number;
  remainingTicks: number;
  overtime: boolean;
  score: [number, number];
  controlledId: string;
  players: Player[];
  ball: Ball;
  stats: Stats;
  winner: Team | "draw" | null;
  restartTeam: Team | null;
  restartProtection: number;
}
export interface Participant {
  id: string;
  team: Team;
  playerId: string;
  active?: boolean;
}
export interface Controller extends Participant {
  active: boolean;
  canSwitch: boolean;
  pendingSwitch: string | null;
  switchReady: number;
  revision: number;
}
export interface Checkpoint {
  version: 16;
  state: State;
  rng: import("@onepage/game-simulation/random").RandomSnapshot;
}
export interface State extends Observation {
  possessionReady: number;
  config: import("./spec").MatchConfig;
  epoch: number;
  nextEvent: number;
  controllers: Controller[];
  teamStats: [Stats, Stats];
  participantStats: Record<string, Stats>;
  pendingSwitch: string | null;
  switchReady: number;
  nextAction: number;
  events: CryptballEvent[];
  goalTeam: Team | null;
  touchTick: number;
}
export type BallPoseSample = Pick<State, "tick" | "sportId" | "phase" | "score" | "ball" | "possessionId" | "restartTeam" | "restartProtection" | "volley">;

export interface CryptballSession {
  step(command?: CommandFrame): void;
  /** Prediction may withhold automatic ownership changes until authority confirms a down/out. */
  stepParticipants(commands?: Record<string, CommandFrame>, policy?: { automaticSwitches?: boolean }): void;
  setParticipants(participants: Participant[]): void;
  setParticipantActive(id: string, active: boolean): void;
  observeFor(participantId: string): Observation;
  getTick(): number;
  /** Detached compact sample for bounded presentation replay, without cloning actors. */
  sampleBallPose(): BallPoseSample;
  getControllerTransfer(id: string): { canSwitch: boolean; pending: boolean } | undefined;
  getControllerRevision(id: string): number | undefined;
  getPhase(): "ready" | "play" | "goal" | "results";
  capture(): Checkpoint;
  restore(checkpoint: unknown): void;
  observe(): Observation;
  drainEvents(): CryptballEvent[];
}
export type GameEvent = CryptballEvent;
