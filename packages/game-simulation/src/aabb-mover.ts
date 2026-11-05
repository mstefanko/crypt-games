import type { OpenAabb } from './aabb-kernel';
export interface MoverCollider extends OpenAabb { readonly id: string }
/** Provisional face-crossing kernel, shared by platform and m3 adapters.
 * Coordinates/displacements are safe integers with absolute magnitude <=2^30;
 * positive dimensions <=2^30; at most 4096 queried candidates per axis. No
 * depenetration: an initially penetrating obstacle does not block escape.
 * Touching endpoints count as contacts; parallel edge/corner contact does not.
 * Zero displacement reports both touching axis faces (strict overlap on the
 * perpendicular axis), with no penetration contacts.
 * Stable lexical IDs order equal-distance contacts. No owner state is mutated.
 * Adapters own candidate enumeration, one-way eligibility, support/carry,
 * boundaries and vector-norm caps. X must be resolved/committed before Y.
 * `limit` is an already bounded displacement (e.g. world-edge clamp).
 * Query and rejection are synchronous, with no hidden state/checkpoint data. */
export function resolveAabbAxis<T extends MoverCollider>(
  body: OpenAabb, requested: number, axis: 'x' | 'y',
  query: () => readonly T[], eligible: (candidate: T) => boolean = () => true,
  limit = requested,
): { displacement: number; blocked: boolean; contacts: readonly T[]; tested: number } {
  const valid = (n: number) => Number.isSafeInteger(n) && Math.abs(n) <= 2 ** 30;
  if (!["x", "y"].includes(axis) || ![body.x, body.y, body.width, body.height, requested, limit].every(valid) ||
    body.width <= 0 || body.height <= 0 || Math.abs(limit) > Math.abs(requested) ||
    (limit !== 0 && Math.sign(limit) !== Math.sign(requested))) throw Error('Invalid AABB movement');
  const candidates = query();
  if (candidates.length > 4096) throw Error('AABB candidate budget exceeded');
  const ids = new Set<string>();
  for (const c of candidates) {
    if (typeof c.id !== "string" || !c.id || ids.has(c.id) || ![c.x,c.y,c.width,c.height].every(valid) || c.width <= 0 || c.height <= 0)
      throw Error('Invalid AABB candidate');
    ids.add(c.id);
  }
  let displacement = limit;
  let contacts: T[] = [];
  const side = axis === 'x' ? 'y' : 'x';
  const size = axis === 'x' ? 'width' : 'height';
  const sideSize = axis === 'x' ? 'height' : 'width';
  for (const c of candidates) {
    if (!eligible(c) || body[side] >= c[side] + c[sideSize] || body[side] + body[sideSize] <= c[side]) continue;
    if (requested === 0) {
      if (body[axis] + body[size] === c[axis] || body[axis] === c[axis] + c[size]) contacts.push(c);
      continue;
    }
    let distance: number;
    if (requested > 0 && body[axis] + body[size] <= c[axis]) distance = c[axis] - body[axis] - body[size];
    else if (requested < 0 && body[axis] >= c[axis] + c[size]) distance = c[axis] + c[size] - body[axis];
    else continue;
    if (requested >= 0 ? distance > displacement : distance < displacement) continue;
    if (distance !== displacement) contacts = [];
    displacement = distance;
    contacts.push(c);
  }
  contacts.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { displacement, blocked: displacement !== requested, contacts, tested: candidates.length };
}
