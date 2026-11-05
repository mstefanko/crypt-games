import { createInspectionQueueRandom } from "./rng";
import {
  calendarDate,
  formatCalendarDate,
  compareCalendarDates,
  evaluateDocumentRules,
  returnDocumentCase,
  stampDocumentCase,
  type CalendarDate,
  type DocumentCaseState,
  type DocumentRule,
  type EvidenceField,
  type EvidenceValue,
} from "./document-rules";
import { TransactionOwner, type TransactionOperation } from "./transactions";
export interface InspectionPaper {
  id: string;
  title: string;
  color: string;
  fields: EvidenceField[];
}
export interface InspectionTraveler {
  state: DocumentCaseState;
  name: string;
  portrait: number;
  papers: InspectionPaper[];
  statement: EvidenceField[];
  mutation: string[];
  moral?: "family" | "medicine" | "bribe";
  corrected: boolean;
  story: string;
}
type Traveler = InspectionTraveler;
type Paper = InspectionPaper;
export type InspectionPredicate =
  | {
      op: "equal" | "not-equal" | "date-on-or-after";
      field: string;
      other?: string;
      value?: EvidenceValue;
    }
  | { op: "one-of"; field: string; values: readonly EvidenceValue[] }
  | { op: "all" | "any"; tests: readonly InspectionPredicate[] };
