import { BallisticWorld, canonicalBallisticData } from "./ballistics";
import type { BallisticBodyDefinition, BallisticCheckpoint, BallisticConfiguration, BallisticPrediction, BallisticState, BallisticTarget } from "./ballistics";
import type { CircleGeometryShape } from "./circle-geometry";

function targets(): BallisticTarget[] {
  const base = { owner: "fixture-world", category: "world" as const, region: "body" as const, sensor: false, priority: 0, shapeId: "body" };
  return [
    { response: "solid", shape: { ...base, bodyId: "cover", kind: "rect", rect: { x: 2000, y: 0, width: 128, height: 1500 } } },
    { response: "solid", shape: { ...base, bodyId: "floor", kind: "rect", rect: { x: -1000, y: 4000, width: 20000, height: 128 } } },
    { response: "catch", shape: { ...base, bodyId: "catcher", category: "sensor", sensor: true, priority: -1, kind: "circle", circle: { x: 2304, y: 2000, radius: 128 } } },
  ];
}
/** Detached presentation facts. The fixture builds its own original definitions. */
export const BALLISTIC_FIXTURE_SHAPES: readonly CircleGeometryShape[] = Object.freeze(targets().map(t => {
  const s = t.shape;
  return s.kind === "rect" ? Object.freeze({ ...s, rect: Object.freeze({ ...s.rect }) }) : Object.freeze({ ...s, circle: Object.freeze({ ...s.circle }) });
}));
function fixtureConfiguration(): BallisticConfiguration {
  const base = { radius: 24, impact: "stop" as const, restitution: 192, maxBounces: 0, catchable: false };
  const bodies: BallisticBodyDefinition[] = [
    { ...base, id: "arrow-over", x: 0, y: 0, vx: 256, vy: -256 },
    { ...base, id: "arrow-into", x: 0, y: 512, vx: 256, vy: 0 },
    { ...base, id: "throw-catch", x: 0, y: 3000, vx: 256, vy: -192, catchable: true },
    { ...base, id: "bounce", x: 4000, y: 3000, vx: 96, vy: 128, impact: "bounce", maxBounces: 3 },
  ];
  return { acceleration: { x: 0, y: 16 }, bodies, targets: targets() };
}
export type BallisticFixtureState = BallisticState;
export interface BallisticFixtureCheckpoint {
  readonly format: "p1-ballistic-fixture-v1";
  readonly world: BallisticCheckpoint;
}
/** Four independent bodies prove cover clearance, impact, catch and termination.
 * This finite P1 fixture is separate from production combat or a general solver. */
export class BallisticFixture {
  private readonly world = new BallisticWorld(fixtureConfiguration());
  step(): BallisticFixtureState { return this.world.step(); }
  observe(): BallisticFixtureState { return this.world.observe(); }
  capture(): BallisticFixtureCheckpoint { return { format: "p1-ballistic-fixture-v1", world: this.world.capture() }; }
  restore(value: unknown): void {
    canonicalBallisticData(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== 2 || !Object.hasOwn(value, "format") || !Object.hasOwn(value, "world")) throw Error("Invalid ballistic fixture checkpoint");
    const source = value as BallisticFixtureCheckpoint;
    if (source.format !== "p1-ballistic-fixture-v1") throw Error("Incompatible ballistic fixture checkpoint");
    this.world.restore(source.world);
  }
  predict(ticks: number): BallisticPrediction { return this.world.predict(ticks); }
}
