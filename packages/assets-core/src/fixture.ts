import type {
  AssetAction,
  AssetFamily,
  AssetFrame,
  AssetLibraryDocument,
  IndexedPixelFrame,
} from "./types";
import { createEmptyLibrary } from "./library";
/** Original, deliberately small authored fixtures. These are not model generation results. */
function courierVisual(
  action: string,
  direction: string,
  phase: number,
  palette: string[],
): IndexedPixelFrame {
  const width = 20,
    height = 28,
    pixels = Array.from({ length: height }, () => Array(width).fill("0"));
  const rect = (x: number, y: number, w: number, h: number, color: string) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++)
        pixels[yy][xx] = color;
  };
  const sitting = action === "sit",
    jump = action === "jump" ? (phase === 1 ? -4 : -2) : 0;
  const stride =
    action === "walk" || action === "run" ? (phase % 2 ? 2 : -2) : 0;
  const bob = (action === "walk" || action === "run") && phase % 2 ? -1 : 0;
  const y = (sitting ? 5 : 0) + jump + bob;
  rect(6, 3 + y, 8, 7, "2");
  rect(5, 2 + y, 9, 3, "3");
  rect(4, 4 + y, 12, 2, "3");
  rect(5, 11 + y, 10, sitting ? 7 : 9, "4");
  rect(7, 11 + y, 2, sitting ? 7 : 9, "5");
  rect(3, 12 + y, 3, 8, "2");
  rect(14, 12 + y, 3, 8, "2");
  if (sitting) {
    rect(5, 22, 8, 3, "6");
    rect(12, 22, 5, 3, "6");
    rect(14, 24, 3, 3, "1");
    rect(5, 25, 5, 2, "1");
  } else {
    rect(6 - stride, 20 + jump, 3, 6, "6");
    rect(11 + stride, 20 + jump, 3, 6, "6");
    rect(5 - stride, 25 + jump, 5, 2, "1");
    rect(10 + stride, 25 + jump, 5, 2, "1");
  }
  if (action === "wave") {
    rect(14, 12 + y, 3, 8, "0");
    rect(14, 8 + y, 3, 7, "2");
    rect(phase % 2 ? 15 : 13, 5 + y, 3, 4, "2");
  }
  if (direction !== "back") {
    rect(direction === "left" ? 7 : 11, 7 + y, 1, 1, "1");
    rect(
      direction === "front" ? 7 : direction === "left" ? 6 : 12,
      9 + y,
      direction === "front" ? 6 : 2,
      1,
      "7",
    );
  } else rect(6, 6 + y, 8, 4, "7");
  if (direction === "left") pixels.forEach((row) => row.reverse());
  return {
    kind: "indexed",
    width,
    height,
    palette: [...palette],
    rows: pixels.map((row) => row.join("")),
  };
}
export function createDemoLibrary(): AssetLibraryDocument {
  const document = createEmptyLibrary(
    "pocket-assets-demo",
    "Pocket Assets Library",
  );
  document.sources.push({
    id: "original-starter",
    name: "Pocket originals",
    source: "Original Pocket Assets demo artwork",
    license: "CC0-1.0",
    author: "Pocket Assets",
    mediaIds: [],
  });
  const palettes = [
    [
      "#00000000",
      "#25333b",
      "#e5b88f",
      "#705f89",
      "#d7845d",
      "#f7cb87",
      "#455b68",
      "#674c42",
    ],
    [
      "#00000000",
      "#263b35",
      "#d9ac8b",
      "#466d58",
      "#78988d",
      "#e6c47e",
      "#3a5358",
      "#59493d",
    ],
  ];
  const names = ["Juniper the courier", "Moss the keeper"];
  document.families = names.map((name, index): AssetFamily => {
    const id = index ? "moss" : "juniper";
    const actions: AssetAction[] = [
      "idle",
      "walk",
      "run",
      "jump",
      "sit",
      "wave",
    ].map((action) => ({
      id: `${id}:${action}`,
      name: action,
      loop: ["idle", "walk", "run"].includes(action),
      directions: ["front", "right", "back", "left"].map((direction) => ({
        direction,
        frames: Array.from(
          { length: action === "idle" || action === "sit" ? 1 : 4 },
          (_, phase): AssetFrame => ({
            id: `${id}:${action}:${direction}:${phase}`,
            durationTicks: action === "run" ? 5 : action === "sit" ? 30 : 10,
            visual: courierVisual(action, direction, phase, palettes[index]),
            ...(action === "sit"
              ? { anchors: { hand: { x: 15, y: 23 }, speech: { x: 10, y: 6 } } }
              : {}),
          }),
        ),
      })),
    }));
    return {
      id,
      name,
      kind: "character",
      revision: 1,
      sourcePackId: "original-starter",
      description: index
        ? "A patient keeper with six authored actions."
        : "A small courier ready for a forest story.",
      tags: ["original", "pixel art", "four directions"],
      variants: [
        {
          id: `${id}:pixel`,
          name: "Forest pixel",
          style: "16-bit",
          logicalHeight: 28,
          anchors: {
            ground: { x: 10, y: 27 },
            hand: { x: 16, y: 18 },
            speech: { x: 10, y: 1 },
          },
          actions,
        },
      ],
    };
  });
  const propPixels: IndexedPixelFrame = {
    kind: "indexed",
    width: 10,
    height: 14,
    palette: ["#00000000", "#344941", "#d49c4b", "#ffe7a0"],
    rows: [
      "0001111000",
      "0010000100",
      "0010000100",
      "0111111110",
      "0122222210",
      "0123333210",
      "0123333210",
      "0123333210",
      "0123333210",
      "0123333210",
      "0122222210",
      "0111111110",
      "0000000000",
      "0000000000",
    ],
  };
  document.families.push({
    id: "lantern",
    name: "Trail lantern",
    revision: 1,
    kind: "prop",
    sourcePackId: "original-starter",
    tags: ["light", "attachment"],
    variants: [
      {
        id: "lantern:pixel",
        name: "Brass",
        style: "16-bit",
        logicalHeight: 14,
        anchors: {
          ground: { x: 5, y: 12 },
          hand: { x: 5, y: 0 },
          speech: { x: 5, y: 0 },
        },
        actions: [
          {
            id: "lantern:idle",
            name: "idle",
            loop: true,
            directions: [
              {
                direction: "front",
                frames: [
                  { id: "lantern:f0", durationTicks: 20, visual: propPixels },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  document.collections.push({
    id: "forest-kit",
    name: "Forest story kit",
    familyIds: ["juniper", "moss", "lantern"],
  });
  return document;
}
