import {
  TransactionOwner,
  type TransactionCheckpoint,
  type TransactionOperation,
} from "./transactions";

export const MANAGEMENT_DOCUMENTS = Object.freeze([
  Object.freeze({
    id: "ada",
    name: "Ada Vale",
    passportName: "Ada Vale",
    passportValid: true,
    permit: false,
  }),
  Object.freeze({
    id: "bo",
    name: "Bo Reed",
    passportName: "Bea Reed",
    passportValid: true,
    permit: true,
  }),
  Object.freeze({
    id: "cy",
    name: "Cy Moss",
    passportName: "Cy Moss",
    passportValid: false,
    permit: true,
  }),
]);
export type ManagementAction =
  | {
      readonly kind: "decide";
      readonly documentId: string;
      readonly decision: "accept" | "reject";
    }
  | { readonly kind: "settle" | "next-day" };
export interface ManagementCommand {
  readonly id: string;
  readonly revision: number;
  readonly action: ManagementAction;
}
export interface ManagementSave {
  readonly format: "management-desk-v1";
  readonly commands: readonly ManagementCommand[];
  readonly day: number;
  readonly settled: boolean;
  readonly decisions: readonly {
    documentId: string;
    decision: "accept" | "reject";
    correct: boolean;
  }[];
  readonly pendingAudit: number;
  readonly ledger: TransactionCheckpoint;
}
const definition = {
  id: "management-desk-v1",
  resources: [{ id: "credits", initial: 20, capacity: 100 }],
  stats: [],
  flags: ["audit-completed", "day-two"],
  rewardSeed: 1,
  outcomes: [
    "day-1",
    "day-2",
    ...[1, 2].flatMap((day) =>
      MANAGEMENT_DOCUMENTS.map((d) => `day-${day}-${d.id}`),
    ),
  ],
};
// Bound and reject exotic objects/accessors before replay or serialization. Never invoke getters.
function plain(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 12000 || depth > 14) throw Error("Desk save work limit");
  if (value === null || typeof value === "boolean") return value;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
  )
    return value;
  if (typeof value === "string" && value.length <= 96) return value;
  if (!value || typeof value !== "object")
    throw Error("Desk plain data required");
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
    (array ? Array.prototype : Object.prototype)
  )
    throw Error("Desk plain data required");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length > 65 ||
    (array &&
      (keys.length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, i) => String(i)).some(
          (key) => !Object.hasOwn(value, key),
        )))
  )
    throw Error("Desk collection limit");
  const result: Record<string, unknown> = {};
  const entries: unknown[] = [];
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string" || key.length > 96 || key === "__proto__")
      throw Error("Desk invalid key");
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
      throw Error("Desk accessor or hidden field rejected");
    const item = plain(descriptor.value, depth + 1, budget);
    if (array) entries.push(item);
    else result[key] = item;
  }
  return array
    ? entries
    : Object.fromEntries(
        Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      );
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(value, k))
  )
    throw Error("Invalid desk fields");
  return value as Record<string, unknown>;
}
function command(value: unknown): ManagementCommand {
  const c = fields(plain(value), ["id", "revision", "action"]);
  if (
    typeof c.id !== "string" ||
    !/^[a-z][a-z0-9.-]{0,63}$/.test(c.id) ||
    typeof c.revision !== "number" ||
    c.revision < 0 ||
    c.revision > 9
  )
    throw Error("Invalid desk command");
  const kind = (c.action as Record<string, unknown> | null)?.kind;
  if (kind === "decide") {
    const a = fields(c.action, ["kind", "documentId", "decision"]);
    if (
      !MANAGEMENT_DOCUMENTS.some((d) => d.id === a.documentId) ||
      (a.decision !== "accept" && a.decision !== "reject")
    )
      throw Error("Invalid document decision");
    return {
      id: c.id,
      revision: c.revision,
      action: {
        kind,
        documentId: a.documentId as string,
        decision: a.decision,
      },
    };
  }
  if (kind !== "settle" && kind !== "next-day")
    throw Error("Unknown desk action");
  fields(c.action, ["kind"]);
  return { id: c.id, revision: c.revision, action: { kind } };
}
const exact = (v: unknown) => JSON.stringify(plain(v));

