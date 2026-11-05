/** Own immutable data at session construction; never retain caller-owned definitions. */
export function snapshotDefinitions<T>(value: T): T {
  const snapshot = structuredClone(value);
  const freeze = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Object.isFrozen(node))
      return;
    for (const child of Object.values(node)) freeze(child);
    Object.freeze(node);
  };
  freeze(snapshot);
  return snapshot;
}
