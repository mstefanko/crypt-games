/** A deliberately small fictional calendar: twelve 30-day months. */
export interface CalendarDate {
  readonly dayIndex: number;
}
export function calendarDate(
  year: number,
  month: number,
  day: number,
): CalendarDate {
  if (
    ![year, month, day].every(Number.isInteger) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 30
  )
    throw Error("Invalid calendar date");
  return { dayIndex: year * 360 + (month - 1) * 30 + day - 1 };
}
export function formatCalendarDate(date: CalendarDate): string {
  const n = date.dayIndex;
  return `${String((n % 30) + 1).padStart(2, "0")}.${String((Math.floor(n / 30) % 12) + 1).padStart(2, "0")}.${Math.floor(n / 360)}`;
}
export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  return Math.sign(a.dayIndex - b.dayIndex);
}
export type EvidenceValue = string | number | CalendarDate;
export interface EvidenceField {
  id: string;
  label: string;
  value: EvidenceValue;
}
export interface DocumentRule {
  id: string;
  text: string;
  fields: readonly string[];
  check: (fields: ReadonlyMap<string, EvidenceValue>) => boolean;
}
export interface RuleViolation {
  ruleId: string;
  fields: readonly string[];
  explanation: string;
}
export function evaluateDocumentRules(
  fields: readonly EvidenceField[],
  rules: readonly DocumentRule[],
): RuleViolation[] {
  const map = new Map(fields.map((field) => [field.id, field.value]));
  return rules
    .filter((rule) => !rule.check(map))
    .map((rule) => ({
      ruleId: rule.id,
      fields: [...rule.fields],
      explanation: rule.text,
    }));
}
export interface DocumentCaseState {
  id: string;
  phase: "open" | "stamped" | "returned";
  decision: "admit" | "refuse" | null;
}
/** The return transition is the sole commit point; duplicate stamps/returns are inert. */
export function stampDocumentCase(
  state: DocumentCaseState,
  decision: "admit" | "refuse",
): boolean {
  if (state.phase !== "open") return false;
  state.phase = "stamped";
  state.decision = decision;
  return true;
}
export function returnDocumentCase(
  state: DocumentCaseState,
  commit: (decision: "admit" | "refuse") => void,
): boolean {
  if (state.phase !== "stamped" || !state.decision) return false;
  commit(state.decision);
  state.phase = "returned";
  return true;
}
