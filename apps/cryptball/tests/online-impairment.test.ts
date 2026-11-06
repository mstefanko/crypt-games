import { afterEach, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { OrderedLink } from "./helpers/ordered-link";
const transport = vi.hoisted(() => ({ rooms: [] as any[] }));
vi.mock("@colyseus/sdk", async (original) => ({
  ...(await original<object>()),
  Client: class {
    async joinOrCreate() {
      return transport.rooms.shift();
    }
  },
}));
import { createOnlineSession } from "../src/online/session";
import { MatchAuthority } from "../../cryptball-server/src/model";
import { encodeSnapshot, PROTOCOL } from "../protocol";
import { SPORT_IDS } from "../sim/session";
import { FixedScheduler } from "../../../packages/game-runtime/src/scheduler";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  transport.rooms.length = 0;
});
it("ordered links preserve stream order through jitter and retransmission stalls", () => {
  const delivered: number[] = [];
  const link = new OrderedLink((_sent, ordinal) => [100, 10, 20][ordinal]!);
  for (let i = 0; i < 3; i++) link.send(i, () => delivered.push(i));
  link.deliver(99);
  expect(delivered).toEqual([]);
  link.deliver(100);
  expect(delivered).toEqual([0, 1, 2]);
});
const scenarios = [
  ...[20, 80, 150, 200, 250, 300].map((rtt) => ({
    name: `steady-${rtt}`,
    up: rtt / 2,
    down: rtt / 2,
    jitter: 0,
    stall: 0,
  })),
  ...[
    [10, 140],
    [140, 10],
    [25, 225],
    [225, 25],
  ].map(([up, down]) => ({
    name: `asymmetric-${up}-${down}`,
    up: up!,
    down: down!,
    jitter: 30,
    stall: 0,
  })),
  { name: "jitter", up: 75, down: 75, jitter: 30, stall: 0 },
  { name: "stall-100", up: 40, down: 40, jitter: 30, stall: 100 },
  { name: "mixed-250-20", up: 125, down: 125, jitter: 30, stall: 0 },
  { name: "route-change", up: 125, down: 125, jitter: 30, stall: 0 },
  { name: "stall-250", up: 40, down: 40, jitter: 30, stall: 250 },
];
for (const sport of SPORT_IDS)
  for (const scenario of scenarios)
    it(`${sport} ${scenario.name}: keeps every supported participant controllable`, async () => {
      let now = 0,
        accepted = 0,
        rejected = 0,
        resync = 0,
        resyncAfterWarmup = 0,
        inactive = 0,
        rejectedAfterWarmup = 0,
        acceptedAfterWarmup = 0,
        appliedAfterWarmup = 0,
        pendingAfterWarmup = 0,
        inFlightInputs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      vi.stubGlobal("sessionStorage", {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      });
      const authority = new MatchAuthority("impairment", false, sport);
      for (let i = 0; i < authority.capacity; i++) {
        authority.join(`p${i}`, "Guest");
        authority.ready(`p${i}`);
      }
      authority.start();
      for (let i = 0; i < 180; i++) authority.advance();
      const originalTerminal = (authority as any).terminal.bind(authority);
      let actionExecuted = 0;
      const actions = new Set<string>();
      const measuredInputs = new Set<string>();
      const measuredAccepted = new Set<string>();
      const terminalReasons = new Map<string, string | undefined>();
      const terminalCounts = new Map<string, number>();
      const measuredRejections: { peer: string; at: number; reason: string | undefined }[] = [];
      const firstChangedRouteRtt = new Map<string, number>();
      vi.spyOn(authority as any, "terminal").mockImplementation(
        (...args: any[]) => {
          const [peer, seq, reason] = args;
          const key = `${peer.id}:${seq}`;
          terminalReasons.set(key, reason);
          terminalCounts.set(key, (terminalCounts.get(key) ?? 0) + 1);
          if (measuredInputs.has(`${peer.id}:${seq}`) && reason === undefined) {
            appliedAfterWarmup++;
            if (actions.has(`${peer.id}:${seq}`)) actionExecuted++;
          }
          return originalTerminal(...args);
        },
      );
      const clients: ReturnType<typeof createOnlineSession>[] = [],
        links: OrderedLink[] = [];
      const handlers: Map<string, (value: any) => void>[] = [];
      for (let i = 0; i < authority.capacity; i++) {
        const id = `p${i}`,
          h = new Map<string, (value: any) => void>();
        handlers.push(h);
        const delay = (base: number) => (sent: number, ordinal: number) =>
          (scenario.name === "mixed-250-20" && i > 0 ? 10 : scenario.name === "route-change" && sent < 4000 ? 10 : base) +
          Math.sin(ordinal * 1.71) * scenario.jitter +
          (scenario.stall && sent >= 4000 && sent < 4000 + scenario.stall
            ? 4000 + scenario.stall - sent
            : 0);
        const up = new OrderedLink(delay(scenario.up)),
          down = new OrderedLink(delay(scenario.down));
        links.push(up, down);
        const snapshot = (resyncId?: number) => {
          const frame = authority.snapshot(id, [], undefined, now);
          if (resyncId !== undefined) frame.resyncId = resyncId;
          const bytes = encodeSnapshot(frame);
          down.send(now, () => h.get("snapshot")?.(bytes));
        };
        transport.rooms.push({
          roomId: "impairment",
          sessionId: id,
          reconnectionToken: `impairment:${id}`,
          reconnection: {},
          onMessage: (type: string, cb: (value: any) => void) =>
            h.set(type, cb),
          onDrop: () => {},
          onReconnect: () => {},
          onLeave: () => {},
          onError: () => {},
          leave: async () => {},
          send: (type: string, value: any) => {
            if (type === "input") inFlightInputs++;
            up.send(now, () => {
              if (type === "input") {
                inFlightInputs--;
                if (now > 2000) measuredInputs.add(`${id}:${value.seq}`);
                if (value.command.strikePressed || value.command.dash)
                  actions.add(`${id}:${value.seq}`);
                if (authority.receive(id, value)) {
                  accepted++;
                  if (now > 2000) {
                    acceptedAfterWarmup++;
                    measuredAccepted.add(`${id}:${value.seq}`);
                  }
                } else {
                  rejected++;
                  if (now > 2000) {
                    rejectedAfterWarmup++;
                    measuredRejections.push({peer:id, at:now, reason:terminalReasons.get(`${id}:${value.seq}`)});
                  }
                }
              } else if (type === "heartbeat") authority.heartbeat(id, value);
              else if (type === "resume") {
                authority.suspend(id, false);
                snapshot();
              } else if (type === "resync") {
                resync++;
                if(now > 2000) resyncAfterWarmup++;
                snapshot(value.id);
              } else if (type === "ping") {
                const pong = {
                  ...value,
                  serverTime: now,
                  tick: authority.session.getTick(),
                  epoch: authority.epoch,
                  phase: authority.phase,
                  serverDebt: 0,
                };
                down.send(now, () => h.get("pong")?.(pong));
              }
            });
          },
        });
        const client = createOnlineSession({
          endpoint: "ws://impairment",
          sportId: sport,
          onPerformance(event) {
            if (scenario.name === "route-change" && event.kind === "rtt" && event.at >= 4000 &&
                Number(event.fields.rttMs) >= (scenario.up + scenario.down) / 2 && !firstChangedRouteRtt.has(id))
              firstChangedRouteRtt.set(id, event.at);
          },
        });
        await client.connect("quick");
        clients.push(client);
        h.get("lobby")!(authority.lobby());
        snapshot();
      }
      const schedulers = clients.map(client => {
        const scheduler = new FixedScheduler(() => client.step({
          moveX: Math.floor(now / 1000) % 2 ? 1 : -1,
          moveY: 0.5,
          strikePressed: Math.floor(now) % 1000 < 17,
          dash: Math.floor(now) % 1400 < 17,
        }), () => { throw new Error("Unexpected client simulation debt"); });
        scheduler.resume();
        scheduler.advance(0);
        return scheduler;
      });
      let serverAt = 1000 / 60,
        clientAt = 1000 / 60;
      const advanceAuthority = () => {
        if (now >= serverAt) {
          serverAt += 1000 / 60;
          authority.advance();
          if (authority.tick % 3 === 0) {
            const events = authority.session.drainEvents();
            for (let i = 0; i < authority.capacity; i++) {
              const bytes = encodeSnapshot(
                authority.snapshot(`p${i}`, events, undefined, now),
              );
              links[i * 2 + 1]!.send(now, () =>
                handlers[i]!.get("snapshot")!(bytes),
              );
            }
          }
          if (now > 2000)
            inactive += [...authority.peers.values()].filter(
              (p) => !p.active,
            ).length;
        }
      };
      for (now = 0; now < 10000; now++) {
        for (const link of links) link.deliver(now);
        advanceAuthority();
        if (now >= clientAt) {
          clientAt += 1000 / 60;
          for (let i = 0; i < clients.length; i++) {
            clients[i]!.update();
            schedulers[i]!.advance(now, clients[i]!.predictionRate);
          }
        }
      }
      const pendingAtCutoff = [...authority.peers.values()].reduce((sum, peer) => sum + peer.queue.length, 0);
      // Stop generating commands, but retain liveness and authority progression
      // until every command in the finite input cohort has a terminal outcome.
      const drainStarted = now;
      for (; now < drainStarted + 2000; now++) {
        for (const link of links) link.deliver(now);
        advanceAuthority();
        for (const client of clients) client.update();
        if (inFlightInputs === 0 && [...measuredAccepted].every(key => terminalCounts.has(key))) break;
      }
      expect(inFlightInputs).toBe(0);
      for (const key of measuredAccepted) {
        expect(terminalCounts.get(key), key).toBe(1);
        expect(terminalReasons.get(key), key).toBeUndefined();
      }
      pendingAfterWarmup = [...authority.peers.values()].reduce(
        (sum, p) =>
          sum +
          p.queue.filter((packet) =>
            measuredInputs.has(`${p.id}:${packet.seq}`),
          ).length,
        0,
      );
      const botTransitions = [...authority.peers.values()].reduce(
        (sum, p) => sum + p.feedback.botTransitions,
        0,
      );
      const report = {
        protocol: PROTOCOL,
        sport,
        scenario: scenario.name,
        participants: authority.capacity,
        accepted,
        rejected,
        acceptedAfterWarmup,
        rejectedAfterWarmup,
        appliedAfterWarmup,
        pendingAfterWarmup,
        pendingAtCutoff,
        drainMs: now - drainStarted,
        acceptedExecutionRate: appliedAfterWarmup / Math.max(1, acceptedAfterWarmup),
        overallAdmissionRate: acceptedAfterWarmup / Math.max(1, acceptedAfterWarmup + rejectedAfterWarmup),
        overallExecutionRate: appliedAfterWarmup / Math.max(1, acceptedAfterWarmup + rejectedAfterWarmup),
        measuredRejections,
        firstChangedRouteRtt: Object.fromEntries(firstChangedRouteRtt),
        actionExecuted,
        botTransitions,
        resync,
        resyncAfterWarmup,
        inactiveSeatTicks: inactive,
        clients: clients.map(client => client.diagnostics),
      };
      if (process.env.CRYPTBALL_IMPAIRMENT_REPORT)
        writeFileSync(
          `${process.env.CRYPTBALL_IMPAIRMENT_REPORT}-${sport}-${scenario.name}.json`,
          JSON.stringify(report, null, 2),
        );
      if (scenario.up + scenario.down > 250) return;
      expect(actionExecuted, JSON.stringify(report)).toBeGreaterThan(0);
      expect(accepted, JSON.stringify(report)).toBeGreaterThan(250 * authority.capacity);
      expect(inactive, JSON.stringify(report)).toBe(0);
      expect(botTransitions, JSON.stringify(report)).toBe(0);
      if (!scenario.stall && scenario.up + scenario.down <= 150)
        expect(
          rejectedAfterWarmup /
            Math.max(1, acceptedAfterWarmup + rejectedAfterWarmup),
          JSON.stringify(report),
        ).toBeLessThan(0.01);
      if (!scenario.stall && scenario.name !== "route-change")
        expect(
          appliedAfterWarmup /
            Math.max(
              1,
              acceptedAfterWarmup + rejectedAfterWarmup - pendingAfterWarmup,
            ),
          JSON.stringify(report),
        ).toBeGreaterThanOrEqual(0.99);
      if (scenario.name === "route-change") {
        // Unknown uplink delay rises abruptly at 4s. Late in-flight commands may
        // expire before that change is observable; they must not form a lasting
        // catch-up streak once the new RTT/clock sample has arrived.
        const maximumTransientTicks = Math.ceil((scenario.up - 10 + scenario.jitter) / (1000 / 60));
        for (let i = 0; i < authority.capacity; i++) {
          const id = `p${i}`, observed = firstChangedRouteRtt.get(id);
          expect(observed, JSON.stringify(report)).toBeDefined();
          const rejections = measuredRejections.filter(rejection => rejection.peer === id);
          expect(rejections.length, JSON.stringify(report)).toBeLessThanOrEqual(maximumTransientTicks);
          for (const rejection of rejections) {
            expect(rejection.reason).toBe("expired");
            expect(rejection.at).toBeGreaterThanOrEqual(4000);
            expect(rejection.at).toBeLessThanOrEqual(5000);
            expect(rejection.at).toBeLessThan(observed!);
          }
        }
      }
      if(!scenario.stall) expect(resyncAfterWarmup,JSON.stringify(report)).toBe(0);
      if(!scenario.stall && scenario.name !== "route-change") expect(clients.reduce((sum,client)=>sum+client.diagnostics.expiredEdges,0),JSON.stringify(report)).toBe(0);
      expect(resync, JSON.stringify(report)).toBeLessThanOrEqual(authority.capacity);
    }, 30000);
