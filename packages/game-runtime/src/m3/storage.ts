/** One bounded record publishes current/previous/original atomically. No multi-key transaction. */
import type { AdventureDefinitions } from "../../../game-simulation/src/m3/adventure";
import {
  BACKUP_BYTES,
  inputBytes,
  prepareCampaignRecovery,
  makeBackup,
  encodeBackup,
  stableSlot,
  CampaignError,
} from "../m5/campaign-codec";
export class CampaignStorage {
  readonly key: string;
  readonly legacyKey: string;
  private memory: string | null = null;
  private original: Uint8Array | null = null;
  private storedOriginal: Uint8Array | null = null;
  private readFailure: CampaignError | null = null;
  private originalPayload: string | null = null;
  private dirty = false;
  private observed: string | null | undefined;
  private committed: string | null = null;
  private generation = 0;
  private conflict = false;
  private legacyPending = false;
  private defs: AdventureDefinitions;
  private slot: string;
  constructor(
    private readonly report: (message: string) => void,
    private readonly storage: () => Pick<Storage, "getItem" | "setItem"> = () =>
      localStorage,
    options: { definitions: AdventureDefinitions; slot?: string },
  ) {
    this.defs = options.definitions;
    this.slot = stableSlot(options.slot ?? "main");
    stableSlot(this.defs.gameId);
    const gameKey = encodeURIComponent(this.defs.gameId),
      slotKey = encodeURIComponent(this.slot);
    this.key = `pocket-game:${gameKey}:campaign:v2:${slotKey}`;
    this.legacyKey = `pocket-game:${gameKey}:campaign:v1:${slotKey}`;
  }
  /** Storage events are advisory conflict notification, never automatic adoption. */
  changed(key: string | null, newValue: string | null) {
    if (
      (key === this.key || key === null) &&
      this.observed !== undefined &&
      newValue !== this.observed
    ) {
      this.conflict = true;
      this.report(
        "Campaign changed in another tab. Export local progress, then reload before saving; campaigns are never merged.",
      );
    }
  }
  read(): string | null {
    if (this.conflict)
      throw new CampaignError(
        "CAMPAIGN_CONFLICT",
        "Another writer changed this slot; export progress and reload.",
      );
    if (this.dirty) return this.memory;
    let attempted: string | null = null;
    try {
      const store = this.storage(),
        raw = store.getItem(this.key);
      // Reading after a known competing writer must not silently acknowledge it.
      if (this.observed !== undefined && raw !== this.observed) {
        this.conflict = true;
        this.report(
          "Campaign changed in another tab. Export local progress and reload before saving.",
        );
        throw new CampaignError(
          "CAMPAIGN_CONFLICT",
          "Another writer changed this slot; export progress and reload.",
        );
      }
      this.observed = raw;
      if (raw !== null) {
        attempted = raw;
        if (this.storedOriginal === null)
          this.storedOriginal = inputBytes(raw).slice();
        const candidate = prepareCampaignRecovery(this.defs, raw, this.slot);
        this.memory = candidate.payload;
        this.committed = candidate.payload;
        this.generation = candidate.generation;
        this.originalPayload = candidate.original;
      } else {
        const legacy = store.getItem(this.legacyKey);
        if (legacy !== null) {
          attempted = legacy;
          if (this.storedOriginal === null)
            this.storedOriginal = inputBytes(legacy).slice();
          const candidate = prepareCampaignRecovery(
            this.defs,
            legacy,
            this.slot,
          );
          this.memory = candidate.payload;
          this.committed = candidate.payload;
          this.originalPayload = candidate.original;
          this.legacyPending = true;
        }
      }
    } catch (error) {
      if (error instanceof CampaignError) {
        this.readFailure = error;
        if (attempted !== null)
          this.storedOriginal = inputBytes(attempted).slice();
        this.report(
          `${error.message} Previous active campaign preserved. Export the stored original, then use Recover previous.`,
        );
        throw error;
      }
      this.report(
        "Browser storage denied. Playing in memory; export your campaign to keep it.",
      );
    }
    return this.memory;
  }
  /** Called only after detached codec/map preparation; synchronous publish+adopt has no await gap. */
  commit(
    bytes: string,
    importedOriginal?: string | null,
  ): "durable" | "memory" {
    const candidate = prepareCampaignRecovery(this.defs, bytes, this.slot);
    // Observe an existing record before preparing its bounded previous generation.
    if (this.observed === undefined) {
      this.read();
    }
    // A failed implicit or explicit read cannot authorize overwriting recovery data.
    if (this.readFailure) throw this.readFailure;
    if (this.conflict)
      throw new CampaignError(
        "CAMPAIGN_CONFLICT",
        "Another writer changed this slot; export progress and reload.",
      );
    if (this.generation === Number.MAX_SAFE_INTEGER)
      throw new CampaignError(
        "CAMPAIGN_GENERATION",
        "Generation exhausted; export and use a fresh slot.",
      );
    const nextOriginal =
      importedOriginal === undefined ? this.originalPayload : importedOriginal;
    const record = encodeBackup(
      makeBackup(
        this.defs,
        candidate.payload,
        this.committed,
        nextOriginal,
        this.generation + 1,
        this.slot,
      ),
    );
    let durable = false;
    try {
      const store = this.storage();
      const latest = store.getItem(this.key);
      if (this.observed !== undefined && latest !== this.observed) {
        this.conflict = true;
        throw new CampaignError(
          "CAMPAIGN_CONFLICT",
          "Another writer changed this slot; export progress and reload.",
        );
      }
      store.setItem(this.key, record);
      this.observed = record;
      durable = true;
    } catch (error) {
      if (error instanceof CampaignError) throw error;
    }
    this.memory = candidate.payload;
    this.originalPayload = nextOriginal;
    this.dirty = !durable;
    if (durable) {
      this.committed = candidate.payload;
      this.generation++;
      this.legacyPending = false;
      this.report(
        "Campaign saved to this browser. One previous generation is retained.",
      );
      return "durable";
    }
    this.report(
      "Browser save denied or quota full. Campaign recovered in memory only; export it to keep it.",
    );
    return "memory";
  }
  write(bytes: string): boolean {
    // Normal gameplay Save retains valid dirty progress even on a writer conflict.
    const payload = prepareCampaignRecovery(
      this.defs,
      bytes,
      this.slot,
    ).payload;
    try {
      return this.commit(payload) === "durable";
    } catch (error) {
      if (
        !(error instanceof CampaignError) ||
        error.code !== "CAMPAIGN_CONFLICT"
      )
        throw error;
      this.memory = payload;
      this.dirty = true;
      this.report(
        `${error.message} Local campaign remains in memory; export it.`,
      );
      return false;
    }
  }
  preserveRejected(bytes: string | Uint8Array) {
    const raw = inputBytes(bytes, BACKUP_BYTES);
    this.original = raw.slice();
  }
  exportOriginal(): Uint8Array | null {
    return (this.original ?? this.storedOriginal)?.slice() ?? null;
  }
  exportStoredOriginal(): Uint8Array | null {
    return this.storedOriginal?.slice() ?? null;
  }
  exportBackup(): string {
    const payload = this.memory ?? this.read();
    if (!payload)
      throw new CampaignError(
        "CAMPAIGN_MISSING",
        "No saved campaign; use Save campaign first.",
      );
    let previous: string | null = null;
    if (this.observed !== undefined && this.observed !== null) {
      try {
        previous = this.dirty
          ? this.committed
          : prepareCampaignRecovery(this.defs, this.observed, this.slot)
              .previous;
      } catch {
        /* Export valid memory with bounded retained provenance. */
      }
    }
    return encodeBackup(
      makeBackup(
        this.defs,
        payload,
        previous,
        this.originalPayload,
        this.generation,
        this.slot,
      ),
    );
  }
  previous(): string {
    const raw = this.storage().getItem(this.key);
    if (!raw)
      throw new CampaignError(
        "CAMPAIGN_PREVIOUS",
        "No previous committed campaign is retained.",
      );
    if (this.storedOriginal === null)
      this.storedOriginal = inputBytes(raw).slice();
    const candidate = prepareCampaignRecovery(
      this.defs,
      raw,
      this.slot,
      "previous",
    );
    // Explicit recovery acknowledges exactly these bytes; it does not guess a newer writer.
    if (this.observed !== undefined && this.observed !== raw)
      throw new CampaignError(
        "CAMPAIGN_CONFLICT",
        "Slot changed; reload before recovery.",
      );
    this.observed = raw;
    this.readFailure = null;
    this.committed = candidate.payload;
    this.generation = candidate.generation;
    return candidate.payload;
  }
  get needsMigration() {
    return this.legacyPending;
  }
  get memoryBytes() {
    return this.memory;
  }
}
