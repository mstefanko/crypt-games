import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  class Node {
    [key: string]: any;
    constructor() {
      return new Proxy(this, {
        get: (target, key, receiver) => {
          if (key in target) return target[key as string];
          if (key === "manifest") return undefined;
          if (["position", "scale", "anchor", "pivot"].includes(String(key)))
            return { set() {} };
          return () => receiver;
        },
      });
    }
  }
  return { Node };
});
vi.mock("./index", () => ({
  Container: mocks.Node,
  Graphics: mocks.Node,
  Text: mocks.Node,
  Sprite: mocks.Node,
  Texture: { WHITE: {} },
  AtlasLoader: mocks.Node,
  ClipPlayer: mocks.Node,
  PanelController: mocks.Node,
  SpringTransform: mocks.Node,
  PresentationQueue: mocks.Node,
  ParticlePool: mocks.Node,
}));
import { SettlementPresenter } from "./settlement-presenter";
import { SettlementSession } from "@onepage/game-simulation/settlement-session";
import { winterContent } from "../../../../apps/audio-arcade/src/games/winter/content";
import { winterScene } from "../../../../apps/audio-arcade/src/games/winter/scene";

it("renders game-owned HUD names and resource selection with alternate scene content", () => {
  const owner = new SettlementSession(winterContent, 17);
  const before = owner.snapshot();
  const resource = winterScene.hud.resources[0]!;
  const alternate = {
    ...winterScene,
    hud: {
      seasons: ["Dawn", "High sun", "Harvest", "Long night"],
      paused: "Resting",
      residents: "settlers",
      resources: [{ id: resource.id, label: "Provisions" }],
    },
  };
  const presenter = new SettlementPresenter(owner, alternate);
  const internals = presenter as unknown as {
    stage: unknown;
    hud: { text: string };
  };
  internals.stage = { layers: { actors: new mocks.Node() } };
  presenter.render(0);
  expect(internals.hud.text).toContain("Dawn");
  expect(internals.hud.text).toContain(`${owner.state.people.length} settlers`);
  expect(internals.hud.text).toContain(
    `Provisions ${owner.available(resource.id)}`,
  );
  expect(internals.hud.text).not.toMatch(/Spring|Food|Logs|Firewood|Stone/);
  expect(owner.snapshot()).toEqual(before);
  owner.command("speed:0");
  presenter.render(0);
  expect(internals.hud.text).toContain("Resting");
  presenter.dispose();

  const original = new SettlementPresenter(owner, winterScene);
  const production = original as unknown as {
    stage: unknown;
    hud: { text: string };
  };
  production.stage = { layers: { actors: new mocks.Node() } };
  original.render(0);
  expect(production.hud.text).toContain("Spring");
  for (const { id, label } of winterScene.hud.resources)
    expect(production.hud.text).toContain(`${label} ${owner.available(id)}`);
  original.dispose();
});
