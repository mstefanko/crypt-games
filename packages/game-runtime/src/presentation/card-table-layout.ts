/** Pure row constraints shared by rendering and inverse drag picking. */
export function cardRowLayout(
  count: number,
  width: number,
  cardWidth: number,
  preferredGap: number,
) {
  const span = Math.max(0, width - cardWidth);
  const gap = count > 1 ? Math.min(preferredGap, span / (count - 1)) : 0;
  return {
    gap,
    x: (index: number) => width / 2 + (index - (count - 1) / 2) * gap,
    index: (x: number) =>
      Math.max(
        0,
        Math.min(
          count - 1,
          gap ? Math.round((x - width / 2) / gap + (count - 1) / 2) : 0,
        ),
      ),
  };
}
/** Cancel drops without interpreting pointer release as a command. */
export class CardDragController {
  private active?: { id: string; x: number; y: number; moved: boolean };
  begin(id: string, x: number, y: number): void {
    this.active = { id, x, y, moved: false };
  }
  move(id: string, x: number, y: number): boolean {
    if (this.active?.id !== id) return false;
    this.active.moved ||= Math.hypot(x - this.active.x, y - this.active.y) > 12;
    return this.active.moved;
  }
  release(id: string): "tap" | "drop" | undefined {
    if (this.active?.id !== id) return;
    const result = this.active.moved ? "drop" : "tap";
    this.cancel();
    return result;
  }
  cancel(): void {
    this.active = undefined;
  }
}
