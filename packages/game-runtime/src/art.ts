import { BitmapFont, Cache, Rectangle, Texture } from "pixi.js";

// Original MIT-licensed 3×5 glyphs and pixel sprites, drawn from bundled data.
const glyphs: Record<string, string> = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "101111111111101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101111011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "110001010100111",
  "3": "110001010001110",
  "4": "101101111001001",
  "5": "111100110001110",
  "6": "011100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001110",
  ":": "000010000010000",
  "/": "001001010100100",
  "-": "000000111000000",
  " ": "000000000000000",
  ".": "000000000000010",
  "!": "010010010000010",
};
let fontSerial = 0;
export function makeArt() {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 16;
  const context = canvas.getContext("2d")!;
  const pixel = (x: number, y: number, w: number, h: number, c: string) => {
    context.fillStyle = c;
    context.fillRect(x, y, w, h);
  };
  pixel(0, 0, 16, 16, "#233749");
  pixel(0, 0, 16, 3, "#72b7a2");
  pixel(1, 4, 14, 1, "#385769");
  pixel(2, 8, 4, 2, "#30485b");
  pixel(10, 12, 4, 2, "#30485b");
  pixel(16, 0, 16, 4, "#f4c778");
  pixel(17, 4, 14, 2, "#9b6d59");
  for (let i = 0; i < 2; i += 1) {
    const x = 32 + i * 16;
    const color = i === 0 ? "#61e7d8" : "#ff8b85";
    pixel(x + 5, 1, 7, 5, color);
    pixel(x + 3, 6, 11, 6, color);
    pixel(x + 4, 12, 4, 4, "#ccd8e2");
    pixel(x + 10, 12, 3, 4, "#ccd8e2");
    pixel(x + 9, 2, 2, 2, "#10212e");
    pixel(x + 2, 7, 3, 5, "#f7d997");
  }
  pixel(65, 0, 13, 16, "#304c57");
  pixel(67, 2, 9, 14, "#83e3b1");
  pixel(69, 4, 5, 12, "#d7f9bb");
  pixel(80, 0, 16, 5, "#9c9af0");
  pixel(81, 5, 14, 3, "#535a91");
  const atlas = Texture.from(canvas);
  atlas.source.scaleMode = "nearest";
  const frames = Array.from(
    { length: 6 },
    (_, i) =>
      new Texture({
        source: atlas.source,
        frame: new Rectangle(i * 16, 0, 16, 16),
      }),
  );
  const fontCanvas = document.createElement("canvas");
  fontCanvas.width = Object.keys(glyphs).length * 4;
  fontCanvas.height = 6;
  const fontContext = fontCanvas.getContext("2d")!;
  fontContext.fillStyle = "#ffffff";
  const chars: ConstructorParameters<typeof BitmapFont>[0]["data"]["chars"] =
    {};
  Object.entries(glyphs).forEach(([letter, bits], index) => {
    for (let bit = 0; bit < bits.length; bit += 1)
      if (bits[bit] === "1")
        fontContext.fillRect(index * 4 + (bit % 3), Math.floor(bit / 3), 1, 1);
    chars[letter] = {
      id: letter.charCodeAt(0),
      letter,
      page: 0,
      x: index * 4,
      y: 0,
      width: 3,
      height: 5,
      xOffset: 0,
      yOffset: 0,
      xAdvance: 4,
      kerning: {},
    };
  });
  const fontTexture = Texture.from(fontCanvas);
  fontTexture.source.scaleMode = "nearest";
  const fontName = `PocketPixel${fontSerial++}`;
  const font = new BitmapFont({
    textures: [fontTexture],
    data: {
      pages: [{ id: 0, file: "bundled-original-glyphs" }],
      chars,
      fontSize: 5,
      lineHeight: 7,
      baseLineOffset: 0,
      fontFamily: fontName,
    },
  });
  Cache.set(`${fontName}-bitmap`, font);
  return {
    frames,
    fontName,
    dispose() {
      Cache.remove(`${fontName}-bitmap`);
      font.destroy();
      for (const frame of frames) frame.destroy();
      atlas.destroy(true);
    },
  };
}
