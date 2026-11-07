import { expect, test, type Page } from "@playwright/test";

// These assertions deliberately avoid scrolling: setup actions must be usable
// together in the viewport, including short laptops and portrait phones.
async function expectFittedMenu(page: Page) {
  await expect(page.getByRole("button", { name: "Pause game", exact: true })).toBeHidden();
  const problems = await page.locator("#overlay").evaluate((overlay) => {
    const issues: string[] = [];
    for (const element of [document.documentElement, document.body, overlay, ...overlay.querySelectorAll<HTMLElement>("*")]) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (element === overlay || element.matches("button, input, select, fieldset")) {
        if (rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1)
          issues.push(`outside viewport: ${element.tagName} ${element.textContent?.trim().slice(0, 50)}`);
      }
      if (element.matches(".team-selector button, .sport-selector button") && element.scrollHeight > element.clientHeight + 1)
        issues.push(`clipped selection tile: ${element.textContent}`);
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1)
        issues.push(`vertical scroll: ${element.tagName}.${element.className}`);
      if (/(auto|scroll)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1)
        issues.push(`horizontal scroll: ${element.tagName}.${element.className}`);
    }
    return issues;
  });
  expect(problems).toEqual([]);
}

async function expectActivities(page: Page) {
  const picker=page.getByRole("group",{name:"Choose a sport",exact:true});
  await expect(picker.getByRole("button")).toHaveCount(7);
  await expect(page.getByRole("group",{name:"Your team",exact:true})).toHaveCount(0);
  await expect(page.getByRole("heading", {name:"CRYPT GAMES",level:1,exact:true})).toBeVisible();
  await expect.poll(() => page.locator(".crypt-games-logo").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect.poll(() => picker.locator(".activity-art").evaluateAll((images: HTMLImageElement[]) => images.length === 7 && images.every(img => img.complete && img.naturalWidth > 0))).toBe(true);
  expect(await picker.locator(".activity-art").evaluateAll((images: HTMLImageElement[]) => new Set(images.map(img => img.currentSrc)).size)).toBe(7);
  const nameplates = picker.locator(".activity-nameplate");
  await expect(nameplates).toHaveCount(7);
  await expect(nameplates).toHaveText([
    "CryptballArena ball", "CryptkickSoccer", "Rift VolleyVolleyball",
    "Cryptcheck · HockeyHockey", "Crypt DodgeDodgeball", "Crypt GuardianSolo boss battle",
    "Crypt ShuffleFive sports · changes after each match",
  ]);
  await expect(page.locator('.title-menu > p')).toHaveCount(0);
  await expect(page.locator('.title-menu > .menu-actions > button')).toHaveText(['Single player', 'Play online']);
  const geometry = await picker.evaluate(el => {
    const cards = [...el.querySelectorAll<HTMLButtonElement>('button:not([data-sport="shuffle"])')].map(card => card.getBoundingClientRect());
    const nameplates = [...el.querySelectorAll<HTMLElement>('.activity-nameplate')].map(plate => plate.getBoundingClientRect().height);
    const shuffle = el.querySelector('[data-sport="shuffle"]')!.getBoundingClientRect();
    const images = [...el.querySelectorAll<HTMLElement>('.activity-art')];
    return {
      equalCards: cards.every(card => Math.abs(card.width - cards[0]!.width) < 1 && Math.abs(card.height - cards[0]!.height) < 1),
      equalNameplates: nameplates.every(height => Math.abs(height - nameplates[0]!) < 1),
      shuffleBelow: shuffle.top >= Math.max(...cards.map(card => card.bottom)) && Math.abs(shuffle.width - el.getBoundingClientRect().width) < 1,
      fillsArt: images.every(img => getComputedStyle(img).objectFit === 'cover'),
    };
  });
  expect(geometry).toEqual({equalCards:true,equalNameplates:true,shuffleBelow:true,fillsArt:true});
  const artworkHeights = await picker.locator('button:not([data-sport="shuffle"]) .activity-art').evaluateAll(images => images.map(img => img.getBoundingClientRect().height));
  expect(Math.min(...artworkHeights)).toBeGreaterThanOrEqual(40);
}

for (const viewport of [{width:844,height:390}, {width:320,height:568}]) {
  test(`constrained menu keeps artwork and scrolls to actions at ${viewport.width}×${viewport.height}`, async ({page}) => {
    await page.setViewportSize(viewport);
    await page.goto("/games/cryptball/");
    await expectActivities(page);
    const overlay = page.locator("#overlay");
    expect(await overlay.evaluate(el => getComputedStyle(el).overflowY)).toBe("auto");
    expect(await overlay.evaluate(el => {
      const children = [...el.children].map(child => child.getBoundingClientRect());
      return children.every((rect, index) => index === 0 || rect.top >= children[index - 1]!.bottom);
    })).toBe(true);
    for (const name of ["Single player", "Play online", "Practice", "Settings", "Credits"]) {
      const action = page.getByRole("button", {name, exact:true});
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeInViewport({ratio:1});
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 500 }, { width: 640, height: 480 }, { width: 390, height: 844 }]) {
  test(`setup fits without scrolling at ${viewport.width}×${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/games/cryptball/");
    await expectActivities(page);
    for (const name of ["Single player", "Play online", "Practice", "Settings", "Credits"])
      await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    await expectFittedMenu(page);
    const dodge=page.locator('button[data-sport="crypt-dodge"]');
    await dodge.click();await expect(dodge).toHaveAttribute("aria-pressed","true");
    await expect(dodge).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("setup.png") });
    await page.getByRole("button", { name: "Play online", exact: true }).click();
    await expect(page.getByRole("heading", {name:"Play online",exact:true})).toBeVisible();
    await expect(page.getByRole("button", {name:"Find a match",exact:true})).toBeInViewport({ratio:1});
    await expect(page.getByRole("button", {name:"Play with friends",exact:true})).toBeInViewport({ratio:1});
    await expect(page.getByRole("button", {name:"Back",exact:true})).toBeInViewport({ratio:1});
    await expect(page.getByText(/Play remotely with other players/)).toBeVisible();
    await expectFittedMenu(page);
    await page.getByRole("button", { name: "Play with friends", exact: true }).click();
    await expectFittedMenu(page);
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", {name:"Back",exact:true}).click();
    await expect(page.getByRole("heading", {name:"Play online",exact:true})).toBeVisible();
    await page.getByRole("button", {name:"Back",exact:true}).click();
    await expect(page.getByRole("heading", {name:"CRYPT GAMES",exact:true})).toBeVisible();
  });
}

test("activity selection preserves keyboard focus and Guardian solo availability", async ({ page }) => {
  await page.goto("/games/cryptball/");
  const shuffle = page.locator('button[data-sport="shuffle"]');
  await shuffle.focus();
  await page.keyboard.press("Enter");
  await expect(shuffle).toHaveAttribute("aria-pressed", "true");
  await expect(shuffle).toBeFocused();
  const guardian = page.locator('button[data-sport="crypt-guardian"]');
  await guardian.focus();
  await page.keyboard.press("Enter");
  await expect(guardian).toHaveAttribute("aria-pressed", "true");
  await expect(guardian).toBeFocused();
  await expect(shuffle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", {name:"Single player",exact:true})).toBeEnabled();
  await expect(page.getByRole("button", {name:"Play online",exact:true})).toBeDisabled();
  await expect(page.getByRole("button", {name:"Play with friends",exact:true})).toHaveCount(0);
});

test("portrait setup returns to fitted court and pause resumes play", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/games/cryptball/");
  await expectFittedMenu(page);
  await page.getByRole("button", { name: "Practice", exact: true }).click();
  await expect.poll(async () => {
    const resume = page.getByRole("button", { name: "Resume", exact: true });
    if (await resume.isVisible()) await resume.click();
    return page.locator("#overlay").isHidden();
  }, { timeout: 30000 }).toBe(true);
  await expect(page.getByRole("button", { name: "Pause game", exact: true })).toBeVisible();
  const court = (await page.locator("canvas").boundingBox())!;
  expect(court.width / court.height).toBeCloseTo(1.6, 1);
  expect(court.x).toBeGreaterThanOrEqual(0);
  expect(court.x + court.width).toBeLessThanOrEqual(391);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.getByRole("button", { name: "Pause game", exact: true })).toBeVisible();
});
