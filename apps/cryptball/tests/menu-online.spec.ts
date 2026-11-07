import { expect, test, type Page } from "@playwright/test";

async function identify(page: Page, name: string) {
  await page.getByRole("textbox", { name: "Player name" }).fill(name);
  await page.locator("form button[type=submit]").click();
}

function dodge(page: Page) {
  return page.locator("#overlay .friends-sport").filter({
    has: page.getByRole("heading", { name: "Crypt Dodge", exact: true }),
  });
}

test("a shared friends link admits named players, starts Dodge and lets a third browser watch and queue", async ({
  browser,
}, testInfo) => {
  const host = await browser.newPage({
    viewport: { width: 800, height: 500 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const guest = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  const viewer = await browser.newPage();
  const viewerConnections: import("@playwright/test").WebSocketRoute[] = [];
  await viewer.routeWebSocket(
    (url) => url.port === "2568",
    (socket) => {
      socket.connectToServer();
      viewerConnections.push(socket);
    },
  );
  const errors: string[] = [];
  for (const page of [host, guest, viewer])
    page.on("pageerror", (error) => errors.push(error.message));
  try {
    await host.goto("/games/cryptball/");
    await host
      .getByRole("button", { name: "Play online", exact: true })
      .click();
    await host
      .getByRole("button", { name: "Play with friends", exact: true })
      .click();
    await identify(host, "Mike");
    await expect(host.locator("#overlay .friends-sport")).toHaveCount(5);
    await host
      .getByRole("button", { name: /Copy (group invite|lobby link)/i })
      .click();
    const link = await host.evaluate(() => navigator.clipboard.readText());
    expect(new URL(link).origin).toBe(new URL(host.url()).origin);
    await dodge(host).getByRole("button").first().click();
    await guest.goto(link);
    await identify(guest, "Jeff");
    await expect(dodge(guest)).toContainText("Mike");
    await guest.screenshot({ path: testInfo.outputPath("friends-phone.png") });
    await dodge(guest)
      .getByRole("button", { name: /^(Join|Join court)$/i })
      .click();
    await expect(host.locator(".lobby-roster")).toContainText("Jeff");
    await host.screenshot({
      path: testInfo.outputPath("friends-court-short.png"),
    });
    await host
      .getByRole("button", { name: /^Start( with bots| match)?$/ })
      .click();
    await expect(host.locator("#game")).toHaveAttribute(
      "data-sport",
      "crypt-dodge",
    );
    await viewer.goto(link);
    await identify(viewer, "Jo");
    await dodge(viewer)
      .getByRole("button", { name: "Watch", exact: true })
      .click();
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-sport",
      "crypt-dodge",
    );
    const panel = viewer.locator("#friends-panel");
    if ((await panel.locator("details").getAttribute("open")) === null)
      await panel.locator("summary").click();
    await panel.getByRole("button", { name: "Play next", exact: true }).click();
    await expect(viewer.getByText(/queued|in line/i).first()).toBeVisible();
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-spectator",
      "true",
    );
    await expect(host.locator("#game")).toHaveAttribute(
      "data-spectator",
      "false",
    );
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-tick",
      /^[1-9]\d*$/,
    );
    const viewerTick = await viewer.locator("#game").getAttribute("data-tick");
    await expect(viewer.locator("#game")).not.toHaveAttribute(
      "data-tick",
      viewerTick!,
    );
    // The load fixture exercises the real 64 KiB cutoff. Deliver its close
    // code to a real browser here to exercise automatic watch-only recovery.
    const previousConnections = viewerConnections.length;
    const slowCourt = viewerConnections.at(-1)!;
    await slowCourt.close({ code: 4001, reason: "Connection too slow" });
    await expect
      .poll(() => viewerConnections.length, { timeout: 15000 })
      .toBeGreaterThan(previousConnections);
    await expect(panel.locator("summary")).toContainText("Watching");
    await expect(panel.locator("summary")).not.toContainText("Queued");
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-controlled-id",
      "",
    );
    const guestControlledId = await guest.locator("#game").getAttribute("data-controlled-id");
    expect(guestControlledId).toBeTruthy();
    await guest.reload();
    await expect(guest.locator("#game")).toHaveAttribute(
      "data-sport",
      "crypt-dodge",
      { timeout: 15000 },
    );
    await expect(guest.locator("#game")).toHaveAttribute(
      "data-spectator",
      "false",
    );
    await expect(guest.locator("#game")).toHaveAttribute(
      "data-tick",
      /^[1-9]\d*$/,
    );
    await expect(guest.locator("#game")).toHaveAttribute("data-controlled-id", guestControlledId!);
    // An expired/missing seat token must settle as a watcher before success is shown.
    await guest.evaluate(() => {
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith("cryptball-reconnect:")) sessionStorage.removeItem(key);
    });
    await guest.reload();
    await expect(guest.locator("#game")).toHaveAttribute("data-spectator", "true", { timeout: 15000 });
    await expect(guest.locator("#game")).toHaveAttribute("data-controlled-id", "");
    await expect(guest.locator("#notice")).toContainText("Your player seat could not be restored");
    const guestPanel = guest.locator("#friends-panel");
    const playNext = guestPanel.getByRole("button", { name: "Play next", exact: true });
    await expect(playNext).toBeVisible();
    await playNext.click();
    await expect(guestPanel.locator("summary")).toContainText("Queued");
    await expect(guest.locator("#game")).toHaveAttribute("data-spectator", "true");
    await expect(guest.locator("#game")).toHaveAttribute("data-controlled-id", "");
    expect(errors).toEqual([]);
  } finally {
    await Promise.all([host, guest, viewer].map((page) => page.close()));
  }
});

