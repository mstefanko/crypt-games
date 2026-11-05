import type { SettlementSession } from "@onepage/game-simulation/settlement-session";

/** Bind observed owner actions to visual poses; poses never advance jobs or needs. */
export function settlementCitizenVisual(
  person: Pick<
    SettlementSession["state"]["people"][number],
    "queue" | "cargo" | "cold" | "work"
  >,
) {
  const action = person.queue[0];
  const loaded = Object.values(person.cargo).some((amount) => amount > 0);
  const moving = action?.kind === "move";
  return {
    mode: moving
      ? loaded
        ? "carry"
        : "walk"
      : action?.kind === "work"
        ? "work"
        : person.cold > 30
          ? "cold"
          : "idle",
    phase: action?.kind ?? "decision",
    loaded,
    route: moving
      ? action.path?.length
        ? "following"
        : action.request !== undefined
          ? "searching"
          : "waiting"
      : "none",
  } as const;
}

/** Player-facing quantities; underlying resource keys remain an owner concern. */
export function formatSettlementResources(
  resources: Readonly<Record<string, number>>,
): string {
  const names: Record<string, string> = {
    food: "food",
    logs: "logs",
    stone: "stone",
    firewood: "firewood",
  };
  return (
    Object.entries(resources)
      .filter(([, amount]) => amount > 0)
      .map(
        ([resource, amount]) =>
          `${amount.toLocaleString("en-US")} ${names[resource] ?? resource.replace(/[_-]/g, " ")}`,
      )
      .join(" · ") || "empty"
  );
}
