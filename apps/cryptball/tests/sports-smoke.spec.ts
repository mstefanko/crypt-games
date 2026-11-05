import { mkdir } from "node:fs/promises";
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


for (const [sportId, label] of [
  ["cryptkick", "Cryptkick"],
  ["rift-volley", "Rift Volley"],
  ["cryptcheck", "Cryptcheck · Hockey"],
] as const) {
  test(`${label} selection, practice, controls and shared arena render in production`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto("/games/cryptball/");
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(
      page.getByRole("button", { name: label, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(new RegExp(`sport=${sportId}`));
    await mkdir("docs/evidence/cryptball-sports-2026-11-04", {
      recursive: true,
    });
    await page.screenshot({
      path: `docs/evidence/cryptball-sports-2026-11-04/${sportId}-menu.png`,
    });
    await page.getByRole("button", { name: "Practice", exact: true }).click();
    await enterLocalCourt(page);
    const canvas = page.locator("canvas");
    await expect(canvas).toHaveAttribute("data-sport-id", sportId);
    await expect(canvas).toHaveAttribute(
      "data-rendered-players",
      sportId === "rift-volley" ? "4" : "2",
    );
    await expect(page.locator("#clock")).toHaveText("PRACTICE");
    if (sportId === "cryptcheck") await expect(page.locator("#prompt")).toContainText("Move opposite to brake");
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(250);
    await page.keyboard.up("KeyD");
    await page.keyboard.down("KeyJ");
    await page.waitForTimeout(450);
    await page.keyboard.up("KeyJ");
    await page.keyboard.press("KeyK");
    await page.keyboard.press("Shift");
    await page.keyboard.press("KeyQ");
    await page.waitForTimeout(700);
    await expect(page.locator("#notice")).toHaveText("");
    await page.screenshot({
      path: `docs/evidence/cryptball-sports-2026-11-04/${sportId}-practice.png`,
    });
    if (await page.getByRole("heading", { name: "Time out" }).isVisible())
      await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "Time out" })).toBeVisible();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await expect(page.locator("#overlay")).toBeHidden();
    // A new page load exercises the selected mode's real four-athlete match too.
    await page.goto(`/games/cryptball/?sport=${sportId}`);
    await page.getByRole("button", { name: "Single player", exact: true }).click();
    await enterLocalCourt(page);
    await expect(canvas).toHaveAttribute("data-rendered-players", "4");
    await expect(canvas).toHaveAttribute("data-sport-id", sportId);
    if (sportId === "rift-volley") {
      await expect(page.locator("#clock")).toHaveText("FIRST TO 11");
      await expect(page.locator("#prompt")).toContainText("RAMS SERVES");
      await page.keyboard.down("KeyJ");
      await page.waitForTimeout(250);
      await page.keyboard.up("KeyJ");
      await expect
        .poll(async () => Number(await canvas.getAttribute("data-ball-height")))
        .toBeGreaterThan(24);
    } else {
      // Software-rendered atlas warmup may trigger the existing protective
      // pause after the initial overlay check. Resume only that known flow,
      // then require actual match-clock progress; other overlays still fail.
      await expect.poll(async () => {
        if (await page.getByRole("heading", { name: "Time out", exact: true }).isVisible())
          await page.getByRole("button", { name: "Resume", exact: true }).click();
        return page.locator("#clock").textContent();
      }, { timeout: 15000 }).not.toBe("1:30");
      await expect(page.locator("#overlay")).toBeHidden();
    }
    await page.screenshot({
      path: `docs/evidence/cryptball-sports-2026-11-04/${sportId}-match.png`,
    });
    expect(errors).toEqual([]);
  });
}
