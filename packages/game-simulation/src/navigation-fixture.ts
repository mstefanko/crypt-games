import { canonicalNavigationData } from "./navigation-data";
import { NavigationScheduler } from "./navigation";
import type { NavigationCheckpoint, NavigationState } from "./navigation";

export interface NavigationFixtureState {
  tick: number;
  actor: number;
  routeIndex: number;
  routeId: number;
  moves: number;
  navigation: NavigationState;
}
export interface NavigationFixtureCheckpoint {
  format: "n0-courier-v1";
  state: NavigationFixtureState;
  navigation: NavigationCheckpoint;
}
/** A courier consumes the route and a changing wall invalidates queued work.
 * Fixed original fixture, separate from production game profiles and RTS support. */
export class NavigationFixture {
  private readonly navigation = new NavigationScheduler({
    width: 8,
    height: 8,
    revision: 0,
    costs: Array(64).fill(1),
  });
  private state: NavigationFixtureState;
  constructor() {
    for (let id = 1; id <= 15; id++)
      this.navigation.request({ id, algorithm: "bfs", start: 0, goal: 63 });
    this.state = {
      tick: 0,
      actor: 0,
      routeIndex: 0,
      routeId: 1,
      moves: 0,
      navigation: this.navigation.observe(),
    };
  }
  step(): NavigationFixtureState {
    if (this.state.tick >= 1024) throw Error("Navigation fixture tick cap");
    this.state.tick++;
    // Change the terrain after one move; explicitly request a fresh route.
    if (this.state.tick === 65) {
      const terrain = this.navigation.observe().grid;
      terrain.revision++;
      terrain.costs[2] = 0;
      this.navigation.setTerrain(terrain);
      this.navigation.request({
        id: 16,
        algorithm: "bfs",
        start: this.state.actor,
        goal: 63,
      });
      this.state.routeId = 16;
      this.state.routeIndex = 0;
    }
    const nav = this.navigation.step(1);
    const route = nav.searches.find((s) => s.id === this.state.routeId)!;
    if (
      route.status === "found" &&
      route.terrainRevision === nav.grid.revision
    ) {
      const next = route.path[this.state.routeIndex + 1];
      if (next !== undefined && nav.grid.costs[next] > 0) {
        this.state.actor = next;
        this.state.routeIndex++;
        this.state.moves++;
      }
    }
    this.state.navigation = nav;
    return this.observe();
  }
  observe(): NavigationFixtureState {
    return JSON.parse(JSON.stringify(this.state)) as NavigationFixtureState;
  }
  capture(): NavigationFixtureCheckpoint {
    return {
      format: "n0-courier-v1",
      state: this.observe(),
      navigation: this.navigation.capture(),
    };
  }
  restore(value: unknown): void {
    // Validate the complete envelope before reading any caller-owned properties.
    const normalized = canonicalNavigationData(value);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== 3
    )
      throw Error("Invalid navigation fixture checkpoint");
    const checkpoint = value as NavigationFixtureCheckpoint;
    if (
      checkpoint.format !== "n0-courier-v1" ||
      !checkpoint.state ||
      !Number.isInteger(checkpoint.state.tick) ||
      checkpoint.state.tick < 0 ||
      checkpoint.state.tick > 1024
    )
      throw Error("Invalid navigation fixture state");
    const staged = new NavigationFixture();
    for (let tick = 0; tick < checkpoint.state.tick; tick++) staged.step();
    if (normalized !== canonicalNavigationData(staged.capture()))
      throw Error("Inconsistent navigation fixture checkpoint");
    this.navigation.restore(staged.navigation.capture());
    this.state = staged.state;
  }
}
