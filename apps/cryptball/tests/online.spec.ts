import { expect, test, type Page } from "@playwright/test";
import { Client, type Room } from "@colyseus/sdk";

async function chooseOnline(page: Page, choice: "Find a match" | "Play with friends") {
  await page.getByRole("button", {name:"Play online",exact:true}).click();
  await page.getByRole("button", {name:choice,exact:true}).click();
}

test("two humans start with bots; menu and reload preserve the running match", async ({
  browser,
}) => {
  const contexts = await Promise.all([
    browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }),
    browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }),
  ]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of pages) page.on("pageerror", (e) => errors.push(e.message));
  try {
    for (const page of pages) {
      await page.goto("http://127.0.0.1:4226/games/cryptball/");
      await chooseOnline(page, "Find a match");
      await expect(
        page.getByRole("heading", { name: "The next match" }),
      ).toBeVisible();
    }
    await expect(
      pages[0].getByRole("button", { name: "Start with bots" }),
    ).toBeVisible();
    await pages[0].getByRole("button", { name: "Start with bots" }).click();
    for (const page of pages)
      await enterOnlineCourt(page, "cryptball", "Cryptball");
    await enterOnlineCourt(pages[0], "cryptball", "Cryptball");
    await pages[0].keyboard.down("KeyD");
    await pages[0].waitForTimeout(500);
    await pages[0].keyboard.up("KeyD");
    await enterOnlineCourt(pages[0], "cryptball", "Cryptball");
    await pages[0].keyboard.press("Escape");
    await expect(
      pages[0].getByRole("heading", { name: "Computer covering" }),
    ).toBeVisible();
    const timeBefore = await pages[1].locator("#clock").textContent();
    await expect(pages[1].locator("#clock")).not.toHaveText(timeBefore!);
    await pages[0].getByRole("button", { name: "Return to play" }).click();
    await expect(pages[0].locator("#overlay")).toBeHidden();
    await pages[1].reload();
    await chooseOnline(pages[1], "Find a match");
    await enterOnlineCourt(pages[1], "cryptball", "Cryptball");
    await expect(pages[1].locator("#clock")).not.toHaveText("1:30");
    await pages[0].screenshot({
      path: ".local-game-tests/cryptball-online-menu-regression/online-court.png",
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("four humans auto-start and a fifth enters the next waiting room", async ({
  browser,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 5 }, () => browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] })),
  );
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const errors: string[] = [];
  for (const page of pages) page.on("pageerror", (e) => errors.push(e.message));
  try {
    for (const page of pages.slice(0, 4)) {
      await page.goto("http://127.0.0.1:4226/games/cryptball/");
      await chooseOnline(page, "Find a match");
    }
    // Concurrent software-rendered contexts can enter the local frame-debt
    // cover menu. The authoritative match must start and remain visible there.
    for (const page of pages.slice(0, 4))
      await expect(page.locator("#clock")).not.toHaveText("1:30", {
        timeout: 20000,
      });
    await pages[4].goto("http://127.0.0.1:4226/games/cryptball/");
    await chooseOnline(pages[4], "Find a match");
    await expect(
      pages[4].getByRole("heading", { name: "The next match" }),
    ).toBeVisible();
    await expect(
      pages[4].getByRole("button", { name: /Start with/ }),
    ).toHaveCount(0);
    if (
      !(await pages[0].getByRole("button", { name: "Leave match" }).isVisible())
    )
      await pages[0].keyboard.press("Escape");
    await pages[0].getByRole("button", { name: "Leave match" }).click();
    await expect(
      pages[0].getByRole("button", { name: "Play online", exact: true }),
    ).toBeVisible();
    const clock = await pages[1].locator("#clock").textContent();
    await expect(pages[1].locator("#clock")).not.toHaveText(clock!);
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test("private four-player room auto-starts and a field-player reload rejoins play", async ({
  browser,
}) => {
  // Two rendered clients plus two real socket peers exercise all four seats.
  const contexts = await Promise.all([
    browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }),
    browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }),
  ]);
  const [creator, returning] = await Promise.all(
    contexts.map((c) => c.newPage()),
  );
  const peers: Room[] = [];
  const errors: string[] = [];
  for (const page of [creator, returning])
    page.on("pageerror", (e) => errors.push(e.message));
  try {
    await creator.goto("http://127.0.0.1:4226/games/cryptball/");
    await chooseOnline(creator, "Play with friends");
    await creator
      .getByRole("button", { name: "Create room", exact: true })
      .click();
    const url = await copyInvite(creator);
    const code = new URL(url).searchParams.get("room")!;
    const { BUILD, PROTOCOL } = await import("../protocol");
    async function joinPeer() {
      const room = await new Client("http://127.0.0.1:2568").joinById(code, {
        build: BUILD,
        protocol: PROTOCOL,
        name: "Field guest",
      });
      peers.push(room);
      room.onMessage("snapshot", () => {});
      room.onMessage("lobby", () => {});
      room.send("ready");
    }
    await joinPeer();
    await expect(
      creator.getByText("Field guest · Ready", { exact: true }),
    ).toHaveCount(1);
    await returning.goto(url);
    await expect(
      returning.getByText("Guest · Ready", { exact: true }),
    ).toHaveCount(2, { timeout: 15000 });
    await expect(
      creator.getByRole("heading", { name: "The next match" }),
    ).toBeVisible();
    await returning.screenshot({
      path: ".local-game-tests/cryptball-online-menu-regression/private-returning-lobby.png",
    });
    await joinPeer(); // Fourth ready human starts the room automatically.
    for (const page of [creator, returning])
      await expect(page.locator("#clock")).not.toHaveText("1:30", {
        timeout: 20000,
      });
    await returning.reload();
    await expect(returning.locator("#clock")).not.toHaveText("1:30", {
      timeout: 20000,
    });
    await returning.screenshot({
      path: ".local-game-tests/cryptball-online-menu-regression/private-returning-rejoined.png",
    });
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled(peers.map((peer) => peer.leave()));
    await Promise.all(contexts.map((context) => context.close()));
  }
});

