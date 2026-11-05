/** Original finite authored motifs. Geometry in pixels is compiled to integer units. */
import { compileBurstReturnGateLevel } from "./platform-burst-gate";
import type { LevelDefinition } from "@onepage/game-project/runtime";
export interface PlatformRoomTemplate {
  id: string;
  width: number;
  hurdles: readonly { x: number; width: number; height: number }[];
  drop: boolean;
  timed: boolean;
}
export const PLATFORM_ROOM_LIBRARY = Object.freeze({
  format: "platform-room-library-v1" as const,
  id: "switchback-courier-library-v1",
  templates: [
    {
      id: "meadow-step",
      width: 384,
      hurdles: [{ x: 144, width: 24, height: 24 }],
      drop: false,
      timed: false,
    },
    {
      id: "twin-posts",
      width: 512,
      hurdles: [
        { x: 144, width: 24, height: 24 },
        { x: 320, width: 24, height: 24 },
      ],
      drop: false,
      timed: false,
    },
    {
      id: "broad-rest",
      width: 640,
      hurdles: [{ x: 176, width: 40, height: 24 }],
      drop: false,
      timed: false,
    },
    {
      id: "triple-climb",
      width: 768,
      hurdles: [
        { x: 144, width: 24, height: 24 },
        { x: 336, width: 32, height: 32 },
        { x: 544, width: 24, height: 24 },
      ],
      drop: false,
      timed: false,
    },
    { id: "drop-lesson", width: 384, hurdles: [], drop: true, timed: false },
    {
      id: "drop-and-step",
      width: 512,
      hurdles: [{ x: 256, width: 24, height: 24 }],
      drop: true,
      timed: false,
    },
    {
      id: "long-descent",
      width: 768,
      hurdles: [{ x: 352, width: 24, height: 24 }],
      drop: true,
      timed: false,
    },
    {
      id: "staggered-posts",
      width: 640,
      hurdles: [
        { x: 192, width: 24, height: 32 },
        { x: 432, width: 32, height: 24 },
      ],
      drop: false,
      timed: false,
    },
    {
      id: "express-steps",
      width: 384,
      hurdles: [
        { x: 112, width: 16, height: 24 },
        { x: 240, width: 16, height: 24 },
      ],
      drop: false,
      timed: false,
    },
    {
      id: "wide-terrace",
      width: 768,
      hurdles: [
        { x: 240, width: 48, height: 32 },
        { x: 528, width: 32, height: 24 },
      ],
      drop: false,
      timed: false,
    },
    {
      id: "drop-switchback",
      width: 640,
      hurdles: [
        { x: 240, width: 24, height: 24 },
        { x: 432, width: 24, height: 24 },
      ],
      drop: true,
      timed: false,
    },
    {
      id: "last-rise",
      width: 512,
      hurdles: [
        { x: 176, width: 32, height: 32 },
        { x: 352, width: 24, height: 24 },
      ],
      drop: false,
      timed: false,
    },
    { id: "burst-gap", width: 384, hurdles: [], drop: false, timed: false },
    { id: "ferry-rest", width: 512, hurdles: [], drop: false, timed: true },
  ] satisfies PlatformRoomTemplate[],
});
export function platformTemplate(id: string): PlatformRoomTemplate {
  const template = PLATFORM_ROOM_LIBRARY.templates.find((t) => t.id === id);
  if (!template) throw Error(`Unknown platform template: ${id}`);
  return template;
}
export function compilePlatformRoom(
  template: PlatformRoomTemplate,
  id: string,
): LevelDefinition {
  if (template.id === "burst-gap") return compileBurstReturnGateLevel(id);
  const U = 256,
    height = 256,
    floor = 208;
  return {
    id,
    width: template.width,
    height,
    tileSize: 16,
    tiles: Array.from(
      { length: ((template.width / 16) * height) / 16 },
      (_, i) => (Math.floor(i / (template.width / 16)) >= floor / 16 ? 1 : 0),
    ),
    rectangles: [
      ...template.hurdles.map((h, i) => ({
        id: `hurdle-${i}`,
        x: h.x * U,
        y: (floor - h.height) * U,
        width: h.width * U,
        height: h.height * U,
        oneWay: false,
      })),
      ...(template.drop
        ? [
            {
              id: "drop-upper",
              x: 8 * U,
              y: 144 * U,
              width: 88 * U,
              height: 8 * U,
              oneWay: true,
            },
            {
              id: "drop-lower",
              x: 8 * U,
              y: 176 * U,
              width: 88 * U,
              height: 8 * U,
              oneWay: true,
            },
          ]
        : []),
    ],
    platforms: template.timed
      ? [
          {
            id: "ferry",
            x: 96 * U,
            y: 176 * U,
            width: 64 * U,
            height: 8 * U,
            endX: 288 * U,
            speed: U,
          },
        ]
      : [],
    spawns: [
      {
        id: "courier",
        archetypeId: "courier",
        x: 32 * U,
        y: (template.drop ? 144 : floor) * U,
        slot: 0,
        team: 0,
        facing: 1,
      },
    ],
    goal: {
      x: (template.width - 8) * U,
      y: 0,
      width: 4 * U,
      height: 4 * U,
      nextLevelId: null,
    },
    deathY: height * U,
  };
}
