import { describe, expect, it } from "vitest";
import { cryptballFrame, SPORT_FRAME_HEIGHT, SPORT_FRAME_TOP } from "../src/viewport";
import { VIEW, projectCourt } from "../src/projection";
import { COURT } from "../sim/spec";
import { SPORT_IDS } from "../src/session";

describe("fixed landscape presentation", () => {
  it("retains the complete tactical view on tablets and in menus", () => {
    for (const sport of SPORT_IDS) {
      expect(cryptballFrame(1024, 768, sport, true)).toEqual({width:640, y:0, height:400});
      expect(cryptballFrame(844, 390, sport, false)).toEqual({width:640, y:0, height:400});
    }
  });
  it("keeps the far-side athlete body below the 40px touch scoreboard", () => {
    for (const sport of ["cryptball", "cryptkick", "cryptcheck"] as const) {
      const frame = cryptballFrame(844, 390, sport, true);
      const scale = Math.min(844 / frame.width, 390 / frame.height);
      // The largest grounded athlete frame extends 52px above its foot, with
      // up to 7px celebration lift. Online labels are separately
      // clamped below the measured scoreboard in game coordinates.
      expect((VIEW.farY - 52 - 7 - frame.y) * scale).toBeGreaterThan(40);
    }
  });
  it("keeps the near floor, actor clearance, and every previously visible lob pixel", () => {
    for (const sport of SPORT_IDS) {
      const frame = cryptballFrame(844, 390, sport, true);
      expect(frame.width).toBe(VIEW.width);
      expect(frame.height).toBe(SPORT_FRAME_HEIGHT[sport] - SPORT_FRAME_TOP[sport]);
      for (const y of [-COURT.halfWidth, 0, COURT.halfWidth]) {
        const floor = projectCourt(0, y);
        expect(floor.y + 24).toBeLessThan(frame.y + frame.height);
        // The crop starts at y=0: high sets/clearances keep their original headroom.
        for (const height of [0, 20, 60, 100, 160, 240]) {
          const ballY = floor.y - height;
          if (SPORT_FRAME_TOP[sport] === 0 && ballY >= 0 && ballY <= VIEW.height) expect(ballY).toBeLessThan(frame.y + frame.height);
        }
      }
    }
  });
});
