import { Graphics } from "@onepage/game-runtime/pixi";
import type { CryptballEvent } from "./contract";
import { projectCourt } from "./projection";
type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: number;
  size: number;
  gravity: number;
};
/** Presentation-only particles. Authority ticks ensure pause freezes every transient. */
export class CryptballEffects {
  readonly graphics = new Graphics();
  private particles: Particle[] = [];
  private cues: CryptballEvent[] = [];
  emit(
    events: readonly CryptballEvent[],
    reduced: boolean,
    colors: readonly number[] = [0xb1f4ed, 0xff917a],
  ) {
    for (const e of events) {
      if (
        ![
          "dodge-catch", "dodge-ding", "dodge-out", "guardian-hit", "guardian-damage", "guardian-cover-crack", "guardian-cover-break", "guardian-down", "guardian-revive", "guardian-victory",
          "slide",
          "keeper-dive",
          "slide-contact",
          "save",
          "block",
          "perfect-block",
          "power-bank",
          "check-resist",
          "strike",
          "pass",
          "board",
          "post",
          "goal",
          "check",
          "dash",
          "whiff",
          "clash",
          "trap",
          "volley-contact",
          "rally-point",
          "puck-contact",
          "ice-stop",
          "special-success",
          "special-release",
        ].includes(e.type)
      )
        continue;
      this.cues.push(e);
      if (this.cues.length > 32) this.cues.shift();
      const p = projectCourt((e.x ?? 0) / 256, (e.y ?? 0) / 256),
        goal = e.type === "goal" || e.type === "rally-point";
      const n = reduced
        ? 2
        : e.type === "slide" || e.type === "ice-stop"
          ? 0
          : e.type === "special-release"
            ? 3
            : e.type === "special-success"
              ? 6
              : goal
                ? 42
                : e.type === "dash"
                  ? 5
                  : 10;
      const color = ["post", "perfect-block", "power-bank"].includes(e.type)
        ? 0xffe6a0
        : colors[e.team === 1 ? 1 : 0];
      for (let i = 0; i < n && this.particles.length < 112; i++) {
        const a = (i / n) * Math.PI * 2 + (e.tick % 13) * 0.37,
          speed = goal ? 0.3 + (i % 5) * 0.24 : 0.1 + (i % 4) * 0.18;
        this.particles.push({
          x: p.x,
          y: p.y - 3 - (typeof e.height === "number" ? e.height / 256 : 0),
          vx: Math.cos(a) * speed,
          vy: Math.sin(a) * speed - (goal ? 0.6 : 0),
          born: e.tick,
          life: goal ? 40 + (i % 14) : 10 + (i % 8),
          color,
          size: goal ? 1.5 : 1,
          gravity: goal ? 0.025 : 0.006,
        });
      }
    }
  }
  render(tick: number, reduced: boolean) {
    this.graphics.clear();
    this.particles = this.particles.filter(
      (p) => tick - p.born < p.life && tick >= p.born,
    );
    this.cues = this.cues.filter((e) => tick >= e.tick && tick - e.tick < 18);
    for (const e of this.cues) {
      if (e.type === "special-success" || e.type === "special-release") {
        const age = tick - e.tick;
        if (age >= 12) continue;
        const p = projectCourt((e.x ?? 0) / 256, (e.y ?? 0) / 256);
        const alpha = 1 - age / 12;
        if (e.type === "special-success") {
          // An actual interception/reception gets a compact ground ring. The
          // release streak below never claims that a shot connected.
          this.graphics
            .ellipse(p.x, p.y + 2, reduced ? 15 : 11 + age * 0.5, 5)
            .stroke({ color: 0xd8fff2, width: 2, alpha });
        } else {
          const angle = (Number(e.heading ?? 0) * Math.PI) / 128;
          const reach = reduced ? 13 : 10 + age * 0.6;
          const q = projectCourt(
            (e.x ?? 0) / 256 + Math.cos(angle) * reach,
            (e.y ?? 0) / 256 + Math.sin(angle) * reach,
          );
          this.graphics
            .moveTo(p.x, p.y + 2)
            .lineTo(q.x, q.y + 2)
            .stroke({ color: 0xffe6a0, width: 2, alpha });
        }
        continue;
      }
      if (e.type === "ice-stop") {
        const age = tick - e.tick,
          p = projectCourt((e.x ?? 0) / 256, (e.y ?? 0) / 256);
        const angle = (Number(e.heading ?? 0) * Math.PI) / 128;
        const q = projectCourt(
          (e.x ?? 0) / 256 - Math.cos(angle) * 7,
          (e.y ?? 0) / 256 - Math.sin(angle) * 7,
        );
        // Short edge scratches remain at the stop location, with no growing
        // spray under reduced motion. Cosmetic lifetime is authority-ticked.
        for (const side of [-1, 1])
          this.graphics
            .moveTo(p.x + side * 2, p.y + side)
            .lineTo(q.x + side * 2, q.y + side)
            .stroke({ color: 0xd5f3ff, width: 1, alpha: (1 - age / 18) * 0.7 });
        continue;
      }
      if (e.type === "puck-contact") {
        const age = tick - e.tick,
          p = projectCourt((e.x ?? 0) / 256, (e.y ?? 0) / 256);
        if (age < 7)
          this.graphics
            .ellipse(
              p.x,
              p.y,
              reduced ? 4 : 3 + age * 0.6,
              reduced ? 2 : 1.5 + age * 0.3,
            )
            .stroke({ color: 0xe5fbff, width: 1, alpha: 1 - age / 7 });
        continue;
      }
      const age = tick - e.tick,
        ground = projectCourt((e.x ?? 0) / 256, (e.y ?? 0) / 256),
        p = {
          x: ground.x,
          y:
            ground.y -
            (e.type === "volley-contact" && typeof e.height === "number"
              ? e.height / 256
              : 0),
        },
        alpha = 1 - age / 18;
      if (
        [
          "save",
          "slide-contact",
          "block",
          "perfect-block",
          "check-resist",
        ].includes(e.type)
      ) {
        this.graphics
          .moveTo(p.x - 6 - age * 0.2, p.y - 8)
          .lineTo(p.x, p.y - 13 - age * 0.2)
          .lineTo(p.x + 6 + age * 0.2, p.y - 8)
          .stroke({
            color: e.type === "perfect-block" ? 0xffe6a0 : 0xc8f3ef,
            width: e.type === "perfect-block" ? 2 : 1,
            alpha,
          });
      }
      if (
        e.type === "power-bank" ||
        (e.type === "strike" && typeof e.charge === "number" && e.charge >= 24)
      ) {
        for (let ray = 0; ray < 4; ray++) {
          const angle = (ray * Math.PI) / 2 + Math.PI / 4,
            radius = 4 + age * 0.6;
          this.graphics
            .moveTo(
              p.x + Math.cos(angle) * radius,
              p.y + Math.sin(angle) * radius * 0.5,
            )
            .lineTo(
              p.x + Math.cos(angle) * (radius + 4),
              p.y + Math.sin(angle) * (radius + 4) * 0.5,
            )
            .stroke({ color: 0xffdfa0, width: 2, alpha });
        }
      }
      if (e.type === "pass" || e.type === "trap" || e.type === "volley-contact")
        this.graphics
          .ellipse(p.x, p.y, 4 + age * 0.7, 2 + age * 0.35)
          .stroke({ color: 0xaff7ea, width: 1, alpha });
      if (e.type === "post" && age < 5)
        this.graphics
          .moveTo(p.x - 5, p.y)
          .lineTo(p.x + 5, p.y)
          .moveTo(p.x, p.y - 5)
          .lineTo(p.x, p.y + 5)
          .stroke({ color: 0xfff1b1, width: 1, alpha });
      if (e.type === "check" && age < 9)
        this.graphics
          .circle(p.x, p.y - 7, 2 + age)
          .stroke({ color: 0xffe0a2, width: 2, alpha });
      if (e.type === "whiff" && age < 6)
        this.graphics
          .moveTo(p.x - 6, p.y - 4 - age * 0.3)
          .lineTo(p.x + 6, p.y - 7 - age * 0.3)
          .stroke({ color: 0xabc1c7, width: 1, alpha: alpha * 0.5 });
    }
    for (const p of this.particles) {
      const age = tick - p.born,
        alpha = 1 - age / p.life,
        x = p.x + (reduced ? 0 : p.vx * age),
        y = p.y + (reduced ? 0 : p.vy * age + p.gravity * age * age);
      this.graphics
        .rect(Math.round(x), Math.round(y), p.size, p.size)
        .fill({ color: p.color, alpha });
    }
  }
  clear() {
    this.cues = [];
    this.particles = [];
    this.graphics.clear();
  }
  dispose() {
    this.graphics.destroy();
    this.particles = [];
  }
}
