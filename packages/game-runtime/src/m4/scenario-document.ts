import type { ArenaIdentity } from "../../../game-simulation/src/m3/arena";
import type { M4Command } from "./session";
import { M4Session, validateCommand, M4Error } from "./session";
import { type M4Profile, findScenario } from "./scenarios";
import {
  parseBounded,
  record,
  string,
  integer,
  array,
  hashId,
  sha256,
  detached,
  firstDifference,
} from "./codec";
export type ScenarioDocument = {
  format: "pocket-game-scenario";
  version: 1;
  id: string;
  fixture: string;
  identity: ArenaIdentity;
  buildId: string;
  runtimeBuildId: string;
  seed: number;
  initial: { bytes: string; hash: string };
  actions: M4Command[];
  assertions: { index: number; bytes: string; hash: string }[];
} & (
  | { profile: "arena" | "duel"; clock: "tick" }
  | { profile: "grid" | "adventure"; clock: "command" }
);
export async function scenarioDocument(
  session: M4Session,
  id?: string,
): Promise<ScenarioDocument> {
  // An explicit ID selects a catalogue fixture, never relabels live state.
  const selected =
    id === undefined
      ? session
      : new M4Session({
          project: session.project,
          profile: session.profile,
          identity: session.identity,
          buildId: session.buildId,
          runtimeBuildId: session.runtimeBuildId,
          scenario: findScenario(id, session.profile).id,
        });
  const o = selected.observe(),
    bytes = selected.checkpoint();
  return {
    format: "pocket-game-scenario",
    version: 1,
    id: id ?? o.scenario,
    fixture: o.scenario,
    profile: session.profile,
    clock: o.clock.kind,
    identity: detached(session.identity),
    buildId: session.buildId,
    runtimeBuildId: session.runtimeBuildId,
    seed: findScenario(o.scenario).seed,
    initial: { bytes, hash: await sha256(bytes) },
    actions: [],
    assertions: [],
  } as ScenarioDocument;
}
/** A scenario's complete actions/assertions are staged against production codecs before load. */
export async function validateScenarioDocument(
  value: unknown,
  current: M4Session,
): Promise<ScenarioDocument> {
  const o = record(parseBounded(value, 8 * 1024 * 1024), [
    "format",
    "version",
    "id",
    "fixture",
    "profile",
    "clock",
    "identity",
    "buildId",
    "runtimeBuildId",
    "seed",
    "initial",
    "actions",
    "assertions",
  ]);
  if (o.format !== "pocket-game-scenario" || o.version !== 1)
    throw Error("M4_VERSION: unsupported scenario version");
  string(o.id);
  string(o.fixture);
  const fixture = findScenario(o.fixture as string, current.profile);
  if (
    o.profile !== current.profile ||
    o.clock !== fixture.clock ||
    o.seed !== fixture.seed
  )
    throw Error("M4_SCENARIO: profile/clock/seed mismatch");
  const identity = record(o.identity, ["gameId", "rulesBuildId", "contentId"]);
  if (
    firstDifference(identity, current.identity) ||
    o.buildId !== current.buildId ||
    o.runtimeBuildId !== current.runtimeBuildId
  )
    throw Error("M4_BUILD_UNAVAILABLE: scenario requires another exact build");
  const initial = record(o.initial, ["bytes", "hash"]);
  hashId(initial.hash);
  if (
    typeof initial.bytes !== "string" ||
    (await sha256(initial.bytes)) !== initial.hash
  )
    throw Error("M4_HASH: scenario initial hash mismatch");
  const actions = array(o.actions, 10000).map((a) =>
    validateCommand(current.profile, a),
  );
  const assertions = array(o.assertions, 1000);
  let previous = -1;
  for (const a of assertions) {
    const c = record(a, ["index", "bytes", "hash"]);
    integer(c.index, 0, actions.length);
    if ((c.index as number) <= previous)
      throw Error("M4_ORDER: scenario assertions must be strictly ordered");
    previous = c.index as number;
    hashId(c.hash);
    if (typeof c.bytes !== "string" || (await sha256(c.bytes)) !== c.hash)
      throw Error("M4_HASH: scenario assertion hash mismatch");
  }
  if (assertions.length)
    M4Session.validateScenarioCheckpoints(
      {
        project: current.project,
        profile: current.profile,
        identity: current.identity,
        buildId: current.buildId,
        runtimeBuildId: current.runtimeBuildId,
        scenario: fixture.id,
      },
      assertions.map((a) => (a as { bytes: string }).bytes),
    );
  const stage = M4Session.stageScenario(
    {
      project: current.project,
      profile: current.profile,
      identity: current.identity,
      buildId: current.buildId,
      runtimeBuildId: current.runtimeBuildId,
      scenario: fixture.id,
    },
    initial.bytes,
  );
  if (stage.checkpoint() !== initial.bytes)
    throw Error("M4_CHECKPOINT: scenario initial is not canonical");
  for (let index = 0; index <= actions.length; index++) {
    const assertion = assertions.find(
      (a) => (a as { index: number }).index === index,
    ) as { index: number; bytes: string } | undefined;
    if (assertion) {
      const actual = stage.checkpoint();
      const d = firstDifference(
        JSON.parse(assertion.bytes),
        JSON.parse(actual),
      );
      if (d || assertion.bytes !== actual)
        throw new M4Error(
          "M4_DIVERGENCE",
          "Scenario assertion diverged",
          `/assertions/${assertions.indexOf(assertion)}/bytes${d ?? "/@canonicalBytes"}`,
        );
    }
    if (index < actions.length)
      try {
        stage.step(actions[index]);
      } catch (error) {
        throw new M4Error(
          "M4_SCENARIO_ACTION",
          error instanceof Error ? error.message : String(error),
          `/actions/${index}`,
        );
      }
  }
  return detached(o) as unknown as ScenarioDocument;
}