async function enterOnlineCourt(page: Page, sportId: string, label: string) {
  await page.bringToFront();
  await expect(page.locator("#game")).toHaveAttribute("data-sport", sportId, {
    timeout: 20000,
  });
  // Two software-rendered clients can exceed the local frame budget during
  // mode/reload warmup. Only the recognized bot-cover flow may be resumed;
  // connection errors, waiting lobbies and other overlays must still fail.
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
    expect(tick).not.toBeNull();
    // Covered clients do not predict: a changing tick proves authority snapshots
    // continue through bot takeover rather than a successful-looking frozen HUD.
    await expect(page.locator("#game")).not.toHaveAttribute("data-tick", tick!);
    await page
      .getByRole("button", { name: "Return to play", exact: true })
      .click();
  }
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("canvas")).toHaveAttribute(
    "aria-label",
    `${label} court`,
  );
}

for (const [sportId, label] of [
  ["cryptkick", "Cryptkick"],
  ["rift-volley", "Rift Volley"],
  ["cryptcheck", "Cryptcheck · Hockey"],
  ["crypt-dodge", "Crypt Dodge"],
  ["crypt-guardian", "Crypt Guardian"],
] as const) {
  test(`${label} private invitation hydrates the sport, starts with bots, and reconnects on reload`, async ({
    browser,
  }) => {
    const contexts = await Promise.all([
      browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }),
      browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }),
    ]);
    const [creator, returning] = await Promise.all(
      contexts.map((context) => context.newPage()),
    );
    const errors: string[] = [];
    for (const page of [creator, returning])
      page.on("pageerror", (error) => errors.push(error.message));
    try {
      await creator.goto("http://127.0.0.1:4226/games/cryptball/");
      await creator.getByRole("button", { name: label, exact: true }).click();
      await chooseOnline(creator, "Play with friends");
      await creator
        .getByRole("button", { name: "Create room", exact: true })
        .click();
      const url = new URL(await copyInvite(creator));
      expect(url.searchParams.get("sport")).toBe(sportId);
      // A bare room-code link starts from the default sport and discovers the room's sport.
      url.searchParams.delete("sport");
      await returning.goto(url.href);
      expect(new URL(await copyInvite(returning)).searchParams.get("sport")).toBe(sportId);
      if(sportId !== "crypt-guardian") {
        await expect(creator.getByRole("button", { name: "Start with bots" })).toBeVisible();
        await creator.getByRole("button", { name: "Start with bots" }).click();
      } // Guardian's two ready humans fill the room and start automatically.
      for (const page of [creator, returning])
        await enterOnlineCourt(page, sportId, label);
      if (sportId === "rift-volley")
        await expect(returning.locator("#clock")).toHaveText("FIRST TO 11");
      else await expect(returning.locator("#clock")).not.toHaveText("1:30");
      await enterOnlineCourt(creator, sportId, label);
      await creator.keyboard.press("Escape");
      await expect(
        creator.getByRole("heading", { name: "Computer covering" }),
      ).toBeVisible();
      await creator.getByRole("button", { name: "Return to play" }).click();
      await returning.reload();
      await enterOnlineCourt(returning, sportId, label);
      await returning.keyboard.press("Escape");
      await expect(
        returning.getByRole("heading", {
          name: "Computer covering",
          exact: true,
        }),
      ).toBeVisible();
      await returning
        .getByRole("button", { name: "Return to play", exact: true })
        .click();
      await expect(returning.locator("#overlay")).toBeHidden();
      await returning.screenshot({
        path: `.local-game-tests/cryptball-online-menu-regression/${sportId}-reconnected.png`,
      });
      if (sportId === "crypt-dodge" || sportId === "crypt-guardian") {
        await expect(returning.locator("canvas")).toHaveAttribute("data-new-modes-atlas-ready", "true");
        await expect(returning.locator("#special-hud")).toBeHidden();
        if (sportId === "crypt-guardian") {
          await expect(returning.locator("#ivory")).toHaveText("TWO ALLIES");
          await expect(returning.locator("#game")).toHaveAttribute("data-guardian-status", /^(active|down|out),(active|down|out)$/);
        } else {
          await expect(returning.locator("#game")).toHaveAttribute("data-dodge-lives", /^[0-3],[0-3],[0-3],[0-3]$/);
        }
      }
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  });
}

