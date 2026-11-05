import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ballVisual, isBallContact, volleyContactKind } from "../src/ball-presentation";
import { SPORT_BALL_PROFILES } from "../sim/sports-spec";

describe("mode ball artwork", () => {
  it("preserves legacy orb while using actual distinct sports frames and shared radii", () => {
    expect(ballVisual("cryptball", 9, 10).frame).toBe("orb.2");
    for (const sport of ["cryptkick", "rift-volley"] as const) {
      const view = ballVisual(sport, 0, 100);
      expect(view.radius).toBe(SPORT_BALL_PROFILES[sport].radius);
      expect(view.frame).toBe(`balls.${sport === "cryptkick" ? "kick" : "volley"}.spin.0`);
      expect(ballVisual(sport, 12, 100).frame).not.toBe(view.frame);
    }
    expect(ballVisual("rift-volley", 0, 1).groundLift).toBe(0);
    expect(ballVisual("cryptkick", 0, 1).groundLift).toBe(6);
  });
  it("samples actual deformation and recovery by authority tick and expires it", () => {
    const contact = {type:"volley-contact", kind:"attack", tick:100};
    expect(ballVisual("rift-volley",0,100,contact).frame).toBe("balls.volley.contact.0");
    expect(ballVisual("rift-volley",0,100,{...contact,kind:"set"}).frame).toBe("balls.volley.contact.1");
    expect(ballVisual("rift-volley",0,104,contact).frame).toBe("balls.volley.contact.2");
    expect(ballVisual("rift-volley",0,108,contact).frame).toBe("balls.volley.contact.3");
    expect(ballVisual("rift-volley",0,110,contact).frame).toBe("balls.volley.spin.0");
    expect(ballVisual("rift-volley",0,99,contact).frame).toBe("balls.volley.spin.0");
    expect(ballVisual("cryptball",0,100,contact).frame).toBe("orb.0");
    expect(ballVisual("rift-volley",20,100,contact,true).frame).toBe("balls.volley.spin.0");
    expect(ballVisual("rift-volley",20,100,contact)).toEqual(ballVisual("rift-volley",20,100,contact));
    expect(isBallContact(contact)).toBe(true);
    expect(isBallContact({type:"goal",tick:100})).toBe(false);
    expect(volleyContactKind({...contact,kind:"dig"})).toBe("dig");
  });
  it("packs every runtime frame and distinct airborne contact clip with fixed center pivots", () => {
    const manifest=JSON.parse(readFileSync(new URL("../public/assets/cryptball-balls/manifest.json",import.meta.url),"utf8"));
    for (const sport of ["cryptkick", "rift-volley"] as const)
      for (let travel=0; travel<80; travel++) {
        const frame=ballVisual(sport,travel,100).frame;
        expect(manifest.frames[frame]?.pivot).toEqual({x:10,y:10});
      }
    for (const kind of ["set","dig","attack"])
      expect(manifest.clips[`balls.fx.${kind}`]).toHaveLength(5);
    expect(manifest.provenance.solidDiameters).toEqual({kick:12,volley:12});
  });
});
