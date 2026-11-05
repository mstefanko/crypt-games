/** Executable evidence uses the campaign authority; no second movement model. */
import { boundedJSON, canonical, integer } from "@onepage/game-project/runtime";
import type {
  CompatibilityIdentity,
  GameDefinitions,
  Rect,
  LevelDefinition,
} from "@onepage/game-project/runtime";
import {
  CampaignPlatformOwner,
  copyCampaignPlainData,
  type CampaignPlatformCommand,
  type CampaignPlatformDefinition,
} from "./campaign-platform";
import { sha256Content } from "./content-hash";
import {
  PLATFORM_WORLD_LIMITS,
  type PlatformTraversalCertificate,
  type PlatformRouteDescriptor,
} from "./platform-world-types";

export interface PlatformContent {
  definitions: GameDefinitions;
  campaign: CampaignPlatformDefinition;
  identity: CompatibilityIdentity;
}
/** Chunked hashes keep the shared SHA primitive's bounded input contract. */
export function platformDigest(value: unknown): string {
  const bytes = canonical(copyCampaignPlainData(value, 262144));
  boundedJSON(bytes, PLATFORM_WORLD_LIMITS.realizationBytes);
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += 32768)
    chunks.push(sha256Content(bytes.slice(start, start + 32768)));
  return `sha256:${sha256Content(canonical(chunks))}`;
}
/** Conservative projection: unknown authoritative fields remain included. Only the
 * manifest's explicitly display-only title is excluded; editor data lives outside. */
export function platformSemanticDigest(content: PlatformContent): string {
  const definitions = copyCampaignPlainData(
    content.definitions,
    262144,
  ) as GameDefinitions;
  const manifest = { ...definitions.manifest, title: "" };
  return platformDigest({
    projection: "platform-semantic-v1",
    rulesBuildId: content.identity.rulesBuildId,
    definitions: { ...definitions, manifest },
    campaign: content.campaign,
  });
}
export class PlatformWorkBudget {
  ticks = 0;
  selections = 0;
  backtracks = 0;
  constructor(
    readonly limit: number = PLATFORM_WORLD_LIMITS.requestTicks,
    readonly cancelled: () => boolean = () => false,
  ) {
    integer(limit, 0, PLATFORM_WORLD_LIMITS.requestTicks);
  }
  charge(ticks = 1): void {
    integer(ticks, 0, PLATFORM_WORLD_LIMITS.requestTicks);
    if (this.cancelled()) throw Error("cancelled");
    if (this.ticks + ticks > this.limit)
      throw Error("no-witness-within-budget");
    this.ticks += ticks;
  }
  select(): void {
    this.charge(0);
    if (++this.selections > PLATFORM_WORLD_LIMITS.selectionChecks)
      throw Error("selection-budget-exhausted");
  }
}
export function recordPlatformCommand(
  tape: PlatformTraversalCertificate["tape"],
  command: CampaignPlatformCommand,
): void {
  const last = tape.at(-1);
  if (
    command.kind === "frame" &&
    last?.command.kind === "frame" &&
    canonical(last.command) === canonical(command)
  )
    last.repeat++;
  else tape.push({ command: JSON.parse(canonical(command)), repeat: 1 });
}
function inside(
  a: { x: number; y: number; width: number; height: number },
  r: Rect,
): boolean {
  return (
    a.x >= r.x &&
    a.y >= r.y &&
    a.x + a.width <= r.x + r.width &&
    a.y + a.height <= r.y + r.height
  );
}
function endpoint(
  owner: CampaignPlatformOwner,
  destination: PlatformTraversalCertificate["destination"],
): void {
  const observation = owner.observation();
  const actor = observation.platform.actors.find((a) => a.slot === 0);
  if (
    observation.roomId !== destination.roomId ||
    observation.platform.status !== "playing" ||
    !actor ||
    actor.health <= 0 ||
    !actor.grounded ||
    !inside(actor, destination.region) ||
    destination.requiredOutcomes.some(
      (id) => !observation.transactions.outcomes.includes(id),
    )
  )
    throw Error("unsafe-or-incomplete-destination");
}
/** Actual support span at a witnessed landing, clipped by blocking obstacles.
 * This is measured recovery space, not a promise about every player timing. */
