export interface DamageBody {
  id: string;
  hp: number;
  maxHp: number;
}
/** Health authority; a destroyed body emits exactly one terminal edge. */
export class DamageOwner {
  private bodies: DamageBody[];
  constructor(bodies: readonly DamageBody[]) {
    if (
      new Set(bodies.map((b) => b.id)).size !== bodies.length ||
      bodies.some(
        (b) =>
          !b.id ||
          !Number.isFinite(b.maxHp) ||
          b.maxHp <= 0 ||
          !Number.isFinite(b.hp) ||
          b.hp < 0 ||
          b.hp > b.maxHp,
      )
    )
      throw Error("Invalid health bodies");
    this.bodies = bodies.map((b) => ({ ...b }));
  }
  damage(id: string, amount: number): { applied: number; destroyed: boolean } {
    if (!Number.isFinite(amount) || amount < 0) throw Error("Invalid damage");
    const b = this.findBody(id),
      before = b.hp;
    b.hp = Math.max(0, b.hp - amount);
    return { applied: before - b.hp, destroyed: before > 0 && b.hp === 0 };
  }
  repair(id: string, amount: number): number {
    if (!Number.isFinite(amount) || amount < 0) throw Error("Invalid repair");
    const b = this.findBody(id);
    if (b.hp === 0) return 0;
    const before = b.hp;
    b.hp = Math.min(b.maxHp, b.hp + amount);
    return b.hp - before;
  }
  get(id: string): DamageBody {
    return { ...this.findBody(id) };
  }
  capture(): DamageBody[] {
    return this.bodies.map((b) => ({ ...b }));
  }
  private findBody(id: string): DamageBody {
    const b = this.bodies.find((b) => b.id === id);
    if (!b) throw Error("Unknown health body");
    return b;
  }
}
