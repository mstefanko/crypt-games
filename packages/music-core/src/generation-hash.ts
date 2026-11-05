/** Bounded synchronous SHA-256, adapted from the repository's existing M5
 * portable hash. Only this reviewed helper admits bitwise operations; callers
 * pass exact canonical UTF-8 bytes rather than host crypto or async callbacks. */
export function sha256Content(source: string): string {
  if (typeof source !== "string" || source.length > 262144)
    throw Error("SHA-256 source cap");
  const values: number[] = [];
  for (let i = 0; i < source.length; i++) {
    let point = source.codePointAt(i)!;
    if (point > 65535) i++;
    else if (point >= 55296 && point <= 57343) point = 65533;
    if (point < 128) values.push(point);
    else if (point < 2048)
      values.push(192 + Math.floor(point / 64), 128 + (point % 64));
    else if (point < 65536)
      values.push(
        224 + Math.floor(point / 4096),
        128 + (Math.floor(point / 64) % 64),
        128 + (point % 64),
      );
    else
      values.push(
        240 + Math.floor(point / 262144),
        128 + (Math.floor(point / 4096) % 64),
        128 + (Math.floor(point / 64) % 64),
        128 + (point % 64),
      );
    if (values.length > 262144) throw Error("SHA-256 UTF-8 byte cap");
  }
  const bytes = new Uint8Array(values);

  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ];
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 128;
  new DataView(padded.buffer).setUint32(padded.length - 4, bytes.length * 8);
  const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const words = new Uint32Array(64),
    view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15],
        b = words[i - 2];
      words[i] =
        words[i - 16] +
        (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) +
        words[i - 7] +
        (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, j] = h;
    for (let i = 0; i < 64; i++) {
      const first =
        (j +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          k[i] +
          words[i]) |
        0;
      const second =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
          ((a & b) ^ (a & c) ^ (b & c))) |
        0;
      j = g;
      g = f;
      f = e;
      e = (d + first) | 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) | 0;
    }
    for (const [i, value] of [a, b, c, d, e, f, g, j].entries())
      h[i] = (h[i] + value) >>> 0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}
