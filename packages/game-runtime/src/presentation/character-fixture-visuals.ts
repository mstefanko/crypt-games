/** Original finite indexed visual recipe for the character Lab proof. Zero is transparent.
 * These visual dimensions/anchors never enter character stats or arena geometry. */
import type { CharacterVisualAsset, CharacterVisualPart } from "./character";

const part = (id: string, rows: string[], anchorY = 13): CharacterVisualPart => ({
  id, width: rows[0].length, height: rows.length, anchorX: 6, anchorY, rows,
});
const body = part("body", [
  "000022220000", "000233332000", "000231332000", "000233332000",
  "000022220000", "000244442000", "002444444200", "002444444200",
  "000244442000", "000222222000", "000255552000", "000250052000",
  "000220022000", "000220022000",
]);
const stride = { ...body, rows: [...body.rows.slice(0, 11), "002250052200", "002200002200", "002200000220"] };
const cape = part("cape", [
  "000000000000", "000000000000", "000000000000", "000000000000",
  "000022220000", "000266662000", "002666666200", "002666666200",
  "026666666620", "026666666620", "026666666620", "002222222200",
  "000000000000", "000000000000",
]);
const frame = (id: string, bodyPart = body) => ({ id, durationTicks: 6, parts: [bodyPart, cape] });
export const CHARACTER_ARENA_VISUAL_ASSETS: readonly CharacterVisualAsset[] = [{
  id: "hero-atlas",
  palettes: [
    { id: "warm", colors: ["#00000000", "#151c30", "#222338", "#efc598", "#eaa543", "#443a66", "#aa4d57"] },
    { id: "cool", colors: ["#00000000", "#151c30", "#222338", "#c9d9ef", "#53c5d9", "#3c5c84", "#615ab4"] },
  ],
  animationSets: [{ id: "hero-arena", clips: [
    { action: "idle", loop: true, frames: [frame("idle-a"), frame("idle-b", { ...body, anchorY: 14 })] },
    { action: "move", loop: true, frames: [frame("move-a"), frame("move-b", stride)] },
    { action: "dash", loop: false, frames: [frame("dash", stride)] },
    { action: "hurt", loop: false, frames: [frame("hurt", { ...body, anchorX: 5 })] },
    { action: "dead", loop: false, frames: [frame("dead", { ...body, anchorY: 8 })] },
  ] }],
}];