export interface InspectionRuleDefinition {
  id: string;
  text: string;
  fields: readonly string[];
  fromShift: number;
  fromCase?: number;
  predicate: InspectionPredicate;
}
export interface InspectionShiftDefinition {
  contentId: string;
  rulesId: string;
  firstNames: readonly string[];
  lastNames: readonly string[];
  portraitCount: number;
  destination: string;
  alternateDestination: string;
  issuers: readonly string[];
  suspendedIssuer: string;
  seal: string;
  invalidSeal: string;
  firstDay: CalendarDate;
  validExpiry: CalendarDate;
  expiredDate: CalendarDate;
  shifts: readonly {
    mutations: readonly number[];
    caseStages?: readonly number[];
    moralIndex: number;
    moral: "family" | "medicine" | "bribe";
    story: string;
  }[];
  rules: readonly InspectionRuleDefinition[];
  shiftSeconds: number;
  initialCoins: number;
  initialHealth: number;
  wage: number;
  fine: number;
  trainingCases: number;
  bribe: number;
  costs: { rent: number; food: number; heat: number };
}
function today(d: InspectionShiftDefinition, shift: number): CalendarDate {
  return { dayIndex: d.firstDay.dayIndex + shift };
}
function testPredicate(
  p: InspectionPredicate,
  fields: ReadonlyMap<string, EvidenceValue>,
): boolean {
  if (p.op === "all" || p.op === "any")
    return p.op === "all"
      ? p.tests.every((t) => testPredicate(t, fields))
      : p.tests.some((t) => testPredicate(t, fields));
  if (p.op === "one-of") return p.values.includes(fields.get(p.field)!);
  if (!("field" in p)) return false;
  const a = fields.get(p.field),
    b = p.other ? fields.get(p.other) : p.value;
  if (p.op === "date-on-or-after")
    return (
      !!a &&
      !!b &&
      typeof a === "object" &&
      typeof b === "object" &&
      compareCalendarDates(a, b) >= 0
    );
  return p.op === "equal" ? a === b : a !== b;
}
function rulesFor(
  d: InspectionShiftDefinition,
  shift: number,
  caseIndex = 0,
): DocumentRule[] {
  return d.rules
    .filter((r) => shift >= r.fromShift && caseIndex >= (r.fromCase ?? 0))
    .map((r) => ({ ...r, check: (f) => testPredicate(r.predicate, f) }));
}
function evidence(
  t: Traveler,
  d: InspectionShiftDefinition,
  shift: number,
): EvidenceField[] {
  return [
    ...t.papers.flatMap((p) => p.fields),
    ...t.statement,
    { id: "calendar.today", label: "Today", value: today(d, shift) },
  ];
}
function violations(
  d: InspectionShiftDefinition,
  t: Traveler,
  shift: number,
  caseIndex = 0,
) {
  return evaluateDocumentRules(
    evidence(t, d, shift),
    rulesFor(d, shift, caseIndex),
  );
}
function generateQueue(
  definition: InspectionShiftDefinition,
  seed: number,
  shift: number,
): Traveler[] {
  const random = createInspectionQueueRandom(seed, shift);
  const first = definition.firstNames,
    last = definition.lastNames;
  const slots = [...definition.shifts[shift]!.mutations];
  // Keep the first teaching case valid; shuffle the remainder only.
  for (let i = slots.length - 1; i > 1; i--) {
    const draw = random();
    const stages = definition.shifts[shift]!.caseStages;
    const eligible = stages
      ? Array.from({ length: i }, (_, j) => j + 1).filter(
          (j) => stages[j] === stages[i],
        )
      : [];
    const j = stages
      ? eligible[Math.floor(draw * eligible.length)]!
      : 1 + Math.floor(draw * i);
    [slots[i], slots[j]] = [slots[j]!, slots[i]!];
  }
  return slots.map((mutation, index) => {
    const stage = definition.shifts[shift]!.caseStages?.[index] ?? shift;
    const name = `${first[Math.floor(random() * first.length)]} ${last[Math.floor(random() * last.length)]}`,
      portrait = Math.floor(random() * definition.portraitCount),
      purpose = index % 2 ? "work" : "visit";
    const field = (
      id: string,
      label: string,
      value: EvidenceField["value"],
    ): EvidenceField => ({ id, label, value });
    const papers: Paper[] = [
      {
        id: "identity",
        title: "PORT IDENTITY",
        color: "#d7d6ab",
        fields: [
          field("identity.name", "Name", name),
          field("identity.portrait", "Portrait", portrait + 1),
          field("identity.issuer", "Issuer", definition.issuers[0]!),
          field("identity.expires", "Expires", definition.validExpiry),
          field("identity.seal", "Seal", definition.seal),
        ],
      },
      {
        id: "ticket",
        title: "FERRY PASSAGE",
        color: "#e3bd96",
        fields: [
          field("ticket.name", "Name", name),
          field("ticket.destination", "Destination", definition.destination),
          field("ticket.date", "Departure", today(definition, shift)),
        ],
      },
    ];
    if (stage >= 1)
      papers.push({
        id: "permit",
        title: "ENTRY PERMIT",
        color: "#b9d0bc",
        fields: [
          field("permit.name", "Name", name),
          field("permit.purpose", "Purpose", purpose),
          field(
            "permit.authorization",
            "Authorization",
            purpose === "work" ? "WORK" : "VISIT",
          ),
        ],
      });
    if (stage >= 2)
      papers.push({
        id: "cargo",
        title: "CARGO DECLARATION",
        color: "#c4bdd1",
        fields: [
          field("cargo.name", "Name", name),
          field("cargo.goods", "Goods", "clothing"),
        ],
      });
    const t: Traveler = {
      state: { id: `case-${shift}-${index}`, phase: "open", decision: null },
      name,
      portrait,
      papers,
      statement: [
        field("statement.name", "Name", name),
        field("statement.portrait", "Portrait", portrait + 1),
        field("statement.purpose", "Purpose", purpose),
      ],
      mutation: [],
      corrected: false,
      story: "The ferry leaves soon. My papers are here.",
    };
    const set = (id: string, value: EvidenceField["value"]) => {
      papers.flatMap((p) => p.fields).find((f) => f.id === id)!.value = value;
    };
    if (mutation === 1) {
      set(
        "ticket.name",
        `${first[(first.indexOf(name.split(" ")[0]!) + 1) % first.length]} ${name.split(" ")[1]}`,
      );
      t.mutation.push("identity");
    }
    if (mutation === 2) {
      set("ticket.destination", definition.alternateDestination);
      t.mutation.push("destination");
    }
    if (mutation === 3) {
      set("identity.expires", definition.expiredDate);
      t.mutation.push("expiry");
    }
    if (mutation === 4) {
      if (stage) {
        t.papers = t.papers.filter((p) => p.id !== "permit");
        t.mutation.push("permit");
      } else {
        set("identity.seal", definition.invalidSeal);
        t.mutation.push("seal");
      }
    }
    if (mutation === 5) {
      set("permit.purpose", purpose === "work" ? "visit" : "work");
      t.mutation.push("purpose");
    }
    if (mutation === 6) {
      set("identity.seal", definition.invalidSeal);
      set("ticket.destination", definition.alternateDestination);
      t.mutation.push("seal", "destination");
    }
    if (index === definition.shifts[shift]!.moralIndex) {
      t.moral = definition.shifts[shift]!.moral;
      if (shift === 0) {
        set("ticket.destination", definition.alternateDestination);
        t.story = definition.shifts[shift]!.story;
      }
      if (shift === 1) {
        set("identity.expires", definition.expiredDate);
        t.story = definition.shifts[shift]!.story;
      }
      if (shift === 2) {
        set("identity.issuer", definition.suspendedIssuer);
        t.story = definition.shifts[shift]!.story;
      }
    }
    // Evaluation is runtime generation feedback, never a hidden truth oracle.
    t.mutation = violations(definition, t, shift, index).map((v) => v.ruleId);
    return t;
  });
}
function correctTraveler(t: Traveler, ruleId: string, shift: number): string {
  if (t.corrected || t.moral)
    return "I have no other document. You must decide with the evidence you have.";
  if (ruleId === "identity") {
    const f = t.papers
      .flatMap((p) => p.fields)
      .find((f) => f.id === "ticket.name");
    if (f) f.value = t.name;
    t.corrected = true;
    return "A booking clerk wrote that name. Here is my corrected ticket.";
  }
  if (ruleId === "permit") {
    t.papers.push({
      id: "permit",
      title: "ENTRY PERMIT",
      color: "#b9d0bc",
      fields: [
        { id: "permit.name", label: "Name", value: t.name },
        {
          id: "permit.purpose",
          label: "Purpose",
          value: t.statement.find((f) => f.id === "statement.purpose")!.value,
        },
        {
          id: "permit.authorization",
          label: "Authorization",
          value:
            t.statement.find((f) => f.id === "statement.purpose")!.value ===
            "work"
              ? "WORK"
              : "VISIT",
        },
      ],
    });
    t.corrected = true;
    return "It was in my coat. Here is my permit.";
  }
  return "That is the only paper I have. I cannot correct it here.";
}

