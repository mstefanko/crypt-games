import type { EmbeddedPlatformWorld } from "@onepage/game-simulation/platform-world-save";
import type { CampaignPlatformSession } from "@onepage/game-runtime/session/campaign-platform";
export function renderPlatformWorld(
  canvas: HTMLCanvasElement,
  content: EmbeddedPlatformWorld,
  o: ReturnType<CampaignPlatformSession["observation"]>,
) {
  const ctx = canvas.getContext("2d")!;
  const level =
    content.definitions.levels.find((l) => l.id === o.platform.levelId) ??
    content.definitions.levels.find((l) => l.id === o.roomId)!;
  const hero = o.platform.actors.find((a) => a.slot === 0)!;
  const width = content.definitions.manifest.viewport.width,
    height = content.definitions.manifest.viewport.height;
  ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
  ctx.fillStyle = "#132438";
  ctx.fillRect(0, 0, width, height);
  const cameraX = Math.max(
    0,
    Math.min(level.width - width, hero.x / 256 - width / 2),
  );
  ctx.translate(-cameraX, 0);
  const rect = (
    r: { x: number; y: number; width: number; height: number },
    color: string,
  ) => {
    ctx.fillStyle = color;
    ctx.fillRect(r.x / 256, r.y / 256, r.width / 256, r.height / 256);
  };
  const cols = level.width / level.tileSize;
  level.tiles.forEach((tile, i) => {
    if (tile) {
      ctx.fillStyle = tile === 2 ? "#afc9ad" : "#536677";
      ctx.fillRect(
        (i % cols) * level.tileSize,
        Math.floor(i / cols) * level.tileSize,
        level.tileSize,
        level.tileSize,
      );
    }
  });
  level.rectangles.forEach((r) => rect(r, r.oneWay ? "#afc9ad" : "#536677"));
  o.platform.platforms.forEach((p) => rect(p, "#a4b9e3"));
  ctx.globalAlpha = 0.55;
  o.room.exits.forEach((e) => rect(e.area, "#367d77"));
  o.room.pickups.forEach((p) => rect(p.area, "#c89f4e"));
  if (o.room.checkpoint) rect(o.room.checkpoint, "#537940");
  ctx.globalAlpha = 1;
  ctx.font = "7px system-ui";
  ctx.fillStyle = "#edf5e9";
  for (const e of o.room.exits)
    ctx.fillText(e.id, e.area.x / 256, e.area.y / 256 - 3);
  for (const p of o.room.pickups)
    ctx.fillText(p.id, p.area.x / 256, p.area.y / 256 - 3);
  o.platform.actors
    .filter((a) => a.health > 0)
    .forEach((a) => rect(a, a.slot === 0 ? "#f4e5c3" : "#d98171"));
}
