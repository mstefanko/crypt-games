import type { CryptballSession, MatchConfig } from "../sim/contract";
export interface LabOptions {
  seed?: number;
  ticks?: number;
  halfLength?: number;
  halfWidth?: number;
  config?: Partial<Omit<MatchConfig, "version">>;
}
export interface LabMetrics {
  seed: number;
  requestedTicks: number;
  elapsedTicks: number;
  playTicks: number;
  roster: { id: string; team: number; role: string }[];
  score: number[];
  sampleSize: number;
  halfLengthPx: number;
  config: LabOptions["config"] | null;
  heatmap: { columns: number; rows: number; counts: number[] };
  raw: {
    speedSum: number;
    emptyTicks: number;
    possessionChanges: number;
    thirds: number[];
    touches: Record<string, number>;
    idle: Record<string, number>;
    rallies: number[];
  };
  goalsPerMinute: number;
  shots: number;
  shotsPerMinute: number;
  timeToFirstShotSeconds: number | null;
  meanBallSpeedPxPerSecond: number;
  ballThirdFractions: number[];
  emptyRunningFraction: number;
  possessionChangesPerMinute: number;
  touchChangesPerMinute: Record<string, number>;
  idleSeconds: Record<string, number>;
  slides: number;
  slideContacts: number;
  meanCompletedRallySeconds: number | null;
  shotsOnTarget: null;
  savePercentage: null;
  slideWhiffs: number;
  slideOutcomes: {
    attempts: number;
    intercepts: number;
    contacts: number;
    whiffs: number;
    pendingAttempts: number;
    interceptFraction: number | null;
    whiffsWithFullTwoSecondWindow: number;
    whiffsConcedingWithinTwoSeconds: number;
    whiffPenaltyFraction: number | null;
    censoredWhiffWindows: number;
  };
}
export function runMatch(
  createSession: (options?: {
    seed?: number;
    config?: LabOptions["config"];
  }) => CryptballSession,
  options?: LabOptions,
): LabMetrics;
