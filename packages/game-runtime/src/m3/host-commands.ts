/** The production host's reward boundary, shared with development replay. */
export function rewardSlot(revision: number): string {
  return `reward:${revision}`;
}
export function acceptsRewardBoundary(
  command: { epoch: number; slot: string; kind: "complete" | "skip" },
  current: { epoch: number; ending: boolean; revision: number },
): boolean {
  return (
    command.epoch === current.epoch &&
    current.ending &&
    command.slot === rewardSlot(current.revision)
  );
}
