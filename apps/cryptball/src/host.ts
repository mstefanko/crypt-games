import { FrameInterpolation } from "./online/frame-interpolation";
import { installPerformanceDiagnostics } from "./online/performance-diagnostics";
import { BUILD } from "../protocol";
import { PixiStage } from "@onepage/game-runtime/pixi";
import { BrowserLifecycle } from "@onepage/game-runtime/browser/lifecycle";
import {
  createCryptballSession,
  SPORTS,
  SPORT_IDS,
  TEAMS, TEAM_IDS, DEFAULT_TEAM_IDS, isTeamId, resolveTeamSelection,
  type TeamId, type TeamSelection,
  type SportId,
} from "./session";
import { reviveTarget } from "../sim/modes/crypt-guardian/damage";
import { isNewMode, modeStatus } from "./new-mode-presentation";
import { CourtTouchControls } from "./touch-controls";
import { ownControlSwitched, eligibleTouchTeammates } from "./control-events";
import { isSportId } from "../protocol";
import {
  VIEW,
  screenVectorToWorld,
  unprojectCourt,
  aimHeading,
  projectCourt,
} from "./projection";
import { CryptballPresenter } from "./presenter";
import { resizeCryptball, fitCryptballScale } from "./viewport";
import { CryptballAudio } from "./audio";
import type { CommandFrame, CryptballEvent } from "./contract";
import type { OnlineSession } from "./online/session";
import type { Lobby } from "../protocol";
export async function mountCryptball() {
  const game = document.querySelector<HTMLElement>("#game")!,
    root = document.querySelector<HTMLElement>("#stage")!,
    overlay = document.querySelector<HTMLElement>("#overlay")!,
    notice = document.querySelector<HTMLElement>("#notice")!,
    prompt = document.querySelector<HTMLElement>("#prompt")!;
  const requestedSport = new URL(location.href).searchParams.get("sport");
  let sportId: SportId = isSportId(requestedSport)
    ? requestedSport
    : "cryptball";
  const performanceDiagnostics = installPerformanceDiagnostics({ clientBuild: BUILD,
    clientRevision: import.meta.env.VITE_CRYPTBALL_REVISION ?? "unknown", mode: sportId });
  const sport = () => SPORTS[sportId];
  let guardianPractice: { weapon?: "cannon" | "hook" | "maul"; immortal?: boolean } = {};
  let guardianSeed = (Date.now() ^ 0xc7ba11) >>> 0;
  let touchMode = matchMedia("(pointer: coarse)").matches;
  const controlsText = () => isNewMode(sportId)
    ? sportId === "crypt-dodge"
      ? touchMode ? "Drag to move · Empty-handed: tap CATCH or the action thumb to catch immediately · Holding: hold / release to throw, tap to pass · Flick to dive · Lift the movement thumb to cancel a prepared throw"
        : "WASD / arrows move · J / left mouse catches when empty; hold / release to throw while holding · K passes · Shift / right mouse dives · Space dashes · Q switches eligible allies"
      : touchMode ? "Drag to move · Collect an orb · Hold / release to throw · Tap to pass · Flick to dive · Hold REVIVE beside a downed ally"
        : "WASD / arrows move · Collect an orb · Hold / release J to throw · K passes; empty-handed hold K near a soul to revive · Shift dives · Space dashes · Q switches eligible allies"
    : touchMode
    ? `Drag one thumb to move · tap with the other to pass · hold / release to shoot · flick to ${sportId === "cryptcheck" ? "poke · tap CHECK to body-check" : "dive"}. Drag the action thumb to aim. Return the movement thumb to its ring to stand still; lifting it cancels a shot. Lift and quickly re-touch near the movement ring, then drag to dash. Tap a teammate ring with the other thumb to switch.`
    : `WASD / arrows move · J / left mouse ${sport().controls.strike.toLowerCase()} · K / middle mouse ${sport().controls.pass.toLowerCase()} · right mouse / Shift / I ${sport().controls.slide.toLowerCase()}${sportId === "cryptcheck" ? " (one poke per press) · E body-check" : ""} · Space / L ${sport().controls.dash.toLowerCase()} · Q switches`;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Cryptball court");
  canvas.tabIndex = -1;
  root.append(canvas);
  const stage = new PixiStage(canvas),
    presenter = new CryptballPresenter(stage),
    audio = new CryptballAudio((text) => (notice.textContent = text));
  const checkTrigger = document.createElement("button");
  checkTrigger.type = "button";
  checkTrigger.id = "hockey-check";
  checkTrigger.textContent = "CHECK";
  checkTrigger.setAttribute("aria-label", "Body check");
  checkTrigger.hidden = true;
  const modeHud = document.createElement("div"); modeHud.id = "mode-hud"; modeHud.hidden = true;
  const modeSummary = document.createElement("div"); modeSummary.setAttribute("role", "status");
  const bossMeter = document.createElement("progress"); bossMeter.max = 300; bossMeter.setAttribute("aria-label", "Guardian health");
  const roster = document.createElement("div"); roster.className = "mode-roster";
  const rosterCards = Array.from({length:4}, () => { const card = document.createElement("span"); roster.append(card); return card; });
  const contextTrigger = document.createElement("button"); contextTrigger.type="button"; contextTrigger.id="mode-action";
  let contextHeld = false, middleHeld = false;
  modeHud.append(modeSummary, bossMeter, roster, contextTrigger); game.append(modeHud);
  let online: OnlineSession | null = null;
  let onlineJoinGeneration = 0;
  let onlineLobbyKey = "";
  let session: Pick<
      ReturnType<typeof createCryptballSession>,
      "step" | "observe" | "drainEvents"
    > = createCryptballSession({ mode: "match", sportId }),
    screen = "loading",
    returnScreen = "title",
    disposed = false,
    debug = false,
    startingReady = false,
    finishingElapsed = 0,
    warmFrames = 0,
    previousFrameTime = 0,
    frameRate = 60;
  let observation = session.observe();
  const abort = new AbortController(),
    signal = abort.signal;
  const keys = new Set<string>();
  const touch = new CourtTouchControls();
  const touchCues = document.createElement("div");
  touchCues.id = "touch-cues"; touchCues.setAttribute("aria-hidden", "true");
  const moveCue = document.createElement("div"), actionCue = document.createElement("div"), teammateCues = document.createElement("div");
  moveCue.className = "touch-stick"; actionCue.className = "touch-aim";
  moveCue.append(document.createElement("i")); actionCue.append(document.createElement("i"));
  touchCues.append(moveCue, actionCue, teammateCues); game.append(touchCues);
  let touchFacing: number | undefined;
  const capturedTouches = new Set<number>();
  const hudTouches = new Map<number, { trigger: HTMLButtonElement; x: number; y: number; moved: boolean }>();
  let lastHudTouch = -Infinity;
  const inputMode = (isTouch: boolean) => { touchMode = isTouch; game.dataset.input = isTouch ? "touch" : "pointer"; };
  inputMode(touchMode);
  let pendingEvents: CryptballEvent[] = [];
  let edges: CommandFrame = {},
    pointerHeld = false,
    secondaryHeld = false,
    pointerAim: { x: number; y: number } | undefined;
  let prefs = {
    music: 0.7,
    effects: 0.8,
    teamId: DEFAULT_TEAM_IDS[0] as TeamId,
    opponentId: DEFAULT_TEAM_IDS[1] as TeamId,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
  try {
    const p = JSON.parse(
      localStorage.getItem("cryptball-preferences") ?? "null",
    );
    if (p) {
      if (isTeamId(p.teamId)) prefs.teamId = p.teamId;
      if (isTeamId(p.opponentId)) prefs.opponentId = p.opponentId;
      prefs.opponentId = resolveTeamSelection(prefs.teamId, prefs.opponentId)[1];
      for (const key of ["music", "effects"] as const)
        if (typeof p[key] === "number" && p[key] >= 0 && p[key] <= 1)
          prefs[key] = p[key];
      if (typeof p.reducedMotion === "boolean")
        prefs.reducedMotion = p.reducedMotion;
    }
  } catch {}
  let muted = false;
  const save = () => {
    try {
      localStorage.setItem("cryptball-preferences", JSON.stringify(prefs));
    } catch {}
  };
  const cancel = () => {
    touch.cancel(); touchFacing = undefined; contextHeld = false; middleHeld = false;
    for (const id of capturedTouches) releaseTouch(id);
    for (const [id, value] of hudTouches) {
      hudTouches.delete(id);
      if (value.trigger.hasPointerCapture(id)) value.trigger.releasePointerCapture(id);
    }
    keys.clear();
    secondaryHeld = false;
    pointerHeld = false;
    pointerAim = undefined;
    edges = {};
    if (online) online.releaseInput();
    else session.step({ cancel: true });
    observation = session.observe();
    drawTouchCues();
  };
  let localMusicMatch = 0;
  function observeMusic() {
    if (online) {
      const snapshot = online.musicObservation(audio.lastMusicStamp);
      if (snapshot) audio.observeMusic(snapshot.state, snapshot.stamp, snapshot.controlledTeam);
    } else {
      audio.observeMusic(observation, { matchId: `local:${localMusicMatch}`, epoch: localMusicMatch, generation: 0, snapshotSeq: observation.tick }, observation.players.find(player => player.id === observation.controlledId)?.team ?? null);
    }
  }
  const frameInterpolation = new FrameInterpolation();
  let diagnosticMetadataAt = 0;
  let frameSteps = 0;
  if (performanceDiagnostics.enabled) {
    for (const type of ["keydown", "keyup", "pointerdown", "pointerup", "pointermove", "pointercancel"]) {
      window.addEventListener(type, event => {
        if (screen === "play") performanceDiagnostics.captureInput("physical-event", event.timeStamp);
      }, { signal, capture: true, passive: true });
    }
  }
  const capturePresentation = () => {
    if (!online) { frameInterpolation.capture(observation); return; }
    const correction = online.takePresentationCorrection();
    if (correction) {
      frameInterpolation.correct(correction.before, correction.after,
        performance.now(), correction.key, correction.reset);
      // The detached correction already contains the confirmed current render view.
      observation = correction.after;
    }
    const previousPrediction = online.takePreviousPrediction();
    if (previousPrediction) frameInterpolation.capture(previousPrediction);
    frameInterpolation.capture(observation);
  };
  const lifecycle = new BrowserLifecycle({
    tick,
    interruptionPolicy: "suspend-input",
    releaseInputWhileVisible: () => !!online,
    onInputSuspension(suspended) {
      if (suspended) {
        if (online) {
          online.suspend();
          if (screen === "play") showOnlinePause();
        } else if (screen === "play") pause();
      } else if (online && ["online-lobby", "online-connecting", "online-starting"].includes(screen)) {
        // Setup has no cover menu to dismiss; returning before kickoff restores intent.
        online.resume();
      }
    },
    frame(time) {
      const frameStarted = performance.now();
      frameSteps = 0;
      if (previousFrameTime && time > previousFrameTime)
        frameRate = frameRate * 0.9 + (1000 / (time - previousFrameTime)) * 0.1;
      if (import.meta.env.DEV) presenter.setFps(frameRate);
      capturePresentation();
      const alpha = lifecycle.advance(time, online?.predictionRate ?? 1);
      // Authority snapshots keep arriving even when a local frame-debt pause
      // stops input ticks. Keep the visible court/HUD current while bots cover.
      if (online && lifecycle.paused) {
        observation = online.observe();
        observeMusic();
        pendingEvents.push(...online.drainEvents());
        updateHud();
      }
      const interpolateFrame = screen === "play" && !lifecycle.paused;
      if (!interpolateFrame) frameInterpolation.reset();
      const covered = ["play", "pause", "settings"].includes(screen) ? online?.coveredObservation(time) : null;
      const state = covered?.state ?? (interpolateFrame
        ? frameInterpolation.drawCaptured(observation, time, alpha) : observation);
      if (covered) updateHud(state);
      const renderEvents = covered ? pendingEvents.filter(event => event.tick <= covered.tick) : pendingEvents;
      presenter.render(state, renderEvents, prefs.reducedMotion, Object.fromEntries((online?.lobby?.seats ?? []).map(seat=>[online?.controllerOwners.find(controller=>controller.id===seat.id)?.playerId ?? seat.playerId,seat.name])), covered?.tick ?? (interpolateFrame ? Math.max(0, observation.tick - 1 + alpha) : observation.tick));
      pendingEvents = covered ? pendingEvents.filter(event => event.tick > covered.tick) : [];
      stage.render(0);
      performanceDiagnostics.submittedRender();
      if (performanceDiagnostics.enabled && time - diagnosticMetadataAt >= 1000) {
        diagnosticMetadataAt = time;
        const playback = online?.diagnostics;
        performanceDiagnostics.setMetadata({ mode: sportId, online: !!online,
          focused: document.hasFocus(), hidden: document.hidden, inputSuspended: online?.suspended ?? false,
          coveredBufferUnderruns: playback?.coveredBufferUnderruns ?? 0,
          coveredBufferDelayMs: playback?.coveredBufferDelayMs ?? null,
          coveredBufferTick: playback?.coveredBufferTick ?? null,
          refreshHz: frameRate, canvasWidth: canvas.width, canvasHeight: canvas.height,
          inputTiming: "Command application is linked to render submission by session/epoch/generation/sequence; physical captures remain unlinked." });
      }
      performanceDiagnostics.frame(time, frameSteps, performance.now() - frameStarted);
      if (screen === "finishing") { finishingElapsed += Math.max(0,Math.min(50,time-previousFrameTime)); if(finishingElapsed>=1500) showResults(); }
      if (screen === "starting" && startingReady) {
        warmFrames = time - previousFrameTime < 50 ? warmFrames + 1 : 0;
        if (warmFrames >= 6) {
          screen = "play";
          overlay.hidden = true;
          lifecycle.resume();
          updateHud();
          canvas.focus();
        }
      }
      previousFrameTime = time;
      lifecycle.schedule();
    },
    cancelInput: cancel,
    onPause() {
      if (screen === "play") pause();
    },
    onDebt() {
      if (screen === "play") pause();
    },
    onPageExit() {
      dispose();
    },
  });
  const button = (label: string, action: () => void, primary = false) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.addEventListener(
      "click",
      () => {
        void audio.engine.unlock();
        action();
      },
      { signal },
    );
    return b;
  };
  function menu(
    title: string,
    description: string,
    actions: [string, () => void][],
    eyebrow = "CRYPTBALL",
  ) {
    overlay.className = "";
    game.dataset.menu = ["title", "online-lobby", "online-choice"].includes(screen) ? "setup" : "other";
    document.querySelector<HTMLElement>("#hud")!.hidden = !["play", "pause", "results"].includes(screen);
    if (screen !== "loading") resize();
    overlay.hidden = false;
    touchCues.hidden = true;
    modeHud.hidden = true;
    overlay.replaceChildren();
    const e = document.createElement("p");
    e.className = "eyebrow";
    e.textContent = eyebrow;
    const h = document.createElement(
      title === "CRYPT GAMES" || SPORT_IDS.some((id) => SPORTS[id].label.toUpperCase() === title)
        ? "h1"
        : "h2",
    );
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = description;
    const buttons = document.createElement("div");
    buttons.className = "menu-actions";
    actions.forEach(([label, fn], i) =>
      buttons.append(button(label, fn, i === 0)),
    );
    if (eyebrow) overlay.append(e);
    overlay.append(h);
    if (description) overlay.append(p);
    overlay.append(buttons);
    h.tabIndex = -1;
    overlay.setAttribute("aria-label", title);
    (buttons.firstElementChild as HTMLElement)?.focus();
  }
  function localTeams(): TeamSelection {
    return resolveTeamSelection(prefs.teamId, prefs.opponentId);
  }
  function teamIcon(id: TeamId) {
    const img = document.createElement("img");
    img.src = TEAMS[id].icon;
    img.alt = "";
    img.className = "team-icon";
    return img;
  }
  function title() {
    prefs.teamId = TEAM_IDS[Math.floor(Math.random()*TEAM_IDS.length)]!;
    prefs.opponentId = resolveTeamSelection(prefs.teamId, TEAM_IDS[Math.floor(Math.random()*TEAM_IDS.length)]!)[1];
    onlineJoinGeneration++;
    if (online) {
      void online.leave();
      online = null;
    }
    session = createCryptballSession({ mode: "match", sportId, teamIds: localTeams(), seed: guardianSeed });
    observation = session.observe();
    canvas.setAttribute("aria-label", `${sport().label} court`);
    onlineLobbyKey = "";
    notice.textContent = "";
    screen = "title";
    void presenter.loadSport(observation.sportId).catch((error) => {
      if (screen === "title") notice.textContent = String(error);
    });
    updateHud();
    lifecycle.pause();
    audio.titleCue();
    prompt.textContent = "";
    menu(
      "CRYPT GAMES",
      "",
      [
        ["Single player", () => start("match")],
        ["Play online", onlineChoices],
        ["Practice", () => sportId === "crypt-guardian" ? guardianPracticeSetup() : start("practice")],
        ["Settings", () => settings("title")],
        ["Credits", credits],
      ],
      "",
    );
    overlay.className = "setup-menu title-menu";
    const heading = overlay.querySelector("h1")!;
    const headingText = document.createElement("span");
    headingText.className = "visually-hidden";
    headingText.textContent = "CRYPT GAMES";
    const logo = document.createElement("img");
    logo.className = "crypt-games-logo";
    logo.src = `${import.meta.env.BASE_URL}assets/crypt-menu-v2/logo.webp`;
    logo.alt = "";
    logo.width = 2160;
    logo.height = 720;
    heading.replaceChildren(headingText, logo);
    const decorateActivity = (choice: HTMLButtonElement, id: SportId | "shuffle", label: string, description: string) => {
      const artwork = document.createElement("img");
      artwork.className = "activity-art";
      artwork.src = `${import.meta.env.BASE_URL}assets/crypt-menu-v2/${id}.webp`;
      artwork.alt = "";
      artwork.draggable = false;
      const nameplate = document.createElement("span");
      nameplate.className = "activity-nameplate";
      const name = document.createElement("span");
      name.className = "activity-name";
      name.id = `activity-${id}-name`;
      name.textContent = label;
      const subtitle = document.createElement("small");
      subtitle.id = `activity-${id}-description`;
      subtitle.textContent = description;
      nameplate.append(name, subtitle);
      choice.replaceChildren(artwork, nameplate);
      choice.setAttribute("aria-labelledby", name.id);
      choice.setAttribute("aria-describedby", subtitle.id);
    };
    const selector = document.createElement("fieldset");
    selector.className = "sport-selector";
    const legend = document.createElement("legend");
    legend.textContent = "Choose a sport";
    selector.append(legend);
    for (const id of SPORT_IDS) {
      const choice = button(SPORTS[id].label, () => {
        shuffle = false;
        sportId = id;
        const url = new URL(location.href);
        url.searchParams.set("sport", id);
        url.searchParams.delete("room");
        history.replaceState(null, "", url);
        title();
        overlay
          .querySelector<HTMLButtonElement>(`[data-sport="${id}"]`)
          ?.focus();
      });
      decorateActivity(choice, id, SPORTS[id].label, ({cryptball:"Arena ball",cryptkick:"Soccer","rift-volley":"Volleyball",cryptcheck:"Hockey","crypt-dodge":"Dodgeball","crypt-guardian":"Solo boss battle"})[id]);
      choice.dataset.sport = id;
      choice.setAttribute("aria-pressed", String(id === sportId && !shuffle));
      selector.append(choice);
    }
    const shuffleChoice=button("Crypt Shuffle",()=>{
      shuffle=true;sportId="cryptball";title();
      overlay.querySelector<HTMLButtonElement>('[data-sport="shuffle"]')?.focus();
    });
    decorateActivity(shuffleChoice, "shuffle", "Crypt Shuffle", "Five sports · changes after each match");
    shuffleChoice.setAttribute("aria-pressed",String(shuffle));shuffleChoice.dataset.sport="shuffle";selector.append(shuffleChoice);
    overlay.insertBefore(selector, overlay.querySelector(".menu-actions"));
    const actions = overlay.querySelector<HTMLElement>(".menu-actions")!;
    if (sportId === "crypt-guardian") {
      (actions.children[1] as HTMLButtonElement).disabled = true;
    }
    const utilities = document.createElement("div"); utilities.className = "menu-utilities";
    while (actions.children.length > 2) utilities.append(actions.children[2]!);
    overlay.append(utilities);
  }
  function onlineChoices() {
    screen = "online-choice";
    menu("Play online", "Play remotely with other players. Find a public match or invite friends to a private room.", [
      ["Find a match", () => joinOnline("quick")],
      ["Play with friends", friends],
      ["Back", title],
    ]);
    overlay.className = "online-choice-menu";
  }
  function onlineFailure(message: string) {
    screen = "online-error";
    notice.textContent = "";
    const detail = /failed to fetch|networkerror/i.test(message)
      ? "Cannot reach the multiplayer service. For local play, start npm run dev:cryptball:online; a hosted game needs its configured multiplayer service running."
      : message;
    menu("Online play unavailable", detail, [
      ["Retry matchmaking", () => joinOnline("quick")],
      ["Single player", () => start("match")],
      ["Back", title],
    ]);
  }
  function friends() {
    screen = "friends";
    menu(
      "Play with friends",
      `${sport().label} · Create a private court or enter a room code or invite link. Everyone in a room plays the same sport.`,
      [
        ["Create room", () => joinOnline("private")],
        ["Back", onlineChoices],
      ],
    );
    const modeLabel=document.createElement("label"); modeLabel.textContent="Room activity ";
    const modes=document.createElement("select"); modes.setAttribute("aria-label","Room activity");
    for(const id of SPORT_IDS.filter(id=>id!=="crypt-guardian")) {
      const option=document.createElement("option");option.value=id;option.textContent=SPORTS[id].label;modes.append(option);
    }
    const shuffleOption=document.createElement("option");shuffleOption.value="shuffle";shuffleOption.textContent="Crypt Shuffle · new activity each match";modes.append(shuffleOption);
    modes.value=shuffle?"shuffle":sportId; modes.addEventListener("change",()=>{shuffle=modes.value==="shuffle"; if(shuffle)sportId="cryptball";else if(isSportId(modes.value)) sportId=modes.value;},{signal});
    modeLabel.append(modes);overlay.append(modeLabel);
    const form = document.createElement("form");
    form.className = "room-entry";
    const input = document.createElement("input");
    input.placeholder = "Room code or invite link";
    input.maxLength = 2048;
    input.setAttribute("aria-label", "Room code or invite link");
    input.autocomplete = "off";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Join room";
    form.append(input, submit);
    form.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        let code = value;
        try {
          const invite = new URL(value);
          const invitedSport = invite.searchParams.get("sport");
          if (isSportId(invitedSport)) sportId = invitedSport;
          code = invite.searchParams.get("room") ?? value;
        } catch {}
        void joinOnline("join", code);
      },
      { signal },
    );
    overlay.append(form);
  }
  function renderLobby(lobby: Lobby) {
    if (!online || screen === "online-error") return;
    sportId = lobby.sportId;
    if (performanceDiagnostics.enabled) performanceDiagnostics.setMetadata({ mode: sportId, serverBuild: lobby.build });
    shuffle = lobby.shuffle === true;
    canvas.setAttribute("aria-label", `${sport().label} court`);
    if (lobby.phase === "playing") {
      if (screen === "online-lobby" || screen === "online-connecting") {
        void beginOnlinePlay(lobby);
      }
      return;
    }
    if (lobby.phase === "results" || lobby.phase === "closing") return;
    const focusedButton = document.activeElement instanceof HTMLButtonElement && overlay.contains(document.activeElement) ? document.activeElement : null;
    const focusedTeam = focusedButton?.dataset.team;
    const focusedAction = focusedButton && !focusedTeam ? focusedButton.textContent : null;
    const key = JSON.stringify(lobby);
    if (key === onlineLobbyKey) return;
    onlineLobbyKey = key;
    screen = "online-lobby";
    const seat = lobby.seats.find((seat) => seat.id === online?.participantId);
    const canStart =
      lobby.phase === "waiting" &&
      lobby.seats.length >= (sportId === "crypt-guardian" ? 1 : 2) &&
      lobby.seats.every((s) => s.ready && s.connected);
    menu(
      lobby.phase === "countdown"
        ? `Starting in ${Math.ceil(lobby.countdown / 60)}`
        : "The next match",
      lobby.private
        ? `${shuffle ? "Shuffle · " : ""}${sport().label} · Private court ${lobby.roomId} · ${sportId === "crypt-guardian" ? "2 allies versus the guardian" : "2 versus 2"}`
        : `${shuffle ? "Shuffle · " : ""}${sport().label} · Public court · ${sportId === "crypt-guardian" ? "2 allies versus the guardian" : "2 versus 2"}`,
      [
        ...(lobby.phase === "waiting" && seat
          ? [[seat.ready ? "Ready ✓" : "Ready", () => online?.ready()] as [string, () => void]] : []),
        ...(canStart
          ? [["Start with bots", () => online?.start()] as [string, () => void]]
          : []),
        ["Leave", title],
      ],
      `ONLINE · ${sport().label.toUpperCase()}`,
    );
    overlay.className = "setup-menu lobby-menu";
    const readyButton = overlay.querySelector<HTMLButtonElement>(".menu-actions button");
    if (seat?.ready && readyButton?.textContent === "Ready ✓") readyButton.disabled = true;
    const roster = document.createElement("div");
    roster.className = "lobby-roster";
    for (const team of (sportId === "crypt-guardian" ? [0] : [0, 1])) {
      const column = document.createElement("div");
      const identity = TEAMS[lobby.teamIds[team]!];
      column.style.color = identity.color;
      const heading = document.createElement("strong");
      heading.textContent = sportId === "crypt-guardian" ? `ALLIES ${team * 2 + 1}–${team * 2 + 2}` : identity.name.toUpperCase();
      heading.prepend(teamIcon(lobby.teamIds[team]!));
      column.append(heading);
      const seats = lobby.seats.filter((s) => s.team === team);
      for (let n = 0; n < 2; n++) {
        const row = document.createElement("p");
        const seat = seats[n];
        row.textContent = seat
          ? `${seat.name} · ${seat.connected ? (seat.ready ? "Ready" : "Not ready") : "Reconnecting"}`
          : "Computer teammate";
        column.append(row);
      }
      roster.append(column);
    }
    overlay.insertBefore(roster, overlay.lastChild);
    if (lobby.private) {
      const link = new URL(location.href);
      link.searchParams.set("room", lobby.roomId);
      link.searchParams.set("sport", lobby.sportId);
      const copy = button("Copy invite", () => {
        void Promise.resolve().then(() => navigator.clipboard.writeText(link.href)).then(() => { copy.textContent = "Invite copied"; }).catch(() => {
          notice.textContent = `Room code: ${lobby.roomId}`;
        });
      });
      overlay.querySelector(".menu-actions")!.append(copy);
    }
    if (focusedAction) Array.from(overlay.querySelectorAll<HTMLButtonElement>(".menu-actions button")).find(candidate => candidate.textContent === focusedAction)?.focus();
  }
  async function beginOnlinePlay(lobby: Lobby) {
    const generation = onlineJoinGeneration;
    screen = "online-starting";
    menu("Get ready", "Opening the stadium…", []);
    try {
      await presenter.prewarm(createCryptballSession({ sportId: lobby.sportId }).observe());
      if (generation !== onlineJoinGeneration || disposed || !online || screen !== "online-starting") return;
      observation = online.observe();
      screen = "play";
      overlay.hidden = true;
      onlineLobbyKey = "";
      audio.resetMatch();
      observeMusic();
      void audio.engine.resume();
      if (online.suspended || lifecycle.inputSuspended || document.hidden) {
        online.suspend();
        showOnlinePause();
      } else {
        online.resume();
      }
      lifecycle.resume();
      updateHud();
    } catch (error) {
      if (generation === onlineJoinGeneration)
        onlineFailure(error instanceof Error ? error.message : "Court assets could not load. Please retry.");
    }
  }
  let playerName = "";
  let shuffle = false;
  async function joinOnline(kind: "quick" | "private" | "join", code?: string) {
    if (sportId === "crypt-guardian" && kind !== "join") {
      onlineFailure("Crypt Guardian is a solo activity for now."); return;
    }
    if (!playerName) {
      menu("Your name", "Shown above your athlete. Up to 24 characters.", [["Back", title]]);
      const form = document.createElement("form"); form.className = "room-entry";
      const input = document.createElement("input"); input.required = true; input.maxLength = 24;
      input.placeholder = "Player name"; input.setAttribute("aria-label", "Player name");
      const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "Continue";
      form.append(input,submit); overlay.append(form); input.focus();
      form.addEventListener("submit", e => { e.preventDefault(); playerName = input.value.trim(); if(playerName) void joinOnline(kind,code); }, {signal});
      return;
    }
    const generation = ++onlineJoinGeneration;
    if (online) {
      void online.leave();
      online = null;
    }
    onlineLobbyKey = "";
    screen = "online-connecting";
    menu("Finding a court", "Connecting to the stadium…", [["Cancel", title]]);
    try {
      const { createOnlineSession } = await import("./online/session");
      if (generation !== onlineJoinGeneration || disposed) return;
      const next = createOnlineSession({
        name: playerName,
        shuffle,
        sportId,

        onPerformance: performanceDiagnostics.enabled
          ? event => performanceDiagnostics.onlineEvent(event, `online:${generation}`) : undefined,
        onTeamError: (message) => { notice.textContent = message; },
        onLobby: (value) => {
          if (generation === onlineJoinGeneration) renderLobby(value);
        },
        onStatus: (status) => {
          if (generation !== onlineJoinGeneration) return;
          if (status === "reconnecting")
            notice.textContent =
              "Reconnecting — computer covering your player…";
          else if (status === "joined") notice.textContent = "";
        },
        onError: (message) => {
          if (generation === onlineJoinGeneration) onlineFailure(message);
        },
      });
      online = next;
      session = next;
      if (document.hidden || lifecycle.inputSuspended) next.suspend();
      await next.connect(kind, code);
      if (generation !== onlineJoinGeneration) {
        await next.leave();
        return;
      }
      if (next.lobby) renderLobby(next.lobby);
      lifecycle.resume();
      await audio.engine.unlock();
    } catch (error) {
      if (generation === onlineJoinGeneration)
        onlineFailure(
          error instanceof Error
            ? error.message
            : "The server is unavailable. You can still play Solo.",
        );
    }
  }
  function showOnlinePause() {
    screen = "pause";
    menu(
      "Computer covering",
      "The online match continues while you are away.",
      [
        ["Return to play", resume],
        ["Settings", () => settings("pause")],
        ["Leave match", title],
      ],
    );
  }
  function guardianPracticeSetup() {
    screen = "practice-setup";
    menu("Guardian practice", "Unscored training · choose a weapon family and learn its warnings. Retry keeps the seed.", [["Begin practice", () => start("practice")], ["Back", title]]);
    const label=document.createElement("label"); label.textContent="Weapon family ";
    const select=document.createElement("select"); select.setAttribute("aria-label","Practice weapon family");
    for(const [value,text] of [["","Seeded guardian"],["cannon","Ossuary Cannon"],["hook","Grave Hook"],["maul","Tomb Maul"]]){const option=document.createElement("option");option.value=value!;option.textContent=text!;select.append(option);}
    select.value=guardianPractice.weapon??"";select.addEventListener("change",()=>{guardianPractice.weapon=select.value?select.value as "cannon"|"hook"|"maul":undefined;},{signal});label.append(select);
    const immortalLabel=document.createElement("label"),immortal=document.createElement("input");immortal.type="checkbox";immortal.checked=!!guardianPractice.immortal;immortal.addEventListener("change",()=>{guardianPractice.immortal=immortal.checked;},{signal});immortalLabel.append(immortal," Immortal athletes (practice only)");
    overlay.insertBefore(label,overlay.querySelector(".menu-actions"));overlay.insertBefore(immortalLabel,overlay.querySelector(".menu-actions"));
  }
  async function start(mode: "match" | "practice", newGuardian = false) {
    onlineJoinGeneration++;
    if (online) {
      void online.leave();
      online = null;
    }
    notice.textContent = "";
    if (newGuardian) guardianSeed = (guardianSeed + 0x9e3779b9) >>> 0;
    session = createCryptballSession({ mode, sportId, teamIds: localTeams(), seed: guardianSeed, ...(mode === "practice" && sportId === "crypt-guardian" ? {guardianPractice} : {}) });
    canvas.setAttribute("aria-label", `${sport().label} court`);
    practicePrompt =
      sportId === "rift-volley"
        ? "Move under the ball. K sets high; hold J and release to attack."
        : sportId === "cryptkick"
          ? "Move to the ball to dribble. Hold J, then release to kick."
          : sportId === "cryptcheck"
            ? "Push to skate; release movement to coast. Move opposite to brake. K passes; tap J for a wrist shot, hold and release for a slapshot."
            : "Move close to the orb. Hold J, then release to strike.";
    observation = session.observe();
    if (observation.guardian) guardianSeed = observation.guardian.descriptor.seed;
    pendingEvents = [];
    touch.cancel(); touch.consume(performance.now()); touchFacing = undefined;
    for (const id of capturedTouches) releaseTouch(id);
    edges = {};
    keys.clear();
    secondaryHeld = false;
    pointerHeld = false;
    pointerAim = undefined;
    screen = "starting";
    startingReady = false;
    warmFrames = 0;
    menu("Get ready", "Opening the stadium…", []);
    localMusicMatch++;
    audio.resetMatch();
    observeMusic();
    try { await presenter.prewarm(observation); }
    catch (error) { if (!disposed && screen === "starting") { screen = "load-error"; menu("Artwork could not load", String(error), [["Try again", () => start(mode)], ["Title", title]]); } return; }
    if (disposed || screen !== "starting") return;
    await audio.engine.unlock();
    await audio.engine.resume();
    if (disposed || screen !== "starting") return;
    // Let first-use audio and GPU compilation settle before starting the clock.
    // Six consecutive display frames below 50ms avoid treating warmup as game debt.
    startingReady = true;
  }
  function pause() {
    if (screen !== "play") return;
    if (online) {
      cancel();
      online.suspend();
      showOnlinePause();
      return;
    }
    screen = "pause";
    lifecycle.pause();
    audio.engine.pause();
    menu("Time out", "Your match is paused.", [
      ["Resume", resume],
      [
        "Restart match",
        () =>
          menu("Restart this match?", "The current score will be discarded.", [
            ["Restart", () => start(observation.mode)],
            ["Keep playing", resume],
          ]),
      ],
      ["How to play", help],
      ["Settings", () => settings("pause")],
      ["Title", title],
    ]);
  }
  function resume() {
    online?.resume();
    screen = "play";
    overlay.hidden = true;
    edges = {};
    void audio.engine.resume();
    lifecycle.resume();
    canvas.focus();
  }
  function help() {
    screen = "help";
    menu(
      "How to play",
      `${sport().description} ${sport().rules.join(". ")}. ${sport().scoring} ${controlsText()}${touchMode ? " Move and action thumbs can start on either side of the court. Teammate rings appear when switching is available." : ". Aim with the mouse or your last movement direction. Hold the primary action to charge, then release. Q switches to a computer teammate."}${sportId === "cryptcheck" ? " Release movement to coast; move against your glide to brake before reversing. Aim turns your stick independently of your glide." : ""}`,
      [
        [
          "Back",
          () => {
            screen = "play";
            pause();
          },
        ],
      ],
    );
  }
  function credits() {
    screen = "credits";
    menu(
      "Made for the crypt",
      "Original armored athletes, crypt court, interface and synthesized score. Six mascot teams share one arena.",
      [["Back", title]],
    );
    const p = document.createElement("p");
    p.className = "fine";
    p.textContent =
      "This build uses generated fantasy artwork with cleaned runtime animation sheets. See the asset manifest and LICENSES.txt for provenance.";
    overlay.append(p);
  }
  function settings(from: string) {
    returnScreen = from;
    screen = "settings";
    menu("Settings", "Tune the stadium to suit you.", [
      [
        "Back",
        () => {
          if (returnScreen === "title") title();
          else {
            screen = "play";
            pause();
          }
        },
      ],
    ]);
    const form = document.createElement("div");
    form.className = "settings";
    for (const key of ["music", "effects"] as const) {
      const label = document.createElement("label");
      label.textContent = key === "music" ? "Music" : "Effects";
      const input = document.createElement("input");
      input.type = "range";
      input.min = "0";
      input.max = "1";
      input.step = ".05";
      input.value = String(prefs[key]);
      input.setAttribute("aria-label", label.textContent);
      input.addEventListener(
        "input",
        () => {
          prefs[key] = Number(input.value);
          audio.volumes(prefs.music, prefs.effects);
          save();
        },
        { signal },
      );
      label.append(input);
      form.append(label);
    }
    const label = document.createElement("label");
    label.textContent = "Reduced motion";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = prefs.reducedMotion;
    input.addEventListener(
      "change",
      () => {
        prefs.reducedMotion = input.checked;
        save();
      },
      { signal },
    );
    label.append(input);
    form.append(label);
    overlay.insertBefore(form, overlay.lastChild);
  }
  const writeText = (node: Element, text: string) => {
    if (node.textContent !== text) node.textContent = text;
  };
  function updateHud(state = observation) {
    touchCues.hidden = screen !== "play";
    game.dataset.sport = state.sportId;
    const newMode = isNewMode(state.sportId);
    modeHud.hidden = !newMode || !["play", "starting"].includes(screen);
    modeHud.dataset.mode=state.sportId;
    const mine = state.players.find(p=>p.id===state.controlledId);
    const carrying = !!state.dodge?.balls.some(b=>!b.retired && b.mode.holderId===state.controlledId) || !!state.guardian && (state.guardian.orbs?.some(b=>b.possessionId===state.controlledId) ?? state.possessionId===state.controlledId);
    const reviveNear = !carrying && !!state.guardian && !!mine && state.guardian.athletes[mine.id]?.status === "active" && !!reviveTarget(state,mine);
    touch.setContext({catch:newMode && !reviveNear && !carrying && (!!state.dodge?.athletes[state.controlledId]?.lives || state.guardian?.athletes[state.controlledId]?.status==="active"), revive:reviveNear, preparedThrow:!!state.dodge?.athletes[state.controlledId]?.pendingThrow});
    modeSummary.textContent=state.guardian ? `${state.guardian.descriptor.name} · ${state.guardian.descriptor.weapon.toUpperCase()} · ${state.guardian.hp} / ${state.guardian.maxHp} HP` : "3 LIVES · BEST OF THREE";
    bossMeter.hidden=!state.guardian; bossMeter.value=state.guardian?.hp??0;
    while(rosterCards.length>state.players.length) rosterCards.pop()!.remove();
    while(rosterCards.length<state.players.length) { const card=document.createElement("span");roster.append(card);rosterCards.push(card); }
    rosterCards.forEach((card,i)=>{const p=state.players[i]!;const d=state.dodge?.athletes[p.id],a=state.guardian?.athletes[p.id];card.textContent=`${p.id===state.controlledId?"YOU":state.guardian?"ALLY "+(i+1):`P${i+1} ${p.team===mine?.team?"ALLY":"RIVAL"}`} ${d?d.lives?"◆".repeat(d.lives)+"◇".repeat(3-d.lives):"✕ OUT":a?a.status==="active"?"♥".repeat(a.hp)+"♡".repeat(5-a.hp):a.status==="down"?`DOWN ${Math.floor(a.reviveTicks/90*100)}%`:"✕ OUT":""}`;card.dataset.player=p.id;});
    contextTrigger.hidden=!touchMode || state.sportId==="crypt-dodge" && (!state.dodge?.athletes[state.controlledId]?.lives || carrying) || state.sportId==="crypt-guardian" && (carrying || state.guardian?.athletes[state.controlledId]?.status!=="active");
    contextTrigger.textContent=reviveNear?"HOLD REVIVE":"CATCH";
    contextTrigger.setAttribute("aria-label",reviveNear?"Hold to revive nearby ally":state.sportId==="crypt-dodge"?"Catch the dodgeball":"Catch the orb");
    contextTrigger.disabled=screen!=="play";
    if (!reviveNear) contextHeld=false;
    if(state.dodge){game.dataset.controlledCatch=state.dodge.athletes[state.controlledId]?.catchKind??"none";game.dataset.controlledCatchStart=String(state.dodge.athletes[state.controlledId]?.catchStart??-1); }
    game.dataset.tick = String(state.tick);
    game.dataset.phase = state.phase;
    const controlled = state.players.find((p) => p.id === state.controlledId);
    const skater = controlled && state.sportId === "cryptcheck" ? state.hockey?.skaters[controlled.id] : undefined;
    const showCheck = touchMode && state.sportId === "cryptcheck";
    if (checkTrigger.parentElement !== game) game.append(checkTrigger);
    checkTrigger.hidden = !showCheck || screen !== "play";
    checkTrigger.disabled = screen !== "play";
    checkTrigger.setAttribute("aria-disabled", String(!!skater?.check || !!skater?.downTicks));
    game.dataset.controlledAction = skater?.downTicks ? "knockdown" : skater?.check ? "check" : controlled?.slideTicks ? "slide" : controlled?.slideRecovery ? "slide-recover" : controlled?.action?.kind ?? "idle";
    game.dataset.passes = String(state.stats.passes);
    game.dataset.controlledId = state.controlledId;
    game.dataset.charging = String(!!controlled?.charging);
    if (controlled) { game.dataset.playerX = String(controlled.x); game.dataset.playerY = String(controlled.y); game.dataset.aim = String(controlled.heading); }
    canvas.setAttribute("aria-label", `${SPORTS[state.sportId].label} court`);
    if (screen === "play" && game.dataset.menu !== "play") {
      game.dataset.menu = "play";
      document.querySelector<HTMLElement>("#hud")!.hidden = false;
      resize();
    }
    const home = TEAMS[state.teamIds[0]], away = TEAMS[state.teamIds[1]];
    const homeNode = document.querySelector<HTMLElement>("#ivory")!, awayNode = document.querySelector<HTMLElement>("#ember")!;
    homeNode.style.backgroundImage = `url("${home.icon}")`;
    awayNode.style.backgroundImage = `url("${away.icon}")`;
    homeNode.style.color = home.color; awayNode.style.color = away.color;
    writeText(homeNode, state.guardian ? "TWO ALLIES" : `${home.name.toUpperCase()} ${state.score[0]}`);
    writeText(awayNode, state.guardian ? `GUARDIAN ${state.guardian.hp} HP` : `${state.score[1]} ${away.name.toUpperCase()}`);
    const secs = Math.ceil(state.remainingTicks / 60),
      clock = document.querySelector("#clock")!;
    writeText(
      clock,
      state.mode === "practice"
        ? "PRACTICE"
        : sportId === "rift-volley"
          ? "FIRST TO 11"
          : `${state.overtime ? "OT " : ""}${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`,
    );
    clock.classList.toggle(
      "urgent",
      sportId !== "rift-volley" && state.mode !== "practice" && secs <= 10,
    );
    writeText(
      prompt,
      state.phase === "ready"
        ? sportId === "rift-volley"
          ? "GET READY · CLEAR THE NET"
          : sportId === "cryptcheck"
            ? "FACEOFF · WAIT FOR THE WHISTLE"
            : state.players.find((p) => p.id === state.controlledId)?.team === 1
            ? `GET READY · ← ${away.name.toUpperCase()} ATTACKS LEFT`
            : `GET READY · ${home.name.toUpperCase()} ATTACKS RIGHT →`
        : state.phase === "goal"
          ? sportId === "rift-volley"
            ? "POINT!"
            : "GOAL!"
          : state.mode === "practice"
            ? touchMode ? `Drag: move · Other thumb: tap to pass, hold/release to shoot, flick to ${sportId === "cryptcheck" ? "poke · CHECK: body-check" : "dive"}` : practicePrompt
            : state.volley
              ? state.volley.serving
                ? `${TEAMS[state.teamIds[state.volley.serveTeam]].name.toUpperCase()} SERVES · ${touchMode ? "HOLD / RELEASE TO ATTACK" : "J / LEFT MOUSE TO ATTACK"}`
                : `${TEAMS[state.teamIds[state.volley.lastContactTeam === 1 ? 1 : 0]].name.toUpperCase()} · ${state.volley.teamContacts} / 3 CONTACTS · ${touchMode ? "TAP SETS · FLICK DIGS" : "K SETS · SHIFT DIGS"}`
              : " ",
    );
    if (newMode) writeText(prompt, modeStatus(state, touchMode));
    if(state.guardian){game.dataset.guardianHp=String(state.guardian.hp);game.dataset.guardianSeed=String(state.guardian.descriptor.seed);game.dataset.guardianStatus=state.players.map(p=>state.guardian!.athletes[p.id].status).join(",");}
    if(state.dodge){game.dataset.dodgeLives=state.players.map(p=>state.dodge!.athletes[p.id].lives).join(",");game.dataset.dodgeBall=state.dodge.ball.state;game.dataset.dodgeHolder=state.dodge.ball.holderId??"";}
    drawTouchCues();
  }
  let practicePrompt = "Move close to the orb. Hold J, then release to strike.";
  function tick() {
    frameSteps++;
    if (online) {
      online.update();
      observation = online.observe();
      if (online.lobby) renderLobby(online.lobby);
      observeMusic();
      if (screen !== "play") {
        pendingEvents.push(...online.drainEvents());
        updateHud();
        return;
      }
    }
    if (screen !== "play") return;
    const gesture = touch.consume(performance.now());
    const dx =
        Number(keys.has("KeyD") || keys.has("ArrowRight")) -
        Number(keys.has("KeyA") || keys.has("ArrowLeft")),
      dy =
        Number(keys.has("KeyS") || keys.has("ArrowDown")) -
        Number(keys.has("KeyW") || keys.has("ArrowUp"));
    const keyboardMoving = !!(dx || dy);
    const screenMove = keyboardMoving ? { x: dx, y: dy } : gesture.move;
    const direction = screenVectorToWorld(screenMove.x, screenMove.y);
    const magnitude = keyboardMoving ? 1 : Math.min(1, Math.hypot(screenMove.x, screenMove.y));
    const move = { x: direction.x * magnitude, y: direction.y * magnitude };
    const state = online ? online.rawObserve() : observation,
      player = state.players.find((p) => p.id === state.controlledId)!;
    let aim: number | undefined;
    if (gesture.aim) {
      const v = screenVectorToWorld(gesture.aim.x, gesture.aim.y);
      aim = aimHeading(v.x, v.y);
    } else if (gesture.aiming || gesture.edges.strikeReleased) aim = touchFacing ?? player.heading;
    else if (pointerAim) {
      const point = stage.pointer(pointerAim.x, pointerAim.y),
        world = unprojectCourt(point.x, point.y);
      aim = aimHeading(world.x - player.x / 256, world.y - player.y / 256);
    } else if (screenMove.x || screenMove.y) aim = aimHeading(move.x, move.y);
    // Specials deliberately use the movement thumb's direction even while the
    // action thumb is holding independent shot aim.
    session.step({
      ...edges,
      ...gesture.edges,
      moveX: move.x,
      moveY: move.y,
      aim,
      pointerAim: !!pointerAim || gesture.aiming || !!gesture.aim,
      strikeHeld: keys.has("KeyJ") || pointerHeld || gesture.strikeHeld,
      passHeld: sportId === "crypt-guardian" && (keys.has("KeyK") || middleHeld || contextHeld || gesture.passHeld),
      slide:
        gesture.edges.slide || (["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(sportId) ? !!edges.slide : secondaryHeld || keys.has("KeyI") || keys.has("ShiftLeft") || keys.has("ShiftRight")),
    });
    game.dataset.passHeld=String(sportId === "crypt-guardian" && (keys.has("KeyK") || middleHeld || contextHeld || gesture.passHeld));
    edges = {};
    observation = session.observe();
    capturePresentation();
    const events = session.drainEvents();
    if (ownControlSwitched(events, online?.participantId)) {
      touch.disarmAction(); touchFacing = undefined;
      keys.delete("KeyJ");
      secondaryHeld = false;
      pointerHeld = false;
    }
    pendingEvents.push(...events);
    if (!online) observeMusic();
    audio.tick(observation, events, !!online);
    if (events.some((e) => e.type === "strike" && e.team === 0))
      practicePrompt =
        sportId === "rift-volley"
          ? "K sets the ball high. Q switches control. Stay on your side of the net."
          : sportId === "cryptcheck"
            ? "K passes. Press Shift / I / right mouse once to poke; E body-checks; Space / L dashes. Move opposite your glide to brake."
            : "K passes toward your teammate. Q switches control.";
    if (events.some((e) => e.type === "pass"))
      practicePrompt = sportId === "cryptcheck"
        ? "Space / L commits a skate burst. Release movement to coast; move opposite to brake. Escape opens the menu."
        : "Space / L dashes. Escape opens the menu when you are ready to play.";
    updateHud();
    if (observation.phase === "results") {
      if (!online) lifecycle.stopClock();
      if (observation.guardian?.outcome === "victory") { screen="finishing";finishingElapsed=0;prompt.textContent="GUARDIAN DEFEATED"; }
      else showResults();
    }
  }
  function showResults() {
    screen="results";
      const s = observation;
      menu(
        s.guardian ? s.guardian.outcome === "victory" ? "Guardian defeated" : "The crypt claims the party" : s.winner === "draw"
          ? "A worthy draw"
          : `${TEAMS[s.teamIds[s.winner === 1 ? 1 : 0]].name} take the crown`,
        s.guardian ? `${s.guardian.descriptor.name} · ${s.guardian.hp} HP remains · ${Math.floor(s.guardian.elapsed / 60)} seconds` : `${s.score[0]} — ${s.score[1]}${s.dodge ? " rounds" : ""}`,
        [
          [
            s.guardian ? "Retry Guardian" : shuffle ? "Next activity" : "Rematch",
            () => {
              if (online) {
                onlineLobbyKey = "";
                screen = "online-lobby";
                online.rematch();
              } else {
                if(shuffle) {
                  const modes: SportId[]=SPORT_IDS.filter(id=>id!=="crypt-guardian");
                  sportId=modes[(modes.indexOf(sportId)+1)%modes.length]!;
                }
                void start(s.guardian ? s.mode : "match");
              }
            },
          ],
          ...(s.guardian && !online ? [["New Guardian", () => start(s.mode, true)] as [string, () => void]] : []),
          ["Title", title],
        ],
        s.mode === "practice" && isNewMode(sportId) ? "PRACTICE COMPLETE · UNSCORED" : sportId === "rift-volley" ? "MATCH COMPLETE" : "FULL TIME",
      );
      const stats = document.createElement("p");
      stats.className = "fine";
      const teamName = TEAMS[s.teamIds[s.players.find((p) => p.id === s.controlledId)?.team ?? 0]].name.toUpperCase();
      stats.textContent = s.guardian ? `${s.stats.shots} orb strikes · ${s.stats.passes} ally passes · Seed ${s.guardian.descriptor.seed}` : s.dodge ? `${s.stats.shots} throws · ${s.stats.passes} passes · Best of three rounds` :
        sportId === "rift-volley"
          ? `${teamName} · ${s.stats.shots} attacks · ${s.stats.goals} points · ${s.stats.passes} sets`
          : `${teamName} · ${s.stats.shots} shots · ${s.stats.goals} goals · ${s.stats.passes} completed passes`;
      overlay.append(stats);
  }
  const movement = new Set([
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
  ]);
  const playKeys = new Set([
    ...movement,
    "KeyJ",
    "KeyK",
    "KeyL",
    "Space",
    "KeyQ",
    "KeyB",
    "KeyI",
    "ShiftLeft",
    "ShiftRight",
  ]);
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Escape") {
        if (e.repeat) return;
        e.preventDefault();
        if (screen === "play") pause();
        else if (screen === "pause") resume();
        return;
      }
      if (import.meta.env.DEV && e.code === "Backquote") {
        debug = !debug;
        presenter.setDebug(debug);
        return;
      }
      if (screen !== "play" || !playKeys.has(e.code) && !(sportId === "cryptcheck" && e.code === "KeyE")) return;
      if (
        e.target instanceof HTMLElement &&
        e.target.closest("button,input,select,textarea")
      )
        return;
      e.preventDefault();
      if (e.repeat) return;
      inputMode(false);
      keys.add(e.code);
      if (movement.has(e.code)) pointerAim = undefined;
      if (e.code === "KeyJ") edges.strikePressed = true;
      if (e.code === "KeyK") edges.pass = true;
      if (e.code === "Space" || e.code === "KeyL") edges.dash = true;
      if (e.code === "KeyQ") edges.switch = true;

      if (sportId === "cryptcheck" && e.code === "KeyE") edges.check = true;
      if (["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(sportId) && ["KeyI", "ShiftLeft", "ShiftRight"].includes(e.code)) edges.slide = true;
    },
    { signal },
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (screen === "play" && e.code === "KeyJ" && keys.has("KeyJ"))
        edges.strikeReleased = true;
      keys.delete(e.code);
    },
    { signal },
  );
  canvas.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch") {
        if (!capturedTouches.has(e.pointerId) || screen !== "play") return;
        e.preventDefault(); touch.movePointer(e.pointerId, e.clientX, e.clientY, performance.now()); drawTouchCues(); return;
      }
      if (screen === "play" && (e.movementX || e.movementY))
        pointerAim = { x: e.clientX, y: e.clientY };
    },
    { signal },
  );
  canvas.addEventListener(
    "pointerdown",
    (e) => {
      if (screen !== "play") return;
      void audio.engine.unlock();
      inputMode(e.pointerType === "touch");
      if (e.pointerType === "touch") {
        e.preventDefault();
        pointerAim = undefined;
        if (!touch.visual.action) touchFacing = observation.players.find(p => p.id === observation.controlledId)?.heading;
        touch.down(e.pointerId, e.clientX, e.clientY, performance.now(), teammateAt(e.clientX, e.clientY));
        capturedTouches.add(e.pointerId);
        canvas.setPointerCapture(e.pointerId);
        drawTouchCues(); return;
      }
    },
    { signal },
  );
  // Mouse buttons have independent down/up edges even when chorded. Pointer
  // down/up only report the first/last button and cannot represent this mapping.
  canvas.addEventListener("mousedown", e => {
      if (screen !== "play" || touchMode) return;
      e.preventDefault();
      pointerAim = { x: e.clientX, y: e.clientY };
      if (e.button === 0) {
        pointerHeld = true;
        edges.strikePressed = true;
      }
      if (e.button === 2) {
        if (["cryptcheck", "crypt-dodge", "crypt-guardian"].includes(sportId) && !secondaryHeld) edges.slide = true;
        secondaryHeld = true; pointerAim = { x: e.clientX, y: e.clientY };
      }
      if (e.button === 1) { edges.pass = true; middleHeld=true; }
  }, { signal });
  window.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerType === "touch") {
        if (!capturedTouches.has(e.pointerId)) return;
        if (screen === "play") touch.up(e.pointerId, e.clientX, e.clientY, performance.now());
        releaseTouch(e.pointerId); drawTouchCues(); return;
      }
    },
    { signal },
  );
  window.addEventListener("mouseup", e => {
      if (e.button === 1) middleHeld=false;
      if (e.button === 2) secondaryHeld = false;
      if (e.button === 0) {
        if (screen === "play" && pointerHeld) edges.strikeReleased = true;
        pointerHeld = false;
      }
  }, { signal });
  canvas.addEventListener(
    "pointercancel",
    (e) => {
      if (e.pointerType === "touch" && !capturedTouches.has(e.pointerId)) return;
      cancel();
    },
    { signal },
  );
  canvas.addEventListener("lostpointercapture", (e) => { if (capturedTouches.has(e.pointerId)) cancel(); }, { signal });
  canvas.addEventListener("auxclick", e => { if (screen === "play") e.preventDefault(); }, { signal });
  canvas.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
  contextTrigger.addEventListener("pointerdown",e=>{e.preventDefault();e.stopPropagation();if(screen!=="play")return;inputMode(e.pointerType==="touch");void audio.engine.unlock();if(sportId==="crypt-dodge" || !contextTrigger.textContent?.includes("REVIVE"))edges.strikePressed=true;else contextHeld=true;contextTrigger.setPointerCapture(e.pointerId);},{signal});
  for(const event of ["pointerup","pointercancel","lostpointercapture"])contextTrigger.addEventListener(event,()=>{contextHeld=false;},{signal});
  contextTrigger.addEventListener("keydown",e=>{if(e.repeat || screen!=="play")return;if(e.code==="Space"||e.code==="Enter"){e.preventDefault();if(sportId==="crypt-dodge" || !contextTrigger.textContent?.includes("REVIVE"))edges.strikePressed=true;else contextHeld=true;}},{signal});
  contextTrigger.addEventListener("keyup",()=>{contextHeld=false;},{signal});
  bindHudTrigger(checkTrigger, () => {
    if (screen !== "play" || sportId !== "cryptcheck") return;
    void audio.engine.unlock(); edges.check = true;
    canvas.focus({ preventScroll: true });
  });
  function bindHudTrigger(trigger: HTMLButtonElement, activate: () => void) {
    trigger.addEventListener("pointerdown", e => {
      e.stopPropagation();
      if (screen !== "play") return;
      inputMode(e.pointerType === "touch");
      if (e.pointerType !== "touch") return;
      e.preventDefault();
      if ([...hudTouches.values()].some(contact => contact.trigger === trigger)) return;
      hudTouches.set(e.pointerId, { trigger, x: e.clientX, y: e.clientY, moved: false });
      trigger.setPointerCapture(e.pointerId);
    }, { signal });
    trigger.addEventListener("pointermove", e => {
      const contact = hudTouches.get(e.pointerId);
      if (contact && Math.hypot(e.clientX - contact.x, e.clientY - contact.y) >= 14) contact.moved = true;
    }, { signal });
    trigger.addEventListener("pointerup", e => {
      const contact = hudTouches.get(e.pointerId);
      if (!contact) return;
      hudTouches.delete(e.pointerId); lastHudTouch = performance.now();
      if (trigger.hasPointerCapture(e.pointerId)) trigger.releasePointerCapture(e.pointerId);
      if (!contact.moved && Math.hypot(e.clientX - contact.x, e.clientY - contact.y) < 14) activate();
    }, { signal });
    for (const name of ["pointercancel", "lostpointercapture"])
      trigger.addEventListener(name, e => { hudTouches.delete((e as PointerEvent).pointerId); }, { signal });
    trigger.addEventListener("click", e => {
      // Every touch pointer can activate, including a non-primary thumb. The
      // subsequent compatibility click must never activate Flutter twice.
      if ((e as PointerEvent).pointerType === "touch" || e.detail && performance.now() - lastHudTouch < 600) return;
      activate();
    }, { signal });
  }
  function releaseTouch(id: number) {
    capturedTouches.delete(id);
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function teammateTargets() {
    if (!touchMode || !touch.visual.movement || screen !== "play") return [];
    const controlled = observation.players.find(p => p.id === observation.controlledId);
    if (!controlled) return [];
    const bounds = canvas.getBoundingClientRect(), rect = game.getBoundingClientRect();
    return eligibleTouchTeammates(observation, online ? online.controllerOwners : null, online?.participantId ?? null).map(p => {
      const point = projectCourt(p.x / 256, p.y / 256);
      return { id: p.id, x: bounds.left + point.x / VIEW.width * bounds.width - rect.left,
        y: bounds.top + (point.y - 10) / VIEW.height * bounds.height - rect.top };
    });
  }
  function teammateAt(x: number, y: number) {
    const rect = game.getBoundingClientRect();
    const hits = teammateTargets().filter(p => Math.hypot(p.x + rect.left - x, p.y + rect.top - y) <= 22);
    return hits.length === 1 ? hits[0]!.id : undefined;
  }
  function drawTouchCues() {
    const rect = game.getBoundingClientRect(), visual = touch.visual;
    for (const [element, value] of [[moveCue, visual.movement], [actionCue, visual.action]] as const) {
      element.hidden = !value || screen !== "play";
      if (!value) continue;
      element.style.left = `${value.anchor.x - rect.left}px`; element.style.top = `${value.anchor.y - rect.top}px`;
      (element.firstElementChild as HTMLElement).style.transform = `translate(${value.point.x - value.anchor.x}px, ${value.point.y - value.anchor.y}px)`;
    }
    actionCue.dataset.phase = visual.action?.phase ?? "";
    const targets = teammateTargets();
    while (teammateCues.children.length > targets.length) teammateCues.lastChild!.remove();
    targets.forEach((p, i) => {
      let cue = teammateCues.children[i] as HTMLElement | undefined;
      if (!cue) { cue = document.createElement("div"); cue.className = "touch-teammate"; teammateCues.append(cue); }
      cue.style.left = `${p.x}px`; cue.style.top = `${p.y}px`; cue.dataset.player = p.id;
    });
  }
  // BrowserLifecycle already owns blur/orientation cancellation and pause.
  document.querySelector("#pause-button")!.addEventListener(
    "click",
    () => {
      if (screen === "play") pause();
      else if (screen === "pause") resume();
    },
    { signal },
  );
  document.querySelector("#sound-button")!.addEventListener(
    "click",
    () => {
      muted = !muted;
      audio.engine.setMuted(muted);
      void audio.engine.unlock();
      const b = document.querySelector("#sound-button")!;
      b.textContent = muted ? "Sound off" : "Sound on";
      b.setAttribute("aria-label", muted ? "Unmute sound" : "Mute sound");
    },
    { signal },
  );
  function resize() {
    const inset = getComputedStyle(document.body);
    const safeX = parseFloat(inset.paddingLeft) + parseFloat(inset.paddingRight);
    const safeY = parseFloat(inset.paddingTop) + parseFloat(inset.paddingBottom);
    const scale = fitCryptballScale(innerWidth - safeX - (touchMode ? 8 : 32), innerHeight - safeY - (touchMode ? 24 : 64));
    game.style.width = `${VIEW.width * scale}px`;
    const courtHeight = VIEW.height * scale;
    const setupHeight = innerWidth <= 600 && innerHeight > innerWidth
      ? Math.min(innerHeight - safeY - 24, 760)
      : Math.max(courtHeight, Math.min(innerHeight - safeY - (touchMode ? 24 : 64), 640));
    game.style.height = `${game.dataset.menu === "setup" ? setupHeight : courtHeight}px`;
    resizeCryptball(stage, root);
  }
  window.addEventListener("resize", resize, { signal });
  function dispose() {
    if (disposed) return;
    disposed = true;
    onlineJoinGeneration++;
    if (online) online.disconnectForReload();
    lifecycle.dispose();
    abort.abort();
    performanceDiagnostics.dispose();
    modeHud.remove();
    touchCues.remove();
    presenter.dispose();
    stage.dispose();
    void audio.engine.dispose();
  }
  menu("Opening the gates", "Loading court and athletes…", []);
  try {
    await stage.init();
    resize();
    await presenter.init((progress) => {
      overlay.querySelector("p:not(.eyebrow)")!.textContent =
        `Loading court and athletes… ${Math.round(progress * 100)}%`;
    });
    await presenter.prewarm(observation);
    audio.volumes(prefs.music, prefs.effects);
    title();
    lifecycle.schedule();
    const invite = new URL(location.href).searchParams.get("room");
    if (invite) void joinOnline("join", invite);
  } catch (error) {
    notice.textContent = String(error);
    menu("The gates are stuck", "A required asset failed to load.", [
      ["Retry", () => location.reload()],
    ]);
  }
  if (import.meta.hot) import.meta.hot.dispose(dispose);
}
