import type { TextRect } from "./text-layout";
export interface DeskObject extends TextRect {
  id: string;
  fields?: readonly (TextRect & { id: string })[];
}
export function containsPoint(rect: TextRect, x: number, y: number): boolean {
  return (
    x >= rect.x &&
    y >= rect.y &&
    x < rect.x + rect.width &&
    y < rect.y + rect.height
  );
}
/** Ordered document ownership, with a single captured drag. Coordinates are logical pixels. */
export class DeskInteraction {
  objects: DeskObject[] = [];
  focus: string | null = null;
  private drag: { id: string; dx: number; dy: number } | null = null;
  hit(x: number, y: number): DeskObject | undefined {
    return [...this.objects]
      .reverse()
      .find((object) => containsPoint(object, x, y));
  }
  begin(x: number, y: number): DeskObject | undefined {
    const object = this.hit(x, y);
    if (!object) return;
    this.focus = object.id;
    this.objects = this.objects.filter((o) => o !== object);
    this.objects.push(object);
    this.drag = { id: object.id, dx: x - object.x, dy: y - object.y };
    return object;
  }
  move(x: number, y: number, bounds: TextRect): void {
    const object = this.objects.find((o) => o.id === this.drag?.id);
    if (!object || !this.drag) return;
    object.x = Math.max(
      bounds.x,
      Math.min(bounds.x + bounds.width - object.width, x - this.drag.dx),
    );
    object.y = Math.max(
      bounds.y,
      Math.min(bounds.y + bounds.height - object.height, y - this.drag.dy),
    );
  }
  end(
    x: number,
    y: number,
    regions: readonly (TextRect & { id: string })[] = [],
  ): string | undefined {
    if (!this.drag) return;
    this.drag = null;
    return regions.find((region) => containsPoint(region, x, y))?.id;
  }
  cancel(): void {
    this.drag = null;
  }
  get dragging(): boolean {
    return this.drag !== null;
  }
  capture(): { objects: DeskObject[]; focus: string | null } {
    return structuredClone({ objects: this.objects, focus: this.focus });
  }
  restore(value: { objects: DeskObject[]; focus: string | null }): void {
    this.objects = structuredClone(value.objects);
    this.focus = value.focus;
    this.cancel();
  }
}
