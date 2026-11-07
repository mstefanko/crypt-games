import type { SportId } from "./sim/contract";
import type { RoomPhase } from "./protocol";
export type CourtIntent = "play" | "watch" | "queue";
export interface CourtMember {
  memberId: string;
  name: string;
  connected: boolean;
}
export interface FriendsDirectory {
  groupKey: string;
  revision: number;
  members: { memberId: string; name: string }[];
  courts: {
    courtId: string;
    number: number;
    watcherCapacity: number;
    sportId: SportId;
    phase: RoomPhase;
    capacity: number;
    spectators: number;
    watchers: CourtMember[];
    participants: CourtMember[];
  }[];
}
export interface FriendsCourtRequest {
  requestId: string;
  sportId: SportId;
  courtId?: string;
  intent: CourtIntent;
  newCourt?: boolean;
}
export interface FriendsDirectoryError {
  requestId?: string;
  message: string;
}