test("multiplayer club preferences and waiting changes are authoritative", async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] }), browser.newContext()]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    for (const [index, name] of ["Owls", "Bats"].entries()) {
      await pages[index].goto("http://127.0.0.1:4226/games/cryptball/");
      await pages[index].getByRole("group", { name: "Your team", exact: true }).getByRole("button", { name, exact: true }).click();
      await chooseOnline(pages[index], "Find a match");
      await expect(pages[index].getByRole("heading", { name: "The next match" })).toBeVisible();
    }
    for (const page of pages) {
      await expect(page.locator(".lobby-roster")).toContainText("OWLS");
      await expect(page.locator(".lobby-roster")).toContainText("BATS");
    }
    const picker = pages[0].getByRole("group", { name: "Your team", exact: true });
    await expect(picker.getByRole("button", { name: "Bats, taken by opponent", exact: true })).toBeDisabled();
    await picker.getByRole("button", { name: "Gators", exact: true }).click();
    for (const page of pages) {
      await expect(page.locator(".lobby-roster")).toContainText("GATORS");
      await page.getByRole("button", { name: "Ready", exact: true }).click();
    }
    await pages[0].getByRole("button", { name: "Start with bots" }).click();
    for (const page of pages) {
      await expect(page.locator("#clock")).not.toHaveText("1:30", { timeout: 20000 });
      await expect(page.locator("#ivory")).toContainText("GATORS");
      await expect(page.locator("#ember")).toContainText("BATS");
    }
  } finally { await Promise.all(contexts.map((context) => context.close())); }
});

async function copyInvite(page: Page) {
  await page.getByRole("button", { name: "Copy invite", exact: true }).click();
  await expect(page.getByRole("button", { name: "Invite copied", exact: true })).toBeVisible();
  return page.evaluate(() => navigator.clipboard.readText());
}

test("a joiner hidden through Dodge kickoff gets cover and can take control", async ({ browser }) => {
  const [host, peer] = await Promise.all([browser.newPage(), browser.newPage()]);
  try {
    for (const [index, page] of [host, peer].entries()) {
      await page.goto("http://127.0.0.1:4226/games/cryptball/?sport=crypt-dodge&diagnostics=1");
      await chooseOnline(page, "Find a match");
      await page.getByLabel("Player name", { exact: true }).fill(index === 0 ? "Host" : "Peer");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(page.getByRole("heading", { name: "The next match" })).toBeVisible();
    }
    await peer.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await host.getByRole("button", { name: "Start with bots", exact: true }).click();
    const cover = peer.getByRole("button", { name: "Return to play", exact: true });
    await expect(cover).toBeVisible({ timeout: 20000 });
    await peer.evaluate(() => {
      Reflect.deleteProperty(document, "hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(cover).toBeVisible();
    await cover.click();
    await expect(peer.locator("#overlay")).toBeHidden();
    await peer.waitForFunction(() => {
      const diagnostics = (window as unknown as {
        __cryptballPerformance: { export(): { events: { kind: string }[] } };
      }).__cryptballPerformance;
      return diagnostics.export().events.some(event => event.kind === "input-applied");
    });
  } finally {
    await Promise.all([host.close(), peer.close()]);
  }
});
