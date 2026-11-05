import {
  AtlasLoader,
  ClipPlayer,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  type PixiStage,
} from "@onepage/game-runtime/pixi";
import type { Observation, CryptballEvent } from "./contract";
import { VIEW, projectCourt } from "./projection";
import { athleteClipId } from "./sport-presentation";
import { athleteAnimation, athleteHeading, spriteHeading } from "./animation";
import { specialPose, renderSpecialEffects } from "./special-presentation";
import { CryptballEffects } from "./effects";
import { COURT } from "../sim/spec";
import { VOLLEY_RULES } from "../sim/sports-spec";
import { ballVisual, isBallContact, volleyContactKind } from "./ball-presentation";
import { predictVolleyLanding } from "../sim/session";
import { bladeAnchor } from "../sim/modes/cryptcheck/control";
import type { SportId } from "./contract";
import { guardianPose, isNewMode, guardianDeflectionCues, maulApproachLift } from "./new-mode-presentation";
import { guardianIsGuarding } from "../sim/modes/crypt-guardian/boss";
import { guardianPassTarget } from "../sim/modes/crypt-guardian/ball";
import { TEAMS, TEAM_IDS, DEFAULT_TEAM_IDS } from "../sim/team-identities";
const assetPrefixes = TEAM_IDS.map((id) => TEAMS[id].assetPrefix);
/** Detached observations drive every pose; no gameplay is changed by rendering. */
export class CryptballPresenter {
  private atlas = new AtlasLoader();
  private sportAtlas = new AtlasLoader();
  private ballAtlas = new AtlasLoader();
  private newAtlas = new AtlasLoader();
  private newReady?: Promise<void>;
  private newLoaded = false;
  private hockeyAtlas = new AtlasLoader();
  private hockeyReady?: Promise<void>;
  private hockeyLoaded = false;
  private bannerAtlas = new AtlasLoader();
  private bannerSprites = new Map<string, Sprite>();
  private ballContact?: CryptballEvent;
  private ballContacts = new Map<string, CryptballEvent>();
  private seenEvents = new Set<string>();
  private sportScenery = new Graphics();
  private netSegments: Graphics[] = [];
  private sport: SportId | null = null;
  private contacts = new Map<string, CryptballEvent>();
  private clipCache = new Map<string, ReturnType<AtlasLoader["clip"]>>();
  private ground = new Container();
  private actors = new Container();
  private overlay = new Container();
  private hud = new Container();
  private clips = new Map<string, ClipPlayer>();
  private sprites = new Map<string, Sprite>();
  private marks = new Graphics();
  private specialMarks = new Graphics();
  private trails = new Graphics();
  private polish = new Graphics();
  private goalNet = new Graphics();
  private fx = new CryptballEffects();
  private labels = new Map<string, Text>();
  private cheers = new Map<string, number>();
  private lastTick = -1;
  private postFlashUntil = 0;
  private goalUntil = 0;
  private ambient = new Map<string, ClipPlayer>();
  private spriteEffects: {
    player: ClipPlayer;
    clip: string;
    born: number;
    life: number;
    x: number;
    y: number;
  }[] = [];
  private history: { x: number; y: number; z: number }[] = [];
  private orbTravel = 0;
  private defeatElapsed = 0;
  private lastRenderTime = 0;
  private renderDelta = 0;
  private guardianHitUntil = -1;
  private guardianImpact: {x:number;y:number;until:number;blocked:boolean} | null = null;
  private debug = false;
  private fps = 0;
  private loaded = false;
  private disposed = false;
  constructor(private stage: PixiStage) {
    stage.layers.ground.addChild(this.ground);
    stage.layers.actors.addChild(this.actors);
    stage.layers.effects.addChild(this.overlay);
    stage.layers.hud.addChild(this.hud);
    this.actors.sortableChildren = true;
    this.ground.addChild(this.marks, this.specialMarks);
    this.overlay.addChild(this.fx.graphics, this.polish);
    stage.camera.reducedMotion = true;
  }
  async init(progress?: (fraction: number) => void) {
    progress?.(0);
    await this.atlas.loadUrl(
      `${import.meta.env.BASE_URL}assets/cryptball/manifest.json`,
    );
    await this.sportAtlas.loadUrl(`${import.meta.env.BASE_URL}assets/cryptball-sports/manifest.json`);
    await this.ballAtlas.loadUrl(`${import.meta.env.BASE_URL}assets/cryptball-balls/manifest.json`);
    await this.bannerAtlas.loadUrl(`${import.meta.env.BASE_URL}assets/cryptball-banners/manifest.json`);
    if (this.disposed) return;
    for (const style of ["kick", "volley"])
      for (const [kind, count] of [["spin", 8], ["contact", 4]] as const)
        for (let i=0;i<count;i++)
          if (this.ballAtlas.texture(`balls.${style}.${kind}.${i}`) === Texture.EMPTY)
            throw Error(`Missing mode ball art: ${style}.${kind}.${i}`);
    for (const kind of ["set", "dig", "attack"])
      if (this.getClip(`balls.fx.${kind}`).frames.length !== 5)
        throw Error(`Missing airborne contact art: ${kind}`);
    for (const team of assetPrefixes)
      for (const role of ["warrior", "knight"])
        for (const action of [
          "idle",
          "run",
          "strike",
          "pass",
          "power",
          "slide-launch",
          "slide",
          "slide-recover",
          "sprint",
          "recoil",
          "celebrate",
        ])
          for (const heading of [
            "E",
            "NEE",
            "NE",
            "NNE",
            "N",
            "NNW",
            "NW",
            "NWW",
            "W",
            "SWW",
            "SW",
            "SSW",
            "S",
            "SSE",
            "SE",
            "SEE",
          ]) {
            if (
              !this.getClip(`${team}.${role}.${action}.${heading}`).frames
                .length
            )
              throw Error(
                `Missing athlete clip: ${team}.${role}.${action}.${heading}`,
              );
          }
    for (const name of ["arena.polished", "orb.0", "goal.post.polished"])
      if (this.atlas.texture(name) === Texture.EMPTY)
        throw Error(`Missing polished court art: ${name}`);
    if (this.getClip("arena.fire").frames.length < 2)
      throw Error("Missing generated animated flame clip");
    this.image("arena.polished", "arena.polished", this.ground, 0, 0);
    this.image("sports.floor", "sports.floor.volley", this.ground, 0, 0).visible = false;
    this.ground.addChild(this.sportScenery);
    this.addTeamBanners("rear", this.ground);
    for (let i = 0; i < 24; i++) {
      const segment = new Graphics();
      this.netSegments.push(segment);
      this.actors.addChild(segment);
    }
    for (const team of assetPrefixes)
      for (const action of ["idle", "run", "slide", "slide-recover", "trap", "pass", "kick", "receive", "set", "spike", "dig", "dive", "dive-recover"])
        for (const heading of ["E", "SE", "S", "SW", "W", "NW", "N", "NE"])
          if (!this.getClip(`sports.${team}.${action}.${heading}`).frames.length)
            throw Error(`Missing weapon-free sports clip: ${team}.${action}.${heading}`);
    this.stage.canvas.dataset.sportAtlasReady = "true";
    // Extracted spectator pose groups sit on painted rear terrace steps.
    for (const [i, p] of [[100,96],[160,113],[480,113],[540,96]].entries())
      this.image(`crowd.polished.${i}`, `crowd.polished.${i}`, this.ground, p[0], p[1]);
    this.ground.addChild(this.marks, this.specialMarks);
    this.actors.addChild(this.trails);
    // Foreground masonry/post cutouts sit above actors; the floor remains unobscured.
    if (this.atlas.texture("arena.foreground") !== Texture.EMPTY)
      this.image("arena.foreground", "arena.foreground", this.overlay, 0, 0);
    this.addTeamBanners("front", this.overlay);
    // Nets and crossbars are scenery behind athletes, not a screen-space overlay.
    this.ground.addChild(this.goalNet);
    this.paintRegisteredGoals();
    this.loaded = true;
    progress?.(1);
  }
  /** The same observation identity drives athletes, HUD and both wall planes.
   * Opaque generated cloth replaces every baked colored flag, including its motif. */
  private addTeamBanners(layer: "rear" | "front", parent: Container) {
    for (const side of [0, 1]) {
      const sprite = new Sprite();
      parent.addChild(sprite);
      this.bannerSprites.set(`${side}.${layer}`, sprite);
    }
  }
  private updateTeamBanners(s: Observation) {
    const ids = s.teamIds ?? DEFAULT_TEAM_IDS;
    for (const side of [0, 1] as const)
      for (const layer of ["rear", "front"] as const) {
        const sprite = this.bannerSprites.get(`${side}.${layer}`);
        if (sprite) {
          const name = `banners.${ids[side]}.${side}.${layer}`;
          sprite.texture = this.bannerAtlas.texture(name);
          const pivot = this.bannerAtlas.manifest?.frames[name]?.pivot;
          sprite.pivot.set(pivot?.x ?? 0, pivot?.y ?? 0);
        }
      }
    this.stage.canvas.dataset.bannerTeams = ids.join(",");
  }
  /** Reproject the goal assembly onto the same end planes as ball collisions.
   * Painted background cages are decorative architecture; these framed mouths score. */
  private paintRegisteredGoals() {
    const g = this.goalNet;
    g.clear();
    for (const side of [-1, 1]) {
      const point = (u: number, v: number, z = 0) => {
        const p = projectCourt(side * u, v);
        return { x: p.x, y: p.y - z };
      };
      const frontFar = point(COURT.halfLength, -COURT.goalHalfMouth);
      const frontNear = point(COURT.halfLength, COURT.goalHalfMouth);
      const backFar = point(COURT.halfLength + COURT.netDepth, -COURT.goalHalfMouth);
      const backNear = point(COURT.halfLength + COURT.netDepth, COURT.goalHalfMouth);
      const height = 38;
      g.moveTo(backFar.x, backFar.y).lineTo(backFar.x, backFar.y - height)
        .lineTo(backNear.x, backNear.y - height).lineTo(backNear.x, backNear.y)
        .closePath().fill({ color: 0x18202c, alpha: 0.65 });
      // Back grille and side returns sit beyond the open scoring plane.
      for (let j = 0; j <= 8; j++) {
        const v = -COURT.goalHalfMouth + j * COURT.goalHalfMouth / 4;
        const a = point(COURT.halfLength + COURT.netDepth, v);
        g.moveTo(a.x, a.y).lineTo(a.x, a.y - height).stroke({ color: 0xb6a485, width: 1, alpha: 0.8 });
      }
      for (let z = 0; z <= height; z += 5)
        g.moveTo(backFar.x, backFar.y - z).lineTo(backNear.x, backNear.y - z)
          .stroke({ color: 0x8c8171, width: 1, alpha: 0.75 });
      for (const v of [-COURT.goalHalfMouth, COURT.goalHalfMouth]) {
        const a = point(COURT.halfLength, v), b = point(COURT.halfLength + COURT.netDepth, v);
        for (const z of [0, 13, height])
          g.moveTo(a.x, a.y - z).lineTo(b.x, b.y - z).stroke({ color: 0xa4967a, width: 1 });
      }
      // A material crossbar joins the exact two physical post centers.
      g.moveTo(frontFar.x, frontFar.y - height).lineTo(frontNear.x, frontNear.y - height)
        .stroke({ color: 0x332f35, width: 5 });
      g.moveTo(frontFar.x, frontFar.y - height).lineTo(frontNear.x, frontNear.y - height)
        .stroke({ color: 0xe0c69b, width: 2 });
      for (const [depth, p] of [["far", frontFar], ["near", frontNear]] as const) {
        const post = this.image(`registered.post.${side}.${depth}`, "goal.post.polished", this.actors, p.x, p.y);
        post.scale.y = height / 28;
        post.zIndex = p.y;
      }
    }
  }
  /** The net is split by floor depth so nearer athletes can cover its far mesh. */
  private paintSport(sport: SportId) {
    const volley = sport === "rift-volley";
    this.sprites.get("sports.floor")!.visible = volley || isNewMode(sport);
    const ice = this.sprites.get("hockey.floor");
    if (ice) ice.visible = sport === "cryptcheck";
    const closed = volley || isNewMode(sport);
    this.goalNet.visible = !closed;
    for (const [key, sprite] of this.sprites)
      if (key.startsWith("registered.post.")) sprite.visible = !closed;
    const g = this.sportScenery;
    g.clear();
    const line = (a: ReturnType<typeof projectCourt>, b: ReturnType<typeof projectCourt>, alpha = .45) =>
      g.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({color: 0xd9cdb1, width: 1, alpha});
    for (const mesh of this.netSegments) mesh.clear();
    if (sport === "cryptcheck") {
      const rinkLine = (points: {x: number; y: number}[], color: number, alpha = .5, fill = false) => {
        const projected = points.flatMap(p => { const q = projectCourt(p.x,p.y); return [q.x,q.y]; });
        g.poly(projected, fill).stroke({color, width: 1, alpha});
        if (fill) g.fill({color, alpha: .07});
      };
      rinkLine([{x:0,y:-COURT.halfWidth},{x:0,y:COURT.halfWidth}],0xa75772,.55);
      rinkLine(Array.from({length:65},(_,i)=>({x:24*Math.cos(i/64*Math.PI*2),y:24*Math.sin(i/64*Math.PI*2)})),0xa75772,.48);
      const center = projectCourt(0,0);
      g.circle(center.x,center.y,1.5).fill({color:0xa75772,alpha:.7});
      for (const side of [-1,1]) {
        rinkLine([{x:side*COURT.halfLength,y:-COURT.halfWidth},{x:side*COURT.halfLength,y:COURT.halfWidth}],0xa75772,.5);
        rinkLine(Array.from({length:33},(_,i)=>({x:side*(COURT.halfLength-20*Math.sin(i/32*Math.PI)),y:(COURT.goalHalfMouth+4)*Math.cos(i/32*Math.PI)})),0x6090a6,.6,true);
      }
      return;
    }
    if (!closed) return;
    for (const y of [-COURT.halfWidth, COURT.halfWidth])
      line(projectCourt(-COURT.halfLength, y), projectCourt(COURT.halfLength, y));
    for (const x of (sport === "crypt-guardian" ? [-COURT.halfLength, COURT.halfLength] : [-COURT.halfLength, 0, COURT.halfLength]))
      line(projectCourt(x, -COURT.halfWidth), projectCourt(x, COURT.halfWidth));
    // Short attack lines are muted and registered to world coordinates.
    if (volley) for (const x of [-55, 55]) line(projectCourt(x, -COURT.halfWidth), projectCourt(x, COURT.halfWidth), .2);
    // Solid masonry physically seals the old goal mouths in this mode.
    for (const side of [-1, 1]) {
      const a = projectCourt(side * COURT.halfLength, -COURT.goalHalfMouth);
      const b = projectCourt(side * COURT.halfLength, COURT.goalHalfMouth);
      g.poly([a.x,a.y,a.x,a.y-35,b.x,b.y-35,b.x,b.y]).fill(0x4b455b).stroke({color:0x9b8a7d,width:2});
      for (const z of [9,18,27])
        g.moveTo(a.x,a.y-z).lineTo(b.x,b.y-z).stroke({color:0x29283a,width:2});
      const mid = {x:(a.x+b.x)/2,y:(a.y+b.y)/2};
      g.moveTo(mid.x,mid.y).lineTo(mid.x,mid.y-35).stroke({color:0x29283a,width:1});
    }
    if (sport === "crypt-dodge") {
      for (const x of [-20, 20]) line(projectCourt(x, -COURT.halfWidth), projectCourt(x, COURT.halfWidth), .6);
      const p = projectCourt(0, 0);
      g.ellipse(p.x, p.y, 5, 3).stroke({color: 0xe9bd81, width: 1});
    }
    if (!volley) return;
    for (let i = 0; i < this.netSegments.length; i++) {
      const mesh = this.netSegments[i];
      const a = projectCourt(0,-COURT.halfWidth+i*2*COURT.halfWidth/24);
      const b = projectCourt(0,-COURT.halfWidth+(i+1)*2*COURT.halfWidth/24);
      const h = VOLLEY_RULES.netHeight;
      mesh.zIndex = (a.y+b.y)/2;
      // This camera sees the physical center plane edge-on. A narrow spectral
      // thickness makes its mesh readable without moving the registered plane.
      mesh.poly([a.x-4,a.y,a.x+4,a.y-h,b.x+4,b.y-h,b.x-4,b.y])
        .fill({color:0x7fcacb,alpha:.055});
      for (const z of [0,6,12,18,h])
        mesh.moveTo(a.x-4+8*z/h,a.y-z).lineTo(b.x-4+8*z/h,b.y-z)
          .stroke({color:0xb8e8df,width:z===h?1.5:1,alpha:z===h?.75:.22});
      mesh.moveTo(a.x-4,a.y).lineTo(a.x+4,a.y-h)
        .stroke({color:0xc4e6dc,width:1,alpha:.3});
      mesh.moveTo(a.x+4,a.y-h).lineTo(b.x-4,b.y)
        .stroke({color:0xa7dedb,width:1,alpha:.18});
      if (i===0 || i===23) {
        const p=i===0?a:b;
        mesh.moveTo(p.x,p.y+2).lineTo(p.x,p.y-h-5).stroke({color:0x302c3b,width:5});
        mesh.moveTo(p.x,p.y+1).lineTo(p.x,p.y-h-5).stroke({color:0xd7b68b,width:2});
      }
    }
  }
  private paintLanding(s: Observation) {
    const radius=ballVisual(s.sportId,0,s.tick).radius;
    if (s.ball.z/256<=radius || s.phase!=="play") return;
    const landing=predictVolleyLanding(s.ball);
    if (!landing.landed) return;
    const x=landing.x/256, y=landing.y/256;
    if (Math.abs(x)>COURT.halfLength || Math.abs(y)>COURT.halfWidth) return;
    const p=projectCourt(x,y);
    this.marks.ellipse(p.x,p.y,radius+1,(radius+1)*.5).stroke({color:0xf5dca8,width:1,alpha:.55});
    this.marks.circle(p.x,p.y,1).fill({color:0xf5dca8,alpha:.65});
  }
  private getClip(id: string) {
    let clip = this.clipCache.get(id);
    if (!clip) {
      clip = (id.startsWith("new.") ? this.newAtlas : id.startsWith("hockey.") ? this.hockeyAtlas : id.startsWith("balls.") ? this.ballAtlas : id.startsWith("sports.") ? this.sportAtlas : this.atlas).clip(id);
      this.clipCache.set(id, clip);
    }
    return clip;
  }
  private image(
    key: string,
    frame: string,
    parent: Container,
    x: number,
    y: number,
  ) {
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = new Sprite();
      parent.addChild(sprite);
      this.sprites.set(key, sprite);
    }
    const atlas = frame.startsWith("new.") ? this.newAtlas : frame.startsWith("hockey.") ? this.hockeyAtlas : frame.startsWith("balls.") ? this.ballAtlas : frame.startsWith("sports.") ? this.sportAtlas : this.atlas;
    const meta = atlas.manifest?.frames[frame];
    sprite.texture = atlas.texture(frame);
    sprite.pivot.set(
      (meta?.pivot?.x ?? 0) - (meta?.trim?.x ?? 0),
      (meta?.pivot?.y ?? 0) - (meta?.trim?.y ?? 0),
    );
    sprite.position.set(Math.round(x), Math.round(y));
    sprite.visible = true;
    return sprite;
  }
  private text(
    key: string,
    value: string,
    x: number,
    y: number,
    size = 10,
    color = 0xf4e8cd,
  ) {
    let text = this.labels.get(key);
    if (!text) {
      text = new Text({
        text: value,
        style: {
          fontFamily: "monospace",
          fontSize: size,
          fontWeight: "bold",
          fill: color,
          align: "center",
        },
      });
      text.anchor.set(0.5);
      this.hud.addChild(text);
      this.labels.set(key, text);
    }
    text.text = value;
    text.position.set(x, y);
    return text;
  }
  setDebug(value: boolean) {
    this.debug = value;
  }
  setFps(value: number) {
    if (Number.isFinite(value) && value >= 0) this.fps = value;
  }
  /** Only hockey selection leases its independent pages; concurrent menu/start
   * requests share one load and never mutate the other modes' atlas leases. */
  async loadSport(sport: SportId): Promise<void> {
    if (this.disposed) return;
    if (isNewMode(sport)) {
      this.newReady ??= this.newAtlas.loadUrl(`${import.meta.env.BASE_URL}assets/cryptball-new-modes/manifest.json`).then(() => {
        if (this.disposed) return;
        const frames = this.newAtlas.manifest?.frames ?? {};
        if (Object.keys(frames).length !== 448) throw Error("Incomplete new-mode atlas");
        for (const [name, frame] of Object.entries(frames)) {
          if (this.newAtlas.texture(name) === Texture.EMPTY) throw Error(`Missing mode art: ${name}`);
          if (name.startsWith("new.guardian.") && !(frame.anchors as Record<string, {x:number;y:number}> | undefined)?.weapon) throw Error(`Missing guardian socket: ${name}`);
        }
        this.newLoaded = true;
        this.stage.canvas.dataset.newModesAtlasReady = "true";
      }).catch(error => { this.newReady = undefined; this.newAtlas.dispose(); this.newAtlas = new AtlasLoader(); throw error; });
      return this.newReady;
    }
    if (sport !== "cryptcheck") return;
    this.hockeyReady ??= this.hockeyAtlas.loadUrl(`${import.meta.env.BASE_URL}assets/cryptball-hockey/manifest.json`).then(() => {
      if (this.disposed) return;
      for (const team of assetPrefixes)
        for (const action of ["idle", "glide", "skate", "burst", "stickhandle", "wrist", "pass", "slap", "slap-hold", "poke", "shoulder", "stop", "recover", "receive", "recoil"])
          for (const heading of ["E", "SE", "S", "SW", "W", "NW", "N", "NE"])
            if (!this.getClip(`hockey.${team}.${action}.${heading}`).frames.length)
              throw Error(`Missing hockey clip: ${team}.${action}.${heading}`);
      for (let i = 0; i < 4; i++)
        if (this.hockeyAtlas.texture(`hockey.puck.${i}`) === Texture.EMPTY)
          throw Error(`Missing rigid puck frame: ${i}`);
      const floor = this.image("hockey.floor", "hockey.floor", this.ground, 0, 0);
      floor.visible = false;
      this.ground.setChildIndex(floor, 1);
      this.hockeyLoaded = true;
      this.sport = null;
      this.stage.canvas.dataset.hockeyAtlasReady = "true";
    });
    return this.hockeyReady;
  }
  /** Upload every team/effect variant while loading, before semantic time starts. */
  async prewarm(observation: Observation): Promise<void> {
    await this.loadSport(observation.sportId);
    if (this.disposed) return;
    const warmSprites: Sprite[] = [];
    for (const atlas of [this.atlas, this.sportAtlas, this.ballAtlas, this.hockeyAtlas, this.newAtlas]) {
      const pages = new Set<string>();
      for (const [id, frame] of Object.entries(atlas.manifest?.frames ?? {})) {
        if (pages.has(frame.pageId)) continue;
        pages.add(frame.pageId);
        const sprite = new Sprite(atlas.texture(id));
        sprite.position.set(0, 0);
        this.hud.addChild(sprite);
        warmSprites.push(sprite);
      }
    }
    this.stage.render(0);
    for (const sprite of warmSprites) sprite.destroy();
    for (let team = 0; team < 2; team++) {
      const scene = structuredClone(observation);
      scene.tick = 0;
      scene.phase = "goal";
      scene.ball.lastTouch = scene.players.find((p) => p.team === team)?.id ?? null;
      for (const [i, p] of scene.players.entries()) {
        p.charging = i === 0;
        p.chargeTicks = 24;
        p.staggerTicks = i === 1 ? 5 : 0;
        p.dashTicks = i === 2 ? 5 : 0;
        if (i === 3)
          p.action = {
            id: 999,
            kind: "strike",
            elapsed: 5,
            timing: { tell: 4, active: 3, recover: 9 },
            hits: [],
            heading: p.heading,
          };
      }
      this.lastTick = -1;
      this.render(
        scene,
        [
          "strike",
          "pass",
          "dash",
          "goal",
          "check",
          "whiff",
          "post",
          "board",
          "clash",
        ].map((type) => ({ type, tick: 0, team: team as 0 | 1, x: 0, y: 0 })),
        false,
      );
      this.stage.render(0);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      this.clearTransient();
    }
    this.render(observation, [], false);
    this.stage.render(0);
  }
  private clearTransient() {
    this.seenEvents.clear();
    this.ballContact = undefined;
    this.ballContacts.clear();
    this.contacts.clear();
    this.history = [];
    this.orbTravel = 0;
    this.goalUntil = 0;
    this.postFlashUntil = 0;
    this.fx.clear();
    for (const e of this.spriteEffects) e.player.sprite.destroy();
    this.spriteEffects = [];
    this.lastTick = -1;
    this.defeatElapsed = 0;
    this.guardianHitUntil = -1;
    this.guardianImpact = null;
  }
  render(
    s: Observation,
    events: readonly CryptballEvent[] = [],
    reducedMotion = false,
    playerNames: Readonly<Record<string,string>> = {},
    presentationTick = s.tick,
  ) {
    if (!this.loaded || this.disposed || s.sportId === "cryptcheck" && !this.hockeyLoaded || isNewMode(s.sportId) && !this.newLoaded) return;
    for (const [key,label] of this.labels) if (key.startsWith("player-name.")) label.visible = false;
    const renderTime = performance.now();
    this.renderDelta = Math.max(0,Math.min(50,renderTime-this.lastRenderTime));
    this.lastRenderTime = renderTime;
    if (this.sport !== s.sportId) {
      this.clearTransient();
      this.sport = s.sportId;
      this.paintSport(s.sportId);
    }
    this.updateTeamBanners(s);
    this.stage.canvas.dataset.sportId = s.sportId;
    this.stage.canvas.dataset.ballHeight = String(s.ball.z / 256);
    if (s.tick < this.lastTick) {
      this.seenEvents.clear();
      this.ballContact = undefined;
    this.ballContacts.clear();
      this.contacts.clear();
      this.history = [];
      this.orbTravel = 0;
      this.goalUntil = 0;
      this.postFlashUntil = 0;
      this.fx.clear();
      for (const e of this.spriteEffects) e.player.sprite.destroy();
      this.spriteEffects = [];
    }
    const colors = (s.teamIds ?? DEFAULT_TEAM_IDS).map((id) => Number.parseInt(TEAMS[id].color.slice(1), 16));
    const advanced = s.tick !== this.lastTick;
    // Confirmed online contacts can arrive while the predicted render tick stays
    // unchanged. Intake depends on event identity, never on frame advancement.
    events = events.filter((event) => {
      const key = Number.isSafeInteger(event.epoch) && Number.isSafeInteger(event.counter)
        ? `${event.epoch}:${event.counter}:${event.ballId ?? ""}:${event.actionId ?? ""}` : JSON.stringify(event);
      if (this.seenEvents.has(key)) return false;
      this.seenEvents.add(key);
      return true;
    });
    while (this.seenEvents.size > 512) this.seenEvents.delete(this.seenEvents.values().next().value!);
    if (advanced || events.length) {
      for (const event of events) {
        if (event.type === "goal" || event.type === "rally-point") {
          const scorer = s.players.find(p=>p.id===event.playerId && p.team===event.team);
          if (scorer) this.cheers.set(scorer.id,renderTime);
        }
        if (event.type === "dodge-round-end" || event.type === "guardian-victory")
          for (const p of s.players) if (s.guardian || p.team===event.winner) this.cheers.set(p.id,renderTime);
      }
      for (const event of events) if (isBallContact(event) && typeof event.ballId === "string") this.ballContacts.set(event.ballId,event);
      for (const event of events) if (isBallContact(event) && (event.ballId === undefined || event.ballId === "dodge-0" || event.ballId === "guardian-0") &&
        (!this.ballContact || event.tick > this.ballContact.tick ||
          event.tick === this.ballContact.tick && Number(event.counter ?? 0) >= Number(this.ballContact.counter ?? 0)))
        this.ballContact = event;
      for (const event of events)
        if (event.playerId && (event.type === "volley-contact" || event.type === "trap" || event.type === "puck-contact" || event.type === "ice-stop" || event.type === "skate-push" || event.type === "check" || event.type.startsWith("dodge-") || event.type.startsWith("guardian-"))) {
          const previous=this.contacts.get(event.playerId);
          if (!previous || event.tick >= previous.tick) this.contacts.set(event.playerId, (event.type.startsWith("dodge-") || event.type.startsWith("guardian-")) ? {...event,presentationTick:s.tick} : event);
        }
      for (const e of events) if(e.type === "guardian-hit" && typeof e.x === "number" && typeof e.y === "number") {
        this.guardianImpact = {x:e.x,y:e.y,until:s.tick+10,blocked:Number(e.damage)===0};
        if(Number(e.damage)>0) this.guardianHitUntil=s.tick+8;
      }
      if (events.some((e) => e.type === "post"))
        this.postFlashUntil = s.tick + 5;
      if (events.some((e) => e.type === "goal" || e.type === "rally-point")) this.goalUntil = s.tick + 54;
      const effectEvents = s.sportId === "cryptcheck" ? events.filter(e => !["strike", "pass", "slide", "dash"].includes(e.type)) : events;
      this.fx.emit(effectEvents, reducedMotion, colors);
      for (const e of events) {
        const kinds: Record<string, string> = {
          strike: "swoosh",
          pass: "pass",
          dash: "dust",
          slide: "dust",
          "keeper-dive": "dust",
          "slide-contact": "impact",
          save: "impact",
          goal: "goal",
          check: "impact",
          whiff: "whiff",
          trap: "pass",
          "volley-contact": "impact",
          "rally-point": "goal",
          "puck-contact": "contact",
          "ice-stop": "spray",
        };
        const hockey = s.sportId === "cryptcheck";
        // Hockey receipts already identify contact; suppress legacy soccer dust
        // and duplicate strike/pass receipts from the shared attribution path.
        if (hockey && ["strike", "pass", "slide", "dash", "trap"].includes(e.type)) continue;
        const kind = kinds[e.type];
        if (!kind || reducedMotion || this.spriteEffects.length >= 16) continue;
        const player = new ClipPlayer(),
          p = projectCourt((e.x ?? 0) / 256, (e.y ?? 0) / 256);
        player.sprite.tint = hockey && ["puck-contact", "ice-stop"].includes(e.type) || e.type === "volley-contact" ? 0xffffff : colors[e.team === 1 ? 1 : 0];
        this.overlay.addChild(player.sprite);
        this.spriteEffects.push({
          player,
          clip: hockey && ["puck-contact", "ice-stop"].includes(e.type) ? `hockey.fx.${kind}` : e.type === "volley-contact" ? `balls.fx.${volleyContactKind(e)}` : `fx.${e.team === 1 ? "ember" : "ivory"}.${kind}`,
          born: e.tick,
          life: e.type === "goal" || e.type === "rally-point" ? 40 : e.type === "volley-contact" ? 12 : 18,
          x: p.x,
          y: p.y - (hockey || e.type === "volley-contact" ? 0 : 5) - (typeof e.height === "number" ? e.height / 256 : 0),
        });
      }
      if (advanced) {
        const previous = this.history[0];
        if (previous) {
          const distance = Math.hypot(
            s.ball.x / 256 - previous.x,
            s.ball.y / 256 - previous.y,
          );
          if (distance < 12) this.orbTravel += distance;
        }
        this.history.unshift({ x: s.ball.x / 256, y: s.ball.y / 256, z: s.ball.z / 256 });
        this.history.length = Math.min(this.history.length, 5);
      }
    }
    this.lastTick = s.tick;
    this.marks.clear();
    this.trails.clear();
    this.polish.clear();
    for (const cp of this.clips.values()) cp.sprite.visible = false;
    for (const [key, sprite] of this.sprites)
      if (
        key.startsWith("ball.extra.") ||
        key.startsWith("mode.") ||
        key.startsWith("shadow.") ||
        key.startsWith("badge.") ||
        key.startsWith("dash.ghost.") ||
        key.startsWith("charge.glow.")
      )
        sprite.visible = false;
    for (const [i, p] of s.players.entries()) {
      if (s.mode === "practice" && s.sportId !== "rift-volley" && !isNewMode(s.sportId) && p.team === 1) continue;
      const foot = projectCourt(p.x / 256, p.y / 256),
        team = TEAMS[(s.teamIds ?? DEFAULT_TEAM_IDS)[p.team]].assetPrefix,
        contact = this.contacts.get(p.id),
        anim = specialPose(p, s, athleteAnimation(p, s, contact)),
        heading = spriteHeading(isNewMode(s.sportId) && ["throw-release", "throw-follow", "pass-release"].includes(anim.clip) && typeof contact?.heading === "number" ? contact.heading : athleteHeading(p, s));
      const shadow = this.image(
        `shadow.${p.id}`,
        "shadow",
        this.ground,
        foot.x,
        foot.y,
      );
      shadow.visible = true;
      shadow.scale.set(
        1 + (reducedMotion ? 0 : Math.sin(p.distance / 3000) * 0.05),
        1,
      );
      const badge = this.image(
        `badge.${p.id}`,
        "badge.ivory",
        this.ground,
        foot.x,
        foot.y,
      );
      badge.tint = colors[p.team];
      badge.alpha = 0.75;
      badge.visible = true;
      let cp = this.clips.get(p.id);
      if (!cp) {
        cp = new ClipPlayer();
        this.clips.set(p.id, cp);
        this.actors.addChild(cp.sprite);
      }
      cp.sample(
        this.getClip(athleteClipId(s.sportId, team, p.archetype, anim.clip, heading)),
        anim.phase,
        anim.instance,
      );
      cp.sprite.visible = true;
      cp.sprite.position.set(Math.round(foot.x), Math.round(foot.y - (anim.lift ?? 0)));
      const cheer = this.cheers.get(p.id);
      if (cheer !== undefined) {
        const elapsed = renderTime-cheer;
        if (elapsed >= 650) this.cheers.delete(p.id);
        else if (!reducedMotion) cp.sprite.y -= Math.round(Math.sin(elapsed/650*Math.PI)*7);
      }
      if (playerNames[p.id]) {
        const label=this.text(`player-name.${p.id}`,playerNames[p.id]!,foot.x,cp.sprite.y-65,10,0xffffff);
        label.style.dropShadow={color:0x080a13,alpha:1,blur:0,angle:Math.PI/2,distance:2};
        label.visible=true;
      }
      cp.sprite.zIndex = foot.y + i * 0.001;
      cp.sprite.tint =
        p.immunityTicks > 0 && s.tick % 8 < 3 ? 0xd0edff : 0xffffff;
      cp.sprite.alpha = s.dodge?.athletes[p.id]?.lives === 0 || s.guardian?.athletes[p.id]?.status !== undefined && s.guardian.athletes[p.id].status !== "active" ? .3 : 1;
      if (this.debug && s.sportId === "cryptcheck") {
        const tip = cp.sampledAnchors?.weaponTip;
        if (tip) this.polish.circle(foot.x + tip.x - cp.sampledPivot.x, foot.y + tip.y - cp.sampledPivot.y, 2)
          .stroke({color:0xff87d7,width:1,alpha:.9});
        const anchor = bladeAnchor(p, undefined, athleteHeading(p, s));
        const blade = projectCourt(anchor.x/256, anchor.y/256);
        this.polish.circle(blade.x,blade.y,2).stroke({color:0x96ffb4,width:1,alpha:.9});
      }
      if (p.charging && p.chargeTicks >= 24) {
        // A small silhouette halo stays attached to the actual pose and is
        // visible to both teams from replicated charge state. No extra events.
        const pulse = reducedMotion ? 0.4 : 0.32 + 0.12 * Math.sin(presentationTick * 0.12);
        for (const [j, offset] of [[-1, 0], [1, 0], [0, -1], [0, 1]].entries()) {
          const key = `charge.glow.${p.id}.${j}`;
          let glow = this.sprites.get(key);
          if (!glow) {
            glow = new Sprite();
            this.sprites.set(key, glow);
            this.actors.addChild(glow);
          }
          glow.texture = cp.sprite.texture;
          glow.pivot.copyFrom(cp.sprite.pivot);
          glow.position.set(Math.round(foot.x) + offset[0], Math.round(foot.y) + offset[1]);
          glow.zIndex = cp.sprite.zIndex - 0.0001;
          glow.tint = 0xffdc83;
          glow.blendMode = "add";
          glow.alpha = pulse;
          glow.visible = true;
        }
        for (let j = 0; j < 3; j++) {
          const rise = reducedMotion ? j * 5 : (Math.floor(presentationTick / 3) + j * 7) % 18;
          this.polish.rect(foot.x + (j - 1) * 10, foot.y - 25 - rise, 1, 2)
            .fill({ color: 0xffe7a0, alpha: 0.8 });
        }
      }
      if ((p.dashTicks > 0 || p.slideTicks > 0) && !reducedMotion) {
        for (let j = 1; j <= 2; j++) {
          const g = projectCourt(
              (p.x - p.vx * 0.025 * j) / 256,
              (p.y - p.vy * 0.025 * j) / 256,
            ),
            key = `dash.ghost.${p.id}.${j}`;
          let ghost = this.sprites.get(key);
          if (!ghost) {
            ghost = new Sprite();
            this.actors.addChild(ghost);
            this.sprites.set(key, ghost);
          }
          ghost.texture = cp.sprite.texture;
          ghost.pivot.copyFrom(cp.sprite.pivot);
          ghost.position.set(Math.round(g.x), Math.round(g.y));
          ghost.zIndex = g.y - 0.01;
          ghost.alpha = 0.22 / j;
          ghost.tint = colors[p.team];
          ghost.visible = true;
        }
      }
      if (p.id === s.controlledId) {
        const offset = reducedMotion
          ? 0
          : (Math.floor(presentationTick / 8) * Math.PI) / 3;
        for (let segment = 0; segment < 6; segment++) {
          const start = offset + (segment * Math.PI) / 3;
          for (let n = 0; n <= 4; n++) {
            const angle = start + (n * Math.PI) / 18,
              x = foot.x + 10 * Math.cos(angle),
              y = foot.y + 5 * Math.sin(angle);
            if (n === 0) this.marks.moveTo(x, y);
            else this.marks.lineTo(x, y);
          }
          this.marks.stroke({
            color: segment === 0 ? 0xffffff : 0xe8ead7,
            width: 1,
            alpha: segment === 0 ? 1 : 0.7,
          });
        }
        this.image(
          "control.arrow",
          "arrow",
          this.actors,
          foot.x,
          foot.y -
            44 -
            (reducedMotion ? 0 : Math.round(Math.sin(presentationTick * 0.2))),
        ).zIndex = 1000;
        if (p.dashCooldown > 0)
          this.marks
            .arc(
              foot.x,
              foot.y,
              10,
              -Math.PI / 2,
              -Math.PI / 2 + (1 - p.dashCooldown / 66) * Math.PI * 2,
            )
            .stroke({ width: 1, color: colors[p.team], alpha: 0.8 });
        const slideName = s.sportId === "cryptcheck" ? "POKE" : s.sportId === "rift-volley" ? "DIG" : isNewMode(s.sportId) ? "DIVE" : "SLIDE";
        const slideStatus = this.text("slide-ready", p.slideTicks > 0 ? slideName : p.slideRecovery > 0 ? "RECOVER" : p.slideReady > s.tick ? `${slideName} ${Math.ceil((p.slideReady - s.tick) / 60)}s` : `SHIFT / I · ${slideName}`, VIEW.width - 68, VIEW.height - 12, 8, colors[p.team]);
        slideStatus.visible = s.phase === "play" && !isNewMode(s.sportId);
        if (p.charging) {
          this.polish
            .rect(foot.x - 10, foot.y + 7, 20, 3)
            .fill(0x132c39)
            .rect(
              foot.x - 9,
              foot.y + 8,
              Math.round((18 * p.chargeTicks) / 24),
              1,
            )
            .fill(p.chargeTicks >= 20 ? 0xffe49b : colors[p.team]);
        }
      }
      if (p.staggerTicks > 0)
        for (let j = 0; j < 3; j++) {
          const angle = presentationTick * 0.25 + (j * Math.PI * 2) / 3;
          this.polish
            .rect(
              foot.x + Math.cos(angle) * 6,
              foot.y - 38 + Math.sin(angle) * 2,
              2,
              2,
            )
            .fill(0xffe3a0);
        }
      if (p.charging && p.chargeTicks >= 18) {
        const h = (p.heading * Math.PI) / 128,
          tip = projectCourt(
            p.x / 256 + Math.cos(h) * 13,
            p.y / 256 + Math.sin(h) * 13,
          );
        const size = reducedMotion ? 1 : 1 + (Math.floor(presentationTick / 3) % 2);
        this.polish
          .moveTo(tip.x - size, tip.y - 12)
          .lineTo(tip.x + size, tip.y - 12)
          .moveTo(tip.x, tip.y - 12 - size)
          .lineTo(tip.x, tip.y - 12 + size)
          .stroke({ color: 0xffefb3, width: 1 });
      }
      if (
        p.action &&
        p.action.elapsed >= p.action.timing.tell &&
        p.action.elapsed < p.action.timing.tell + p.action.timing.active
      ) {
        const h = ((p.action.heading ?? p.heading) * Math.PI) / 128,
          tip = projectCourt(
            p.x / 256 + Math.cos(h) * 17,
            p.y / 256 + Math.sin(h) * 17,
          );
        this.polish
          .moveTo(foot.x, foot.y - 8)
          .quadraticCurveTo(
            tip.x + (tip.y - foot.y) * 0.4,
            tip.y - 13,
            tip.x,
            tip.y - 2,
          )
          .stroke({
            color: colors[p.team],
            width: p.action.charge ? 2 : 1,
            alpha: 0.8,
          });
      }
    }
    this.stage.canvas.dataset.renderedPlayers = String(
      [...this.clips.values()].filter((clip) => clip.sprite.visible).length,
    );
    const movingClip=this.clips.get(s.controlledId);
    this.stage.canvas.dataset.controlledRunPhase=String(s.players.find(p=>p.id===s.controlledId)?.distance ?? 0);
    this.stage.canvas.dataset.controlledFrame=movingClip ? `${movingClip.sprite.texture.frame.x}:${movingClip.sprite.texture.frame.y}` : '';
    this.stage.canvas.dataset.poweredPlayers = String(
      [...this.sprites.entries()].filter(([key, sprite]) => key.startsWith("charge.glow.") && key.endsWith(".0") && sprite.visible).length,
    );
    const visual = ballVisual(s.sportId, this.orbTravel, presentationTick, this.ballContact, reducedMotion);
    const height = Math.max(0, s.ball.z / 256);
    this.paintNewMode(s, reducedMotion);
    const speed = Math.hypot(s.ball.vx, s.ball.vy) / 256,
      ball = projectCourt(s.ball.x / 256, s.ball.y / 256);
    this.image(
      "ball.shadow",
      "shadow",
      this.ground,
      ball.x,
      ball.y + 1,
    );
    const ballShadow = this.sprites.get("ball.shadow")!;
    ballShadow.scale.set(visual.shadowScale + Math.min(height, 80) / 300, .65 * visual.radius / 3);
    ballShadow.alpha = Math.max(.3, .8 - height / 160);
    ballShadow.visible = !s.dodge?.balls[0].retired;
    if (s.sportId === "rift-volley") this.paintLanding(s);
    if (!reducedMotion && speed > 45 && !s.dodge?.balls[0].retired)
      for (let i = 1; i < this.history.length; i++) {
        const p = projectCourt(this.history[i].x, this.history[i].y);
        this.trails
          .circle(p.x, p.y - visual.groundLift - this.history[i].z, Math.max(0.6, visual.trailRadius - i * 0.3))
          .fill({ color: s.dodge?.ball.powered ? 0xffd071 : s.dodge?.ball.state === "hostile-flight" ? 0xffba7d : 0xdaf7ec, alpha: s.dodge?.ball.state === "friendly-pass" ? i % 2 ? .65 : 0 : (5 - i) * 0.1 });
      }
    this.trails.zIndex = ball.y - 0.01;
    const orb = this.image(
      "ball",
      visual.frame,
      this.actors,
      ball.x,
      ball.y - visual.groundLift - height,
    );
    orb.visible = !s.dodge?.balls[0].retired;
    orb.tint=s.dodge?.ball.state === "hostile-flight" && s.dodge.ball.powered ? 0xffb65e : 0xffffff;
    const holderId = s.dodge?.ball.state === "held" ? s.dodge.ball.holderId : s.guardian ? s.possessionId : null;
    if (holderId) {
      const holder = this.clips.get(holderId);
      if (holder) {
        // Dive source art has no socket metadata; its leading hands are authored
        // explicitly below. Normal carries use the actual sampled pose anchor.
        const p = s.players.find(p => p.id === holderId)!;
        const socket = holder.sampledAnchors?.hand;
        if (socket) orb.position.set(holder.sprite.x + socket.x - holder.sampledPivot.x, holder.sprite.y + socket.y - holder.sampledPivot.y);
        else if (p.slideTicks || p.slideRecovery) {
          const offsets: Record<string, [number,number]> = {E:[24,-9],SE:[23,-5],S:[0,-6],SW:[-23,-5],W:[-24,-9],NW:[-21,-14],N:[0,-17],NE:[21,-14]};
          const [x,y] = offsets[spriteHeading(athleteHeading(p,s))]!;
          orb.position.set(holder.sprite.x+x, holder.sprite.y+y);
        }
      }
    }
    orb.zIndex = (holderId ? this.clips.get(holderId)?.sprite.zIndex ?? ball.y : ball.y) + (height - visual.radius >= VOLLEY_RULES.netHeight ? 25 : .01);
    const dodgePower = !!s.dodge && (s.dodge.ball.state === "hostile-flight" && s.dodge.ball.powered || s.dodge.ball.state === "held" && s.players.some(p=>p.id===s.dodge!.ball.holderId && (p.chargeTicks>=30 || s.dodge!.athletes[p.id].passAssistUntil>s.tick)));
    if (dodgePower || s.guardian?.orbs[0].ballToken && s.guardian.orbs[0].ballToken.damage >= 10) this.polish.circle(orb.x,orb.y,visual.radius+3).stroke({color:0xffd071,width:2});
    if (isNewMode(s.sportId) && orb.visible) this.polish.circle(orb.x,orb.y,visual.radius+2).stroke({color:s.guardian?0xf9da8c:0xffc9a0,width:1,alpha:s.dodge ? .25 : .7});
    this.stage.canvas.dataset.ballPositions = JSON.stringify(s.dodge?.balls.filter(b=>!b.retired).map(b=>({id:b.id,x:b.physical.x,y:b.physical.y,holder:b.mode.holderId})) ?? s.guardian?.orbs.map(b=>({id:b.id,x:b.ball.x,y:b.ball.y,holder:b.possessionId})) ?? []);
    this.stage.canvas.dataset.ballFrame = visual.frame;
    this.stage.canvas.dataset.ballRadius = String(visual.radius);
    // An outlined locator remains legible while an upright athlete covers the orb.
    if (
      s.players.some((p) => {
        const f = projectCourt(p.x / 256, p.y / 256);
        return f.y > ball.y && Math.abs(f.x - ball.x) < 10 && f.y - ball.y < 32;
      })
    )
      this.polish
        .circle(ball.x, ball.y - visual.groundLift - height, visual.locatorRadius)
        .stroke({ color: 0xfff5cb, width: 1, alpha: s.dodge ? 0.25 : 0.9 });
    const extraBalls = s.dodge?.balls.slice(1) ?? s.guardian?.orbs.slice(1).map(orb=>({id:orb.id,physical:orb.ball,retired:false,mode:{state:orb.possessionId?'held':s.tick<orb.hostileUntil?'hostile-flight':'dead-loose',holderId:orb.possessionId,powered:(orb.ballToken?.damage ?? 0)>=10}})) ?? [];
    for (const entry of extraBalls) {
      if (entry.retired) continue;
      const extraVisual=ballVisual(s.sportId,this.orbTravel,presentationTick,this.ballContacts.get(entry.id),reducedMotion);
      const b = entry.physical, pos = projectCourt(b.x / 256, b.y / 256);
      const sprite = this.image(`ball.extra.${entry.id}`, extraVisual.frame, this.actors, pos.x, pos.y - b.z / 256);
      const holder = entry.mode.state === 'held' && entry.mode.holderId ? this.clips.get(entry.mode.holderId) : undefined;
      const socket = holder?.sampledAnchors?.hand;
      if (holder && socket) sprite.position.set(holder.sprite.x + socket.x - holder.sampledPivot.x, holder.sprite.y + socket.y - holder.sampledPivot.y);
      sprite.zIndex = holder ? holder.sprite.zIndex+.02 : pos.y + .02;
      sprite.tint=s.dodge && entry.mode.state === "hostile-flight" && entry.mode.powered ? 0xffb65e : 0xffffff;
      this.polish.circle(sprite.x,sprite.y,visual.radius+2).stroke({color:s.guardian?0xf9da8c:0xffc9a0,width:1,alpha:s.dodge ? .25 : .7});
      const shadow = this.image(`ball.extra.${entry.id}.shadow`, 'shadow', this.ground, pos.x, pos.y + 1);
      shadow.scale.set(visual.shadowScale, .65 * visual.radius / 3);
      const extraPower=s.dodge ? entry.mode.state === "hostile-flight" && entry.mode.powered || entry.mode.state === "held" && s.players.some(p=>p.id===entry.mode.holderId && (p.chargeTicks>=30 || s.dodge!.athletes[p.id].passAssistUntil>s.tick)) : entry.mode.powered;
      if (extraPower) this.polish.circle(sprite.x, sprite.y, visual.radius + 3).stroke({color:0xffd071,width:2});
      if (!reducedMotion && entry.mode.state === 'hostile-flight') for (let i=1;i<5;i++) {
        const tail=projectCourt((b.x-b.vx*i/60)/256,(b.y-b.vy*i/60)/256);
        this.trails.circle(tail.x,tail.y-b.z/256,Math.max(.6,visual.trailRadius-i*.2)).fill({color:entry.mode.powered?0xffd071:0xffba7d,alpha:(5-i)*.12});
      }
    }
    this.stage.canvas.dataset.renderedBalls = String(s.dodge?.balls.filter(b => !b.retired).length ?? s.guardian?.orbs.length ?? 1);
    this.animateStadium(presentationTick, reducedMotion);
    this.fx.render(presentationTick, reducedMotion);
    renderSpecialEffects(this.specialMarks, s, reducedMotion);
    this.spriteEffects = this.spriteEffects.filter((e) => {
      const age = s.tick - e.born;
      if (reducedMotion || age < 0 || age >= e.life) {
        e.player.sprite.destroy();
        return false;
      }
      e.player.sample(
        this.getClip(e.clip),
        age / e.life,
        `${e.clip}:${e.born}`,
      );
      e.player.sprite.position.set(Math.round(e.x), Math.round(e.y));
      e.player.sprite.alpha = 1 - age / e.life;
      return true;
    });
    // Accessible DOM scoreboard and status own text; the atlas supplies their painted backing.
    const debug = this.text(
      "debug",
      this.debug
        ? `${this.fps.toFixed(0)} FPS • T${s.tick} • ${speed.toFixed(0)}px/s • ${s.players.map((p) => p.aiRole).join("/")}`
        : "",
      VIEW.originX,
      31,
      7,
    );
    debug.visible = this.debug;
  }
  private paintNewMode(s: Observation, reduced: boolean) {
    for (const [key, label] of this.labels) if (key.startsWith('mode.')) label.visible = false;
    const diamond = (x: number, y: number, filled: boolean, color: number) => {
      this.polish.poly([x,y-3,x+3,y,x,y+3,x-3,y]).stroke({color,width:1});
      if (filled) this.polish.fill({color,alpha:.95});
    };
    for (const [i,p] of s.players.entries()) {
      const d = s.dodge?.athletes[p.id], a = s.guardian?.athletes[p.id];
      if (!d && !a) continue;
      const foot = projectCourt(p.x/256,p.y/256), count=d?.lives??a!.hp, total=d?3:5;
      const color = s.guardian ? 0xa8eee1 : p.team === 0 ? 0xa8eee1 : 0xffb28e;
      for(let n=0;n<total;n++) diamond(foot.x+(n-(total-1)/2)*7,foot.y-49,count>n,color);

      if (d && !d.lives || a && a.status !== 'active') {
        const soul=this.image(`mode.soul.${p.id}`,'new.object.soul',this.actors,foot.x,foot.y-(reduced?7:7+Math.sin(s.tick/12)*2));soul.zIndex=foot.y+1;soul.alpha=a?.status==='down'?1:.55;
        this.polish.ellipse(foot.x,foot.y,11,5).stroke({color:0xc9a2f2,width:1});
        if(a?.reviveTicks) this.polish.arc(foot.x,foot.y-14,9,-Math.PI/2,-Math.PI/2+Math.PI*2*a.reviveTicks/90).stroke({color:0xa8eee1,width:2});
      }
      if (d?.catchKind && s.tick-d.catchStart<14) this.polish.ellipse(foot.x,foot.y-17,13,8).stroke({color:0xd5f7f0,width:2,alpha:.8});
    }
    const controlled=s.players.find(p=>p.id===s.controlledId);
    const carrying=!!s.dodge?.balls.some(b=>!b.retired && b.mode.holderId===s.controlledId) || !!s.guardian && (s.guardian.orbs?.some(b=>b.possessionId===s.controlledId) ?? s.possessionId===s.controlledId);
    if(controlled && carrying) {
      const ally=s.guardian ? guardianPassTarget(s,controlled) : s.players.find(p=>p.team===controlled.team && p.id!==controlled.id && !!s.dodge?.athletes[p.id]?.lives && !s.dodge.balls.some(b=>b.mode.holderId===p.id));
      if(ally) {const f=projectCourt(ally.x/256,ally.y/256);this.polish.ellipse(f.x,f.y,15,7).stroke({color:0xaff4dc,width:2});this.text('mode.pass-target','PASS',f.x,f.y-58,8,0xaff4dc);}

    }
    if(s.dodge) {
      const d=s.dodge;
      for(const entry of d.balls) {
        if(entry.retired)continue;
        const holder=s.players.find(p=>p.id===entry.mode.holderId);
        if(!holder)continue;
        const left=Math.max(0,entry.possessionDeadline-s.tick);
        const sprite=this.sprites.get(entry.id === "dodge-0" ? "ball" : `ball.extra.${entry.id}`);
        if(sprite && left>0) {
          const radius=7, fraction=Math.min(1,left/360);
          this.polish.moveTo(sprite.x,sprite.y-radius).arc(sprite.x,sprite.y,radius,-Math.PI/2,-Math.PI/2+Math.PI*2*fraction).stroke({color:left<120?0xffa45e:0xf6d79d,width:1.5,alpha:left<120?.9:.35});
        }
      }
      this.stage.canvas.dataset.dodgeLives=s.players.map(p=>d.athletes[p.id].lives).join(',');
      this.stage.canvas.dataset.dodgeBall=d.ball.state;
      this.stage.canvas.dataset.dodgeRound=String(d.round);
      return;
    }
    const g=s.guardian;if(!g)return;
    const d=g.descriptor, foot=projectCourt(d.x/256,d.y/256), scale=d.size/100;
    if (g.outcome !== "victory") this.defeatElapsed = 0; else this.defeatElapsed += this.renderDelta;
    const pose = g.outcome === "victory" ? reduced ? "rubble" : ["hit", "stun", "defeat", "rubble"][Math.min(3, Math.floor(this.defeatElapsed / 300))]! : guardianPose(s),frame=`new.guardian.${d.palette}.${pose}`;
    const boss=this.image('mode.guardian',frame,this.actors,foot.x,foot.y);boss.scale.set(scale);boss.zIndex=foot.y;boss.tint=s.tick<this.guardianHitUntil && !g.outcome?0xffe1a4:0xffffff;
    if (this.guardianImpact && s.tick<this.guardianImpact.until && !g.outcome) {
      const point=projectCourt(this.guardianImpact.x/256,this.guardianImpact.y/256);
      const impact=this.image("mode.boss-impact","new.object.impact",this.actors,point.x,point.y-3);
      impact.zIndex=Math.max(foot.y,point.y)+.3;
      impact.tint=this.guardianImpact.blocked?0x9bcfff:0xffdc91;
      impact.scale.set(this.guardianImpact.blocked?.7:1.15);
    }
    const deflectionCues=guardianDeflectionCues(s);
    for(const cue of deflectionCues) {
      const point=projectCourt(cue.x/256,cue.y/256),pulse=reduced?0:Math.sin(s.tick*Math.PI/6)*2;
      this.polish.circle(point.x,point.y-cue.z/256,11+pulse).stroke({color:0xffe49d,width:3,alpha:1});
      this.text(`mode.deflect.${cue.id}`,'RETURN',point.x,point.y-cue.z/256-21,8,0xffe49d);
    }
    this.stage.canvas.dataset.guardianDeflectionOrbs=deflectionCues.map(cue=>cue.id).join(',');
    const guardAngle = g.guardHeading * Math.PI / 128;
    const guardTip = projectCourt(d.x / 256 + Math.cos(guardAngle)*34, d.y / 256 + Math.sin(guardAngle)*34);
    this.stage.canvas.dataset.guardianGuarding=String(guardianIsGuarding(s));
    if (guardianIsGuarding(s)) {
      this.polish.moveTo(foot.x,foot.y-28).lineTo(guardTip.x,guardTip.y-28).stroke({color:deflectionCues.length?0xffdf91:0xa0ded6,width:deflectionCues.length?4:2,alpha:.9});
      this.polish.circle(guardTip.x,guardTip.y-28,4+g.guard/25).stroke({color:0xffdf91,width:2});
    }
    const anchors=this.newAtlas.manifest?.frames[frame]?.anchors as Record<string,{x:number;y:number}> | undefined;
    const pivot=this.newAtlas.manifest?.frames[frame]?.pivot??{x:80,y:112};
    if(g.hp>0 && anchors?.weapon) {
      const socket={x:foot.x+(anchors.weapon.x-pivot.x)*scale,y:foot.y+(anchors.weapon.y-pivot.y)*scale};
      const weaponFrame=`new.object.${d.weapon}`;
      const weapon=this.image('mode.weapon',weaponFrame,this.actors,socket.x,socket.y);
      const meta=this.newAtlas.manifest?.frames[weaponFrame],grip=(meta?.anchors as Record<string,{x:number;y:number}> | undefined)?.grip;
      if(grip)weapon.pivot.set(grip.x-(meta?.trim?.x??0),grip.y-(meta?.trim?.y??0));
      weapon.scale.set(scale*1.35);weapon.zIndex=foot.y+.1;weapon.rotation=0;
      const attack=g.attack,active=attack?attack.elapsed-attack.timing.tell:-1;
      if ((d.weapon === 'cannon' || d.weapon === 'hook') && attack?.shapes.length) {
        const lane = attack.shapes[Math.floor(attack.shapes.length/2)];
        if (lane?.kind === 'lane') { const end=projectCourt(lane.endX/256,lane.endY/256);weapon.rotation=Math.atan2(end.y-socket.y,end.x-socket.x)-Math.PI/2; }
      }
      if (attack && active < 0) {
        const progress = Math.min(1, attack.elapsed / attack.timing.tell);
        const glow = d.weapon === 'cannon' ? 0xffcf7d : 0xf6bda1;
        this.polish.circle(socket.x,socket.y,3+progress*7).stroke({color:glow,width:1+progress*2,alpha:.7});
      }
      if (d.weapon === 'maul' && attack) {
        const diskTarget=attack.shapes.filter(shape=>shape.kind==='disk').find(shape=>active<shape.at+6);
        if (diskTarget?.kind === 'disk' && attack.locked) {
          const target=projectCourt(diskTarget.x/256,diskTarget.y/256);
          const contact=attack.timing.tell+diskTarget.at;
          const approach=Math.max(0,Math.min(1,(attack.elapsed-(contact-30))/30));
          weapon.position.set(socket.x+(target.x-socket.x)*approach,socket.y+(target.y-socket.y)*approach-(active<diskTarget.at?maulApproachLift(approach):0));
          weapon.zIndex=target.y+.1;
        }
        weapon.rotation = active < 0 ? -.65 : active < attack.timing.active ? .55 : 0;
        const disk=attack.shapes.filter(shape=>shape.kind==='disk').find(shape=>active>=shape.at&&active<shape.at+6);
        if (disk?.kind === 'disk') {
          const target=projectCourt(disk.x/256,disk.y/256);
          const impact=this.image('mode.maul-impact','new.object.impact',this.actors,target.x,target.y);impact.scale.set(1.4);impact.zIndex=target.y+.5;
          this.polish.ellipse(target.x,target.y,7,4).stroke({color:0xffdfaf,width:2});
        }
      }
      if(d.weapon==='hook' && attack?.shapes[0]?.kind==='lane' && active>=0 && active<attack.timing.active) {
        const lane=attack.shapes[0],t=active<24?(active+1)/24:(48-active)/24;
        const tip=projectCourt((lane.x+(lane.endX-lane.x)*t)/256,(lane.y+(lane.endY-lane.y)*t)/256);
        const n=Math.min(32,Math.ceil(Math.hypot(tip.x-socket.x,tip.y-socket.y)/6));
        for(let j=0;j<n;j++){const c=this.image(`mode.chain.${j}`,'new.object.chain',this.actors,socket.x+(tip.x-socket.x)*j/n,socket.y+(tip.y-socket.y)*j/n);c.rotation=Math.atan2(tip.y-socket.y,tip.x-socket.x);c.zIndex=foot.y+.08;}
        weapon.position.set(tip.x,tip.y);weapon.rotation=Math.atan2(tip.y-socket.y,tip.x-socket.x)-Math.PI/2;
      }
      if(anchors.crown){const crown=this.image('mode.crown','new.object.crown',this.actors,foot.x+(anchors.crown.x-pivot.x)*scale,foot.y+(anchors.crown.y-pivot.y)*scale);crown.scale.set(scale*.7);crown.zIndex=foot.y+.2;}
    }
    for(const c of g.cover) {
      const p=projectCourt(c.x/256,c.y/256),sprite=this.image(`mode.cover.${c.id}`,`new.object.${c.hp===3?'pillar':c.hp?'pillar-cracked':'pillar-rubble'}`,this.actors,p.x,p.y);
      sprite.zIndex=p.y; const edge=projectCourt((c.x+c.radius)/256,c.y/256); sprite.scale.set((edge.x-p.x)*2 / 38);
      if(c.hp) for(let n=0;n<3;n++) diamond(p.x+(n-1)*5,p.y-35,n<c.hp,0xd4bc9f);
    }
    for(const shot of g.projectiles) {
      const p=projectCourt(shot.x/256,shot.y/256),sprite=this.image(`mode.projectile.${shot.id}`,'new.object.boss-bolt',this.actors,p.x,p.y-7);sprite.zIndex=p.y+1;sprite.scale.set(1.25);
      this.polish.circle(p.x,p.y-7,shot.radius/256+1).stroke({color:0xffd09b,width:1,alpha:.8});
    }
    const attack=g.attack;
    if(attack) {
      const active=attack.elapsed-attack.timing.tell, tell=active<0, recover=active>=attack.timing.active;
      if(s.mode === 'practice' && !recover)for(const shape of attack.shapes) {
        if(!tell && (active<shape.at || active>=shape.at+(['slam','double-slam','proximity'].includes(attack.kind)?6:attack.timing.active)))continue;
        const color=tell?0xffcb78:0xff815e,alpha=tell?.12:.24;
        const point=(x:number,y:number)=>projectCourt(x/256,y/256);
        if(shape.kind==='disk'||shape.kind==='arc') {
          const start=shape.kind==='arc'?0:0,end=shape.kind==='arc'?Math.PI:Math.PI*2;
          const pts=Array.from({length:49},(_,i)=>{const a=start+(end-start)*i/48;return point(shape.x+Math.cos(a)*shape.radius,shape.y+Math.sin(a)*shape.radius);});
          if(shape.kind==='arc')for(let i=48;i>=0;i--){const a=start+(end-start)*i/48;pts.push(point(shape.x+Math.cos(a)*shape.innerRadius,shape.y+Math.sin(a)*shape.innerRadius));}
          this.marks.poly(pts.flatMap(p=>[p.x,p.y])).fill({color,alpha}).stroke({color,width:2});
        } else {
          const t=attack.kind==='hook'&&!tell?(active<24?(active+1)/24:(48-active)/24):1;
          const ex=shape.x+(shape.endX-shape.x)*t,ey=shape.y+(shape.endY-shape.y)*t;
          const dx=ex-shape.x,dy=ey-shape.y,n=Math.hypot(dx,dy)||1,rx=-dy/n*shape.radius,ry=dx/n*shape.radius;
          this.marks.poly([point(shape.x+rx,shape.y+ry),point(ex+rx,ey+ry),point(ex-rx,ey-ry),point(shape.x-rx,shape.y-ry)].flatMap(p=>[p.x,p.y])).fill({color,alpha}).stroke({color,width:1});
        }
      }
      const target=s.players.find(p=>p.id===attack.targetId);
      if(s.mode === 'practice' && tell&&target){
        const shape=attack.shapes[attack.kind==='double-slam'?0:Math.floor(attack.shapes.length/2)];
        const locked=attack.locked && shape ? shape.kind==='lane' ? {x:shape.endX,y:shape.endY} : {x:shape.x,y:shape.y} : target;
        const p=projectCourt(locked.x/256,locked.y/256);this.polish.ellipse(p.x,p.y,12,6).stroke({color:0xffce7f,width:2});const lock=this.text('mode.target',attack.locked?'LOCKED':'TARGET',p.x,p.y-22,8,0xffce7f);lock.visible=true;
      }
    }
    if(g.ballResetTicks){const p=projectCourt(0,26);this.marks.ellipse(p.x,p.y,17,8).stroke({color:0xc0efed,width:2});}
    this.stage.canvas.dataset.guardianGuard=String(g.guard);
    this.stage.canvas.dataset.guardianStagger=String(g.staggerUntil>s.tick);
    this.stage.canvas.dataset.guardianHp=String(g.hp);
    this.stage.canvas.dataset.guardianWeapon=d.weapon;
    this.stage.canvas.dataset.guardianPose=pose;
    this.stage.canvas.dataset.guardianFloorPreviews=String(s.mode==="practice" && !!g.attack);
    this.stage.canvas.dataset.guardianAttack=g.attack?.kind??'idle';
    this.stage.canvas.dataset.guardianHealth=s.players.map(p=>g.athletes[p.id].hp).join(',');
    this.stage.canvas.dataset.guardianCover=g.cover.map(c=>c.hp).join(',');
  }
  private animateStadium(tick: number, reduced: boolean) {
    const sample = (
      id: string,
      clip: string,
      x: number,
      y: number,
      phase: number,
      foreground = false,
      scale = 1,
    ) => {
      let cp = this.ambient.get(id);
      if (!cp) {
        cp = new ClipPlayer();
        this.ambient.set(id, cp);
        (foreground ? this.overlay : this.ground).addChild(cp.sprite);
      }
      cp.sample(this.getClip(clip), phase, clip);
      cp.sprite.position.set(x, y);
      cp.sprite.scale.set(scale);
    };
    // Match generated flames to the eight bowls in the registered static painting.
    // Baked flames are masked in arena.polished by the asset importer.
    const fires = [[60,43],[183,57],[267,59],[373,59],[458,57],[580,43],[27,343],[614,343]];
    if (!this.getClip("arena.fire").frames.length) return;
    for (const [i, p] of fires.entries())
      sample(`arena.fire.${i}`, "arena.fire", p[0], p[1],
        reduced ? 0 : ((tick + i * 5) % 48) / 48, i >= 6,
        i < 6 ? Math.min(0.8, (p[1] - 28) / 40) : 1);

  }
  dispose() {
    this.disposed = true;
    this.fx.dispose();
    this.atlas.dispose();
    this.sportAtlas.dispose();
    this.ballAtlas.dispose();
    this.hockeyAtlas.dispose();
    this.newAtlas.dispose();
    this.bannerAtlas.dispose();
    this.bannerSprites.clear();
    for (const node of [this.ground, this.actors, this.overlay, this.hud])
      node.destroy({ children: true });
    this.clips.clear();
    this.clipCache.clear();
    this.sprites.clear();
    this.labels.clear();
  }
}
