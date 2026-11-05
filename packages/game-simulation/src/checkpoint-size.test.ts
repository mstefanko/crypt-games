import { describe, expect, it } from "vitest";
import { canonical } from "@onepage/game-project/runtime";
import { checkpointSize } from "./checkpoint-size";

describe("trusted checkpoint canonical byte budget", () => {
  it("matches canonical UTF-8 for escapes, Unicode, surrogate pairs, keys and nested data", () => {
    const strings = [
      "",
      '\"\\',
      String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)),
      "é中😀",
      "\ud800",
      "\udfff",
      "a\ud800b\udfff",
      "\ud800\ud800\udc00",
    ];
    for (const value of [
      null,
      true,
      false,
      0,
      -0,
      1e21,
      -1e-7,
      [],
      {},
      ...strings,
      { [strings.join("")]: [false, 123, ...strings] },
    ]) {
      expect(checkpointSize(value)).toBe(
        Buffer.byteLength(canonical(value), "utf8"),
      );
    }
  });
  it("admits the exact byte limit and rejects one extra byte or non-JSON fields", () => {
    expect(checkpointSize("a".repeat(2097150))).toBe(2097152);
    expect(() => checkpointSize("a".repeat(2097151))).toThrow(/byte limit/);
    expect(() => checkpointSize({ unsupported: undefined })).toThrow(
      /JSON data/,
    );
    expect(() => checkpointSize([undefined])).toThrow(/JSON data/);
  });
});