function landingWidth(
  level: LevelDefinition,
  actor: Rect,
  platforms: readonly Rect[],
): number {
  const feet = actor.y + actor.height,
    center = actor.x + actor.width / 2;
  const supports = [...level.rectangles, ...platforms].filter(
    (r) => r.y === feet && center >= r.x && center < r.x + r.width,
  );
  if (supports.length) return Math.max(...supports.map((r) => r.width));
  const size = level.tileSize * 256,
    columns = level.width / level.tileSize,
    row = Math.floor(feet / size),
    col = Math.floor(center / size);
  const solid = (c: number) =>
    c >= 0 && c < columns && [1, 2].includes(level.tiles[row * columns + c]);
  if (!solid(col)) return actor.width;
  let left = col,
    right = col;
  while (solid(left - 1)) left--;
  while (solid(right + 1)) right++;
  let start = left * size,
    end = (right + 1) * size;
  for (const r of level.rectangles)
    if (!r.oneWay && r.y < feet && r.y + r.height > actor.y) {
      if (r.x + r.width <= center) start = Math.max(start, r.x + r.width);
      else if (r.x >= center) end = Math.min(end, r.x);
    }
  return Math.max(0, end - start);
}
export type PlatformReplayObservation = ReturnType<
  CampaignPlatformOwner["observation"]
>;
export interface PlatformReplayStep {
  command: CampaignPlatformCommand;
  before: PlatformReplayObservation;
  after: PlatformReplayObservation;
  commandIndex: number;
  tick: number;
}
export interface PlatformReplayOptions {
  onStep?: (step: PlatformReplayStep) => void;
}
export function replayPlatformTape(
  content: PlatformContent,
  tape: PlatformTraversalCertificate["tape"],
  budget = new PlatformWorkBudget(),
  options: PlatformReplayOptions = {},
) {
  const owner = new CampaignPlatformOwner(
    content.definitions,
    content.identity,
    content.campaign,
    { onSimulationTick: () => budget.charge() },
  );
  let ticks = 0,
    commands = 0;
  let distance = 0,
    waitRideTicks = 0,
    recoveryWidth = Number.MAX_SAFE_INTEGER;
  let lastVerticalDelta = 0;
  const beats: PlatformRouteDescriptor["beats"] = [];
  const visited = [
    content.campaign.rooms.findIndex(
      (r) => r.id === content.campaign.initialRoom,
    ),
  ];
  const milestones: PlatformTraversalCertificate["milestones"] = [];
  if (!Array.isArray(tape) || tape.length > 18000)
    throw Error("certificate-tape-cap");
  for (const entry of tape) {
    integer(entry.repeat, 1, PLATFORM_WORLD_LIMITS.routeTicks);
    if (entry.command.kind !== "frame" && entry.repeat !== 1)
      throw Error("non-frame-repeat");
    for (let i = 0; i < entry.repeat; i++) {
      if (++commands > 20000) throw Error("certificate-command-cap");
      if (entry.command.kind === "frame") {
        if (++ticks > PLATFORM_WORLD_LIMITS.routeTicks)
          throw Error("route-tick-cap");
        budget.charge(0);
      } else budget.charge(0);
      const before = owner.observation();
      try {
        owner.execute(entry.command);
      } catch (error) {
        throw new PlatformReplayFailure(String(error), commands, ticks);
      }
      const after = owner.observation();
      options.onStep?.({
        command: entry.command,
        before,
        after,
        commandIndex: commands,
        tick: ticks,
      });
      if (entry.command.kind === "frame") {
        const a = before.platform.actors.find((a) => a.slot === 0)!;
        const b = after.platform.actors.find((a) => a.slot === 0)!;
        const horizontal = Math.abs(b.x - a.x),
          vertical = b.y - a.y;
        distance += horizontal;
        const input = entry.command.input.slots.find((s) => s.slot === 0);
        const pressed = (name: string) =>
          input?.edges.some((e) => e.action === name && e.kind === "pressed");
        if (
          b.platformMotion?.ignoredSupportId &&
          !a.platformMotion?.ignoredSupportId
        )
          beats.push("drop");
        if (vertical < 0 && lastVerticalDelta >= 0 && !b.grounded)
          beats.push("jump");
        const profile = content.definitions.archetypes.find(
          (p) => p.id === b.archetypeId,
        )!;
        if (pressed("heavy") && horizontal > profile.speed) beats.push("burst");
        const riding =
          b.platformMotion?.supportId?.startsWith("platform:") ?? false;
        if (riding && !a.platformMotion?.supportId?.startsWith("platform:"))
          beats.push("ride");
        if (riding || (b.grounded && input?.axes.moveX === 0)) waitRideTicks++;
        if (b.grounded)
          recoveryWidth = Math.min(
            recoveryWidth,
            landingWidth(
              content.definitions.levels.find(
                (l) => l.id === after.platform.levelId,
              )!,
              b,
              after.platform.platforms,
            ),
          );
        lastVerticalDelta = vertical;
      } else if (entry.command.kind === "exit") {
        visited.push(
          content.campaign.rooms.findIndex((r) => r.id === after.roomId),
        );
        lastVerticalDelta = 0;
      }
      if (entry.command.kind !== "frame") {
        const o = owner.observation();
        milestones.push({
          command: commands,
          roomId: o.roomId,
          outcomes: [...o.transactions.outcomes],
        });
      }
    }
  }
  const body = content.definitions.archetypes.find(
    (a) =>
      a.id ===
      owner.observation().platform.actors.find((a) => a.slot === 0)!
        .archetypeId,
  )!.body;
  const descriptor: PlatformRouteDescriptor = {
    beats,
    topology: canonical(visited),
    distance: Math.round(distance / body.width),
    waitRideTicks,
    recoveryWidths:
      recoveryWidth === Number.MAX_SAFE_INTEGER
        ? 0
        : Math.floor(recoveryWidth / body.width),
  };
  return { owner, ticks, milestones, descriptor };
}
export function certifyPlatformTape(
  content: PlatformContent,
  tape: PlatformTraversalCertificate["tape"],
  destination: PlatformTraversalCertificate["destination"],
  _descriptor: PlatformRouteDescriptor,
  budget = new PlatformWorkBudget(),
  options: PlatformReplayOptions = {},
): PlatformTraversalCertificate {
  const { owner, ticks, milestones, descriptor } = replayPlatformTape(
    content,
    tape,
    budget,
    options,
  );
  endpoint(owner, destination);
  return {
    format: "platform-traversal-certificate-v1",
    semanticDigest: platformSemanticDigest(content),
    rulesBuildId: content.identity.rulesBuildId,
    source: {
      roomId: content.campaign.initialRoom,
      anchorId: content.campaign.initialAnchor ?? null,
    },
    destination,
    tape,
    milestones,
    finalDigest: platformDigest(owner.observation()),
    ticks,
    descriptor,
  };
}
export class PlatformReplayFailure extends Error {
  constructor(
    message: string,
    readonly command: number,
    readonly tick: number,
  ) {
    super(message);
  }
}
export type PlatformCertificateResult =
  | { status: "valid"; ticks: number }
  | {
      status:
        | "stale-certificate"
        | "failed-replay"
        | "no-witness-within-budget"
        | "cancelled";
      reason: string;
      command?: number;
      tick?: number;
    };