/** Two authored days, three applications per day. The ledger owns all monetary commits. */
export class ManagementSession {
  private ledger = new TransactionOwner(definition);
  private commands: ManagementCommand[] = [];
  private day = 1;
  private settled = false;
  private decisions: {
    documentId: string;
    decision: "accept" | "reject";
    correct: boolean;
  }[] = [];
  private pendingAudit = 0;
  execute(value: ManagementCommand): void {
    const c = command(value);
    const previous = this.commands.find((p) => p.id === c.id);
    if (previous) {
      if (exact(previous) !== exact(c)) throw Error("Conflicting desk retry");
      return;
    }
    if (c.revision !== this.commands.length || this.commands.length >= 9)
      throw Error("Stale or exhausted desk command");
    let operations: TransactionOperation[];
    let outcome: string | null = null;
    const a = c.action;
    let correct = false;
    if (a.kind === "decide") {
      if (
        this.settled ||
        this.decisions.some((d) => d.documentId === a.documentId)
      )
        throw Error("Document already decided or day closed");
      const doc = MANAGEMENT_DOCUMENTS.find((d) => d.id === a.documentId)!;
      const eligible =
        doc.passportValid &&
        doc.name === doc.passportName &&
        (this.day === 1 || doc.permit);
      correct = (a.decision === "accept") === eligible;
      operations = [
        { kind: "grant", resource: "credits", amount: correct ? 4 : 1 },
      ];
      outcome = `day-${this.day}-${a.documentId}`;
    } else if (a.kind === "settle") {
      if (this.settled || this.decisions.length !== 3)
        throw Error("Decide all three documents before settlement");
      operations = [
        {
          kind: "consume",
          resource: "credits",
          amount: 8 + (this.day === 2 ? this.pendingAudit : 0),
        },
      ];
      if (this.day === 2)
        operations.push({ kind: "flag", flag: "audit-completed", value: true });
      outcome = `day-${this.day}`;
    } else {
      if (!this.settled || this.day !== 1) throw Error("No next day available");
      operations = [{ kind: "flag", flag: "day-two", value: true }];
    }
    this.ledger.execute({
      id: c.id,
      revision: c.revision,
      outcome,
      operations,
    });
    if (a.kind === "decide") {
      this.decisions.push({
        documentId: a.documentId,
        decision: a.decision,
        correct,
      });
      if (this.day === 1 && !correct) this.pendingAudit += 3;
    } else if (a.kind === "settle") this.settled = true;
    else {
      this.day = 2;
      this.settled = false;
      this.decisions = [];
    }
    this.commands.push(c);
  }
  observe() {
    const ledger = this.ledger.capture();
    return {
      day: this.day,
      revision: this.commands.length,
      settled: this.settled,
      complete: this.day === 2 && this.settled,
      rule:
        this.day === 1
          ? "Accept only valid passports whose name matches the application."
          : "Accept only valid matching passports WITH an entry permit.",
      credits: ledger.resources[0].quantity,
      expenses: 8,
      pendingAudit: this.pendingAudit,
      decisions: this.decisions.map((d) => ({ ...d })),
      auditCompleted: ledger.flags.find((f) => f.id === "audit-completed")!
        .value,
    };
  }
  save(): ManagementSave {
    return {
      format: "management-desk-v1",
      commands: this.commands.map((c) => ({ ...c, action: { ...c.action } })),
      day: this.day,
      settled: this.settled,
      decisions: this.decisions.map((d) => ({ ...d })),
      pendingAudit: this.pendingAudit,
      ledger: this.ledger.capture(),
    };
  }
  load(value: unknown): void {
    const normalized = plain(value);
    const s = fields(normalized, [
      "format",
      "commands",
      "day",
      "settled",
      "decisions",
      "pendingAudit",
      "ledger",
    ]);
    if (
      s.format !== "management-desk-v1" ||
      !Array.isArray(s.commands) ||
      s.commands.length > 9
    )
      throw Error("Incompatible desk save");
    const staged = new ManagementSession();
    for (const c of s.commands) staged.execute(command(c));
    if (
      staged.commands.length !== s.commands.length ||
      exact(staged.save()) !== JSON.stringify(normalized)
    )
      throw Error("Inconsistent desk save");
    this.ledger = staged.ledger;
    this.commands = staged.commands;
    this.day = staged.day;
    this.settled = staged.settled;
    this.decisions = staged.decisions;
    this.pendingAudit = staged.pendingAudit;
  }
}
