import {
  renderScene,
  hydrateSceneMedia,
  createPlaybackController,
  createAudioHost,
} from "./index";
import type { SceneDocument } from "@onepage/director-core";
export async function mountPlayer(scene: SceneDocument) {
  const canvas = document.querySelector("canvas")!,
    status = document.querySelector<HTMLElement>("#status")!;
  canvas.width = scene.width * 3;
  canvas.height = scene.height * 3;
  await hydrateSceneMedia(scene);
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const audio = createAudioHost(scene);
  const player = createPlaybackController(scene, {
    onComplete: (outcome) => {
      status.textContent = `Complete · ${outcome}`;
    },
    onSkip: (outcome) => {
      status.textContent = `Skipped · ${outcome}`;
    },
  });
  const draw = () => {
    const s = player.getState();
    audio.sync(s.tick, s.playing && !s.ended);
    renderScene(canvas, scene, s.tick, {
      reducedMotion,
      revealDialogue: s.revealed,
    });
    if (!s.ended)
      status.textContent = s.gate
        ? "Press Continue to read and advance"
        : s.playing
          ? "Playing"
          : "Paused";
  };
  document.querySelector("#advance")!.addEventListener("click", () => {
    player.advance();
    draw();
  });
  document.querySelector("#pause")!.addEventListener("click", () => {
    player.getState().playing ? player.pause() : player.play();
    draw();
  });
  document.querySelector("#skip")!.addEventListener("click", () => {
    player.skip();
    draw();
  });
  document.addEventListener("keydown", (e) => {
    if (
      e.code === "Space" &&
      !["BUTTON", "INPUT"].includes((e.target as HTMLElement).tagName)
    ) {
      e.preventDefault();
      player.advance();
      draw();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      player.pause();
      audio.sync(player.getState().tick, false);
    }
  });
  player.play();
  let previous = performance.now(),
    accumulator = 0;
  function animate(now: number) {
    accumulator += Math.min(100, now - previous) * 0.06;
    previous = now;
    if (accumulator >= 1) {
      const delta = Math.floor(accumulator);
      accumulator -= delta;
      player.step(delta);
      draw();
    }
    if (!player.getState().ended) requestAnimationFrame(animate);
  }
  draw();
  requestAnimationFrame(animate);
}
