import { evaluateScene, sceneDuration } from "@onepage/director-core";
import type { SceneDocument } from "@onepage/director-core";

export interface RenderOptions {
  guides?: boolean;
  selectedId?: string;
  reducedMotion?: boolean;
  preview?: boolean;
  revealDialogue?: boolean;
  actorPreview?: { id: string; x: number; y: number };
  /** Optional host-owned cache; release it on scene disposal. */
  mediaImages?: ReadonlyMap<string, HTMLImageElement>;
}
const images = new Map<string, HTMLImageElement>();
export async function hydrateSceneMedia(
  scene: SceneDocument,
  options: {
    images?: Map<string, HTMLImageElement>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const cache = options.images ?? images;
  await Promise.all(
    scene.media
      .filter((m) => /^data:image\/(png|jpeg|webp);base64,/.test(m.dataUrl))
      .map(
        (m) =>
          new Promise<void>((resolve) => {
            if (cache.has(m.dataUrl) || options.signal?.aborted)
              return resolve();
            const img = new Image();
            const finish = () => {
              img.onload = null;
              img.onerror = null;
              options.signal?.removeEventListener("abort", abort);
              resolve();
            };
            const abort = () => {
              img.src = "";
              finish();
            };
            img.onload = () => {
              if (
                !options.signal?.aborted &&
                img.naturalWidth > 0 &&
                img.naturalHeight > 0 &&
                img.naturalWidth <= 8192 &&
                img.naturalHeight <= 8192 &&
                img.naturalWidth * img.naturalHeight <= 32 * 1024 * 1024
              )
                cache.set(m.dataUrl, img);
              finish();
            };
            img.onerror = finish;
            options.signal?.addEventListener("abort", abort, { once: true });
            img.src = m.dataUrl;
          }),
      ),
  );
}
function noise(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
export function renderScene(
  canvas: HTMLCanvasElement,
  scene: SceneDocument,
  tick: number,
  options: RenderOptions = {},
): void {
  const c = canvas.getContext("2d");
  if (!c) return;
  const f = evaluateScene(scene, tick),
    w = scene.width,
    h = scene.height,
    bit = scene.style === "8-bit",
    real = scene.style === "realistic";
  c.save();
  c.setTransform(canvas.width / w, 0, 0, canvas.height / h, 0, 0);
  c.clearRect(0, 0, w, h);
  c.imageSmoothingEnabled = real;
  const rect = (x: number, y: number, a: number, b: number, color: string) => {
    c.fillStyle = color;
    c.fillRect(
      bit ? Math.round(x / 2) * 2 : x,
      bit ? Math.round(y / 2) * 2 : y,
      a,
      b,
    );
  };
  const line = (
    x: number,
    y: number,
    a: number,
    b: number,
    color: string,
    width = 1,
  ) => {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(a, b);
    c.stroke();
  };
  if (options.actorPreview) {
    const preview = options.actorPreview;
    f.actors = f.actors.map((actor) =>
      actor.id === preview.id
        ? { ...actor, x: preview.x, y: preview.y }
        : actor,
    );
  }
  const env = f.environment;
  const day = env.timeOfDay === "day";
  rect(0, 0, w, h, day ? "#677f8e" : "#101b30");
  c.save();
  c.translate(w / 2, h / 2);
  c.scale(f.camera.zoom, f.camera.zoom);
  c.translate(-f.camera.x, -f.camera.y);
  const rain = (front: boolean) => {
    if (env.weather === "clear") return;
    const density = front ? env.frontRain : env.backRain;
    const t = options.reducedMotion ? 0 : tick;
    c.globalAlpha = (front ? 0.42 : 0.19) * density;
    for (let i = 0; i < (front ? 100 : 140) * density; i++) {
      const x =
          ((noise(i + 18) * w + t * (front ? 0.32 : 0.17)) % (w + 20)) - 10,
        y = ((noise(i + 62) * h + t * (front ? 1.9 : 1.1)) % (h + 20)) - 10;
      if (!front && y < 87 && x > 23 && x < 236) continue;
      line(x, y, x - 2, y + 6, front ? "#b2d7df" : "#7394af");
    }
    c.globalAlpha = 1;
  };
  const drawLayer = (kind: string) => {
    if (kind === "sky") {
      for (let i = 0; i < 45; i++)
        rect(noise(i) * w, noise(i + 77) * 65, bit ? 2 : 1, 1, "#70839b");
      c.fillStyle = "#c4c5ad";
      c.beginPath();
      c.arc(204, 29, 9, 0, Math.PI * 2);
      c.fill();
      // Layered ridgeline, telegraph wire and a distant signal keep the horizon legible.
      c.fillStyle = "#162737";
      c.beginPath();
      c.moveTo(-20, 74);
      for (let x = -20; x <= w + 20; x += 16)
        c.lineTo(x, 48 + noise(x + 91) * 14);
      c.lineTo(w + 20, 100);
      c.lineTo(-20, 100);
      c.fill();
      line(-20, 27, 76, 41, "#253644");
      line(76, 41, 157, 35, "#253644");
      line(157, 35, w + 20, 42, "#253644");
      rect(0, 64, w, 30, "#172a3a");
      for (let i = 0; i < 14; i++)
        rect(i * 21, 59 - noise(i) * 14, 17, 32, "#1d3340");
    }
    if (kind === "facade") {
      rect(18, 65, 221, 61, "#30434a");
      rect(25, 72, 207, 53, bit ? "#3c5055" : "#3c5054");
      if (!bit)
        for (let y = 77; y < 121; y += 6)
          for (let x = 25; x < 230; x += 14)
            line(
              x + (y % 12 ? 0 : 7),
              y,
              x + 12 + (y % 12 ? 0 : 7),
              y,
              "#4b5a5c",
            );
      // A stepped slate roof, copper gutter and timber brackets belong to the set.
      rect(25, 51, 207, 7, "#263d46");
      rect(32, 48, 193, 3, "#40545b");
      if (!bit) {
        for (let x = 34; x < 225; x += 9) line(x, 49, x - 7, 57, "#4d6064");
        rect(27, 57, 203, 1, "#829087");
      }
      rect(14, 61, 232, 8, "#172831");
      rect(10, 58, 240, 4, "#66736a");
      rect(35, 82, 35, 32, "#142c35");
      rect(38, 85, 29, 26, "#ad8b52");
      rect(99, 80, 33, 46, "#142b32");
      rect(103, 84, 25, 42, "#233b41");
      rect(172, 82, 39, 31, "#142b32");
      rect(175, 85, 33, 25, "#bc9b5c");
      for (const x of [52, 191]) line(x, 85, x, 111, "#243d42", 2);
      line(38, 98, 67, 98, "#243d42", 2);
      line(175, 98, 208, 98, "#243d42", 2);
      rect(85, 67, 78, 11, "#132c34");
      c.fillStyle = "#d4b875";
      c.font = "6px monospace";
      c.textAlign = "center";
      c.fillText("NORTHBOUND · 07", 124, 75);
      rect(21, 69, 5, 60, "#1d343d");
      rect(229, 69, 5, 60, "#1d343d");
      line(25, 70, 38, 81, "#243b42", 3);
      line(230, 70, 216, 81, "#243b42", 3);
      // A clock, waiting bench and a route board are independent station details.
      rect(77, 84, 15, 18, "#23383f");
      rect(79, 86, 11, 13, "#c4b38a");
      line(84, 89, 84, 93, "#3f5052");
      line(84, 93, 87, 95, "#3f5052");
      rect(139, 91, 14, 21, "#1d343d");
      rect(141, 93, 10, 17, "#8c9b91");
      for (let y = 96; y < 108; y += 3) rect(142, y, 8, 1, "#536d6e");
      rect(65, 114, 30, 4, "#7a6b56");
      rect(67, 119, 26, 3, "#584f44");
      rect(68, 121, 2, 5, "#23373b");
      rect(91, 121, 2, 5, "#23373b");
      rect(216, 116, 9, 10, "#6a6250");
      rect(215, 115, 11, 2, "#a48c65");
      rect(219, 108, 2, 7, "#657658");
      rect(215, 110, 5, 3, "#687e5f");
      rect(221, 107, 5, 3, "#687e5f");
      if (!bit) {
        for (let i = 0; i < 22; i++) {
          const x = 28 + noise(i + 11) * 198;
          rect(x, 123, 2, 1, "#86938a");
        }
        rect(36, 86, 1, 24, "#e5c378");
        rect(176, 86, 1, 23, "#e5c378");
      }
    }
    if (kind === "platform") {
      rect(0, 125, w, 14, "#637071");
      rect(0, 127, w, 2, "#abb09a");
      rect(0, 139, w, 37, "#172b35");
      rect(0, 141, w, 3, "#9b8b6e");
      rect(0, 155, w, 3, "#718083");
      for (let x = 0; x < w; x += 17) rect(x, 146, 4, 25, "#35464a");
      if (env.wetness > 0)
        for (let i = 0; i < 30; i++) {
          c.globalAlpha = env.wetness * 0.32;
          rect(
            noise(i + 4) * w,
            130 + noise(i + 28) * 10,
            5 + noise(i) * 13,
            1,
            "#d5b77d",
          );
        }
      c.globalAlpha = 1;
    }
    if (kind === "lamp") {
      rect(153, 76, 3, 51, "#182b30");
      line(154, 77, 164, 77, "#182b30", 2);
      rect(160, 79, 8, 12, "#24363b");
      rect(162, 81, 4, 7, "#f4c46b");
      if (env.lantern > 0) {
        const g = c.createRadialGradient(164, 85, 1, 164, 85, real ? 48 : 35);
        g.addColorStop(0, `rgba(255,191,83,${env.lantern * 0.42})`);
        g.addColorStop(1, "rgba(255,191,83,0)");
        c.fillStyle = g;
        c.fillRect(110, 40, 110, 110);
      }
    }
    if (kind === "foreground") {
      rect(7, 47, 8, 129, "#10232c");
      rect(0, 46, 24, 7, "#1b343d");
      rect(238, 43, 9, 133, "#10232c");
      rect(230, 42, 26, 7, "#1b343d");
      rect(0, 168, w, 8, "#0a1a24");
      line(0, 161, w, 161, "#31464b", 3);
      for (let x = 23; x < w; x += 38) rect(x, 159, 3, 17, "#172c34");
    }
    if (kind === "rain-back") rain(false);
    if (kind === "rain-front") rain(true);
    if (kind === "mist" && env.weather !== "clear" && !bit) {
      const g = c.createLinearGradient(0, 115, 0, 160);
      g.addColorStop(0, "#a8c0bf00");
      g.addColorStop(0.5, "#a8c0bf12");
      g.addColorStop(1, "#a8c0bf00");
      c.fillStyle = g;
      c.fillRect(0, 115, w, 45);
    }
  };
  const actor = () => {
    for (const a of [...f.actors].sort((a, b) => a.y - b.y)) {
      const v = a.variant,
        media = scene.media.find((m) => m.id === v?.mediaId),
        img = media && (options.mediaImages ?? images).get(media.dataUrl),
        frame = v?.frames[a.frameIndex];
      c.save();
      c.translate(a.x, a.y);
      c.scale(a.scale, a.scale);
      if (img && frame && v) {
        const scale = v.logicalHeight / frame.height,
          ground = frame.sockets?.ground ??
            v.sockets.ground ?? { x: frame.width / 2, y: frame.height };
        c.drawImage(
          img,
          frame.x,
          frame.y,
          frame.width,
          frame.height,
          -ground.x * scale,
          -ground.y * scale,
          frame.width * scale,
          frame.height * scale,
        );
      } else if (v?.renderKey === "courier" || v?.renderKey === "keeper") {
        const keeper = v.renderKey === "keeper",
          step =
            a.action === "walk" &&
            v.clips.some((clip) => clip.name === a.action) &&
            !options.reducedMotion
              ? Math.sin(a.phase * Math.PI * 8) * 3
              : 0;
        c.fillStyle = "#08192366";
        c.beginPath();
        c.ellipse(0, 1, 10, 2, 0, 0, Math.PI * 2);
        c.fill();
        rect(-5, -9 + step / 3, 4, 10 - step / 3, "#182b35");
        rect(2, -9 - step / 3, 4, 10 + step / 3, "#182b35");
        rect(-7, -23, 14, 17, keeper ? "#68746a" : "#ac6347");
        rect(-6, -32, 12, 11, "#c8a27d");
        rect(-8, -34, 16, 5, keeper ? "#32484b" : "#384652");
        rect(3, -29, 2, 2, "#152b35");
        rect(-8, -22, 3, 13, keeper ? "#879087" : "#c17c52");
        rect(6, -21, 3, 12, "#c39a73");
        if (!bit) {
          rect(-5, -22, 2, 15, keeper ? "#a1a18a" : "#d38b5d");
          line(-4, -18, 4, -18, "#444e49");
        }
        if (!keeper) {
          rect(10, -13, 5, 7, "#dba34e");
          rect(11, -12, 3, 5, "#ffe298");
        }
      } else {
        rect(-10, -30, 20, 30, "#7f567866");
        c.strokeStyle = "#b88d9c";
        c.strokeRect(-10, -30, 20, 30);
        c.fillStyle = "#f3d1db";
        c.font = "5px sans-serif";
        c.textAlign = "center";
        c.fillText("Missing art", 0, -35);
      }

      if (v && !v.clips.some((clip) => clip.name === a.action)) {
        c.fillStyle = "#ffd28b";
        c.font = "5px sans-serif";
        c.textAlign = "center";
        c.fillText(`Missing ${a.action}`, 0, -38);
      }
      c.restore();
      if (options.guides || options.selectedId === a.id) {
        c.strokeStyle = "#f6cf86";
        c.setLineDash([2, 2]);
        c.strokeRect(a.x - 12, a.y - 36, 24, 38);
        c.setLineDash([]);
      }
    }
  };
  const layers = [...scene.layers].sort((a, b) => a.z - b.z);
  let actorsDrawn = false;
  for (const l of layers) {
    if (!actorsDrawn && ["foreground", "rain-front", "mist"].includes(l.kind)) {
      actor();
      actorsDrawn = true;
    }
    if (options.preview ? !l.visible : !l.output) continue;
    c.save();
    c.globalAlpha = l.opacity;
    c.translate(l.x, l.y);
    const variant = scene.assets
      .find((a) => a.id === l.familyId)
      ?.variants.find((v) => v.style === scene.style);
    const media = scene.media.find((m) => m.id === variant?.mediaId);
    const img = media && (options.mediaImages ?? images).get(media.dataUrl);
    if (img && variant?.frames[0]) {
      const frame = variant.frames[0],
        scale = variant.logicalHeight / frame.height,
        origin = variant.sockets.origin ?? { x: 0, y: 0 };
      c.drawImage(
        img,
        frame.x,
        frame.y,
        frame.width,
        frame.height,
        -origin.x * scale,
        -origin.y * scale,
        frame.width * scale,
        frame.height * scale,
      );
    } else if (l.familyId && !variant?.renderKey) {
      c.strokeStyle = "#d6a27f";
      c.setLineDash([3, 3]);
      c.strokeRect(2, 70, w - 4, 60);
      c.setLineDash([]);
    } else if (real && l.kind === "foreground" && !variant?.ready) {
      c.fillStyle = "#d7bc8c";
      c.font = "5px sans-serif";
      c.fillText("Foreground artwork missing", 8, 25);
    } else drawLayer(l.kind);
    c.restore();
  }
  if (!actorsDrawn) actor();
  c.restore();
  const incompleteStudy =
    real &&
    [
      ...f.actors.map((a) => a.variant),
      ...scene.layers
        .filter((l) => (options.preview ? l.visible : l.output))
        .map((l) =>
          scene.assets
            .find((a) => a.id === l.familyId)
            ?.variants.find((v) => v.style === scene.style),
        ),
    ].some((v) => v?.renderKey && !v.ready);
  if (incompleteStudy) {
    rect(5, 5, 146, 12, "#11232ce6");
    c.fillStyle = "#e3c893";
    c.font = "6px sans-serif";
    c.textAlign = "left";
    c.fillText("ILLUSTRATION STUDY · INCOMPLETE", 10, 13);
  }
  if (f.dialogue) {
    const dialogue = f.dialogue,
      text = options.revealDialogue ? dialogue.text : f.revealedText;
    c.textAlign = "center";
    c.font =
      dialogue.style === "title" ? "16px Georgia,serif" : "7px sans-serif";
    if (dialogue.style === "title") {
      rect(0, h - 54, w, 35, "#101d2bd9");
      c.fillStyle = "#efdbb5";
      c.fillText(text, w / 2, h - 34);
      line(w / 2 - 26, h - 26, w / 2 + 26, h - 26, "#ab845b");
    } else {
      const speaker = f.actors.find((a) => a.id === dialogue.actorId),
        bubble = dialogue.style === "bubble",
        portrait = dialogue.style === "portrait";
      const boxWidth = bubble ? Math.min(w - 20, 170) : w - 30,
        wrapWidth = boxWidth - (portrait ? 40 : 16),
        words = text.split(" ");
      let lines = [""];
      for (const word of words) {
        const i = lines.length - 1;
        if (c.measureText(lines[i] + word).width > wrapWidth && lines[i])
          lines.push(word + " ");
        else lines[i] += word + " ";
      }
      const ground = speaker?.variant?.sockets.ground,
        speech = speaker?.variant?.sockets.speech;
      const px =
        ((speaker?.x ?? w / 2) +
          (speech && ground
            ? (speech.x - ground.x) * (speaker?.scale ?? 1)
            : 0) -
          f.camera.x) *
          f.camera.zoom +
        w / 2;
      const py =
        ((speaker?.y ?? h / 2) +
          (speech && ground
            ? (speech.y - ground.y) * (speaker?.scale ?? 1)
            : -36) -
          f.camera.y) *
          f.camera.zoom +
        h / 2;
      const bx = bubble
          ? Math.max(6, Math.min(w - boxWidth - 6, px - boxWidth / 2))
          : 15,
        bh = Math.max(22, Math.min(4, lines.length) * 9 + 12),
        by = bubble ? Math.max(7, py - bh - 9) : h - bh - 7;
      rect(bx, by, boxWidth, bh, bubble ? "#e7ddc7" : "#0c1c29ed");
      if (bubble) {
        c.fillStyle = "#e7ddc7";
        c.beginPath();
        c.moveTo(
          Math.max(bx + 8, Math.min(bx + boxWidth - 8, px)) - 4,
          by + bh,
        );
        c.lineTo(px, Math.max(by + bh + 2, py - 2));
        c.lineTo(
          Math.max(bx + 8, Math.min(bx + boxWidth - 8, px)) + 4,
          by + bh,
        );
        c.fill();
      }
      if (portrait) {
        rect(bx + 4, by + 4, 24, bh - 8, "#51616a");
        c.fillStyle = "#f4e7ce";
        c.font = "12px serif";
        c.fillText(speaker?.name.slice(0, 1) ?? "?", bx + 16, by + bh / 2 + 4);
        c.font = "7px sans-serif";
      }
      c.fillStyle = bubble ? "#273841" : "#f4e7ce";
      lines
        .slice(0, 4)
        .forEach((line, i) =>
          c.fillText(
            line.trim(),
            bx + boxWidth / 2 + (portrait ? 14 : 0),
            by + 11 + i * 9,
          ),
        );
    }
  }
  c.restore();
}

export interface PlaybackState {
  tick: number;
  playing: boolean;
  revealed: boolean;
  gate?: string;
  ended: boolean;
}
export function createPlaybackController(
  scene: SceneDocument,
  options: {
    onComplete?: (outcome: string) => void;
    onSkip?: (outcome: string) => void;
    onChange?: (state: PlaybackState) => void;
  } = {},
) {
  let tick = 0,
    playing = false,
    ended = false,
    disposed = false,
    revealed = false;
  const passed = new Set<string>();
  const state = (): PlaybackState => ({
    tick,
    playing,
    revealed,
    gate: evaluateScene(scene, tick).gate,
    ended,
  });
  const emit = () => options.onChange?.(state());
  const finish = (skip: boolean) => {
    if (disposed || ended) return;
    ended = true;
    playing = false;
    (skip ? options.onSkip : options.onComplete)?.(
      skip ? scene.slot.onSkip : scene.slot.onComplete,
    );
    emit();
  };
  return {
    getState: state,
    play() {
      if (disposed) return;
      if (!ended) playing = true;
      emit();
    },
    pause() {
      if (disposed) return;
      playing = false;
      emit();
    },
    seek(value: number) {
      if (disposed || !Number.isFinite(value)) return;
      ended = false;
      tick = Math.max(0, Math.min(sceneDuration(scene), Math.floor(value)));
      revealed = false;
      passed.clear();
      emit();
    },
    step(delta = 1) {
      if (disposed || !playing || ended || !Number.isFinite(delta)) return;
      const target = Math.min(
        sceneDuration(scene),
        tick + Math.max(0, Math.floor(delta)),
      );
      for (let t = tick; t <= target; t++) {
        const f = evaluateScene(scene, t);
        if (f.gate && !passed.has(f.gate)) {
          tick = t;
          playing = false;
          revealed = false;
          emit();
          return;
        }
      }
      tick = target;
      revealed = false;
      if (tick >= sceneDuration(scene)) finish(false);
      else emit();
    },
    advance() {
      if (disposed || ended) return;
      const f = evaluateScene(scene, tick);
      if (
        f.dialogue &&
        !revealed &&
        f.revealedText.length < f.dialogue.text.length
      ) {
        revealed = true;
        playing = false;
        emit();
        return;
      }
      if (f.dialogue) {
        passed.add(f.dialogue.id);
        tick = Math.min(
          sceneDuration(scene),
          Math.max(
            tick + 1,
            (f.shot?.start ?? 0) + f.dialogue.start + f.dialogue.duration,
          ),
        );
      }
      revealed = false;
      playing = true;
      if (tick >= sceneDuration(scene)) finish(false);
      else emit();
    },
    skip() {
      finish(true);
    },
    dispose() {
      disposed = true;
      playing = false;
      ended = true;
    },
  };
}

/** Optional embedded audio host. Seeking presentation never fires game outcomes. */
export function createAudioHost(scene: SceneDocument) {
  const active = new Map<string, HTMLAudioElement>();
  let disposed = false;
  const cues = [
    ...scene.audio
      .filter((c) => c.mediaId)
      .map((c) => ({
        id: `audio:${c.id}`,
        mediaId: c.mediaId!,
        start: c.start,
        duration: c.duration,
        volume: c.volume,
      })),
    ...scene.dialogue
      .filter((d) => d.voiceMediaId)
      .map((d) => ({
        id: `dialogue:${d.id}`,
        mediaId: d.voiceMediaId!,
        start:
          (scene.shots.find((s) => s.id === d.shotId)?.start ?? 0) + d.start,
        duration: d.duration,
        volume: 1,
      })),
  ];
  return {
    sync(tick: number, playing: boolean) {
      if (disposed) return;
      for (const cue of cues) {
        let audio = active.get(cue.id);
        const inRange = tick >= cue.start && tick < cue.start + cue.duration;
        if (!inRange || !playing) {
          audio?.pause();
          continue;
        }
        const media = scene.media.find((m) => m.id === cue.mediaId);
        if (
          !media ||
          !/^data:audio\/(wav|mpeg|ogg);base64,/.test(media.dataUrl)
        )
          continue;
        if (!audio) {
          audio = new Audio(media.dataUrl);
          audio.volume = cue.volume;
          active.set(cue.id, audio);
        }
        const time = (tick - cue.start) / 60;
        if (
          Number.isFinite(audio.duration) &&
          Math.abs(audio.currentTime - time) > 0.15
        )
          audio.currentTime = Math.min(time, audio.duration);
        if (audio.paused) void audio.play().catch(() => {});
      }
    },
    dispose() {
      disposed = true;
      for (const audio of active.values()) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      active.clear();
    },
  };
}
