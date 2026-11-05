import type { CaveContent } from "@onepage/game-project/cave-types";
import { CaveSession } from "../session/cave-rescue";
import { FixedScheduler } from "../scheduler";
import type { CaveCommand } from "@onepage/game-simulation/cave-rescue";
import type { CaveDirection } from "@onepage/game-project/cave-types";

export function mountCaveRescue(
  parent: HTMLElement,
  content: CaveContent,
  rulesBuildId: string,
  allowBranch = true,
) {
  const abort = new AbortController(),
    signal = abort.signal,
    session = new CaveSession(content, rulesBuildId);
  parent.innerHTML = `<section class="cave-player"><h2>Cave Rescue</h2><p>Open a wide tunnel, approach both survey drones, and return to the green extraction pad. Drones cannot be hurt or block you. Roof warnings hurt only you: brace a socket or step aside.</p><div class="cave-toolbar"><button data-cave="pause">Play</button><button data-cave="restart">Restart</button><button data-cave="save">Save checkpoint</button><button data-cave="progress">Save at base</button><label>Open save <input data-cave="open" type="file" accept=".json"></label><button data-cave="capture">Capture branch</button><button data-cave="branch">Open alternate preview</button><button data-cave="scenario">Export branch inputs</button></div><p data-cave="status" role="status" aria-live="polite"></p><p data-cave="notice" role="status"></p><canvas data-cave="canvas" width="512" height="512" tabindex="0" aria-label="Cave game. Arrow keys move and aim; hold Space to drill. C places a charge, B installs the nearest brace. P pauses."></canvas><label><input type="checkbox" data-cave="clearance"> Show escort clearance (green cells)</label><p>Arrows / WASD move and aim · hold Space to drill · C charge · B brace · P pause. Click Play, then the game. Focus loss pauses safely.</p><div class="cave-controls">${[
    ["up", "↑"],
    ["left", "←"],
    ["down", "↓"],
    ["right", "→"],
    ["drill", "Drill"],
    ["charge", "Charge"],
    ["brace", "Brace"],
  ]
    .map(
      ([key, label]) =>
        `<button data-control="${key}" aria-label="${key}">${label}</button>`,
    )
    .join(
      "",
    )}</div><details data-cave="trace"><summary>Why the world changed</summary><button data-cave="inspect">Inspect retained causes</button><pre data-cave="events"></pre></details></section>`;
  const el = <T extends HTMLElement>(key: string) =>
    parent.querySelector<T>(`[data-cave="${key}"]`)!;
  if (!allowBranch) {
    el("capture").hidden = true;
    el("branch").hidden = true;
    el("scenario").hidden = true;
  }
  const canvas = el<HTMLCanvasElement>("canvas"),
    ctx = canvas.getContext("2d")!;
  const terrainCanvas = document.createElement("canvas");
  terrainCanvas.width = terrainCanvas.height = 512;
  const terrainContext = terrainCanvas.getContext("2d")!;
  let cachedContent: CaveContent | undefined;
  let chunkRevisions: number[] = [];
  const keys = new Set<string>();
  let alternate: ReturnType<typeof mountCaveRescue> | undefined;
  let aim: CaveDirection = "right",
    charge = false,
    brace = false,
    frame = 0,
    disposed = false,
    branch: string | null = null,
    branchTape: CaveCommand[] = [],
    branchValid = false,
    lastStatus = "",
    epoch = 0,
    pendingImport: string | undefined,
    lastTraceTick = -1;
  const notice = (s: string) => {
    el("notice").textContent = s;
  };
  const cancelImport = (reason: string) => {
    epoch++;
    if (pendingImport) {
      notice(
        `Import of ${pendingImport} cancelled by ${reason}. Choose the file again to retry.`,
      );
      pendingImport = undefined;
    }
  };
  const cancel = () => {
    keys.clear();
    charge = false;
    brace = false;
  };
  const scheduler = new FixedScheduler(
    () => {
      if (session.owner.observe().status !== "playing") {
        pause();
        return;
      }
      try {
        const command: CaveCommand = {
          moveX: keys.has("right") ? 1 : keys.has("left") ? -1 : 0,
          moveY: keys.has("down") ? 1 : keys.has("up") ? -1 : 0,
          aim,
          drill: keys.has("drill"),
        };
        if (charge || brace) {
          const available = session.owner.toolAvailability(command);
          if (charge) {
            if (available.charge) command.charge = true;
            else
              notice(
                "Charge unavailable: inventory exhausted, four charges active, or placement blocked.",
              );
          }
          if (brace) {
            if (available.braceSockets.length)
              command.brace = available.braceSockets[0];
            else
              notice(
                "No usable brace socket in reach, or no braces remaining.",
              );
          }
        }
        session.owner.step(command);
        if (branchValid) {
          if (branchTape.length < 4096) branchTape.push(command);
          else {
            branchValid = false;
            notice(
              "Branch recording reached 4096 ticks. Capture a new branch to record again.",
            );
          }
        }
        charge = false;
        brace = false;
      } catch (e) {
        pause();
        notice(
          `Action rejected: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    () => {
      pause();
      notice("Paused after a slow frame. Press Play to continue.");
    },
  );
  const pause = () => {
    scheduler.pause();
    cancel();
    el("pause").textContent = "Play";
  };
  const toggle = () => {
    if (scheduler.paused) {
      cancelImport("Play");
      scheduler.resume();
      el("pause").textContent = "Pause";
      canvas.focus();
    } else pause();
  };
  function render() {
    const s = session.owner.observe(),
      c = session.owner.content;
    if (scheduler.paused) aim = s.aim;
    const palette = ["#101a24", "#596576", "#354457", "#e8af46", "#202c40"];
    if (cachedContent !== c) {
      cachedContent = c;
      chunkRevisions = [];
    }
    for (let chunk = 0; chunk < 64; chunk++)
      if (chunkRevisions[chunk] !== s.terrain.chunkRevisions[chunk]) {
        const startX = (chunk % 8) * 16,
          startY = Math.floor(chunk / 8) * 16;
        for (let y = startY; y < startY + 16; y++)
          for (let x = startX; x < startX + 16; x++) {
            const i = y * 128 + x,
              m = s.terrain.cells[i];
            terrainContext.fillStyle = palette[m] ?? "#7d8d85";
            terrainContext.fillRect(x * 4, y * 4, 4, 4);
            if (m && s.terrain.hp[i] < c.materials[m].hp) {
              terrainContext.fillStyle = "#bdc6d0";
              terrainContext.fillRect(x * 4 + 1, y * 4 + 1, 1, 2);
            }
          }
        chunkRevisions[chunk] = s.terrain.chunkRevisions[chunk];
      }
    ctx.drawImage(terrainCanvas, 0, 0);
    if (el<HTMLInputElement>("clearance").checked) {
      ctx.fillStyle = "#47d9b055";
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const i = y * 256 + x * 2;
          if (
            !s.terrain.cells[i] &&
            !s.terrain.cells[i + 1] &&
            !s.terrain.cells[i + 128] &&
            !s.terrain.cells[i + 129]
          )
            ctx.fillRect(x * 8 + 2, y * 8 + 2, 4, 4);
        }
    }
    ctx.fillStyle = "#1d604c";
    ctx.fillRect(
      c.extraction.x / 256,
      c.extraction.y / 256,
      c.extraction.width / 256,
      c.extraction.height / 256,
    );
    ctx.font = "11px sans-serif";
    ctx.fillStyle = "#b8ffe1";
    ctx.fillText("BASE", c.extraction.x / 256, c.extraction.y / 256 - 5);
    for (const z of c.roof.zones) {
      const state = s.support.zones.find((v) => v.id === z.id);
      ctx.strokeStyle = state?.status === "warning" ? "#ff895e" : "#b997d9";
      ctx.lineWidth = 2;
      ctx.strokeRect(
        z.rect.x / 256,
        z.rect.y / 256,
        z.rect.width / 256,
        z.rect.height / 256,
      );
      if (state?.status === "warning") {
        ctx.fillStyle = "#fff";
        ctx.fillText(
          `ROOF ${state.remaining}`,
          z.rect.x / 256,
          z.rect.y / 256 - 4,
        );
      }
    }
    for (const socket of c.roof.braceSockets) {
      ctx.fillStyle = s.support.braces.includes(socket.id)
        ? "#8ff0be"
        : "#b997d9";
      ctx.fillRect(socket.x / 256, socket.y / 256, 4, 8);
    }
    for (const d of s.drones) {
      ctx.fillStyle = d.extracted
        ? "#6eaf8e"
        : d.rescued
          ? "#8ff0be"
          : "#ffdb70";
      ctx.fillRect(d.x / 256, d.y / 256, 8, 8);
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(d.x / 256 - 2, d.y / 256 - 2, 12, 12);
    }
    ctx.fillStyle = "#65caff";
    ctx.fillRect(s.player.x / 256, s.player.y / 256, 8, 8);
    const [dx, dy] =
      aim === "left"
        ? [-1, 0]
        : aim === "right"
          ? [1, 0]
          : aim === "up"
            ? [0, -1]
            : [0, 1];
    ctx.strokeStyle = "#bfe8ff";
    ctx.beginPath();
    ctx.moveTo(s.player.x / 256 + 4, s.player.y / 256 + 4);
    ctx.lineTo(s.player.x / 256 + 4 + dx * 12, s.player.y / 256 + 4 + dy * 12);
    ctx.stroke();
    const warning = s.support.zones
      .filter((z) => z.status === "warning")
      .map((z) => `${Math.ceil(z.remaining / 60)}s`)
      .join(", ");
    const waiting = s.drones.filter(
      (d) => d.rescued && !d.extracted && d.mode !== "following",
    ).length;
    const stateText = `${s.status === "complete" ? "Rescue complete!" : s.status === "defeated" ? "Run ended. Restart or open a checkpoint." : scheduler.paused ? "Paused" : "Rescue in progress"} · Health ${s.player.hp} · Drones ${s.drones.filter((d) => d.extracted).length}/${s.drones.length} · Ore ${s.ore} · Charges ${s.inventory.charges} · Braces ${s.inventory.braces}${warning ? ` · ROOF WARNING ${warning}: move clear or brace` : ""}${waiting ? ` · ${waiting} drone(s) waiting for a route. Widen the passage if needed.` : ""}`;
    if (stateText !== lastStatus) {
      el("status").textContent = stateText;
      lastStatus = stateText;
    }
    if (
      !scheduler.paused &&
      el<HTMLDetailsElement>("trace").open &&
      lastTraceTick !== s.tick
    ) {
      lastTraceTick = s.tick;
      el("events").textContent = JSON.stringify(
        {
          tick: s.tick,
          navigation: s.navigation,
          diagnostics: s.diagnostics,
          events: s.events,
          terrain: s.lastTerrainReceipt,
        },
        null,
        2,
      );
    }
    if (s.status !== "playing") pause();
  }
  function download(bytes: string, name: string) {
    const url = URL.createObjectURL(
      new Blob([bytes], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const action = (op: () => void, reason = "another action") => {
    cancelImport(reason);
    pause();
    try {
      op();
      render();
    } catch (e) {
      notice(e instanceof Error ? e.message : String(e));
    }
  };
  let pointerPauseIntent: boolean | undefined;
  el("pause").addEventListener(
    "pointerdown",
    (e) => {
      pointerPauseIntent = !scheduler.paused;
      e.preventDefault();
    },
    { signal },
  );
  el("pause").addEventListener("mousedown", (e) => e.preventDefault(), {
    signal,
  });
  el("pause").addEventListener(
    "pointercancel",
    () => {
      pointerPauseIntent = undefined;
    },
    { signal },
  );
  el("pause").addEventListener(
    "click",
    (event) => {
      // Focus loss may pause between pointerdown and click. Preserve the user's
      // original action instead of toggling a now-paused scheduler back to play.
      const shouldPause =
        (event.detail === 0 ? undefined : pointerPauseIntent) ??
        !scheduler.paused;
      pointerPauseIntent = undefined;
      if (shouldPause) pause();
      else if (scheduler.paused) toggle();
    },
    { signal },
  );
  el("restart").addEventListener(
    "click",
    () =>
      action(() => {
        session.owner.restart();
        branchValid = false;
      }, "Restart"),
    { signal },
  );
  for (const [key, kind] of [
    ["save", "checkpoint"],
    ["progress", "progress"],
  ] as const)
    el(key).addEventListener(
      "click",
      () => action(() => download(session.export(kind), `cave-${kind}.json`)),
      { signal },
    );
  el("inspect").addEventListener(
    "click",
    () => {
      pause();
      el("events").textContent = JSON.stringify(
        session.owner.inspectDiagnostics(),
        null,
        2,
      );
    },
    { signal },
  );
  el("capture").addEventListener(
    "click",
    () =>
      action(() => {
        branch = session.export();
        branchTape = [];
        branchValid = true;
        notice(
          "Branch checkpoint captured. Play another action, then export branch inputs for scenario verification. Maximum 4096 ticks.",
        );
      }),
    { signal },
  );
  el("scenario").addEventListener(
    "click",
    () =>
      action(() => {
        if (!branch || !branchValid)
          throw Error("Capture a new branch before recording scenario inputs");
        const tape = JSON.stringify(branchTape);
        if (new TextEncoder().encode(tape).length > 1024 * 1024)
          throw Error("Scenario tape exceeds 1MiB");
        const inputs = JSON.stringify({
          format: "cave-scenario-inputs-v1",
          checkpoint: JSON.parse(branch).data,
          tape: branchTape,
        });
        if (new TextEncoder().encode(inputs).length > 5 * 1024 * 1024)
          throw Error("Scenario inputs exceed 5MiB");
        download(inputs, "cave-scenario-inputs.json");
        notice(
          "Downloaded branch checkpoint and accepted commands. Run game:cave scenario-create-inputs to seal and replay the regression scenario.",
        );
      }),
    { signal },
  );
  el("branch").addEventListener(
    "click",
    () =>
      action(() => {
        if (!branch) throw Error("Capture a branch first");
        alternate?.dispose();
        alternate = undefined;
        let host = parent.querySelector<HTMLElement>("[data-alternate]");
        if (!host) {
          host = document.createElement("div");
          host.dataset.alternate = "";
          parent.append(host);
        }
        alternate = mountCaveRescue(
          host,
          session.owner.content,
          rulesBuildId,
          false,
        );
        alternate.session.import(branch);
        alternate.render();
      }),
    { signal },
  );
  el<HTMLInputElement>("open").addEventListener(
    "change",
    async () => {
      cancelImport("a new file selection");
      const token = epoch;
      pause();
      const input = el<HTMLInputElement>("open");
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        notice("Save exceeds 4MiB");
        return;
      }
      pendingImport = file.name;
      notice(`Loading ${file.name}…`);
      try {
        const bytes = await file.text();
        if (disposed || token !== epoch) return;
        pendingImport = undefined;
        action(() => {
          session.import(bytes);
          branchValid = false;
          notice(`Opened ${file.name}.`);
        });
      } catch (error) {
        if (!disposed && token === epoch) {
          pendingImport = undefined;
          notice(
            `Could not read save: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    },
    { signal },
  );
  const mapping: Record<string, string> = {
    ArrowUp: "up",
    KeyW: "up",
    ArrowDown: "down",
    KeyS: "down",
    ArrowLeft: "left",
    KeyA: "left",
    ArrowRight: "right",
    KeyD: "right",
    Space: "drill",
  };
  canvas.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "KeyP") {
        if (!e.repeat) toggle();
        e.preventDefault();
        return;
      }
      if (scheduler.paused) return;
      const k = mapping[e.code];
      if (k) {
        e.preventDefault();
        keys.add(k);
        if (k !== "drill") aim = k as CaveDirection;
      }
      if (e.code === "KeyC" && !e.repeat) charge = true;
      if (e.code === "KeyB" && !e.repeat) brace = true;
    },
    { signal },
  );
  canvas.addEventListener(
    "keyup",
    (e) => {
      const k = mapping[e.code];
      if (k) {
        keys.delete(k);
        e.preventDefault();
      }
    },
    { signal },
  );
  canvas.addEventListener("blur", pause, { signal });
  window.addEventListener("blur", pause, { signal });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) pause();
    },
    { signal },
  );
  for (const button of parent.querySelectorAll<HTMLButtonElement>(
    "[data-control]",
  )) {
    button.style.touchAction = "none";
    button.addEventListener(
      "pointerdown",
      (e) => {
        e.preventDefault();
        if (scheduler.paused) toggle();
        button.setPointerCapture(e.pointerId);
        const key = button.dataset.control!;
        if (key === "charge") charge = true;
        else if (key === "brace") brace = true;
        else {
          keys.add(key);
          if (key !== "drill") aim = key as CaveDirection;
        }
      },
      { signal },
    );
    for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
      button.addEventListener(
        name,
        () => keys.delete(button.dataset.control!),
        { signal },
      );
  }
  const loop = (now: number) => {
    if (disposed) return;
    scheduler.advance(now);
    render();
    frame = requestAnimationFrame(loop);
  };
  render();
  frame = requestAnimationFrame(loop);
  return {
    session,
    pause,
    render,
    dispose() {
      if (disposed) return;
      pause();
      disposed = true;
      epoch++;
      pendingImport = undefined;
      abort.abort();
      cancelAnimationFrame(frame);
      alternate?.dispose();
      parent.replaceChildren();
    },
  };
}
