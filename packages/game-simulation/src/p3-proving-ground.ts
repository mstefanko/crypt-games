import { queryCircleGeometry } from "./circle-geometry";
import { canonicalBallisticData } from "./ballistics";
import {
  prepareP3HeightField,
  P3SlopeWorld,
  p3Integer,
  P3_LIMITS,
} from "./p3-surfaces";
import type {
  P3HeightField,
  P3PreparedHeightField,
  P3SlopeCheckpoint,
  P3MotorCommand,
} from "./p3-surfaces";

const DIRECTIONS = [
  [256, 0],
  [181, 181],
  [0, 256],
  [-181, 181],
  [-256, 0],
  [-181, -181],
  [0, -256],
  [181, -181],
] as const;
export interface P3Vehicle {
  id: string;
  x: number;
  y: number;
  heading: number;
  forward: number;
  lateral: number;
  health: number;
  status: "driving" | "wreck";
  height: number;
}
export interface P3Throw {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  status: "flying" | "landed" | "caught";
}
export interface P3Catcher {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly reach: number;
}
export interface P3Configuration {
  readonly field: P3HeightField;
  readonly vehicles: readonly P3Vehicle[];
  readonly ball: P3Throw;
  readonly catchers: readonly P3Catcher[];
}
export interface P3VehicleCommand {
  readonly throttle: number;
  readonly brake: boolean;
  readonly steer: number;
  readonly damage: number;
}
export interface P3Command {
  readonly vehicles: readonly P3VehicleCommand[];
}
export interface P3State {
  tick: number;
  vehicles: P3Vehicle[];
  ball: P3Throw;
}
export interface P3Checkpoint {
  readonly format: "p3-proving-ground-v1";
  readonly configuration: P3Configuration;
  readonly commands: readonly P3Command[];
  readonly state: P3State;
}
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
function keys(v: object, expected: string): void {
  if (Object.keys(v).sort().join() !== expected) throw Error("P3 fields");
}
function validateBall(b: P3Throw, field: P3PreparedHeightField): void {
  keys(b, "status,vx,vy,vz,x,y,z");
  field.sample(b.x, b.y);
  for (const v of [b.vx, b.vy]) p3Integer(v, -128, 128);
  p3Integer(b.vz, -256, 256);
  p3Integer(b.z, 0, 16384);
  if (
    !["flying", "landed", "caught"].includes(b.status) ||
    b.z < field.sample(b.x, b.y).height
  )
    throw Error("Invalid P3 throw");
  if (b.status !== "flying" && (b.vx !== 0 || b.vy !== 0 || b.vz !== 0))
    throw Error("Inactive P3 throw velocity");
}
function validateConfig(
  c: P3Configuration,
  field: P3PreparedHeightField,
): void {
  canonicalBallisticData(c);
  keys(c, "ball,catchers,field,vehicles");

  if (
    !Array.isArray(c.vehicles) ||
    c.vehicles.length > 2 ||
    !Array.isArray(c.catchers) ||
    c.catchers.length > 4
  )
    throw Error("P3 body cap");
  const ids = new Set<string>();
  for (const v of c.vehicles) {
    keys(v, "forward,heading,health,height,id,lateral,status,x,y");
    if (
      typeof v.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,32}$/.test(v.id) ||
      ids.has(v.id)
    )
      throw Error("P3 vehicle identity");
    ids.add(v.id);
    p3Integer(v.heading, 0, 7);
    p3Integer(v.forward, -128, 256);
    p3Integer(v.lateral, -64, 64);
    p3Integer(v.health, 0, 100);
    if (
      v.height !== field.sample(v.x, v.y).height ||
      (v.status !== "wreck" && v.status !== "driving") ||
      (v.health === 0) !== (v.status === "wreck") ||
      (v.status === "wreck" && (v.forward !== 0 || v.lateral !== 0))
    )
      throw Error("P3 vehicle state");
  }
  if (
    c.vehicles.length === 2 &&
    (c.vehicles[0].x - c.vehicles[1].x) ** 2 +
      (c.vehicles[0].y - c.vehicles[1].y) ** 2 <
      256 ** 2
  )
    throw Error("P3 chassis overlap");
  validateBall(c.ball, field);
  c.catchers.forEach((k) => {
    keys(k, "radius,reach,x,y");
    field.sample(k.x, k.y);
    p3Integer(k.radius, 1, 512);
    p3Integer(k.reach, 0, 512);
  });
}
function validateCommand(command: P3Command, count: number): void {
  canonicalBallisticData(command);
  keys(command, "vehicles");
  if (!Array.isArray(command.vehicles) || command.vehicles.length !== count)
    throw Error("P3 commands count");
  command.vehicles.forEach((c) => {
    keys(c, "brake,damage,steer,throttle");
    p3Integer(c.throttle, -1, 1);
    p3Integer(c.steer, -1, 1);
    p3Integer(c.damage, 0, 100);
    if (typeof c.brake !== "boolean") throw Error("P3 brake");
  });
}
function stepBall(
  c: P3Configuration,
  field: P3PreparedHeightField,
  initial: P3Throw,
): P3Throw {
  const b = copy(initial);
  if (b.status !== "flying") return b;
  // Four bounded substeps; quantized velocity starts are divisible through carries
  // by using endpoint interpolation from this tick's discrete ballistic segment.
  const vz = Math.max(-512, b.vz - 16);
  for (let s = 1; s <= 4; s++) {
    const x = initial.x + Math.trunc((initial.vx * s) / 4),
      y = initial.y + Math.trunc((initial.vy * s) / 4),
      z = initial.z + Math.trunc((vz * s) / 4);
    if (
      x < 0 ||
      y < 0 ||
      x > (c.field.columns - 1) * c.field.pitch ||
      y > (c.field.rows - 1) * c.field.pitch
    ) {
      const ground = field.sample(b.x, b.y).height;
      return { ...b, z: ground, vx: 0, vy: 0, vz: 0, status: "landed" };
    }
    const ground = field.sample(x, y).height;
    if (z >= 16384)
      return { x, y, z: 16384, vx: b.vx, vy: b.vy, vz: 0, status: "flying" };
    for (const k of c.catchers)
      if (
        (x - k.x) ** 2 + (y - k.y) ** 2 <= k.radius ** 2 &&
        z >= ground &&
        z <= ground + k.reach &&
        vz <= 0
      )
        return { x, y, z, vx: 0, vy: 0, vz: 0, status: "caught" };
    if (z <= ground)
      return { x, y, z: ground, vx: 0, vy: 0, vz: 0, status: "landed" };
    b.x = x;
    b.y = y;
    b.z = z;
  }
  b.vz = vz;
  p3Integer(b.vz, -512, 256);
  p3Integer(b.z, 0, 16384);
  return b;
}
function advance(
  c: P3Configuration,
  field: P3PreparedHeightField,
  state: P3State,
  command: P3Command,
): P3State {
  validateCommand(command, state.vehicles.length);
  if (state.tick >= P3_LIMITS.ticks) throw Error("P3 tick cap");
  const next = copy(state);
  next.tick++;
  next.vehicles.forEach((v, i) => {
    const input = command.vehicles[i];
    v.health = Math.max(0, v.health - input.damage);
    if (v.health === 0) {
      v.status = "wreck";
      v.forward = v.lateral = 0;
      return;
    }
    const old = state.vehicles[i];
    // Eight authored headings avoid platform-dependent trigonometry. Steering
    // quantizes one octant per tick; radius-128 chassis uses the P1 sweep.
    if (v.forward !== 0) v.heading = (v.heading + input.steer + 8) % 8;
    const [dx, dy] = DIRECTIONS[v.heading],
      sample = field.sample(v.x, v.y);
    const grade = Math.trunc(
      (sample.gradientX * dx + sample.gradientY * dy) / 256,
    );
    const drive = input.throttle * (v.health < 50 ? 6 : 12);
    const rollingSpeed =
      Math.sign(v.forward) * Math.max(0, Math.abs(v.forward) - 2);
    v.forward = Math.max(
      -128,
      Math.min(
        v.health < 50 ? 128 : 256,
        rollingSpeed + drive - Math.trunc(grade / 8),
      ),
    );
    if (input.brake)
      v.forward = Math.sign(v.forward) * Math.max(0, Math.abs(v.forward) - 24);
    v.lateral = Math.trunc(
      (v.lateral * (v.health < 50 ? 7 : 3)) / (v.health < 50 ? 8 : 4),
    );
    v.forward = v.forward || 0;
    v.lateral = v.lateral || 0;
    const x = v.x + Math.trunc((v.forward * dx - v.lateral * dy) / 256),
      y = v.y + Math.trunc((v.forward * dy + v.lateral * dx) / 256);
    if (
      x < 0 ||
      y < 0 ||
      x > (c.field.columns - 1) * c.field.pitch ||
      y > (c.field.rows - 1) * c.field.pitch
    ) {
      v.forward = v.lateral = 0;
      v.x = old.x;
      v.y = old.y;
    } else {
      const targets = next.vehicles
        .filter((_, j) => j !== i)
        .map((other) => ({
          bodyId: other.id,
          shapeId: "chassis",
          owner: "p3",
          category: "actor" as const,
          region: "body" as const,
          sensor: false,
          priority: 0,
          kind: "circle" as const,
          circle: { x: other.x, y: other.y, radius: 128 },
        }));
      const contact = queryCircleGeometry(targets, {
        kind: "sweep",
        circle: { x: v.x, y: v.y, radius: 128 },
        delta: { x: x - v.x, y: y - v.y },
      }).contacts[0];
      if (contact) {
        v.forward = v.lateral = 0;
      } else {
        v.x = x;
        v.y = y;
      }
    }
    v.height = field.sample(v.x, v.y).height;
  });
  next.ball = stepBall(c, field, next.ball);
  return next;
}
/** Finite deterministic command-history proof. Restore replays at most 256 ticks
 * into a disposable candidate and compares every state byte before publication. */
