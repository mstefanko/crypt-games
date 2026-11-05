import { COURT } from "../sim/spec";
export { aimHeading } from "./rules";
/** Registered to arena-empty.png, resized from 1536×1024 to 640×400.
 * Far floor corners (292,338)/(1243,338), near (108,781)/(1430,781).
 * Physics stays rectangular; only presentation uses this mild trapezoid. */
export const VIEW = {
  width: 640,
  height: 400,
  originX: 320.25,
  originY: 218.5,
  farY: 132,
  nearY: 305,
  farLeft: 122,
  farRight: 518,
  nearLeft: 45,
  nearRight: 596,
} as const;
export function projectCourt(u: number, v: number) {
  const t = (v + COURT.halfWidth) / (2 * COURT.halfWidth);
  const left = VIEW.farLeft + t * (VIEW.nearLeft - VIEW.farLeft);
  const right = VIEW.farRight + t * (VIEW.nearRight - VIEW.farRight);
  return {
    x: left + ((u + COURT.halfLength) / (2 * COURT.halfLength)) * (right - left),
    y: VIEW.farY + t * (VIEW.nearY - VIEW.farY),
  };
}
export function unprojectCourt(x: number, y: number) {
  const t = (y - VIEW.farY) / (VIEW.nearY - VIEW.farY);
  const left = VIEW.farLeft + t * (VIEW.nearLeft - VIEW.farLeft);
  const right = VIEW.farRight + t * (VIEW.nearRight - VIEW.farRight);
  return {
    x: ((x - left) / (right - left)) * 2 * COURT.halfLength - COURT.halfLength,
    y: t * 2 * COURT.halfWidth - COURT.halfWidth,
  };
}
export function screenVectorToWorld(x: number, y: number) {
  const center = projectCourt(0, 0);
  const p = unprojectCourt(center.x + x, center.y + y);
  const n = Math.hypot(p.x, p.y);
  return n ? { x: p.x / n, y: p.y / n } : { x: 0, y: 0 };
}
