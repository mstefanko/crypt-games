import type { CryptballEvent, Observation } from "./contract";
import type { Seat } from "../protocol";

/** Online snapshots include every participant's events. Only our own confirmed
 * switch disarms our held controls; a peer switching must not release a shot. */
export function ownControlSwitched(events: readonly CryptballEvent[], participantId?: string | null) {
  return events.some(e => e.type === "switch" && (participantId == null || e.participantId === participantId));
}

/** Reserved peers count even while disconnected, matching canSwitch on the
 * authority. A lone local human may select the team's remaining bot athlete. */
export function touchSwitchAvailable(seats: readonly Pick<Seat, "id" | "team">[], participantId: string | null, team: 0 | 1) {
  const teammates = seats.filter(s => s.team === team);
  return teammates.length === 1 && teammates[0]?.id === participantId;
}

/** This mirrors authority eligibility using detached state and reserved seat IDs. */
export function eligibleTouchTeammates(state: Observation, seats: readonly Pick<Seat, "id" | "team" | "playerId">[] | null = null, participantId: string | null = null) {
  const controlled=state.players.find(p=>p.id===state.controlledId);
  if(!controlled)return [];
  if(seats && state.sportId!=="crypt-guardian" && !touchSwitchAvailable(seats,participantId,controlled.team))return [];
  const reserved=new Set((seats??[]).filter(s=>s.id!==participantId).map(s=>s.playerId));
  return state.players.filter(p=>p.id!==controlled.id && !reserved.has(p.id)
    && (state.sportId==="crypt-guardian" || p.team===controlled.team)
    && (state.sportId==="crypt-dodge" ? !!state.dodge?.athletes[p.id]?.lives
      : state.sportId==="crypt-guardian" ? state.guardian?.athletes[p.id]?.status==="active" : p.role!=="keeper"));
}
