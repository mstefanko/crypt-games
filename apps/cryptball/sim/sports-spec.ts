import type { SportId } from "./contract";
/** Sport identity is independent from match/practice, renderer and transport. */
export const SPORT_IDS = [
  "cryptball",
  "cryptkick",
  "rift-volley",
  "cryptcheck",
  "crypt-dodge",
  "crypt-guardian",
] as const;
export function isSportId(value: unknown): value is SportId {
  return SPORT_IDS.includes(value as SportId);
}
export interface SportDescriptor {
  id: SportId;
  label: string;
  description: string;
  rules: readonly string[];
  controls: { strike: string; pass: string; dash: string; slide: string };
  scoring: string;
}
export const SPORTS: Readonly<Record<SportId, SportDescriptor>> = Object.freeze(
  {
    "crypt-dodge": {
      id: "crypt-dodge",
      label: "Crypt Dodge",
      description: "Catch, pass and dodge. Three lives. Two balls.",
      rules: [
        "2v2 dodgeball; best of three rounds",
        "Catch on primary press; charge and release while holding",
        "Three dings eliminate an athlete; stay in your half",
        "Pass before the six-second possession deadline",
      ],
      controls: {
        strike: "Catch / throw",
        pass: "Teammate pass",
        dash: "Dash",
        slide: "Diving catch",
      },
      scoring: "90-second rounds; first to two round wins",
    },
    "crypt-guardian": {
      id: "crypt-guardian",
      label: "Crypt Guardian",
      description: "Two allies, two orbs and a guardian of the crypt.",
      rules: [
        "1–2 players cooperate with an allied bot",
        "Throw the orbs into the guardian",
        "Read his weapon, evade attacks and use cover",
        "Hold pass beside a downed ally to revive",
      ],
      controls: {
        strike: "Strike / charge",
        pass: "Pass / revive",
        dash: "Dash",
        slide: "Defensive dive",
      },
      scoring: "Defeat the guardian before the three-minute limit",
    },
    cryptball: {
      id: "cryptball",
      label: "Cryptball",
      description: "Steel, slides and bank shots in the crypt.",
      rules: [
        "2v2 arena combat sport",
        "Strike the orb into the opposing goal",
        "Charge strikes for a powered bank",
      ],
      controls: {
        strike: "Strike / charge",
        pass: "Pass",
        dash: "Dash",
        slide: "Slide block",
      },
      scoring: "90 seconds; sudden death overtime on a tie",
    },
    cryptkick: {
      id: "cryptkick",
      label: "Cryptkick",
      description: "Close control, quick passes and committed tackles.",
      rules: [
        "2v2 soccer with soft possession",
        "Approach a loose ball to trap and dribble",
        "Sprinting exposes the ball; slides knock it loose",
      ],
      controls: {
        strike: "Kick / charge",
        pass: "Pass",
        dash: "Sprint",
        slide: "Slide tackle",
      },
      scoring: "90 seconds; sudden death overtime on a tie",
    },
    cryptcheck: {
      id: "cryptcheck",
      label: "Cryptcheck · Hockey",
      description: "Skate, glide and battle for the puck in the crypt.",
      rules: [
        "2v2 arena hockey",
        "Neutral input coasts; opposite movement brakes",
        "Receive on the stick, pass or charge a slapshot",
        "Whole puck must cross the goal line",
      ],
      controls: {
        strike: "Wrist / slapshot",
        pass: "Push pass",
        dash: "Skate burst",
        slide: "Poke check",
      },
      scoring: "90 seconds; sudden death overtime on a tie",
    },
    "rift-volley": {
      id: "rift-volley",
      label: "Rift Volley",
      description: "Set, attack and dig across the rift.",
      rules: [
        "Clear the net and land the ball on the opposing court",
        "Three team contacts; alternate players",
        "Floor, wall and low net contacts are faults",
        "Attack and set jump automatically when needed",
      ],
      controls: {
        strike: "Serve / attack",
        pass: "Set to teammate",
        dash: "Dash",
        slide: "Low dig",
      },
      scoring: "Rally scoring; first to 11, win by 2, capped at 15",
    },
  },
);
export const VOLLEY_RULES = Object.freeze({
  netHeight: 24,
  gravity: 240,
  target: 11,
  cap: 15,
  serveTimeout: 180,
});