const display = (v: EvidenceValue) =>
  typeof v === "object" ? formatCalendarDate(v) : String(v);
function createInspectionShiftOwner(
  definition: InspectionShiftDefinition,
  seed: number,
) {
  let shift = 0,
    queue = generateQueue(definition, seed, 0),
    next = 0,
    current: Traveler | null = null,
    phase: "bulletin" | "desk" | "settlement" | "end" = "bulletin",
    clock = definition.shiftSeconds,
    tick = 0,
    time = 0,
    sequence = 0,
    processed = 0,
    citations = 0,
    shiftCitations = 0,
    shiftWages = 0,
    health = definition.initialHealth,
    food = false,
    heat = false,
    rent = false,
    message = "Read the bulletin, then open the queue.",
    selected: string[] = [],
    question: string | null = null,
    settled = false;
  let narratives: string[] = [],
    events: InspectionShiftEvent[] = [];
  let revision = 0;
  const ledger = new TransactionOwner({
    id: definition.rulesId,
    resources: [
      { id: "coins", initial: definition.initialCoins, capacity: 10000 },
    ],
    stats: [],
    flags: [],
    outcomes: [],
    rewardSeed: seed,
  });
  const coins = () => ledger.capture().resources[0]!.quantity;
  const transact = (id: string, operations: TransactionOperation[]) =>
    ledger.execute({
      id,
      revision: ledger.capture().revision,
      outcome: null,
      operations,
    });
  const emit = (kind: string, gain?: number, pitch?: number, text?: string) =>
    events.push({
      sequence: ++sequence,
      tick,
      sourceId: current?.state.id ?? "terminal",
      kind,
      payload: { gain, pitch, text },
    });
  const speak = (text: string) => emit("utterance", undefined, undefined, text);
  const bell = () => {
    if (phase === "bulletin") {
      phase = "desk";
      message = "Ring the bell for the first traveler.";
      return;
    }
    if (phase !== "desk" || current) return;
    if (clock <= 0 || next >= queue.length) {
      settlement();
      return;
    }
    current = queue[next++]!;
    selected = [];
    question = null;
    const unlocked = definition.rules.filter(
      (r) => r.fromShift <= shift && r.fromCase === next - 1 && r.fromCase > 0,
    );
    message = unlocked.length
      ? `BULLETIN UPDATE: ${unlocked.map((r) => r.id).join(", ")} now required. ${current.story}`
      : current.story;
    if (unlocked.length) emit("bulletin", undefined, undefined, message);
    emit("bell");
    speak(message);
  };
  const settlement = () => {
    if (phase !== "desk") return;
    phase = "settlement";
    current = null;
    food = heat = rent = false;
    settled = false;
    message = `Shift closed: ${shiftWages} wages, ${shiftCitations} citations. Allocate rent, food and heat.`;
    emit("horn");
  };
  const finishCase = () => {
    if (!current) return;
    const t = current;
    returnDocumentCase(t.state, (decision) => {
      const failures = violations(definition, t, shift, next - 1),
        correct = decision === (failures.length ? "refuse" : "admit");
      processed++;
      shiftWages += definition.wage;
      transact(`${t.state.id}-wage`, [
        { kind: "grant", resource: "coins", amount: definition.wage },
      ]);
      let note = correct
        ? `Decision accepted. +${definition.wage} wages.`
        : `CITATION: ${failures.length ? failures.map((f) => f.ruleId).join(", ") : "valid traveler refused"}.`;
      if (!correct) {
        citations++;
        shiftCitations++;
        const fine =
          processed <= definition.trainingCases
            ? 0
            : Math.min(coins(), definition.fine);
        if (fine)
          transact(`${t.state.id}-fine`, [
            { kind: "consume", resource: "coins", amount: fine },
          ]);
        note += ` Fine ${fine}.`;
        emit("citation");
      } else emit(decision === "admit" ? "gate" : "paper");
      if (t.moral) {
        const helped = decision === "admit";
        narratives.push(
          t.moral === "family"
            ? helped
              ? "A parent reached their child."
              : "A family remained on opposite shores."
            : t.moral === "medicine"
              ? helped
                ? "The clinic received its medicine."
                : "The clinic waited through the fever night."
              : helped
                ? "You accepted a storm-order bribe."
                : "You refused the bribe.",
        );
        if (t.moral === "bribe" && helped)
          transact(`${t.state.id}-bribe`, [
            { kind: "grant", resource: "coins", amount: definition.bribe },
          ]);
      }
      message = note;
    });
    if (t.state.phase === "returned") {
      current = null;
      selected = [];
      question = null;
      if (clock <= 0 || next >= queue.length) settlement();
    }
  };
  const stamp = (decision: "admit" | "refuse") => {
    if (current && stampDocumentCase(current.state, decision)) {
      message = `${decision.toUpperCase()} stamped. Return the documents to commit the decision.`;
      emit("stamp");
    }
  };
  const selectField = (id: string) => {
    if (selected.includes(id)) selected = selected.filter((v) => v !== id);
    else selected = [...selected.slice(-1), id];
    question = null;
    if (!current) return;
    const failures = violations(definition, current, shift, next - 1);
    const values = evidence(current, definition, shift);
    const a = values.find((f) => f.id === selected[0]),
      b = values.find((f) => f.id === selected[1]);
    const comparable =
      !!a &&
      !!b &&
      ((a.id.split(".").at(-1) === b.id.split(".").at(-1) &&
        display(a.value) !== display(b.value)) ||
        ([a.id, b.id].includes("calendar.today") &&
          [a.id, b.id].includes("identity.expires")));
    const supportsRule = (ruleId: string): boolean => {
      const fieldId = selected.find((value) => !value.startsWith("rule:"));
      if (!fieldId) return false;
      const get = (id: string) =>
        values.find((field) => field.id === id)?.value;
      if (ruleId === "identity") {
        if (fieldId.endsWith(".portrait"))
          return get("identity.portrait") !== get("statement.portrait");
        if (fieldId.endsWith(".name"))
          return [get("identity.name"), get("ticket.name")].some(
            (name) => name !== get("statement.name"),
          );
      }
      if (ruleId === "purpose" && fieldId === "permit.authorization")
        return get("statement.purpose") === "work" && get(fieldId) !== "WORK";
      return true;
    };
    const match = failures.find(
      (v) =>
        selected.length === 2 &&
        ((selected.includes(`rule:${v.ruleId}`) &&
          supportsRule(v.ruleId) &&
          selected.some((s) => v.fields.includes(s))) ||
          (comparable &&
            v.fields.filter((f) => selected.includes(f)).length === 2)),
    );
    if (match) {
      question = match.ruleId;
      message = `Discrepancy: ${match.explanation} Ask the traveler (Q).`;
      emit("compare");
    } else if (selected.length === 2)
      message = "No contradiction established by these two pieces of evidence.";
  };
  const ask = () => {
    if (!current) return;
    if (!question) {
      message =
        "Select two conflicting fields, or a rule and its evidence first.";
      return;
    }
    message = correctTraveler(current, question, shift);
    selected = [];
    question = null;
    speak(message);
  };
  const buy = (kind: "rent" | "food" | "heat", cost: number) => {
    if (phase !== "settlement" || { rent, food, heat }[kind]) return;
    if (coins() < cost) {
      message = `Need ${cost} coins for ${kind}.`;
      return;
    }
    transact(`night-${shift}-${kind}`, [
      { kind: "consume", resource: "coins", amount: cost },
    ]);
    if (kind === "rent") rent = true;
    if (kind === "food") food = true;
    if (kind === "heat") heat = true;
    emit("paper");
  };
  const nextShift = () => {
    if (phase !== "settlement" || settled) return;
    settled = true;
    health = Math.max(0, health - (food ? 0 : 1) - (heat ? 0 : 1));
    if (!rent) narratives.push(`Night ${shift + 1}: rent unpaid.`);
    if (
      health === 0 ||
      (!rent && coins() < definition.costs.rent) ||
      shift === definition.shifts.length - 1
    ) {
      phase = "end";
      message =
        health === 0
          ? "Your household could not survive the cold and hunger."
          : !rent && coins() < definition.costs.rent
            ? "The landlord repossessed your room."
            : definition.shifts.length === 1
              ? "Shift complete. The last ferry has crossed."
              : "Three shifts complete. The last ferry has crossed.";
      emit(health > 0 && rent ? "gate" : "horn");
      return;
    }
    shift++;
    queue = generateQueue(definition, seed, shift);
    next = 0;
    clock = definition.shiftSeconds;
    shiftWages = 0;
    shiftCitations = 0;
    phase = "bulletin";
    message = "A new bulletin has arrived.";
  };

  const command = (command: InspectionShiftCommand) => {
    if (events.length >= 240)
      throw Error(
        "Inspection event budget exceeded; drain events before more commands",
      );
    if (command.revision !== undefined && command.revision !== revision)
      return false;
    if (command.caseId !== undefined && command.caseId !== current?.state.id)
      return false;
    if (command.kind === "select-field") {
      if (
        !current ||
        ![
          ...evidence(current, definition, shift).map((f) => f.id),
          ...rulesFor(definition, shift, Math.max(0, next - 1)).map(
            (r) => `rule:${r.id}`,
          ),
        ].includes(command.id)
      )
        return false;
      selectField(command.id);
    } else {
      switch (command.id) {
        case "bell":
          bell();
          break;
        case "ask":
          ask();
          break;
        case "admit":
          stamp("admit");
          break;
        case "refuse":
          stamp("refuse");
          break;
        case "return":
          finishCase();
          break;
        case "rent":
          buy("rent", definition.costs.rent);
          break;
        case "food":
          buy("food", definition.costs.food);
          break;
        case "heat":
          buy("heat", definition.costs.heat);
          break;
        case "next":
        case "continue":
          nextShift();
          break;
        default:
          return false;
      }
    }
    revision++;
    return true;
  };
  const step = (dt: number) => {
    if (!Number.isFinite(dt) || dt < 0 || dt > 0.25)
      throw Error("Inspection step budget is 0..0.25 seconds");
    if (dt === 0) return;
    if (events.length >= 240) throw Error("Inspection event budget exceeded");
    tick++;
    time += dt;
    if (phase === "desk") {
      const previousClock = clock;
      clock = Math.max(0, clock - dt);
      if (previousClock > 0 && clock === 0 && current) {
        emit("horn");
        message =
          "CLOSING HORN: queue closed. Finish and return this traveler’s papers.";
      }
      if (clock === 0 && !current) settlement();
    }
  };
  const snapshot = () =>
    structuredClone({
      format: "inspection-shift-v1" as const,
      contentId: definition.contentId,
      rulesId: definition.rulesId,
      seed,
      owner: {
        shift,
        queue,
        next,
        current,
        phase,
        clock,
        tick,
        time,
        sequence,
        revision,
        processed,
        citations,
        shiftCitations,
        shiftWages,
        health,
        food,
        heat,
        rent,
        message,
        selected,
        question,
        settled,
        narratives,
        ledger: ledger.capture(),
        events,
      },
    });
  return {
    command,
    step,
    snapshot,
    observe: () =>
      structuredClone({
        shift,
        shiftCount: definition.shifts.length,
        queueLength: queue.length,
        next,
        current,
        phase,
        clock,
        tick,
        time,
        revision,
        processed,
        citations,
        shiftCitations,
        shiftWages,
        health,
        food,
        heat,
        rent,
        message,
        selected,
        question,
        narratives,
        coins: coins(),
        rules: definition.rules.filter(
          (r) =>
            shift >= r.fromShift && Math.max(0, next - 1) >= (r.fromCase ?? 0),
        ),
        today: today(definition, shift),
        fields: current ? evidence(current, definition, shift) : [],
        outcome:
          phase === "end"
            ? health > 0 && rent
              ? ("won" as const)
              : ("lost" as const)
            : ("playing" as const),
      }),
    drainEvents: () => {
      const batch = structuredClone(events);
      events = [];
      return batch;
    },
    restore: (checkpoint: unknown) => {
      const v = validateInspectionCheckpoint(checkpoint, definition, seed);
      // Ledger validation occurs on a detached owner before any live state changes.
      const probe = new TransactionOwner({
        id: definition.rulesId,
        resources: [
          { id: "coins", initial: definition.initialCoins, capacity: 10000 },
        ],
        stats: [],
        flags: [],
        outcomes: [],
        rewardSeed: seed,
      });
      probe.restore(v.ledger);
      ledger.restore(v.ledger);
      ({
        shift,
        queue,
        next,
        current,
        phase,
        clock,
        tick,
        time,
        sequence,
        revision,
        processed,
        citations,
        shiftCitations,
        shiftWages,
        health,
        food,
        heat,
        rent,
        message,
        selected,
        question,
        settled,
        narratives,
        events,
      } = v);
    },
  };
}
export type InspectionShiftSnapshot = ReturnType<
  ReturnType<typeof createInspectionShiftOwner>["snapshot"]
