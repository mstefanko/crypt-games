/** Versioned authored pixels; simulation converts to fixed point at its boundary. */
export const SPEC_VERSION = 4;
export const COURT = Object.freeze({
  halfLength: 166,
  halfWidth: 96,
  boardThickness: 10,
  goalHalfMouth: 30,
  goalLine: 169,
  postRadius: 3,
  netDepth: 12,
  creaseDepth: 44,
  creaseHalfWidth: 54,
});
export const ROSTER = Object.freeze({
  teamSize: 2,
  playerCount: 4,
  roles: ["field", "field"] as const,
  seatOrder: [0, 2, 1, 3] as const,
});
export const TUNING = Object.freeze({
  version: 4,
  slideTicks: 18,
  diveTicks: 14,
  slideRecovery: 15,
  slideReuse: 66,
  actionLockout: 20,
  slideLaunchSpeed: 300,
  slideEndSpeed: 120,
});

export interface MatchConfig {
  version: 4;
  slideLaunchSpeed: number;
  slideEndSpeed: number;
}
export function matchConfig(
  overrides: Partial<Omit<MatchConfig, "version">> = {},
): MatchConfig {
  const config = {
    version: 4 as const,
    slideLaunchSpeed: 300,
    slideEndSpeed: 120,
    ...overrides,
  };
  validateMatchConfig(config);
  return Object.freeze(config);
}
export function validateMatchConfig(
  value: unknown,
): asserts value is MatchConfig {
  const c = value as MatchConfig;
  if (
    !c ||
    Object.keys(c).sort().join(",") !==
      "slideEndSpeed,slideLaunchSpeed,version" ||
    c.version !== 4 ||
    !Number.isSafeInteger(c.slideLaunchSpeed) ||
    c.slideLaunchSpeed < 120 ||
    c.slideLaunchSpeed > 380 ||
    !Number.isSafeInteger(c.slideEndSpeed) ||
    c.slideEndSpeed < 40 ||
    c.slideEndSpeed > c.slideLaunchSpeed
  )
    throw Error("Invalid match config");
}
