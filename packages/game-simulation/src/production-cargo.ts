/** Consumers: legacy Harbor production and live settlement deliveries.
 * Acceptance is checked before reducing physical carried stock. */
export function commitCargoDelivery(
  cargo: Record<string, number>,
  resource: string,
  quantity: number,
  accept: (resource: string, quantity: number) => boolean,
): boolean {
  if (
    !Number.isInteger(quantity) ||
    quantity <= 0 ||
    (cargo[resource] ?? 0) < quantity
  )
    return false;
  if (!accept(resource, quantity)) return false;
  cargo[resource] = (cargo[resource] ?? 0) - quantity;
  return true;
}
