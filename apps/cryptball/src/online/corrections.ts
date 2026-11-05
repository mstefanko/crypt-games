import type { Observation } from "../contract";
import { SPORT_BALL_PROFILES } from "../../sim/sports-spec";

type Offset = { x: number; y: number; z?: number };
// Retain only immutable drawing/reset data, rather than cloning action timelines,
// stats, specials and the rest of the world a second time every render frame.
function drawnPose(state: Observation) {
  return {
    sportId: state.sportId,
    phase: state.phase,
    controlledId: state.controlledId,
    possessionId: state.possessionId,
    score: [...state.score],
    volley: state.volley && {
      rally: state.volley.rally,
      serveTeam: state.volley.serveTeam,
      serving: state.volley.serving,
    },
    hockey: state.hockey && {
      faceoffLead: [...state.hockey.faceoffLead],
      dropSide: state.hockey.dropSide,
    },
    players: state.players.map(({ id, x, y }) => ({ id, x, y })),
    ball: { x: state.ball.x, y: state.ball.y, z: state.ball.z },
  };
}
/** Render-only offsets. Keep simulated coordinates for input targeting. */
export class PresentationCorrections {
  private drawn: ReturnType<typeof drawnPose> | null = null;
  private offsets = new Map<string, Offset>();
  private at = 0;
  private identity: string | number | undefined;

  reset() {
    this.drawn = null;
    this.offsets.clear();
    this.identity = undefined;
  }

  /** identity must include epoch and controller ownership/revision. */
  correct(
    next: Observation,
    now: number,
    identity: string | number,
    reset = false,
  ) {
    const previous = this.drawn;
    this.offsets.clear();
    this.at = now;
    const continuous =
      previous &&
      !reset &&
      this.identity === identity &&
      previous.sportId === next.sportId &&
      previous.phase === "play" &&
      next.phase === "play" &&
      previous.controlledId === next.controlledId &&
      previous.possessionId === next.possessionId &&
      previous.score.join() === next.score.join() &&
      previous.volley?.rally === next.volley?.rally &&
      previous.volley?.serveTeam === next.volley?.serveTeam &&
      previous.volley?.serving === next.volley?.serving &&
      previous.hockey?.faceoffLead.join() === next.hockey?.faceoffLead.join() &&
      previous.hockey?.dropSide === next.hockey?.dropSide;
    this.identity = identity;
    if (!continuous) {
      this.drawn = null;
      return;
    }
    // Hockey movement is faster; allow a slightly wider correction before snap.
    const threshold = (next.sportId === "cryptcheck" ? 18 : 12) * 256;
    const add = (key: string, old: Offset, value: Offset) => {
      const offset = {
        x: old.x - value.x,
        y: old.y - value.y,
        z: (old.z ?? 0) - (value.z ?? 0),
      };
      if (Math.hypot(offset.x, offset.y, offset.z) <= threshold)
        this.offsets.set(key, offset);
    };
    for (const player of next.players) {
      const old = previous.players.find((p) => p.id === player.id);
      if (old) add(player.id, old, player);
    }
    add("$ball", previous.ball, next.ball);
  }

  draw(simulated: Observation, now: number, suppress = false): Observation {
    if (suppress) this.offsets.clear();
    const result = structuredClone(simulated);
    const decay = suppress ? 0 : Math.exp(-Math.max(0, now - this.at) / 65);
    for (const player of result.players) {
      const offset = this.offsets.get(player.id);
      if (offset) {
        player.x += Math.round(offset.x * decay);
        player.y += Math.round(offset.y * decay);
      }
    }
    const ball = this.offsets.get("$ball");
    if (ball) {
      result.ball.x += Math.round(ball.x * decay);
      result.ball.y += Math.round(ball.y * decay);
      result.ball.z = Math.max(
        result.sportId === "rift-volley"
          ? SPORT_BALL_PROFILES["rift-volley"].radius * 256
          : 0,
        result.ball.z + Math.round((ball.z ?? 0) * decay),
      );
    }
    this.drawn = drawnPose(result);
    return result;
  }
}