/** Authored pixels; convert once at fixed-point simulation boundaries. */
export const SPORT_BALL_PROFILES = Object.freeze({
  "crypt-dodge": Object.freeze({
    radius: 5,
    rollingDeceleration: 48,
    boardRestitution: 0.45,
    dribbleOffset: 12,
  }),
  "crypt-guardian": Object.freeze({
    radius: 3,
    rollingDeceleration: 30,
    boardRestitution: 0.9,
    dribbleOffset: 11,
  }),
  cryptball: Object.freeze({
    radius: 3,
    rollingDeceleration: 30,
    boardRestitution: 0.9,
    dribbleOffset: 11,
  }),
  cryptkick: Object.freeze({
    radius: 6,
    rollingDeceleration: 36,
    boardRestitution: 0.82,
    dribbleOffset: 14,
  }),
  cryptcheck: Object.freeze({
    radius: 4,
    rollingDeceleration: 12,
    boardRestitution: 0.88,
    dribbleOffset: 14,
  }),
  "rift-volley": Object.freeze({
    radius: 6,
    rollingDeceleration: 0,
    boardRestitution: 0,
    dribbleOffset: 11,
  }),
});
export interface GroundBallPhysics {
  radius: number;
  rollingDeceleration: number;
  boardRestitution: number;
  postRestitution: number;
  bodyRestitution: number;
  restSpeed: number;
  maxSpeed: number;
  wholeObjectGoal: boolean;
  poweredBanks: boolean;
  slideContacts: boolean;
  actorBallNudge: boolean;
  projectActorVelocity: boolean;
  clearDragAtRest: boolean;
}
const GROUND_PHYSICS: Readonly<Record<SportId, GroundBallPhysics>> =
  Object.freeze(
    Object.fromEntries(
      SPORT_IDS.map((id) => {
        const p = SPORT_BALL_PROFILES[id],
          hockey = id === "cryptcheck";
        return [
          id,
          Object.freeze({
            radius: p.radius * 256,
            rollingDeceleration: p.rollingDeceleration * 256,
            boardRestitution: p.boardRestitution,
            postRestitution: hockey ? 0.75 : 0.85,
            bodyRestitution: hockey ? 0.35 : 0.6,
            restSpeed: (hockey ? 1 : 8) * 256,
            maxSpeed: (hockey ? 420 : 380) * 256,
            wholeObjectGoal: hockey,
            poweredBanks: !hockey,
            slideContacts: !hockey,
            actorBallNudge: !hockey,
            projectActorVelocity: hockey,
            clearDragAtRest: hockey,
          }),
        ];
      }),
    ) as Record<SportId, GroundBallPhysics>,
  );
export function groundBallPhysics(sportId: SportId): GroundBallPhysics {
  return GROUND_PHYSICS[sportId];
}
export const LEGACY_BALL_PHYSICS = groundBallPhysics("cryptball");

/** Preserve authored surface clearance when the physical football grows. */
export function groundContactReach(
  sportId: SportId,
  authoredReach: number,
): number {
  return (
    authoredReach +
    (sportId === "cryptkick" ? SPORT_BALL_PROFILES.cryptkick.radius - 4 : 0) *
      256
  );
}

/** Allegiance is mode policy; roster team slots continue to identify seats. */
export function isCooperativeSport(sportId: SportId): boolean {
  return sportId === "crypt-guardian";
}
/** A successful pass can transfer the participant to its receiving athlete. */
export function supportsPassControlTransfer(sportId: SportId): boolean {
  return sportId === "cryptball" || sportId === "cryptkick" || sportId === "cryptcheck";
}
export function sportHasSpecials(sportId: SportId): boolean {
  return false; // Teams are cosmetic across every activity.
}
export function athletesAreAllies(
  sportId: SportId,
  a: { team: number },
  b: { team: number },
): boolean {
  return isCooperativeSport(sportId) || a.team === b.team;
}
