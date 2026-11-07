import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
async function enterLocalCourt(page: Page) {
  const game = page.locator("#game"), overlay = page.locator("#overlay");
  const initialTick = Number(await game.getAttribute("data-tick"));
  // Software-rendered asset warmup may enter the normal frame-debt pause.
  // Resume only that named flow, then require real simulation progress.
  await expect.poll(async () => {
    if (await page.getByRole("heading", { name: "Time out", exact: true }).isVisible())
      await page.getByRole("button", { name: "Resume", exact: true }).click();
    if (!(await overlay.isHidden())) return false;
    const tick = await game.getAttribute("data-tick");
    return tick !== null && Number(tick) > initialTick;
  }, { timeout: 30000 }).toBe(true);
  await expect(overlay).toBeHidden();
}

test("production court accepts keyboard play and pause/resume", async ({
  page,
}) => {
  const errors: string[] = [];
  const loadedPages = new Set<string>();
  page.on("response", (response) => {
    if (response.ok() && /assets\/cryptball\/page-.*\.png/.test(response.url()))
      loadedPages.add(response.url().split("/").pop()!);
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/games/cryptball/");
  await expect(
    page.getByRole("button", { name: "Single player", exact: true }),
  ).toBeVisible();
  await expect(page.locator("canvas")).toHaveAttribute("width", "640");
  await expect(page.locator("canvas")).toHaveAttribute("height", "400");
  const fitted = (await page.locator("canvas").boundingBox())!;
  expect(fitted.width).toBeGreaterThan(1100);
  expect(fitted.x).toBeGreaterThanOrEqual(16);
  expect(fitted.y).toBeGreaterThanOrEqual(16);
  await expect(page.getByText("For best play, use a window at least 768 × 512.")).toHaveCount(0);
  await page.getByRole("button", {name:"Single player",exact:true}).press("Enter");
  await enterLocalCourt(page);
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(1000);
  await page.keyboard.up("KeyD");
  await page.keyboard.down("KeyJ");
  await page.waitForTimeout(250);
  await page.keyboard.up("KeyJ");
  await page.keyboard.press("KeyK");
  await page.keyboard.press("Shift");
  await page.keyboard.press("Space");
  await page.waitForTimeout(3750);
  await expect(page.locator("#notice")).toHaveText("");
  await expect(page.locator("#clock")).not.toHaveText("1:30");
  await expect(page.locator("canvas")).toHaveAttribute("data-rendered-players", "4");
  const manifestResponse = await page.request.get("/games/cryptball/assets/cryptball/manifest.json");
  expect(manifestResponse.ok()).toBe(true);
  const manifest = await manifestResponse.json();
  expect(manifest.recipeId).toBe("cryptball-polished-2v2-2026-11-04");
  expect(manifest.provenance.tools).toContain("OpenAI ImageGen");
  for (const frame of ["arena.polished", "goal.post.polished", "crowd.polished.0"])
    expect(manifest.frames[frame], frame).toBeTruthy();
  // Verify generated directional action coverage and that every referenced page loaded.
  const directions = ["E", "SE", "S", "SW", "W", "NW", "N", "NE"];
  for (const team of ["ivory", "ember"])
    for (const direction of directions)
      for (const action of ["idle", "sprint", "strike", "slide", "slide-recover"]) {
        const clip = manifest.clips[`${team}.warrior.${action}.${direction}`];
        expect(clip?.length, `${team}/${action}/${direction}`).toBeGreaterThan(0);
        for (const frame of clip)
          expect(loadedPages.has(manifest.pages[manifest.frames[frame].pageId])).toBe(true);
      }
  for (const action of ["idle", "sprint", "strike", "slide", "slide-recover"])
    expect(new Set(directions.map((direction) => manifest.clips[`ivory.warrior.${action}.${direction}`].join("|"))).size,
      `${action} has eight distinct source-facing sequences`).toBe(8);
  expect(manifest.clips["arena.fire"].length).toBeGreaterThanOrEqual(4);
  // Software-rendered asset inspection can trigger the lifecycle's protective
  // pause. Resume explicitly before checking animated pixels, never compare a
  // paused scene and interpret it as a broken flame clip.
  if (await page.getByRole("heading", { name: "Time out" }).isVisible())
    await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();
  const canvasBox = (await page.locator("canvas").boundingBox())!;
  const scaleX = canvasBox.width / 640, scaleY = canvasBox.height / 400;
  // Isolate the center-left rear flame. No actors, ball or other moving UI enter this crop.
  const flameClip = { x: canvasBox.x + 250 * scaleX, y: canvasBox.y + 18 * scaleY,
    width: 34 * scaleX, height: 42 * scaleY };
  await mkdir(".local-game-tests/cryptball-browser", { recursive: true });
  const fireA = await page.screenshot({ clip: flameClip,
    path: ".local-game-tests/cryptball-browser/fire-a.png" });
  await page.waitForTimeout(170);
  const fireB = await page.screenshot({ clip: flameClip,
    path: ".local-game-tests/cryptball-browser/fire-b.png" });
  const changedFraction = await page.evaluate(async ([a, b]) => {
    const decode = async (encoded: string) => {
      const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      bitmap.close();
      return data;
    };
    const first = await decode(a), second = await decode(b);
    let changed = 0;
    for (let i = 0; i < first.length; i += 4)
      if (Math.abs(first[i] - second[i]) + Math.abs(first[i+1] - second[i+1]) + Math.abs(first[i+2] - second[i+2]) > 24)
        changed++;
    return changed / (first.length / 4);
  }, [fireA.toString("base64"), fireB.toString("base64")]);
  await writeFile(".local-game-tests/cryptball-browser/fire-proof.json", JSON.stringify({
    recipeId: manifest.recipeId, renderedPlayers: 4, authoredDirections: directions,
    intervalMs: 170, cropLogicalPixels: { x: 250, y: 18, width: 34, height: 42 },
    materiallyChangedPixelFraction: changedFraction, minimumFraction: 0.015,
  }, null, 2));
  expect(changedFraction, "isolated flame pixels advance while gameplay runs").toBeGreaterThan(0.015);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Time out" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.getByRole("button", { name: "Pause game", exact: true })).toBeVisible();
  await page.screenshot({
    path: ".local-game-tests/cryptball-browser/production-court.png",
  });
  expect(errors).toEqual([]);
});

test("full charge persists beside the goal until release", async ({ page }) => {
  // Keep this sustained-input test within the software renderer's smaller
  // viewport; the preceding test independently verifies full-window fitting.
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto("/games/cryptball/");
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await enterLocalCourt(page);
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(1400);
  await page.keyboard.up("KeyA");
  if (await page.getByRole("heading", { name: "Time out" }).isVisible())
    await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.keyboard.down("KeyJ");
  await page.waitForTimeout(1800); // well beyond the former 42-tick auto-release
  await expect(page.locator("canvas")).toHaveAttribute("data-powered-players", "1");
  await page.screenshot({ path: ".local-game-tests/cryptball-browser/charged-goal.png" });
  await page.keyboard.up("KeyJ");
  await expect(page.locator("canvas")).toHaveAttribute("data-powered-players", "0");
});

for (const input of ["right click", "solo touch"] as const) {
  test(`Cryptkick passes from a standstill with ${input}`, async ({ browser }) => {
    const page = await browser.newPage({ hasTouch: input === "solo touch", viewport: { width: 844, height: 390 } });
    try {
      await page.goto("http://127.0.0.1:4223/games/cryptball/?sport=cryptkick");
      await page.getByRole("button", { name: "Practice", exact: true }).click();
      await enterLocalCourt(page);
      const game = page.locator("#game");
      // Practice starts the stationary athlete within trapping distance of the ball.
      // Observe the short pass animation independently of Playwright polling cadence.
      await game.evaluate(el => {
        const observer = new MutationObserver(() => {
          if (el.getAttribute("data-controlled-action") === "pass") {
            observer.disconnect();
            el.setAttribute("data-observed-pass", "true");
          }
        });
        observer.observe(el, { attributes: true, attributeFilter: ["data-controlled-action"] });
      });
      const bounds = (await game.boundingBox())!;
      const x = bounds.x + bounds.width * 0.85, y = bounds.y + bounds.height * 0.7;
      if (input === "solo touch") await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y, { button: "right" });
      await expect(game).toHaveAttribute("data-observed-pass", "true");
    } finally {
      await page.close();
    }
  });
}

for (const [sportId, label] of [["cryptball", "Cryptball"], ["cryptkick", "Cryptkick"], ["rift-volley", "Rift Volley"], ["cryptcheck", "Cryptcheck · Hockey"]]) {
  test(`${label} explicit defensive key works independently of possession`, async ({ page }) => {
    await page.goto(`/games/cryptball/?sport=${sportId}`);
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await enterLocalCourt(page);
    const canvas = page.locator("canvas");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width * .7, box.y + box.height * .6);
    await page.keyboard.down("Shift");
    await expect.poll(
      () => page.locator("#game").getAttribute("data-controlled-action"),
      { intervals: [10, 20, 50], timeout: 5000 },
    ).toBe("slide");
    await page.keyboard.up("Shift");
    await expect(page.locator("#game")).toHaveAttribute("data-passes", "0");
  });
}

test("the score strip preserves both assigned clubs when a solo match pauses", async ({ page }) => {
  await page.goto("/games/cryptball/");
  await page.getByRole("button", { name: "Single player", exact: true }).click();
  await enterLocalCourt(page);
  const scores = page.locator("#ivory, #ember");
  const opening = await scores.allTextContents();
  expect(opening).toHaveLength(2);
  expect(opening[0]).toMatch(/^[A-Z]+ 0$/);
  expect(opening[1]).toMatch(/^0 [A-Z]+$/);
  expect(opening[0]!.split(" ")[0]).not.toBe(opening[1]!.split(" ")[1]);
  await page.getByRole("button", { name: "Pause game", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Time out" })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(scores).toHaveText(opening);
});