test("Play next holds a spectator through a vacancy and seats them at the next actual match", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { Client } = await import("@colyseus/sdk");
  const { BUILD, PROTOCOL } = await import("../protocol");
  const client = new Client("http://127.0.0.1:2568");
  const shared = { build: BUILD, protocol: PROTOCOL };
  const rooms: import("@colyseus/sdk").Room[] = [];
  const viewer = await browser.newPage();
  const errors: string[] = [];
  viewer.on("pageerror", (error) => errors.push(error.message));
  try {
    const first = await client.create("friends", {
      ...shared,
      name: "Mike",
      foundingKey: crypto.randomUUID(),
    });
    rooms.push(first);
    const directory = new Promise<
      import("../friends-protocol").FriendsDirectory
    >((resolve) => first.onMessage("directory", resolve));
    first.send("refresh");
    const { groupKey } = await directory;
    const second = await client.joinOrCreate("friends", {
      ...shared,
      name: "Jeff",
      groupKey,
    });
    rooms.push(second);
    second.onMessage("directory", () => {});
    async function seat(directoryRoom: import("@colyseus/sdk").Room) {
      const reservation = new Promise<
        Parameters<typeof client.consumeSeatReservation>[0]
      >((resolve) => {
        directoryRoom.onMessage("court-reservation", (reply) =>
          resolve(reply.reservation),
        );
      });
      directoryRoom.send("court", {
        requestId: crypto.randomUUID(),
        sportId: "cryptball",
        intent: "play",
      });
      const room = await client.consumeSeatReservation(await reservation);
      rooms.push(room);
      room.onMessage("snapshot", () => {});
      return room;
    }
    const mike = await seat(first);
    let epoch = 0;
    mike.onMessage("lobby", (lobby: import("../protocol").Lobby) => {
      epoch = lobby.epoch;
      if (lobby.phase === "results") mike.send("rematch");
    });
    const jeff = await seat(second);
    jeff.onMessage("lobby", () => {});
    mike.send("start");
    await viewer.goto(
      "/games/cryptball/?group=" + encodeURIComponent(groupKey),
    );
    await identify(viewer, "Jo");
    await viewer
      .locator("#overlay .friends-sport")
      .filter({
        has: viewer.getByRole("heading", { name: "Cryptball", exact: true }),
      })
      .getByRole("button", { name: "Watch", exact: true })
      .click();
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-tick",
      /^[1-9]\d*$/,
    );
    await viewer.locator("#friends-panel summary").click();
    await viewer
      .locator("#friends-panel")
      .getByRole("button", { name: "Play next", exact: true })
      .click();
    await expect(viewer.locator("#friends-panel")).toContainText(
      "Queued for next match",
    );
    await jeff.leave();
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-spectator",
      "true",
    );
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-controlled-id",
      "",
    );
    await expect
      .poll(() => epoch, { timeout: 245_000, intervals: [500] })
      .toBe(2);
    await expect(viewer.locator(".lobby-roster")).toContainText("Jo");
    await expect(viewer.locator(".lobby-roster")).toContainText("Mike");
    const drawer = viewer.locator("#friends-panel details");
    if (await drawer.evaluate((el) => (el as HTMLDetailsElement).open))
      await drawer.locator("summary").click();
    await viewer
      .getByRole("button", { name: "Start match", exact: true })
      .click();
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-controlled-id",
      /^player-\d$/,
      { timeout: 15000 },
    );
    await expect(viewer.locator("#game")).toHaveAttribute(
      "data-spectator",
      "false",
    );
    expect(errors).toEqual([]);
  } finally {
    await viewer.close();
    await Promise.allSettled(rooms.map((room) => room.leave()));
  }
});

