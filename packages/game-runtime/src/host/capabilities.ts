/** Host UI outcomes never grant gameplay authority. */
export type HostOutcome =
  | "success"
  | "unsupported"
  | "denied"
  | "cancelled"
  | "transient-failure";
export type DeviceOperation = "fullscreen" | "haptics" | "share";
export type CapabilityStatus = "supported" | "experimental" | "unavailable";
export interface HostDeclaration {
  required: readonly ("lifecycle" | "storage" | "viewport" | "input")[];
  optional: readonly DeviceOperation[];
  durableStorage: "required" | "memory-fallback";
}
export const WEB_GAME_DECLARATION: HostDeclaration = Object.freeze({
  required: Object.freeze([
    "lifecycle",
    "storage",
    "viewport",
    "input",
  ] as const),
  optional: Object.freeze([]),
  durableStorage: "memory-fallback",
});
export interface HostRequest {
  id: number;
  session: number;
  scene: number;
  operation: DeviceOperation;
  payload: string;
}
export interface HostResponse extends Omit<HostRequest, "payload"> {
  outcome: HostOutcome;
}
const outcomes: readonly string[] = [
  "success",
  "unsupported",
  "denied",
  "cancelled",
  "transient-failure",
];
/** Local callback authority: no window-message/receipt acceptance, no rule mutation. */
export class HostRequests {
  private next = 0;
  private session = 1;
  private scene = 0;
  private active = true;
  private replay = false;
  private pending = new Map<
    number,
    { request: HostRequest; finish: (result: HostOutcome) => void }
  >();
  constructor(
    private readonly send: (
      request: HostRequest,
      reply: (response: unknown) => void,
    ) => void,
  ) {}
  request(operation: DeviceOperation, payload = ""): Promise<HostOutcome> {
    if (
      !["fullscreen", "haptics", "share"].includes(operation) ||
      typeof payload !== "string" ||
      payload.length > 2048
    )
      throw new Error("Invalid bounded host request");
    if (!this.active || this.replay) return Promise.resolve("cancelled");
    if (this.pending.size >= 32 || this.next >= 1_000_000)
      return Promise.resolve("transient-failure");
    const request = Object.freeze({
      id: ++this.next,
      session: this.session,
      scene: this.scene,
      operation,
      payload,
    });
    return new Promise((finish) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.id);
        finish("transient-failure");
      }, 10_000);
      this.pending.set(request.id, {
        request,
        finish: (result) => {
          clearTimeout(timeout);
          finish(result);
        },
      });
      try {
        this.send(request, (response) => this.accept(response, request.id));
      } catch {
        this.accept(
          {
            id: request.id,
            session: request.session,
            scene: request.scene,
            operation,
            outcome: "transient-failure",
          },
          request.id,
        );
      }
    });
  }
  isCurrent(request: HostRequest): boolean {
    return (
      this.active &&
      !this.replay &&
      request.session === this.session &&
      request.scene === this.scene &&
      this.pending.has(request.id)
    );
  }
  private accept(value: unknown, expectedId: number): void {
    if (!this.active || this.replay || !value || typeof value !== "object")
      return;
    const response = value as HostResponse;
    if (
      response.id !== expectedId ||
      !Number.isSafeInteger(response.id) ||
      typeof response.outcome !== "string" ||
      !outcomes.includes(response.outcome) ||
      Object.keys(response).sort().join(",") !==
        "id,operation,outcome,scene,session"
    )
      return;
    const pending = this.pending.get(response.id);
    if (
      !pending ||
      response.session !== this.session ||
      response.scene !== this.scene ||
      response.session !== pending.request.session ||
      response.scene !== pending.request.scene ||
      response.operation !== pending.request.operation
    )
      return;
    this.pending.delete(response.id);
    pending.finish(response.outcome);
  }
  private cancel(): void {
    for (const pending of this.pending.values()) pending.finish("cancelled");
    this.pending.clear();
  }
  sceneChanged(): void {
    this.cancel();
    if (this.scene >= 1_000_000) this.dispose();
    else this.scene++;
  }
  setReplay(replay: boolean): void {
    this.cancel();
    this.replay = replay;
  }
  disconnect(): void {
    this.cancel();
    this.active = false;
  }
  dispose(): void {
    this.disconnect();
    this.session++;
  }
}