>;
export type InspectionShiftObservation = ReturnType<
  ReturnType<typeof createInspectionShiftOwner>["observe"]
>;
export type InspectionShiftEvent = {
  sequence: number;
  tick: number;
  sourceId: string;
  kind: string;
  payload: { gain?: number; pitch?: number; text?: string };
};
export type InspectionShiftCommand = (
  | { kind: "action"; id: string }
  | { kind: "select-field"; id: string }
) & { revision?: number; caseId?: string };
export class InspectionShiftSession {
  private owner: ReturnType<typeof createInspectionShiftOwner>;
  readonly definition: InspectionShiftDefinition;
  readonly seed: number;
  constructor(definition: InspectionShiftDefinition, seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw Error("Invalid inspection seed");
    if (
      !definition.contentId ||
      !definition.rulesId ||
      !definition.shifts.length ||
      definition.shifts.length > 16 ||
      definition.shifts.some(
        (s) =>
          s.mutations.length < 1 ||
          s.mutations.length > 32 ||
          (s.caseStages !== undefined &&
            (s.caseStages.length !== s.mutations.length ||
              s.caseStages.some(
                (stage) => !Number.isInteger(stage) || stage < 0 || stage > 2,
              ))),
      ) ||
      !definition.firstNames.length ||
      !definition.lastNames.length ||
      !Number.isFinite(definition.shiftSeconds) ||
      definition.shiftSeconds <= 0 ||
      definition.rules.length > 64
    )
      throw Error("Invalid inspection definition or budget");
    this.definition = structuredClone(definition);
    this.seed = seed;
    this.owner = createInspectionShiftOwner(
      structuredClone(this.definition),
      seed,
    );
  }
  command(c: InspectionShiftCommand) {
    return this.owner.command(c);
  }
  step(dt: number) {
    this.owner.step(dt);
  }
  observe() {
    return this.owner.observe();
  }
  snapshot() {
    return this.owner.snapshot();
  }
  restore(s: unknown) {
    this.owner.restore(s);
  }
  drainEvents() {
    return this.owner.drainEvents();
  }
}
function validateInspectionCheckpoint(
  value: unknown,
  d: InspectionShiftDefinition,
  seed: number,
): InspectionShiftSnapshot["owner"] {
  const s = structuredClone(value) as InspectionShiftSnapshot;
  if (
    !s ||
    s.format !== "inspection-shift-v1" ||
    s.contentId !== d.contentId ||
    s.rulesId !== d.rulesId ||
    s.seed !== seed ||
    !s.owner
  )
    throw Error("Incompatible inspection checkpoint; restart this shift");
  const v = s.owner;
  const maxCases = d.shifts.reduce((n, s) => n + s.mutations.length, 0);
  if (
    [
      d.initialCoins,
      d.initialHealth,
      d.wage,
      d.fine,
      d.trainingCases,
      d.bribe,
      ...Object.values(d.costs),
    ].some((n) => !Number.isSafeInteger(n) || n < 0)
  )
    throw Error("Invalid inspection economy");
  const integers = [
    v.shift,
    v.next,
    v.tick,
    v.sequence,
    v.revision,
    v.processed,
    v.citations,
    v.shiftCitations,
    v.shiftWages,
    v.health,
  ];
  if (
    integers.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    v.shift >= d.shifts.length ||
    v.health > d.initialHealth ||
    v.processed > maxCases ||
    v.citations > v.processed ||
    v.shiftCitations > v.citations ||
    !Number.isFinite(v.clock) ||
    v.clock < 0 ||
    v.clock > d.shiftSeconds ||
    !Number.isFinite(v.time) ||
    v.time < 0 ||
    !["bulletin", "desk", "settlement", "end"].includes(v.phase) ||
    typeof v.message !== "string" ||
    [v.food, v.heat, v.rent, v.settled].some((b) => typeof b !== "boolean") ||
    !Array.isArray(v.queue) ||
    v.queue.length !== d.shifts[v.shift]!.mutations.length ||
    v.next > v.queue.length ||
    !Array.isArray(v.selected) ||
    v.selected.length > 2 ||
    !Array.isArray(v.narratives) ||
    v.narratives.length > d.shifts.length * 2 ||
    !Array.isArray(v.events) ||
    v.events.length > 256
  )
    throw Error("Malformed inspection checkpoint");
  if (
    v.selected.some((id) => typeof id !== "string") ||
    (v.question !== null && !d.rules.some((r) => r.id === v.question)) ||
    v.narratives.some((n) => typeof n !== "string")
  )
    throw Error("Malformed inspection evidence");
  const validField = (f: EvidenceField) =>
    !!f &&
    typeof f.id === "string" &&
    typeof f.label === "string" &&
    (typeof f.value === "string" ||
      (typeof f.value === "number" && Number.isFinite(f.value)) ||
      (typeof f.value === "object" &&
        f.value !== null &&
        Number.isSafeInteger(f.value.dayIndex)));
  for (const t of v.queue) {
    if (
      !t ||
      !t.state ||
      typeof t.state.id !== "string" ||
      !["open", "stamped", "returned"].includes(t.state.phase) ||
      ![null, "admit", "refuse"].includes(t.state.decision) ||
      !Array.isArray(t.papers) ||
      t.papers.length > 8 ||
      !Array.isArray(t.statement) ||
      t.statement.length > 16 ||
      typeof t.name !== "string" ||
      typeof t.story !== "string" ||
      !Number.isInteger(t.portrait) ||
      t.portrait < 0 ||
      t.portrait >= d.portraitCount ||
      typeof t.corrected !== "boolean" ||
      t.statement.some((f) => !validField(f)) ||
      t.papers.some(
        (p) =>
          !p ||
          typeof p.id !== "string" ||
          typeof p.title !== "string" ||
          typeof p.color !== "string" ||
          !Array.isArray(p.fields) ||
          p.fields.length > 32 ||
          p.fields.some((f) => !validField(f)),
      )
    )
      throw Error("Malformed inspection traveler");
  }
  if (
    v.current &&
    (!v.queue.some((t) => t.state.id === v.current!.state.id) ||
      v.current.state.phase === "returned" ||
      v.phase !== "desk")
  )
    throw Error("Malformed active inspection case");
  if (v.current) {
    const active = v.queue[v.next - 1];
    if (!active || JSON.stringify(active) !== JSON.stringify(v.current))
      throw Error("Inconsistent active inspection case");
    v.current = active;
  }
  for (const e of v.events)
    if (
      !e ||
      !Number.isSafeInteger(e.sequence) ||
      e.sequence > v.sequence ||
      e.sequence < 1 ||
      !Number.isSafeInteger(e.tick) ||
      e.tick > v.tick ||
      typeof e.kind !== "string" ||
      typeof e.sourceId !== "string"
    )
      throw Error("Malformed inspection event");
  return v;
}
