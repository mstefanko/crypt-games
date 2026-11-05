import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  explorationContentIdentity,
  explorationIdentityDetails,
} from "../../../scripts/lib/game-exploration-identity.mjs";
import { explorationIdentityPlugin } from "../../../scripts/game-exploration-plugin.mjs";
import { createExplorationCharacterGame } from "./exploration-character";
import {
  EXPLORATION_CAMPAIGN,
  EXPLORATION_DEFINITIONS,
  EXPLORATION_ROOMS,
  explorationInput,
} from "./exploration-game";
import * as publicExploration from "./exploration-game";
import { EXPLORATION_ROOMS as cosmeticRooms } from "./exploration-rooms";
import { CampaignPlatformOwner } from "./campaign-platform";
import {
  CampaignPlatformSession,
  prepareCampaignPlatformRecovery,
} from "../../game-runtime/src/session/campaign-platform";

const root = resolve(import.meta.dirname, "../../..");
let sandbox: string;
beforeAll(async () => {
  sandbox = await mkdtemp(resolve(tmpdir(), "exploration-identity-"));
  await mkdir(resolve(sandbox, "packages"), { recursive: true });
  await mkdir(resolve(sandbox, "node_modules/@onepage"), { recursive: true });
  for (const name of ["game-project", "game-simulation"]) {
    await cp(
      resolve(root, "packages", name),
      resolve(sandbox, "packages", name),
      { recursive: true },
    );
    await symlink(
      resolve(sandbox, "packages", name),
      resolve(sandbox, "node_modules/@onepage", name),
      "dir",
    );
  }
  await cp(
    resolve(root, "examples/game-exploration"),
    resolve(sandbox, "examples/game-exploration"),
    { recursive: true },
  );
});
afterAll(async () => {
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe("production Beacon compatibility preparation", () => {
  it("refreshes the dev identity and watch set for new unused imports, edits, deletion and recovery", async () => {
    const plugin = explorationIdentityPlugin({ root: sandbox });
    const watched = new Set<string>();
    await (plugin.buildStart as Function).call({
      addWatchFile: (file: string) => watched.add(file),
    });
    const readIdentity = async () =>
      JSON.parse(
        (
          await (plugin.load as Function)("\0virtual:game-exploration-identity")
        ).slice("export default ".length, -1),
      );
    const baseline = await readIdentity();
    const module = {};
    const invalidateModule = vi.fn();
    const send = vi.fn();
    const context = {
      environment: {
        moduleGraph: { getModuleById: () => module, invalidateModule },
        hot: { send },
      },
    };
    const update = (file: string, type = "update") =>
      (plugin.hotUpdate as Function).call(context, {
        file,
        type,
        server: {
          watcher: {
            add: (files: string[]) =>
              files.forEach((file) => watched.add(file)),
          },
        },
      });
    const entry = resolve(
      sandbox,
      "packages/game-simulation/src/exploration-gameplay.ts",
    );
    const helper = resolve(
      sandbox,
      "packages/game-simulation/src/dev-identity-probe.ts",
    );
    const original = await readFile(entry, "utf8");
    try {
      await writeFile(helper, "export const unusedProbe = 1;\n");
      await update(helper, "create");
      expect(await readIdentity()).toEqual(baseline);
      await writeFile(
        entry,
        original + '\nimport { unusedProbe } from "./dev-identity-probe";\n',
      );
      await update(entry);
      const added = await readIdentity();
      expect(added.rulesBuildId).not.toBe(baseline.rulesBuildId);
      expect(watched.has(helper)).toBe(true);
      await writeFile(helper, "export const unusedProbe = 2;\n");
      await update(helper);
      expect((await readIdentity()).rulesBuildId).not.toBe(added.rulesBuildId);
      expect(invalidateModule).toHaveBeenCalledWith(module);
      expect(send).toHaveBeenCalledWith({ type: "full-reload" });
      await rm(helper);
      await expect(update(helper, "delete")).rejects.toThrow();
      await expect(readIdentity()).rejects.toThrow();
      await writeFile(helper, "export const unusedProbe = 3;\n");
      await update(helper, "create");
      expect((await readIdentity()).rulesBuildId).not.toBe(added.rulesBuildId);
      await writeFile(entry, original);
      await update(entry);
      expect(await readIdentity()).toEqual(baseline);
    } finally {
      await writeFile(entry, original);
      await rm(helper, { force: true });
    }
  });

  it("preserves the reviewed public facade and shared cosmetic room metadata", () => {
    expect(Object.keys(publicExploration).sort()).toEqual([
      "EXPLORATION_CAMPAIGN",
      "EXPLORATION_DEFINITIONS",
      "EXPLORATION_IDENTITY",
      "EXPLORATION_ROOMS",
      "createExplorationCampaign",
      "createExplorationGame",
      "explorationInput",
    ]);
    expect(EXPLORATION_ROOMS).toBe(cosmeticRooms);
    expect(EXPLORATION_ROOMS.map((room) => room.id)).toEqual(
      EXPLORATION_CAMPAIGN.rooms.map((room) => room.id),
    );
  });
  it("uses one prepared identity for production assembly and emitted artifact metadata", async () => {
    const plugin = explorationIdentityPlugin();
    await (plugin.buildStart as Function)();
    const virtual = await (plugin.load as Function)(
      "\0virtual:game-exploration-identity",
    );
    const identity = JSON.parse(virtual.slice("export default ".length, -1));
    const emitted: { fileName: string; source: string }[] = [];
    const hook = plugin.generateBundle as { handler: Function };
    await hook.handler.call(
      {
        emitFile: (file: { fileName: string; source: string }) =>
          emitted.push(file),
      },
      {},
      {
        "assets/main.js": {
          type: "chunk",
          fileName: "assets/main.js",
          code: "export const player=true;",
        },
        "game-exploration-module-graph.json": {
          type: "asset",
          fileName: "game-exploration-module-graph.json",
          source: '{"modules":[]}',
        },
      },
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0].fileName).toBe("game-build-manifest.json");
    const manifest = JSON.parse(emitted[0].source);
    expect(manifest.identity).toEqual(identity);
    expect(manifest.rulesContract).toEqual(manifest.explorationContract);
    expect(manifest.rulesContract.format).toBe("beacon-return-source-v1");
    expect(
      manifest.artifacts.map((file: { path: string }) => file.path),
    ).toEqual(["assets/main.js", "game-exploration-module-graph.json"]);
    expect(manifest.artifactSetId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(manifest.explorationContract.exactAndPortablePolicy).toBe(
      "strict-rules-and-selected-gameplay-content",
    );
    expect(manifest.authoritativeSources.length).toBeGreaterThan(10);
  });

  it("discovers recursive authority and hashes actual selected gameplay separately from presentation", async () => {
    const baseline = await explorationIdentityDetails({ root: sandbox });
    expect(baseline.sources.map((source) => source.path)).toEqual(
      expect.arrayContaining([
        "packages/game-simulation/src/simulation.ts",
        "packages/game-simulation/src/checkpoint.ts",
        "packages/game-simulation/src/campaign-platform.ts",
        "packages/game-simulation/src/character-session.ts",
        "packages/game-simulation/src/exploration-character.ts",
      ]),
    );
    expect(baseline.sources.map((source) => source.path)).not.toContain(
      "packages/game-simulation/src/exploration-game.ts",
    );
    expect(baseline.sources.map((source) => source.path)).not.toContain(
      "packages/game-simulation/src/exploration-rooms.ts",
    );
    expect(
      baseline.sources.every(
        (source) =>
          !source.path.includes("game-runtime") &&
          !source.path.includes("apps/"),
      ),
    ).toBe(true);
    expect(baseline.identity.contentId).toBe(
      explorationContentIdentity(baseline.content),
    );
    const mutations = [
      [
        "packages/game-simulation/src/exploration-rules.ts",
        'archetype("hero", 18, 2,',
        'archetype("hero", 18, 3,',
      ],
      [
        "packages/game-simulation/src/exploration-rules.ts",
        "damage: 1,",
        "damage: 2,",
      ],
      [
        "packages/game-simulation/src/exploration-character.ts",
        'id: "beacon-loadout-v2"',
        'id: "beacon-loadout-v3"',
      ],
      [
        "examples/game-exploration/behaviors.json",
        '"windup": 2',
        '"windup": 3',
      ],
    ];
    for (const [path, from, to] of mutations) {
      const file = resolve(sandbox, path);
      const original = await readFile(file, "utf8");
      expect(original).toContain(from);
      try {
        await writeFile(file, original.replace(from, to));
        const changed = await explorationIdentityDetails({ root: sandbox });
        expect(changed.identity.contentId, path).not.toBe(
          baseline.identity.contentId,
        );
        if (path.endsWith(".ts"))
          expect(changed.identity.rulesBuildId, path).not.toBe(
            baseline.identity.rulesBuildId,
          );
        else
          expect(changed.identity.rulesBuildId).toBe(
            baseline.identity.rulesBuildId,
          );
        // Old exact and portable bytes are rejected before either owner publishes.
        const old = new CampaignPlatformOwner(
          baseline.content.platform,
          baseline.identity,
          baseline.content.campaign,
        );
        const next = new CampaignPlatformOwner(
          changed.content.platform,
          changed.identity,
          changed.content.campaign,
        );
        const before = next.checkpoint();
        expect(() => next.restore(old.checkpoint())).toThrow();
        expect(next.checkpoint()).toBe(before);
        expect(() => next.restoreProgress(old.progress())).toThrow();
        expect(next.checkpoint()).toBe(before);
      } finally {
        await writeFile(file, original);
      }
    }
    const ruleFile = resolve(
      sandbox,
      "packages/game-simulation/src/simulation.ts",
    );
    const ruleSource = await readFile(ruleFile, "utf8");
    try {
      await writeFile(
        ruleFile,
        ruleSource + "\n// reviewed rules source mutation\n",
      );
      const changed = await explorationIdentityDetails({ root: sandbox });
      expect(changed.identity.rulesBuildId).not.toBe(
        baseline.identity.rulesBuildId,
      );
      expect(changed.identity.contentId).toBe(baseline.identity.contentId);
    } finally {
      await writeFile(ruleFile, ruleSource);
    }
    const roomsFile = resolve(
      sandbox,
      "packages/game-simulation/src/exploration-rooms.ts",
    );
    const roomsSource = await readFile(roomsFile, "utf8");
    await writeFile(
      roomsFile,
      roomsSource.replace("Harbor refuge", "Sheltered harbor"),
    );
    expect(
      (await explorationIdentityDetails({ root: sandbox })).identity,
    ).toEqual(baseline.identity);
    const reordered = Object.fromEntries(
      Object.entries(baseline.content).reverse(),
    );
    expect(explorationContentIdentity(reordered)).toBe(
      baseline.identity.contentId,
    );
  });

  it("threads detached injected identity through composite reopen, session staging, reset and recovery", async () => {
    const { identity } = await explorationIdentityDetails();
    const callerIdentity = { ...identity };
    const create = () =>
      createExplorationCharacterGame(EXPLORATION_CAMPAIGN, identity);
    const owner = createExplorationCharacterGame(
      EXPLORATION_CAMPAIGN,
      callerIdentity,
    );
    callerIdentity.rulesBuildId = "caller-mutated";
    owner.executeFrames(explorationInput(127), 3);
    const exact = owner.checkpoint(),
      progress = owner.progress();
    expect(JSON.parse(JSON.parse(exact).campaign).identity).toEqual(identity);
    owner.restore(exact);
    expect(owner.checkpoint()).toBe(exact);
    owner.restoreProgress(progress);
    expect(owner.progress()).toBe(progress);
    const rejected = createExplorationCharacterGame(EXPLORATION_CAMPAIGN, {
      ...identity,
      contentId: "edited-gameplay",
    });
    const before = rejected.checkpoint();
    expect(() => rejected.restore(exact)).toThrow();
    expect(() => rejected.restoreProgress(progress)).toThrow();
    expect(rejected.checkpoint()).toBe(before);
    const loader = async ({
      roomId,
      assetIds,
    }: {
      roomId: string;
      assetIds: readonly string[];
    }) => ({ roomId, assetIds, dispose() {} });
    const session = new CampaignPlatformSession(
      EXPLORATION_DEFINITIONS,
      identity,
      EXPLORATION_CAMPAIGN,
      1000,
      create,
    );
    await session.restore(exact, loader);
    expect(session.checkpoint()).toBe(exact);
    await session.restoreProgress(progress, loader);
    await session.reset(loader);
    expect(
      JSON.parse(JSON.parse(session.checkpoint()).campaign).identity,
    ).toEqual(identity);
    const recovery = prepareCampaignPlatformRecovery(
      EXPLORATION_DEFINITIONS,
      identity,
      EXPLORATION_CAMPAIGN,
      progress,
      create,
    );
    expect(recovery.status).not.toBe("rejected");
    if (recovery.status !== "rejected")
      expect(recovery.owner.progress()).toBe(progress);
  });
});