test("a failed court connection keeps the original seat, then a successful switch releases it", async ({
  browser,
}) => {
  const mike = await browser.newPage();
  const jeff = await browser.newPage();
  let refuseNextUpgrade = false;
  let refused = 0;
  // Register before navigation so the SDK captures the routed WebSocket.
  await mike.routeWebSocket(
    (url) => url.port === "2568",
    (socket) => {
      if (refuseNextUpgrade) {
        refuseNextUpgrade = false;
        refused++;
        socket.close({ code: 1008, reason: "Fixture refused first upgrade" });
      } else socket.connectToServer();
    },
  );
  try {
    await mike.goto("/games/cryptball/");
    await mike
      .getByRole("button", { name: "Play online", exact: true })
      .click();
    await mike.getByRole("button", { name: "Play with friends" }).click();
    await identify(mike, "Mike");
    await mike
      .getByRole("button", { name: "Play Crypt Dodge", exact: true })
      .click();
    await expect(mike.locator(".lobby-roster")).toContainText("Mike");
    await jeff.goto(mike.url());
    await identify(jeff, "Jeff");
    await jeff
      .getByRole("button", { name: "Play Cryptkick", exact: true })
      .click();
    await expect(jeff.locator(".lobby-roster")).toContainText("Jeff");
    refuseNextUpgrade = true;
    const panel = mike.locator("#friends-panel");
    await panel.locator("summary").click();
    const switchButton = panel
      .locator(".friends-sport")
      .filter({
        has: mike.getByRole("heading", { name: "Cryptkick", exact: true }),
      })
      .getByRole("button", { name: "Join court", exact: true });
    await switchButton.click();
    await expect.poll(() => refused).toBe(1);
    await expect(mike.locator(".lobby-roster")).toContainText("Mike");
    await expect(jeff.locator(".lobby-roster")).not.toContainText("Mike");
    await switchButton.click();
    await expect(jeff.locator(".lobby-roster")).toContainText("Mike");
    await expect(mike.locator(".lobby-roster")).toContainText("Jeff");
    await expect(
      mike.getByRole("button", { name: "Start match", exact: true }),
    ).toBeVisible();
  } finally {
    await Promise.all([mike.close(), jeff.close()]);
  }
});
