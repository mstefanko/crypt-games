export interface PresentedActor {
  id: number;
  x: number;
  y: number;
  motionEpoch: number;
}
export function interpolatePosition(
  previous: PresentedActor | undefined,
  current: PresentedActor,
  alpha: number,
  previousViewEpoch: number,
  viewEpoch: number,
): { x: number; y: number } {
  if (
    !previous ||
    previous.id !== current.id ||
    previous.motionEpoch !== current.motionEpoch ||
    previousViewEpoch !== viewEpoch
  )
    return { x: current.x, y: current.y };
  return {
    x: previous.x + (current.x - previous.x) * alpha,
    y: previous.y + (current.y - previous.y) * alpha,
  };
}