export function verifyPlatformCertificate(
  content: PlatformContent,
  certificate: PlatformTraversalCertificate,
  budget = new PlatformWorkBudget(),
  options: PlatformReplayOptions = {},
): PlatformCertificateResult {
  try {
    certificate = copyCampaignPlainData(certificate, 262144);
    if (
      certificate.semanticDigest !== platformSemanticDigest(content) ||
      certificate.rulesBuildId !== content.identity.rulesBuildId
    )
      return {
        status: "stale-certificate",
        reason: "Content, controller, campaign or entry policy changed",
      };
    if (
      certificate.format !== "platform-traversal-certificate-v1" ||
      certificate.source.roomId !== content.campaign.initialRoom ||
      certificate.source.anchorId !== (content.campaign.initialAnchor ?? null)
    )
      throw Error("certificate-source-mismatch");
    const result = replayPlatformTape(
      content,
      certificate.tape,
      budget,
      options,
    );
    endpoint(result.owner, certificate.destination);
    if (
      result.ticks !== certificate.ticks ||
      platformDigest(result.owner.observation()) !== certificate.finalDigest ||
      canonical(result.milestones) !== canonical(certificate.milestones) ||
      canonical(result.descriptor) !== canonical(certificate.descriptor)
    )
      throw Error("certificate-result-mismatch");
    return { status: "valid", ticks: result.ticks };
  } catch (error) {
    const reason = String(error);
    return {
      status: reason.includes("cancelled")
        ? "cancelled"
        : reason.includes("budget")
          ? "no-witness-within-budget"
          : "failed-replay",
      reason,
      ...(error instanceof PlatformReplayFailure
        ? { command: error.command, tick: error.tick }
        : {}),
    };
  }
}
export function platformRoutesDistinct(
  a: PlatformRouteDescriptor,
  b: PlatformRouteDescriptor,
): boolean {
  let row = Array.from({ length: b.beats.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.beats.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.beats.length; j++)
      next.push(
        Math.min(
          next[j] + 1,
          row[j + 1] + 1,
          row[j] + (a.beats[i] === b.beats[j] ? 0 : 1),
        ),
      );
    row = next;
  }
  return (
    (row[b.beats.length] >= 2 || a.topology !== b.topology) &&
    (Math.abs(a.distance - b.distance) * 5 >=
      Math.max(a.distance, b.distance) ||
      Math.abs(a.waitRideTicks - b.waitRideTicks) >= 60 ||
      Math.abs(a.recoveryWidths - b.recoveryWidths) >= 2)
  );
}
export function platformPhaseCases(
  period: number,
  granularity: number,
): number[] {
  integer(period, 1, 1800);
  integer(granularity, 1, 1800);
  const phases: number[] = [];
  let phase = 0;
  do {
    phases.push(phase);
    phase = (phase + granularity) % period;
  } while (phase !== 0);
  return phases;
}