export class P3ProvingGround {
  private readonly configuration: P3Configuration;
  private field: P3PreparedHeightField;
  private state: P3State;
  private commands: P3Command[] = [];
  constructor(configuration: P3Configuration = P3_FIXTURE) {
    canonicalBallisticData(configuration);
    this.field = prepareP3HeightField(configuration.field);
    validateConfig(configuration, this.field);
    this.configuration = copy(configuration);
    this.state = {
      tick: 0,
      vehicles: copy(configuration.vehicles) as P3Vehicle[],
      ball: copy(configuration.ball),
    };
  }
  observe(): P3State {
    return copy(this.state);
  }
  step(
    command: P3Command = {
      vehicles: this.state.vehicles.map(() => ({
        throttle: 1,
        brake: false,
        steer: 0,
        damage: 0,
      })),
    },
  ): P3State {
    const next = advance(this.configuration, this.field, this.state, command);
    this.commands.push(copy(command));
    this.state = next;
    return this.observe();
  }
  capture(): P3Checkpoint {
    return {
      format: "p3-proving-ground-v1",
      configuration: copy(this.configuration),
      commands: copy(this.commands),
      state: this.observe(),
    };
  }
  restore(value: unknown): void {
    const canonical = canonicalBallisticData(value),
      c = value as P3Checkpoint;
    keys(c, "commands,configuration,format,state");
    if (
      c.format !== "p3-proving-ground-v1" ||
      canonicalBallisticData(c.configuration) !==
        canonicalBallisticData(this.configuration) ||
      !Array.isArray(c.commands) ||
      c.commands.length > 256
    )
      throw Error("Incompatible P3 checkpoint");
    const candidate = new P3ProvingGround(this.configuration);
    for (const command of c.commands) candidate.step(command);
    if (canonicalBallisticData(candidate.capture()) !== canonical)
      throw Error("Inconsistent P3 checkpoint");
    this.state = candidate.state;
    this.commands = candidate.commands;
    this.field = candidate.field;
  }
  observeWork(): { validations: number; samples: number; heightReads: number } {
    return this.field.work();
  }
  predictThrow(ticks: number): P3Throw[] {
    p3Integer(ticks, 0, 256);
    let b = copy(this.state.ball);
    const states: P3Throw[] = [];
    for (let i = 0; i < ticks; i++) {
      b = stepBall(this.configuration, this.field, b);
      states.push(copy(b));
    }
    return states;
  }
}
/** Stage both clocks and the entire batch. The caller publishes the returned pair
 * only after success; rejected commands/horizon leave both inputs untouched. */
