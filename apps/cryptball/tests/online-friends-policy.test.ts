import { afterEach, expect, it } from "vitest";
import { canCreateCourt } from "../../cryptball-server/src/friends";
import { service } from "../../cryptball-server/src/room";
afterEach(() => {
  service.rooms.clear();
  service.draining = false;
  service.overloaded = false;
});
function rooms(publicCount: number, friendsCount: number) {
  for (let i = 0; i < publicCount; i++)
    service.rooms.add({ groupKey: undefined } as never);
  for (let i = 0; i < friendsCount; i++)
    service.rooms.add({ groupKey: "private-group" } as never);
}
it("reserves ten public simulations while letting public games borrow unused friends capacity", () => {
  rooms(0, 15);
  expect(canCreateCourt(true)).toBe(false);
  expect(canCreateCourt(false)).toBe(true);
  service.rooms.clear();
  rooms(24, 0);
  expect(canCreateCourt(false)).toBe(true);
  rooms(1, 0);
  expect(canCreateCourt(false)).toBe(false);
  expect(canCreateCourt(true)).toBe(false);
});
it("refuses new simulations under overload or drain", () => {
  service.overloaded = true;
  expect(canCreateCourt(true)).toBe(false);
  expect(canCreateCourt(false)).toBe(false);
  service.overloaded = false;
  service.draining = true;
  expect(canCreateCourt(true)).toBe(false);
});
