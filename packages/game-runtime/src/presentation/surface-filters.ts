import { Filter, GlProgram, UniformGroup } from "pixi.js";
// WebGL-only filters match the shell's explicit WebGL renderer. Small local instances,
// not a filter registry. Consumers: card editions and narrative/settlement water.
const vertex = `
in vec2 aPosition;
out vec2 vTextureCoord;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
void main() {
 vec2 p=aPosition*uOutputFrame.zw+uOutputFrame.xy;
 gl_Position=vec4(p.x*2.0/uOutputTexture.x-1.0,p.y*2.0*uOutputTexture.z/uOutputTexture.y-uOutputTexture.z,0.0,1.0);
 vTextureCoord=aPosition*uOutputFrame.zw*uInputSize.zw;
}`;
const foil = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;
uniform float uStrength;
uniform vec2 uPointer;
void main() {
 vec4 c=texture(uTexture,vTextureCoord);
 float band=pow(max(0.0,sin(vTextureCoord.x*11.0+vTextureCoord.y*7.0+uTime*.65+uPointer.x*2.0)),12.0);
 vec3 rainbow=.5+.5*cos(vec3(0.0,2.1,4.2)+vTextureCoord.x*5.0+vTextureCoord.y*3.0+uPointer.y);
 finalColor=vec4(c.rgb+rainbow*band*uStrength*c.a,c.a);
}`;
const water = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform vec4 uInputClamp;
uniform float uTime;
uniform float uStrength;
uniform vec2 uPointer;
void main() {
 vec2 uv=vTextureCoord;
 uv.x+=sin(uv.y*64.0+uTime*.8)*.002*uStrength;
 uv.y+=cos(uv.x*49.0-uTime*.6)*.001*uStrength;
 vec4 c=texture(uTexture,clamp(uv,uInputClamp.xy,uInputClamp.zw));
 float ripple=pow(max(0.0,sin(vTextureCoord.y*150.0+uTime)),16.0)*.025*uStrength;
 finalColor=vec4(c.rgb+vec3(.5,.7,.8)*ripple*c.a,c.a);
}`;
class SurfaceFilter extends Filter {
  constructor(fragment: string, strength: number, name: string) {
    super({
      glProgram: GlProgram.from({ vertex, fragment, name }),
      resources: {
        surfaceUniforms: new UniformGroup({
          uTime: { value: 0, type: "f32" },
          uStrength: { value: strength, type: "f32" },
          uPointer: { value: new Float32Array([0, 0]), type: "vec2<f32>" },
        }),
      },
    });
  }
  update(time: number, pointerX = 0, pointerY = 0, reducedMotion = false) {
    const u = this.resources.surfaceUniforms.uniforms;
    u.uTime = reducedMotion ? 0 : time;
    u.uPointer[0] = Math.max(-1, Math.min(1, pointerX));
    u.uPointer[1] = Math.max(-1, Math.min(1, pointerY));
  }
}
export class CardFoilFilter extends SurfaceFilter {
  constructor(strength = 0.16) {
    super(foil, strength, "card-foil");
  }
}
export class WaterFlowFilter extends SurfaceFilter {
  constructor(strength = 1) {
    super(water, strength, "water-flow");
  }
}
