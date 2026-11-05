/** Declarative vector icons and a low-contrast felt surface, card-genre consumer. */
import {
  Container,
  Graphics,
  Text,
  Filter,
  GlProgram,
  UniformGroup,
} from "pixi.js";
export type CardIconPrimitive =
  | {
      kind: "circle";
      x: number;
      y: number;
      radius: number;
      fill?: number;
      stroke?: number;
      width?: number;
    }
  | {
      kind: "rect";
      x: number;
      y: number;
      width: number;
      height: number;
      fill?: number;
      stroke?: number;
      radius?: number;
    }
  | {
      kind: "path";
      points: number[];
      stroke: number;
      width?: number;
      closed?: boolean;
      fill?: number;
    }
  | {
      kind: "text";
      text: string;
      x: number;
      y: number;
      size: number;
      color: number;
    };
export interface CardVectorIcon {
  label: string;
  color: number;
  primitives: readonly CardIconPrimitive[];
}
export interface CardTableArtwork {
  /** Semantic atlas layers; rank/suit remain readable glyphs over the face family. */
  cards?: {
    face: string;
    back: string;
    faces?: Record<string, string>;
    border?: string;
    editions?: Record<string, string>;
  };
  modifiers?: Record<string, string>;
  states?: { selected: number; focus: number; disabledAlpha: number };
  guide?: readonly string[];
  consumables: Record<string, CardVectorIcon>;
  bosses: Record<string, CardVectorIcon>;
  felt: { base: number; edge: number; thread: number };
}
export function vectorCardIcon(definition: CardVectorIcon): Container {
  const root = new Container();
  root.addChild(
    new Graphics()
      .roundRect(-28, -28, 56, 56, 12)
      .fill(definition.color)
      .stroke({ color: 0xd2bd8f, width: 1.5 }),
  );
  for (const p of definition.primitives) {
    if (p.kind === "text") {
      const text = new Text({
        text: p.text,
        style: { fontFamily: "Georgia", fontSize: p.size, fill: p.color },
      });
      text.anchor.set(0.5);
      text.position.set(p.x, p.y);
      root.addChild(text);
      continue;
    }
    const g = new Graphics();
    if (p.kind === "circle") g.circle(p.x, p.y, p.radius);
    else if (p.kind === "rect")
      g.roundRect(p.x, p.y, p.width, p.height, p.radius ?? 0);
    else {
      if (p.points.length < 4) continue;
      g.moveTo(p.points[0], p.points[1]);
      for (let i = 2; i < p.points.length; i += 2)
        g.lineTo(p.points[i], p.points[i + 1]);
      if (p.closed) g.closePath();
    }
    if (p.fill !== undefined) g.fill(p.fill);
    if (p.stroke !== undefined)
      g.stroke({
        color: p.stroke,
        width: p.kind === "rect" ? 2 : (p.width ?? 2),
      });
    root.addChild(g);
  }
  return root;
}
const vertex = `in vec2 aPosition;out vec2 vTextureCoord;uniform vec4 uInputSize;uniform vec4 uOutputFrame;uniform vec4 uOutputTexture;void main(){vec2 p=aPosition*uOutputFrame.zw+uOutputFrame.xy;gl_Position=vec4(p.x*2.0/uOutputTexture.x-1.0,p.y*2.0*uOutputTexture.z/uOutputTexture.y-uOutputTexture.z,0.,1.);vTextureCoord=aPosition*uOutputFrame.zw*uInputSize.zw;}`;
const fragment = `in vec2 vTextureCoord;out vec4 finalColor;uniform sampler2D uTexture;uniform float uTime;void main(){vec4 c=texture(uTexture,vTextureCoord);vec2 p=vTextureCoord*vec2(1244.,684.);float grain=fract(sin(dot(floor(p),vec2(12.9898,78.233)))*43758.5453);float weave=sin(p.x*3.14159)*sin(p.y*3.14159);float ink=sin(vTextureCoord.x*17.+sin(vTextureCoord.y*13.+uTime*.035))*.008;float vignette=1.-.16*length((vTextureCoord-.5)*1.3);finalColor=vec4(c.rgb*vignette+(grain-.5)*.025+weave*.007+ink,c.a);}`;
export class CardFeltFilter extends Filter {
  constructor() {
    super({
      glProgram: GlProgram.from({ vertex, fragment, name: "card-felt-ink" }),
      resources: {
        feltUniforms: new UniformGroup({ uTime: { value: 0, type: "f32" } }),
      },
    });
  }
  update(time: number) {
    this.resources.feltUniforms.uniforms.uTime = time;
  }
}
