import { expect, test, type Page } from "@playwright/test";

// These assertions deliberately avoid scrolling: setup actions must be usable
// together in the viewport, including short laptops and portrait phones.
async function expectFittedMenu(page: Page) {
  await expect(page.getByLabel("Scoreboard", { exact: true })).toBeHidden();
  const problems = await page.locator("#overlay").evaluate((overlay) => {
    const issues: string[] = [];
    for (const element of [
      document.documentElement,
      document.body,
      overlay,
      ...overlay.querySelectorAll<HTMLElement>("*"),
    ]) {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      if (
        element === overlay ||
        element.matches("button, input, select, fieldset")
      ) {
        if (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1
        )
          issues.push(
            `outside viewport: ${element.tagName} ${element.textContent?.trim().slice(0, 50)}`,
          );
      }
      if (
        element.matches(".team-selector button") &&
        element.scrollHeight > element.clientHeight + 1
      )
        issues.push(`clipped team tile: ${element.textContent}`);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 1
      )
        issues.push(`vertical scroll: ${element.tagName}.${element.className}`);
      if (
        /(auto|scroll)/.test(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1
      )
        issues.push(
          `horizontal scroll: ${element.tagName}.${element.className}`,
        );
    }
    return issues;
  });
  expect(problems).toEqual([]);
}

async function expectSimpleTeams(page: Page) {
  const picker = page.getByRole("group", { name: "Your team", exact: true });
  await expect(picker.getByRole("button")).toHaveCount(6);
  for (const name of ["Rams", "Foxes", "Bats", "Owls", "Gators", "Hornets"]) {
    const tile = picker.locator(`button[data-team="${name.toLowerCase()}"]`);
    await expect(tile).toBeVisible();
    await expect(tile.locator("img")).toHaveCount(1);
    expect((await tile.innerText()).replace(/Taken/gi, "").trim()).toBe(name);
  }
  await expect(picker.locator("small")).toHaveCount(0);
}

test("private lobby keeps team states, readiness and invite actions together", async ({
  browser,
}, testInfo) => {
  const host = await browser.newContext({
    viewport: { width: 800, height: 500 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const guest = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await host.newPage();
    await page.goto("/games/cryptball/");
    await page.getByRole("button", {name:"Play online",exact:true}).click();
    await page
      .getByRole("button", { name: "Play with friends", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Create room", exact: true })
      .click();
    const copyInvite = page.getByRole("button", {
      name: "Copy invite",
      exact: true,
    });
    await expect(copyInvite).toBeVisible();
    await copyInvite.click();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    const other = await guest.newPage();
    await other.goto(link);
    for (const client of [page, other]) {
      await expectSimpleTeams(client);
      const picker = client.getByRole("group", {
        name: "Your team",
        exact: true,
      });
      await expect(picker.locator("button:disabled")).toHaveCount(1);
      await expect(picker.locator("button:disabled")).toContainText("Taken");
      await expect(picker.locator('[aria-pressed="true"]')).toHaveCount(1);
      await expectFittedMenu(client);
      await expect(
        client.getByRole("button", { name: "Copy invite", exact: true }),
      ).toBeInViewport({ ratio: 1 });
    }
    await page
      .getByRole("button", { name: "Copy invite", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(link);
    await page
      .getByRole("group", { name: "Your team", exact: true })
      .getByRole("button", { name: "Owls", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Ready", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await page.getByRole("button", { name: "Ready", exact: true }).click();
    await other.getByRole("button", { name: "Ready", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Start with bots", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expectFittedMenu(page);
    await page.screenshot({ path: testInfo.outputPath("lobby-short.png") });
    await other.screenshot({ path: testInfo.outputPath("lobby-narrow.png") });
    await page.bringToFront();
    await page
      .getByRole("button", { name: "Start with bots", exact: true })
      .click();
    await expect(page.getByLabel("Scoreboard", { exact: true })).toBeVisible({
      timeout: 20000,
    });
    // Opening two contexts and software-rendered stadiums can trigger the explicit
    // focus/frame-debt cover flow. Verify authority advances before resuming it.
    await expect
      .poll(
        async () =>
          (await page.locator("#overlay").isHidden()) ||
          (await page
            .getByRole("heading", { name: "Computer covering", exact: true })
            .isVisible()),
        { timeout: 20000 },
      )
      .toBe(true);
    if (
      await page
        .getByRole("heading", { name: "Computer covering", exact: true })
        .isVisible()
    ) {
      const tick = await page.locator("#game").getAttribute("data-tick");
      await expect(page.locator("#game")).not.toHaveAttribute(
        "data-tick",
        tick!,
      );
      await page
        .getByRole("button", { name: "Return to play", exact: true })
        .click();
    }
    await expect(page.locator("#overlay")).toBeHidden({ timeout: 20000 });
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});
