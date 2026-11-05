/** Host-owned presentation lifetime, proven by the bounded Skyline backends.
 * Implementations must cancel input on disable/dispose and make dispose repeatable.
 * Authority and audio clocks remain outside this contract.
 */
export interface PresentationLifecycle {
  mount(): Promise<void>;
  resize(width: number, height: number, dpr?: number): void;
  setInputEnabled(enabled: boolean): void;
  cancelInput(): void;
  dispose(): Promise<void>;
  inspect(): Record<string, unknown>;
}