export function stageP3ProofBatch(
  ground: P3ProvingGround,
  slope: P3SlopeWorld,
  ticks: number,
  command: P3Command = {
    vehicles: ground
      .observe()
      .vehicles.map(() => ({ throttle: 1, brake: false, steer: 0, damage: 0 })),
  },
  motor: P3MotorCommand = { move: 128, jump: false, drop: false },
): { ground: P3ProvingGround; slope: P3SlopeWorld } {
  p3Integer(ticks, 0, 256);
  const g = ground.capture(),
    s = slope.capture();
  if (g.state.tick + ticks > 256 || s.commands.length + ticks > 256)
    throw Error("P3 batch tick cap");
  const candidate = restoreP3ProofPair(g, s);
  for (let i = 0; i < ticks; i++) {
    candidate.ground.step(command);
    candidate.slope.step(motor);
  }
  return candidate;
}
export function restoreP3ProofPair(
  ground: P3Checkpoint,
  slope: P3SlopeCheckpoint,
): { ground: P3ProvingGround; slope: P3SlopeWorld } {
  // Validate before reading checkpoint configuration, even at this helper boundary.
  canonicalBallisticData(ground);
  canonicalBallisticData(slope);
  const g = new P3ProvingGround(ground.configuration),
    s = new P3SlopeWorld(slope.slopes, slope.initial);
  g.restore(ground);
  s.restore(slope);
  return { ground: g, slope: s };
}
export const P3_FIXTURE: P3Configuration = {
  field: {
    columns: 9,
    rows: 3,
    pitch: 2048,
    heights: Array.from({ length: 27 }, (_, i) => (i % 9) * 256),
  },
  vehicles: [
    {
      id: "car-a",
      x: 1024,
      y: 1024,
      heading: 0,
      forward: 0,
      lateral: 0,
      health: 100,
      status: "driving",
      height: 128,
    },
    {
      id: "car-b",
      x: 1024,
      y: 3072,
      heading: 0,
      forward: 0,
      lateral: 0,
      health: 100,
      status: "driving",
      height: 128,
    },
  ],
  ball: { x: 1024, y: 2048, z: 1024, vx: 64, vy: 0, vz: 128, status: "flying" },
  catchers: [{ x: 2048, y: 2048, radius: 256, reach: 512 }],
};
