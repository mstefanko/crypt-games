/** Shared logical bounds for rendering and picking.
 * Migration: wrapText, fitText, labeledFieldRows and LabeledTextRow were removed.
 * Keep Canvas-specific helpers in the caller; TextRect and this subpath remain.
 * See docs/engine-gap-g4-adoption.md for the public-export compatibility decision. */
export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
