import type { M2Audio } from "./m2-audio.ts";
/** One explicit user gesture retries the existing owner; muting never unlocks sound here. */
export class AudioRecoveryControl {
  private button = document.createElement("button");
  private pending = false;
  constructor(
    container: HTMLElement,
    private audio: M2Audio,
    private signal: AbortSignal,
    private message: (text: string) => void,
    private enabled: () => boolean = () => true,
  ) {
    this.button.dataset.resumeSound = "";
    this.button.textContent = "Resume sound";
    this.button.hidden = true;
    container.append(this.button);
    this.button.addEventListener(
      "click",
      () => {
        void this.retry();
      },
      { signal },
    );
  }
  sync() {
    if (this.signal.aborted) return;
    const stats = this.audio.stats();
    this.button.hidden = stats.error === null || stats.muted;
    this.button.disabled = this.pending || !this.enabled();
  }
  report(text: string) {
    if (!this.signal.aborted && this.enabled()) this.message(text);
    this.sync();
  }
  private async retry() {
    if (
      this.pending ||
      this.signal.aborted ||
      !this.enabled() ||
      this.audio.stats().muted
    )
      return;
    this.pending = true;
    // Call before yielding so browsers retain native user activation.
    const attempt = this.audio.unlock();
    this.sync();
    const enabled = await attempt;
    this.pending = false;
    if (this.signal.aborted) return;
    this.sync();
    if (enabled && this.enabled() && !this.audio.stats().muted)
      this.message("Sound resumed.");
  }
}
