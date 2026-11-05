/** Bounded, device-free physical bindings. Semantic pulses are supplied separately. */
export type ActionBinding<A extends string = string> = {
  code: string;
  action: A;
  slot?: number;
};
export class ActionMap<A extends string = string> {
  private readonly bindings: readonly ActionBinding<A>[];
  constructor(bindings: readonly ActionBinding<A>[]) {
    if (
      bindings.length > 256 ||
      bindings.some(
        (b) =>
          typeof b.code !== "string" ||
          !b.code ||
          b.code.length > 128 ||
          typeof b.action !== "string" ||
          !b.action ||
          b.action.length > 128 ||
          !Number.isInteger(b.slot ?? 0) ||
          (b.slot ?? 0) < 0 ||
          (b.slot ?? 0) > 15,
      )
    )
      throw new Error("Invalid action bindings");
    this.bindings = bindings.map((b) => ({ ...b }));
  }
  lookup(code: string): readonly ActionBinding<A>[] {
    return this.bindings.filter((b) => b.code === code).map((b) => ({ ...b }));
  }
  /** Snapshot projection preserves supplied edges, including rapid taps. It cannot
   * recover transition order or suppress alias edges without source history; use
   * InputQueue for ordered, aggregated transitions. Pulses never become held. */
  project(
    input: {
      held: ReadonlySet<string>;
      pressed: ReadonlySet<string>;
      released?: ReadonlySet<string>;
    },
    pulses: readonly A[] = [],
  ) {
    const held = new Set<A>(),
      pressed = new Set<A>(pulses),
      released = new Set<A>();
    for (const b of this.bindings) {
      if (input.held.has(b.code)) held.add(b.action);
      if (input.pressed.has(b.code)) pressed.add(b.action);
      if (input.released?.has(b.code)) released.add(b.action);
    }
    return { held, pressed, released };
  }
}

/** The platform host's cancel-until-release policy, independent of bindings. */
export class HeldKeyState {
  readonly down = new Set<string>();
  private blocked = new Set<string>();
  press(code: string): boolean {
    if (this.down.has(code) || this.blocked.has(code)) return false;
    this.down.add(code);
    return true;
  }
  release(code: string): boolean {
    this.blocked.delete(code);
    return this.down.delete(code);
  }
  cancel(): void {
    for (const code of this.down) this.blocked.add(code);
    this.down.clear();
  }
  suppress(code: string): void {
    this.blocked.add(code);
  }
}
