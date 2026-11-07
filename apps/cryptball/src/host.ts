import { COURT_ACTIONS, resolveCourtAction, type CourtAction } from "./court-intent";
import { FrameInterpolation } from "./online/frame-interpolation";
import { installPerformanceDiagnostics } from "./online/performance-diagnostics";
import type { FriendsDirectory, FriendsSession } from "./online/friends";
import { BUILD, PROTOCOL } from "../protocol";
import type { CourtIntent } from "../friends-protocol";
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
import { resizeCryptball, cryptballFrame, fitCryptballScale } from "./viewport";
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
  const touchGuidance: Record<SportId, string> = {
    cryptball: "Tap to pass a playable ball or slide otherwise. Hold / release to shoot; flick to slide.",
    cryptkick: "Tap to pass in possession or tackle otherwise. Hold / release to shoot; flick to slide.",
    cryptcheck: "Tap to pass with the puck or poke without it. Hold / release to shoot; flick to body-check.",
    "rift-volley": "Tap to serve, set a reachable ball, or dig a low falling ball. Hold / release to attack; flick to dig.",
    "crypt-dodge": "Empty-handed: touch to catch immediately. Carrying: tap to pass, hold / release to throw. Flick to dive.",
    "crypt-guardian": "Collect an orb; tap to pass, hold / release to throw. Empty-handed: tap to evade, hold to catch. Hold near a downed ally to revive; flick to escape.",
  };
  const secondaryGuidance: Record<SportId, string> = {
    cryptball: "pass a reachable orb or slide",
    cryptkick: "pass in possession or tackle",
    cryptcheck: "push-pass with the puck or poke",
    "rift-volley": "serve, set, or dig a low falling ball",
    "crypt-dodge": "pass while carrying or catch",
    "crypt-guardian": "pass while carrying, hold near a downed ally to revive, or dive",
  };
  const controlsText = () => touchMode
    ? `Drag on the ${prefs.leftHanded ? "right" : "left"} half to move. Use the ${prefs.leftHanded ? "left" : "right"} half for actions, even with one finger. ${touchGuidance[sportId]} Drag the action finger to aim. To dash, lift the movement thumb, touch near its starting ring again, and drag quickly. Tap an ally ring to pass when playable or switch off-ball. Tap the score to pause. Lift both fingers together to cancel a charge.`
    : `WASD / arrows move · J / left mouse ${sport().controls.strike.toLowerCase()} · K / middle mouse ${sport().controls.pass.toLowerCase()} · Right-click to ${secondaryGuidance[sportId]} · Shift / I ${sport().controls.slide.toLowerCase()}${sportId === "cryptcheck" ? " · E body-check" : ""} · Space / L ${sport().controls.dash.toLowerCase()} · Q switches`;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Cryptball court");
  canvas.tabIndex = -1;
  root.append(canvas);
  const stage = new PixiStage(canvas),
    presenter = new CryptballPresenter(stage),
    audio = new CryptballAudio((text) => (notice.textContent = text));
  const modeHud = document.createElement("div"); modeHud.id = "mode-hud"; modeHud.hidden = true;
  const modeSummary = document.createElement("div"); modeSummary.setAttribute("role", "status");
  const bossMeter = document.createElement("progress"); bossMeter.max = 300; bossMeter.setAttribute("aria-label", "Guardian health");
  const roster = document.createElement("div"); roster.className = "mode-roster";
  const rosterCards = Array.from({length:4}, () => { const card = document.createElement("span"); roster.append(card); return card; });
  let middleHeld = false;
  modeHud.append(modeSummary, bossMeter, roster); game.append(modeHud);
  let online: OnlineSession | null = null;
  let friendsSession: FriendsSession | null = null;
  let directory: FriendsDirectory | null = null;
  let watcherRetry = 0;
  let courtRequest = 0;
  let transferringCourt: OnlineSession | null = null;
  let courtAdmission: Promise<void> = Promise.resolve();
  let restoringGroupCourt = false;
  const rememberedCourtKey = (key: string) => `cryptball-friends-court:${BUILD}:${PROTOCOL}:${key}`;
  const friendsPanel = document.createElement("aside");
  friendsPanel.id = "friends-panel"; friendsPanel.hidden = true;
  friendsPanel.setAttribute("aria-label", "Friends and courts"); game.append(friendsPanel);

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
  const touch = new CourtTouchControls(intent => resolveCourtAction(online ? online.rawObserve() : session.observe(), intent).press);
  const touchCues = document.createElement("div");
  touchCues.id = "touch-cues"; touchCues.setAttribute("aria-hidden", "true");
  const moveCue = document.createElement("div"), actionCue = document.createElement("div"), teammateCues = document.createElement("div");
  moveCue.className = "touch-stick"; actionCue.className = "touch-aim";
  moveCue.append(document.createElement("i")); actionCue.append(document.createElement("i"));
  touchCues.append(moveCue, actionCue, teammateCues); game.append(touchCues);
  let touchFacing: number | undefined;
  const capturedTouches = new Set<number>();
  const inputMode = (isTouch: boolean) => { touchMode = isTouch; game.dataset.input = isTouch ? "touch" : "pointer"; };
  inputMode(touchMode);
  let pendingEvents: CryptballEvent[] = [];
  let edges: CommandFrame = {},
    pointerHeld = false,
    secondaryHeld = false,
    secondaryAction: CourtAction | undefined,
    pointerAim: { x: number; y: number } | undefined;
  let prefs = {
    leftHanded: false,
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
      if (typeof p.leftHanded === "boolean") prefs.leftHanded = p.leftHanded;
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
    touch.cancel(); touchFacing = undefined; middleHeld = false;
    for (const id of capturedTouches) releaseTouch(id);
    keys.clear();
    secondaryHeld = false; secondaryAction = undefined;
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
  const orientationGate = document.querySelector<HTMLElement>("#orientation-gate")!;
  const touchPhone = matchMedia("(pointer: coarse)").matches && Math.min(window.screen.width, window.screen.height) <= 600;
  const phonePortrait = matchMedia("(max-width: 600px) and (orientation: portrait)");
  let portraitAccepted = false;
  let fullscreenDeclined = false;
  let gameFullscreen = false;
  let gameExitingFullscreen = false;
  function releaseLandscape() {
    if (!gameFullscreen) return;
    try { window.screen.orientation?.unlock?.(); } catch {}
    if (document.fullscreenElement) {
      gameExitingFullscreen = true;
      void document.exitFullscreen().catch(() => {}).finally(() => { gameExitingFullscreen = false; gameFullscreen = false; });
    } else gameFullscreen = false;
  }
  function requestLandscape() {
    if (!touchPhone || fullscreenDeclined || navigator.userActivation?.isActive === false) return;
    const orientation = window.screen.orientation as ScreenOrientation & { lock?: (value: string) => Promise<void> };
    // Fullscreen and orientation lock are optional enhancements; Safari falls back to the notice.
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      void document.documentElement.requestFullscreen().then(() => {
        gameFullscreen = true;
        if (!disposed && !fullscreenDeclined && document.fullscreenElement && ["starting", "play", "pause", "online-lobby", "online-starting"].includes(screen)) return orientation.lock?.("landscape");
        releaseLandscape();
      }).catch(() => {});
    }
  }
  function syncOrientation() {
    if (!phonePortrait.matches) portraitAccepted = false;
    const blocked = touchPhone && phonePortrait.matches && !portraitAccepted && ["play", "pause", "starting", "online-starting"].includes(screen);
    const wasHidden = orientationGate.hidden;
    orientationGate.hidden = !blocked;
    game.inert = blocked;
    orientationGate.querySelector("p")!.textContent = online?.spectator
      ? "Turn your phone sideways. The match continues while your view is paused."
      : online
      ? "Turn your phone sideways. The match continues while the computer covers your player. Resume when ready."
      : "Turn your phone sideways, then resume when ready.";
    if (blocked && screen === "play") pause();
    if (blocked && wasHidden) document.querySelector<HTMLButtonElement>("#portrait-continue")!.focus();
    if (!blocked && !wasHidden) overlay.querySelector<HTMLButtonElement>(".menu-actions button")?.focus();
  }
  document.querySelector("#portrait-continue")!.addEventListener("click", () => {
    portraitAccepted = true;
    fullscreenDeclined = true;
    releaseLandscape();
    syncOrientation();
    resize();
    // Rotation never resumes a paused match; the existing Resume action remains explicit.
    overlay.querySelector<HTMLButtonElement>("button")?.focus();
  }, { signal });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      if (gameFullscreen && !gameExitingFullscreen) fullscreenDeclined = true;
      gameFullscreen = false;
    }
    resize();
  }, { signal });
  phonePortrait.addEventListener("change", () => { cancel(); syncOrientation(); resize(); }, { signal });
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
      let state = covered?.state ?? (interpolateFrame
        ? frameInterpolation.drawCaptured(observation, time, alpha) : observation);
      const sampleTick = covered?.tick ?? (interpolateFrame ? Math.max(0, observation.tick - 1 + alpha) : observation.tick);
      if (online && !covered) state = online.presentFrame(state, observation, sampleTick);
      if (covered) updateHud(state);
      const renderEvents = covered ? pendingEvents.filter(event => event.tick <= covered.tick) : pendingEvents;
      presenter.render(state, renderEvents, prefs.reducedMotion, Object.fromEntries((online?.lobby?.seats ?? []).map(seat=>[online?.controllerOwners.find(controller=>controller.id===seat.id)?.playerId ?? seat.playerId,seat.name])), covered?.tick ?? online?.presentationTick ?? sampleTick, covered ? 1 : online?.ballCorrectionAlpha(prefs.reducedMotion) ?? 1, touchMode);
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
        if (["Ready", "Start match", "Start with bots", "Play next", "Play again"].includes(label)) requestLandscape();
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
    game.dataset.menu = ["title", "online-lobby", "online-choice", "friends", "friends-directory"].includes(screen) ? "setup" : "other";
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
    releaseLandscape();
    if (friendsSession) {
      const homeUrl = new URL(location.href);
      homeUrl.searchParams.delete("group");
      history.replaceState(null, "", homeUrl);
      rememberCourt();
      void friendsSession.leave(); friendsSession = null;
    }
    directory = null; friendsPanel.hidden = true;
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
    menu("Play online", "Play remotely with other players. Find a public match or share a friends lobby.", [
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
  function friends(groupKey?: string) {
    screen = "friends";
    menu(
      "Your name",
      "Shown in the lobby and above your athlete. Up to 24 characters.",
      [["Back", onlineChoices]],
    );
    const form = document.createElement("form");
    form.className = "room-entry";
    const name = document.createElement("input");
    name.required = true;
    name.maxLength = 24;
    name.value = playerName;
    name.placeholder = "Player name";
    name.setAttribute("aria-label", "Player name");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = groupKey ? "Join group" : "Continue";
    form.append(name, submit);
    overlay.append(form);
    name.focus();
    form.addEventListener(
      "submit",
      (e) => {
        e.preventDefault();
        playerName = name.value.trim();
        if (!playerName) return;
        void enterFriends(groupKey);
      },
      { signal },
    );
  }
  async function enterFriends(groupKey?: string) {
    try {
      sessionStorage.setItem("cryptball-friends-name", playerName);
    } catch {}
    screen = "friends-connecting";
    menu("Joining your friends", "Connecting to the group…", [["Cancel", title]]);
    const generation = ++onlineJoinGeneration;
    let firstDirectory = true;
    try {
      const { createFriendsSession } = await import("./online/friends");
      if (generation !== onlineJoinGeneration || disposed) return;
      const next = createFriendsSession(
        (value) => {
          if (friendsSession !== next) return;
          directory = value;
          const url = new URL(location.href);
          url.searchParams.delete("room");
          url.searchParams.delete("sport");
          url.searchParams.set("group", value.groupKey);
          history.replaceState(null, "", url);
          if (!online) renderDirectory();
          renderFriendsPanel();
          if (firstDirectory && restoringGroupCourt) {
            firstDirectory = false;
            restoringGroupCourt = false;
            try {
              const saved = JSON.parse(
                sessionStorage.getItem(rememberedCourtKey(value.groupKey)) ??
                  "null",
              );
              if (
                saved &&
                isSportId(saved.sportId) &&
                typeof saved.courtId === "string"
              )
                void joinFriendsCourt(
                  saved.sportId,
                  saved.courtId,
                  saved.intent === "watch" ? "watch" : "play",
                  false,
                  false,
                  true,
                );
            } catch {}
          }
        },
        (message) => {
          if (friendsSession === next) notice.textContent = message;
        },
      );
      friendsSession = next;
      await next.connect(playerName, groupKey);
      if (friendsSession !== next || disposed) {
        await next.leave();
        return;
      }
    } catch (error) {
      if (generation === onlineJoinGeneration) {
        if (
          error instanceof Error &&
          error.message.includes("group session expired")
        ) {
          restoringGroupCourt = false;
          friends(groupKey);
          notice.textContent = error.message;
          return;
        }
        screen = "friends-error";
        menu(
          "Group unavailable",
          String(error instanceof Error ? error.message : error),
          [
            ["Retry", () => friends(groupKey)],
            ["Back", title],
          ],
        );
      }
    }
  }
  function directoryContents(container: HTMLElement) {
    if (!directory) return;
    const roster = document.createElement("p");
    roster.className = "friends-members";
    const inCourts = new Set(directory.courts.flatMap(court =>
      [...court.participants, ...court.watchers].map(member => member.memberId)));
    const browsing = directory.members.filter(member => !inCourts.has(member.memberId));
    if (browsing.length) {
      roster.textContent = `In the lobby · ${browsing.map(member => member.name).join(", ")}`;
      container.append(roster);
    }
    const sports = SPORT_IDS.filter(id => id !== "crypt-guardian").map(id => {
      const courts = directory!.courts.filter(court => court.sportId === id);
      const needsOne = courts.some(court => court.phase === "waiting" &&
        court.participants.filter(player => player.connected).length === 1);
      return { id, courts, priority: needsOne ? 0 : courts.length ? 1 : 2 };
    });
    // A Slack arrival should see the person waiting for an opponent first.
    for (const { id, courts } of sports.sort((a, b) => a.priority - b.priority)) {
      const section = document.createElement("section");
      section.className = "friends-sport";
      section.dataset.lobbyScope = id;
      const heading = document.createElement("h3");
      heading.textContent = SPORTS[id].label;
      section.append(heading);
      for (const court of courts) {
        const row = document.createElement("div");
        row.className = "friends-court";
        row.dataset.lobbyScope = court.courtId;
        const description = document.createElement("p");
        const present = court.participants.filter(
          (player) => player.connected,
        ).length;
        const waiting = court.phase === "waiting";
        const status =
          waiting && present < 2 ? `Needs ${2 - present}` : court.phase;
        const names = court.participants.map((player) =>
          player.connected ? player.name : `${player.name} (reconnecting)`,
        );
        description.textContent = [
          `Court ${court.number}`,
          status,
          `${present}/${court.capacity} players`,
          ...names,
          ...(court.watchers.length ? [`Watching · ${court.watchers.map(w => w.name).join(", ")}`] : []),
        ].join(" · ");
        row.append(description);
        if (online?.lobby?.roomId === court.courtId) {
          const current = document.createElement("span");
          current.textContent = "Your court";
          row.append(current);
        } else if (court.phase !== "closing") {
          if (waiting && court.participants.length < court.capacity) {
            row.append(
              button(
                "Join court",
                () => void joinFriendsCourt(id, court.courtId, "play"),
              ),
            );
          }
          if (court.watcherCapacity > 0) {
          const watch = button(
            "Watch",
            () => void joinFriendsCourt(id, court.courtId, "watch"),
          );
          watch.disabled = court.spectators >= court.watcherCapacity;
          if (watch.disabled) watch.textContent = "Viewing full";
          row.append(watch);
          if (!waiting && !watch.disabled) {
            row.append(
              button(
                "Play next",
                () => void joinFriendsCourt(id, court.courtId, "queue"),
              ),
            );
          }
          }
        }
        section.append(row);
      }
      if (courts.length) {
        section.append(
          button(
            `New ${SPORTS[id].label} court`,
            () => void joinFriendsCourt(id, undefined, "play", true),
          ),
        );
      } else {
        section.append(
          button(`Play ${SPORTS[id].label}`, () => void joinFriendsCourt(id)),
        );
      }
      container.append(section);
    }
  }
  function rememberFocus(container: HTMLElement) {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !container.contains(active))
      return null;
    return { text: active.textContent, scope: active.closest<HTMLElement>("[data-lobby-scope]")?.dataset.lobbyScope };
  }
  function restoreFocus(container: HTMLElement, focus: ReturnType<typeof rememberFocus>) {
    if (!focus) return;
    const candidates = container.querySelectorAll<HTMLButtonElement>("button");
    Array.from(candidates).find(action =>
      action.textContent === focus.text &&
      action.closest<HTMLElement>("[data-lobby-scope]")?.dataset.lobbyScope === focus.scope
    )?.focus({ preventScroll: true });
  }
  function renderDirectory() {
    if (!directory) return;
    const focus = rememberFocus(overlay);
    screen = "friends-directory";
    menu("Friends lobby", "", [
      ["Copy lobby link", copyGroupInvite],
      ["Leave group", title],
    ]);
    overlay.className = "setup-menu friends-directory";
    const contents = document.createElement("div");
    contents.className = "friends-courts";
    directoryContents(contents);
    overlay.append(contents);
    restoreFocus(overlay, focus);
  }
  function copyGroupInvite() {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    if (directory) url.searchParams.set("group", directory.groupKey);
    void navigator.clipboard
      .writeText(url.href)
      .then(() => {
        notice.textContent = "Group invite copied";
      })
      .catch(() => {
        notice.textContent = url.href;
      });
  }
  function renderFriendsPanel() {
    const focus = rememberFocus(friendsPanel);
    const summaryFocused =
      document.activeElement === friendsPanel.querySelector("summary");
    const wasOpen = friendsPanel.querySelector("details")?.open ?? false;
    friendsPanel.replaceChildren();
    friendsPanel.hidden = !friendsSession || !online;
    if (friendsPanel.hidden) return;
    const details = document.createElement("details");
    details.open = wasOpen;
    const summary = document.createElement("summary");
    summary.textContent = "Friends & courts";
    details.append(summary);
    details.addEventListener(
      "toggle",
      () => {
        if (details.open) cancel();
      },
      { signal },
    );
    details.append(button("Copy lobby link", copyGroupInvite));
    details.append(button("Leave court", leaveFriendsCourt));
    if (online?.spectator) {
      const watching = document.createElement("p");
      watching.textContent = "Watching · read only";
      watching.className = "watching-status";
      details.append(watching);
    }
    game.dataset.spectator = String(online?.spectator ?? false);
    const queued = !!online?.lobby?.spectators?.find(
      (viewer) => viewer.id === online?.participantId,
    )?.queued;
    summary.textContent = online?.spectator
      ? queued
        ? "Watching · Queued for next match"
        : "Watching · Friends & courts"
      : "Friends & courts";
    if (queued && notice.textContent?.includes("Requesting"))
      notice.textContent =
        "Queued for the next match. This match remains watch only.";
    const elsewhere = directory?.courts.find(court =>
      court.courtId !== online?.lobby?.roomId && (court.participants.length || court.watchers.length));
    if (elsewhere) {
      const activity = document.createElement("small");
      const names = [...elsewhere.participants, ...elsewhere.watchers].map(person => person.name);
      activity.textContent = `${SPORTS[elsewhere.sportId].label} · ${names.join(", ")}`;
      summary.append(activity);
    }
    if (online?.spectator)
      details.append(
        button(
          online.lobby?.spectators?.find(
            (viewer) => viewer.id === online?.participantId,
          )?.queued
            ? "Queued for next match"
            : "Play next",
          () => {
            online?.playNext();
            notice.textContent = "Requesting a place in the next match…";
          },
        ),
      );
    if (queued)
      Array.from(details.querySelectorAll<HTMLButtonElement>("button"))
        .find((action) => action.textContent === "Queued for next match")
        ?.setAttribute("disabled", "");
    directoryContents(details);
    friendsPanel.append(details);
    restoreFocus(friendsPanel, focus);
    if (summaryFocused) summary.focus();
  }
  function rememberCourt(lobby?: Lobby) {
    if (!directory) return;
    const key = rememberedCourtKey(directory.groupKey);
    try {
      if (!lobby) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify({
        sportId: lobby.sportId, courtId: lobby.roomId,
        intent: lobby.seats.some(seat => seat.id === online?.participantId) ? "play" : "watch",
      }));
    } catch {}
  }
  function leaveFriendsCourt() {
    releaseLandscape();
    rememberCourt();
    onlineJoinGeneration++;
    const old = online;
    online = null;
    void old?.leave();
    cancel();
    lifecycle.pause();
    friendsPanel.hidden = true;
    renderDirectory();
  }
  async function joinFriendsCourt(
    id: SportId,
    courtId?: string,
    intent: CourtIntent = "play",
    newCourt = false,
    recovering = false,
    restore = false,
  ) {
    if (!friendsSession) return;
    const request = ++courtRequest;
    let generation = onlineJoinGeneration;
    if (!recovering) watcherRetry = 0;
    let next: OnlineSession | null = null;
    const owner = friendsSession;
    const current = () =>
      generation === onlineJoinGeneration &&
      request === courtRequest &&
      friendsSession === owner &&
      !disposed;
    const source = online;
    try {
      const reservation = restore
        ? null
        : await friendsSession.court(id, courtId, intent, newCourt);
      if (generation !== onlineJoinGeneration || request !== courtRequest) return;
      if (!source) notice.textContent = "Opening court…";
      const { createOnlineSession } = await import("./online/session");
      if (!current()) return;
      next = createOnlineSession({
        name: playerName,
        sportId: id,
        autoReady: false,
        groupKey: directory?.groupKey,
        onStatus: (status) => {
          if (online !== next || generation !== onlineJoinGeneration) return;
          if (status === "reconnecting")
            notice.textContent = online?.spectator
              ? "Reconnecting your view…"
              : "Reconnecting — computer covering your player…";
          else if (status === "joined") notice.textContent = "";
        },
        onCourtLeave: (code) => {
          if (online !== next || generation !== onlineJoinGeneration) return;
          if (code === 4000 && transferringCourt === online) return;
          const retryCourt = online?.lobby?.roomId;
          const wasWatching = online?.spectator;
          const wasReturning = online?.lobby?.returning?.includes(
            online.participantId,
          );
          online = null;
          lifecycle.pause();
          friendsPanel.hidden = true;
          renderDirectory();
          if (code === 4001 && wasWatching && retryCourt && watcherRetry < 3) {
            const retry = ++watcherRetry;
            notice.textContent = `Reconnecting your view… (${retry}/3)`;
            setTimeout(() => {
              if (generation === onlineJoinGeneration && friendsSession)
                void joinFriendsCourt(id, retryCourt, "watch", false, true);
            }, retry * 1000);
          } else {
            rememberCourt();
            notice.textContent =
              code === 4002
                ? wasReturning
                  ? "The next lineup filled. You have returned to your friends lobby."
                  : "The 10-second return window ended without Play again. You have returned to your friends lobby."
                : "Back in your friends lobby. Choose a court to reconnect.";
          }
        },
        onLobby: (value) => {
          if (online === next && generation === onlineJoinGeneration) {
            renderLobby(value);
            if (screen === "results" && value.phase === "results") showResults();
            renderFriendsPanel();
            rememberCourt(value);
          }
        },
        onError: (message) => {
          if (online === next && generation === onlineJoinGeneration)
            notice.textContent = message;
        },
      });
      const candidate = next;
      const previousAdmission = courtAdmission;
      let releaseAdmission!: () => void;
      courtAdmission = new Promise((resolve) => {
        releaseAdmission = resolve;
      });
      await previousAdmission;
      try {
        if (!current()) {
          await candidate.leave();
          return;
        }
        transferringCourt = source;
        if (!restore || !courtId || !(await candidate.reconnectCourt(courtId))) {
          await candidate.connectReservation(
            reservation ?? (await owner.court(id, courtId, intent)),
          );
        }
        await candidate.waitForCourtReady();
        if (!current()) {
          await candidate.leave();
          return;
        }
        if (candidate.status === "left" || candidate.status === "interrupted")
          throw Error("The destination court disconnected. Please choose again.");
        generation = ++onlineJoinGeneration;
        online = candidate;
        session = candidate;
        sportId = id;
        shuffle = false;
        onlineLobbyKey = "";
        lifecycle.pause();
        screen = "online-connecting";
        menu("Opening court", "Connecting to your friends…", []);
        if (source && source !== candidate) void source.leave();
      } finally {
        transferringCourt = null;
        // Admission can remove the source on the server before the destination
        // finishes hydrating. Never leave that dead source on screen.
        if (online === source && source && (source.status === "left" || source.status === "interrupted")) {
          online = null;
          rememberCourt();
          lifecycle.pause();
          friendsPanel.hidden = true;
          renderDirectory();
        }
        releaseAdmission();
      }
      if (next.lobby) rememberCourt(next.lobby);
      if (generation !== onlineJoinGeneration) {
        await next.leave();
        return;
      }
      if (next.lobby) renderLobby(next.lobby);
      renderFriendsPanel();
      if (restore && intent === "play" && next.spectator) {
        notice.textContent = "Your player seat could not be restored. You are watching. Choose Play next to join the next-match queue.";
        const details = friendsPanel.querySelector("details");
        if (details) details.open = true;
      }
      lifecycle.resume();
      await audio.engine.unlock();
    } catch (error) {
      if (next && online !== next) void next.leave();
      if (current()) {
        if (restore && !online) rememberCourt();
        notice.textContent =
          error instanceof Error ? error.message : String(error);
        if (!online) renderDirectory();
      }
    }
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
      (!friendsSession || !!seat) &&
      lobby.seats.length >= (sportId === "crypt-guardian" ? 1 : 2) &&
      (friendsSession ? lobby.seats.filter(seat => seat.connected).length >= 2 : lobby.seats.every(s => s.ready && s.connected));
    menu(
      lobby.phase === "countdown"
        ? `Starting in ${Math.ceil(lobby.countdown / 60)}`
        : friendsSession ? lobby.seats.filter(seat => seat.connected).length < 2 ? "Needs 1 more player" : "Ready to start" : "The next match",
      friendsSession
        ? `${sport().label} · 2 versus 2`
        : lobby.private
        ? `${shuffle ? "Shuffle · " : ""}${sport().label} · Private court ${lobby.roomId} · ${sportId === "crypt-guardian" ? "2 allies versus the guardian" : "2 versus 2"}`
        : `${shuffle ? "Shuffle · " : ""}${sport().label} · Public court · ${sportId === "crypt-guardian" ? "2 allies versus the guardian" : "2 versus 2"}`,
      [
        ...(!seat && friendsSession ? [[lobby.spectators?.find(viewer => viewer.id === online?.participantId)?.queued ? "Queued for next match" : "Play next", () => online?.playNext()] as [string, () => void]] : []),
        ...(!friendsSession && lobby.phase === "waiting" && seat
          ? [[seat.ready ? "Ready ✓" : "Ready", () => online?.ready()] as [string, () => void]] : []),
        ...(canStart
          ? [[friendsSession ? "Start match" : "Start with bots", () => online?.start()] as [string, () => void]]
          : []),
        ["Leave", friendsSession ? leaveFriendsCourt : title],
      ],
      `ONLINE · ${sport().label.toUpperCase()}`,
    );
    overlay.className = friendsSession ? "setup-menu lobby-menu friends-waiting" : "setup-menu lobby-menu";
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
          ? `${seat.name}${seat.connected ? (friendsSession ? "" : seat.ready ? " · Ready" : " · Not ready") : " · Reconnecting"}`
          : "Computer teammate";
        column.append(row);
      }
      roster.append(column);
    }
    overlay.insertBefore(roster, overlay.lastChild);
    if (lobby.private && !friendsSession) {
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
  function announcePauseShortcut() {
    if (notice.textContent || online?.spectator) return;
    const message = touchMode
      ? "Tap the score to pause · Controls and sound are in Settings"
      : "Click the score or press Escape to pause";
    notice.textContent = message;
    setTimeout(() => { if (notice.textContent === message) notice.textContent = ""; }, 4500);
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
      announcePauseShortcut();
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
    if (kind !== "join") shuffle = false;
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
      online?.spectator ? "Watching paused" : "Computer covering",
      "The online match continues while you are away.",
      [
        ["Return to play", resume],
        ["Settings", () => settings("pause")],
        [friendsSession ? "Leave court" : "Leave match", friendsSession ? leaveFriendsCourt : title],
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
    requestLandscape();
    onlineJoinGeneration++;
    if (online) {
      void online.leave();
      online = null;
    }
    announcePauseShortcut();
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
    secondaryHeld = false; secondaryAction = undefined;
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
    requestLandscape();
    if (touchPhone && phonePortrait.matches && !portraitAccepted) { syncOrientation(); return; }
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
      `${sport().description} ${sport().rules.join(". ")}. ${sport().scoring} ${controlsText()}${touchMode ? " Movement and action regions can be swapped in Settings. Teammate rings appear when switching is available." : ". Aim with the mouse or your last movement direction. Hold the primary action to charge, then release. Q switches to a computer teammate."}${sportId === "cryptcheck" ? " Release movement to coast; move against your glide to brake before reversing. Aim turns your stick independently of your glide." : ""}`,
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
    overlay.classList.add("settings-menu");
    const handed = document.createElement("button");
    handed.textContent = prefs.leftHanded ? "Movement: right half" : "Movement: left half";
    handed.addEventListener("click", () => {
      prefs.leftHanded = !prefs.leftHanded;
      save();
      handed.textContent = prefs.leftHanded ? "Movement: right half" : "Movement: left half";
      instructions.textContent = controlsText();
    }, { signal });
    const sound = document.createElement("button");
    sound.textContent = muted ? "Unmute sound" : "Mute sound";
    sound.addEventListener("click", () => { muted = !muted; audio.engine.setMuted(muted); void audio.engine.unlock(); sound.textContent = muted ? "Unmute sound" : "Mute sound"; }, { signal });
    const guide = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Controls";
    const instructions = document.createElement("p");
    guide.addEventListener("toggle", () => { instructions.textContent = controlsText(); }, { signal });
    guide.append(summary, instructions);
    form.append(handed, sound, guide);
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
    touchCues.hidden = screen !== "play" || !!online?.spectator;
    game.dataset.sport = state.sportId;
    game.dataset.spectator = String(!!online?.spectator);
    const newMode = isNewMode(state.sportId);
    modeHud.hidden = !newMode || !["play", "starting"].includes(screen);
    modeHud.dataset.mode=state.sportId;
    const mine = state.players.find(p=>p.id===state.controlledId);
    const carrying = !!state.dodge?.balls.some(b=>!b.retired && b.mode.holderId===state.controlledId) || !!state.guardian && (state.guardian.orbs?.some(b=>b.possessionId===state.controlledId) ?? state.possessionId===state.controlledId);
    const reviveNear = !carrying && !!state.guardian && !!mine && state.guardian.athletes[mine.id]?.status === "active" && !!reviveTarget(state,mine);
    touch.setContext({
      catch: !carrying && !!state.dodge?.athletes[state.controlledId]?.lives,
      revive: reviveNear,
      preparedThrow: !!state.dodge?.athletes[state.controlledId]?.pendingThrow,
    });
    modeSummary.textContent=state.guardian ? `${state.guardian.descriptor.name} · ${state.guardian.descriptor.weapon.toUpperCase()} · ${state.guardian.hp} / ${state.guardian.maxHp} HP` : "3 LIVES · BEST OF THREE";
    bossMeter.hidden=!state.guardian; bossMeter.value=state.guardian?.hp??0;
    while(rosterCards.length>state.players.length) rosterCards.pop()!.remove();
    while(rosterCards.length<state.players.length) { const card=document.createElement("span");roster.append(card);rosterCards.push(card); }
    rosterCards.forEach((card,i)=>{const p=state.players[i]!;const d=state.dodge?.athletes[p.id],a=state.guardian?.athletes[p.id];card.textContent=`${p.id===state.controlledId?"YOU":state.guardian?"ALLY "+(i+1):`P${i+1} ${online?.spectator ? TEAMS[state.teamIds[p.team]].name.toUpperCase() : p.team===mine?.team?"ALLY":"RIVAL"}`} ${d?d.lives?"◆".repeat(d.lives)+"◇".repeat(3-d.lives):"✕ OUT":a?a.status==="active"?"♥".repeat(a.hp)+"♡".repeat(5-a.hp):a.status==="down"?`DOWN ${Math.floor(a.reviveTicks/90*100)}%`:"✕ OUT":""}`;card.dataset.player=p.id;});

    if(state.dodge){game.dataset.controlledCatch=state.dodge.athletes[state.controlledId]?.catchKind??"none";game.dataset.controlledCatchStart=String(state.dodge.athletes[state.controlledId]?.catchStart??-1); }
    game.dataset.tick = String(state.tick);
    game.dataset.phase = state.phase;
    const controlled = state.players.find((p) => p.id === state.controlledId);
    const skater = controlled && state.sportId === "cryptcheck" ? state.hockey?.skaters[controlled.id] : undefined;
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
            ? touchMode ? `Move: ${prefs.leftHanded ? "right" : "left"} half · Action: ${prefs.leftHanded ? "left" : "right"} half · Tap: contextual · Hold/release: shoot · Flick: ${sportId === "cryptcheck" ? "body-check" : "dive"}` : practicePrompt
            : state.volley
              ? state.volley.serving
                ? `${TEAMS[state.teamIds[state.volley.serveTeam]].name.toUpperCase()} SERVES · ${touchMode ? "HOLD / RELEASE TO ATTACK" : "J / LEFT MOUSE TO ATTACK"}`
                : `${TEAMS[state.teamIds[state.volley.lastContactTeam === 1 ? 1 : 0]].name.toUpperCase()} · ${state.volley.teamContacts} / 3 CONTACTS · ${touchMode ? "TAP SETS / LOW BALL DIGS · FLICK DIGS" : "K SETS · SHIFT DIGS"}`
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
        if (observation.phase === "results" && screen !== "results" && online.lobby?.phase === "results") showResults();
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
      player = state.players.find((p) => p.id === state.controlledId) ?? state.players[0]!;
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
    const passHeld = sportId === "crypt-guardian" && (keys.has("KeyK") || middleHeld || gesture.passHeld || !!secondaryAction?.held.passHeld);
    // Specials deliberately use the movement thumb's direction even while the
    // action thumb is holding independent shot aim.
    session.step({
      ...edges,
      ...gesture.edges,
      ...secondaryAction?.held,
      moveX: move.x,
      moveY: move.y,
      aim,
      pointerAim: !!pointerAim || gesture.aiming || !!gesture.aim,
      strikeHeld: keys.has("KeyJ") || pointerHeld || gesture.strikeHeld,
      passHeld,
      slide:
        gesture.edges.slide || !!edges.slide || secondaryAction?.held.slide || (COURT_ACTIONS[sportId].level && (keys.has("KeyI") || keys.has("ShiftLeft") || keys.has("ShiftRight"))),
    });
    game.dataset.passHeld = String(passHeld);
    edges = {};
    observation = session.observe();
    capturePresentation();
    const events = session.drainEvents();
    if (ownControlSwitched(events, online?.participantId)) {
      touch.disarmAction(); touchFacing = undefined;
      keys.delete("KeyJ");
      secondaryHeld = false; secondaryAction = undefined;
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
            ? "K passes. Shift / I pokes; right-click passes with the puck or pokes without it; E body-checks; Space / L dashes. Move opposite your glide to brake."
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
    const focus = rememberFocus(overlay);
    screen = "results";
    const s = observation;
    const queued = !!online?.lobby?.spectators?.find(
      (viewer) => viewer.id === online?.participantId,
    )?.queued;
    const returning = !!online?.lobby?.returning?.includes(online.participantId);
    if ((queued || returning) && notice.textContent?.includes("Requesting"))
      notice.textContent = queued
        ? "Your next-match queue request is confirmed."
        : "Your return request is confirmed.";
    menu(
      s.guardian
        ? s.guardian.outcome === "victory"
          ? "Guardian defeated"
          : "The crypt claims the party"
        : s.winner === "draw"
          ? "A worthy draw"
          : `${TEAMS[s.teamIds[s.winner === 1 ? 1 : 0]].name} take the crown`,
      s.guardian
        ? `${s.guardian.descriptor.name} · ${s.guardian.hp} HP remains · ${Math.floor(s.guardian.elapsed / 60)} seconds`
        : `${s.score[0]} — ${s.score[1]}${s.dodge ? " rounds" : ""}`,
      [
        [
          online?.spectator
            ? queued
              ? "Queued for next match"
              : "Play next"
            : friendsSession
              ? returning
                ? "Returning next match"
                : "Play again"
              : s.guardian
                ? "Retry Guardian"
                : shuffle
                  ? "Next activity"
                  : "Rematch",
          () => {
            if (online) {
              onlineLobbyKey = "";
              if (!friendsSession) screen = "online-lobby";
              if (online.spectator) online.playNext();
              else online.rematch();
              if (friendsSession)
                notice.textContent = "Requesting a place in the next match…";
            } else {
              if (shuffle) {
                const modes: SportId[] = SPORT_IDS.filter(
                  (id) => id !== "crypt-guardian",
                );
                sportId = modes[(modes.indexOf(sportId) + 1) % modes.length]!;
              }
              void start(s.guardian ? s.mode : "match");
            }
          },
        ],
        ...(s.guardian && !online
          ? [["New Guardian", () => start(s.mode, true)] as [string, () => void]]
          : []),
        [
          friendsSession ? "Leave court" : "Title",
          friendsSession ? leaveFriendsCourt : title,
        ],
      ],
      s.mode === "practice" && isNewMode(sportId)
        ? "PRACTICE COMPLETE · UNSCORED"
        : sportId === "rift-volley"
          ? "MATCH COMPLETE"
          : "FULL TIME",
    );
    if (friendsSession) {
      const window = document.createElement("p");
      window.className = "results-return-window";
      const seconds = Math.ceil(
        (online?.lobby?.resultsTicksRemaining ?? 600) / 60,
      );
      window.textContent = `${seconds}s remaining in the 10-second return window. ${online?.spectator ? (queued ? "Your next-match place is queued." : "Play next joins the queue for the next match.") : returning ? "Your return request is confirmed. Queued watchers take priority." : "Choose Play again to request another match; otherwise you return to the friends lobby."}`;
      overlay.append(window);
      const action = overlay.querySelector<HTMLButtonElement>(
        ".menu-actions button",
      );
      if (action && (queued || returning)) action.disabled = true;
    }
    const stats = document.createElement("p");
    stats.className = "fine";
    const teamName =
      TEAMS[
        s.teamIds[s.players.find((p) => p.id === s.controlledId)?.team ?? 0]
      ].name.toUpperCase();
    stats.textContent = online?.spectator
      ? `${TEAMS[s.teamIds[0]].name} versus ${TEAMS[s.teamIds[1]].name} · Match watched`
      : s.guardian
        ? `${s.stats.shots} orb strikes · ${s.stats.passes} ally passes · Seed ${s.guardian.descriptor.seed}`
        : s.dodge
          ? `${s.stats.shots} throws · ${s.stats.passes} passes · Best of three rounds`
          : sportId === "rift-volley"
            ? `${teamName} · ${s.stats.shots} attacks · ${s.stats.goals} points · ${s.stats.passes} sets`
            : `${teamName} · ${s.stats.shots} shots · ${s.stats.goals} goals · ${s.stats.passes} completed passes`;
    overlay.append(stats);
    restoreFocus(overlay, focus);
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
      if (friendsPanel.querySelector("details")?.open) return;
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
      if (["KeyI", "ShiftLeft", "ShiftRight"].includes(e.code)) edges.slide = true;
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
      if (screen !== "play" || friendsPanel.querySelector("details")?.open) return;
      void audio.engine.unlock();
      inputMode(e.pointerType === "touch");
      if (e.pointerType === "touch") {
        e.preventDefault();
        pointerAim = undefined;
        if (!touch.visual.action) touchFacing = observation.players.find(p => p.id === observation.controlledId)?.heading;
        const bounds = canvas.getBoundingClientRect();
        // Keep browser edge gestures and the scoreboard band outside the controls.
        if (e.clientX < 20 || e.clientX > innerWidth - 20 || e.clientY < game.getBoundingClientRect().top + 40) return;
        const target = teammateAt(e.clientX, e.clientY);
        const movementHalf = (e.clientX < bounds.left + bounds.width / 2) !== prefs.leftHanded;
        touch.down(e.pointerId, e.clientX, e.clientY, performance.now(), target, movementHalf ? "move" : "action");
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
        if (!secondaryHeld) {
          secondaryAction = resolveCourtAction(online ? online.rawObserve() : session.observe(), "contextual");
          Object.assign(edges, secondaryAction.press);
        }
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
      if (e.button === 2) { secondaryHeld = false; secondaryAction = undefined; }
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
  function releaseTouch(id: number) {
    capturedTouches.delete(id);
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }
  function teammateTargets() {
    if (!touchMode || screen !== "play") return [];
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
  const scoreboard = document.querySelector<HTMLElement>("#hud")!;
  scoreboard.setAttribute("role", "button"); scoreboard.tabIndex = 0;
  scoreboard.setAttribute("aria-label", "Pause game");
  scoreboard.setAttribute("aria-describedby", "ivory clock ember");
  scoreboard.addEventListener("click", () => { if (screen === "play") pause(); }, { signal });
  scoreboard.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (screen === "play") pause(); } }, { signal });
  // BrowserLifecycle already owns blur/orientation cancellation and pause.
  function resize() {
    const inset = getComputedStyle(document.body);
    const safeX = parseFloat(inset.paddingLeft) + parseFloat(inset.paddingRight);
    const safeY = parseFloat(inset.paddingTop) + parseFloat(inset.paddingBottom);
    const viewportWidth = Math.min(innerWidth, window.visualViewport?.width ?? innerWidth);
    const viewportHeight = Math.min(innerHeight, window.visualViewport?.height ?? innerHeight);
    const width = Math.max(1, viewportWidth - safeX - (touchMode ? 8 : 32));
    const height = Math.max(1, viewportHeight - safeY - (touchMode ? 24 : 64));
    const frame = cryptballFrame(width, height, sportId, ["play", "pause", "finishing"].includes(screen));
    const scale = frame.height === VIEW.height
      ? fitCryptballScale(width, height)
      : Math.max(0.1, Math.min(width / frame.width, height / frame.height));
    game.style.width = `${frame.width * scale}px`;
    const courtHeight = frame.height * scale;
    const setupHeight = viewportWidth <= 600 && viewportHeight > viewportWidth
      ? Math.min(viewportHeight - safeY - 24, 760)
      : Math.max(courtHeight, Math.min(height, 640));
    game.style.height = `${game.dataset.menu === "setup" ? setupHeight : courtHeight}px`;
    game.dataset.frameHeight = String(frame.height);
    resizeCryptball(stage, root, frame.height, frame.y);
    // Player names are drawn in game coordinates; the score strip is sized in CSS pixels.
    const courtBounds = canvas.getBoundingClientRect();
    const scoreBottom = document.querySelector("#hud")!.getBoundingClientRect().bottom;
    canvas.dataset.scoreBottom = String((scoreBottom - courtBounds.top) * VIEW.width / courtBounds.width);
    syncOrientation();
  }
  window.addEventListener("resize", resize, { signal });
  window.visualViewport?.addEventListener("resize", resize, { signal });
  function dispose() {
    if (disposed) return;
    disposed = true;
    releaseLandscape();
    orientationGate.hidden = true;
    game.inert = false;
    onlineJoinGeneration++;
    if (online) online.disconnectForReload();
    lifecycle.dispose();
    abort.abort();
    performanceDiagnostics.dispose();
    friendsSession?.disconnectForReload();
    friendsPanel.remove();
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
    const group = new URL(location.href).searchParams.get("group");
    if (group) {
      try { playerName = sessionStorage.getItem("cryptball-friends-name") ?? ""; } catch {}
      let membership = false;
      try { membership = !!sessionStorage.getItem(`cryptball-friends:${BUILD}:${PROTOCOL}:${group}`); } catch {}
      if (playerName && membership) { restoringGroupCourt = true; void enterFriends(group); } else friends(group);
    }
    const invite = new URL(location.href).searchParams.get("room");
    if (!group && invite) void joinOnline("join", invite);
  } catch (error) {
    notice.textContent = String(error);
    menu("The gates are stuck", "A required asset failed to load.", [
      ["Retry", () => location.reload()],
    ]);
  }
  if (import.meta.hot) import.meta.hot.dispose(dispose);
}
