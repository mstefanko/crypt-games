import type { HostReadiness } from "../host/web.ts";

export const SAVE_DESK_MARKUP = `<details class="save-desk"><summary>Save and checkpoint desk</summary><p>Campaign saves keep progression and return to the last authored entrance. Exact checkpoints require this rules/content version. Backups retain one previous campaign and one source payload. Imported originals stay in memory until the next input or reload; download them to keep exact file bytes.</p><button data-save>Save campaign</button><button data-load>Load campaign</button><button data-checkpoint>Copy exact checkpoint</button><button data-restore>Restore exact checkpoint</button><button data-import>Import campaign</button><button data-export>Export campaign</button><button data-backup>Download backup</button><button data-previous>Recover previous</button><label>Import campaign or backup file <input data-campaign-file type="file" accept="application/json,.json"></label><button data-export-original hidden>Export imported original</button><button data-export-stored-original hidden>Export stored recovery original</button><textarea data-bytes spellcheck="false" aria-label="Save or checkpoint JSON"></textarea></details>`;
const ACTIONS = [
  "save",
  "load",
  "checkpoint",
  "restore",
  "import",
  "export",
  "backup",
  "previous",
  "export-original",
  "export-stored-original",
] as const;
export type SaveDeskCommand =
  | { kind: (typeof ACTIONS)[number] }
  | { kind: "file"; file: File };

/** Presentation and byte transfer only; campaign and execution authority stays in M3Session. */
export class SaveDesk {
  private root: HTMLElement;
  private bytes: HTMLTextAreaElement;
  private notice: HTMLElement;
  constructor(
    shell: HTMLElement,
    signal: AbortSignal,
    dispatch: (command: SaveDeskCommand) => Promise<void>,
    rejected: (message: string) => void,
  ) {
    this.root = shell.querySelector<HTMLElement>(".save-desk")!;
    this.bytes = this.root.querySelector<HTMLTextAreaElement>("[data-bytes]")!;
    this.notice = document.createElement("p");
    this.notice.dataset.hostStorageNotice = "";
    this.root.prepend(this.notice);
    this.root
      .querySelector<HTMLInputElement>("[data-campaign-file]")!
      .addEventListener(
        "change",
        (event) => {
          const element = event.target as HTMLInputElement;
          const file = element.files?.[0];
          element.value = "";
          if (file)
            void dispatch({ kind: "file", file }).catch((error) =>
              rejected(
                `Import rejected: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
        },
        { signal },
      );
  }
  command(button: HTMLButtonElement): SaveDeskCommand | undefined {
    const kind = ACTIONS.find((action) =>
      button.hasAttribute(`data-${action}`),
    );
    return kind ? { kind } : undefined;
  }
  readBytes() {
    return this.bytes.value;
  }
  writeBytes(bytes: string) {
    this.bytes.value = bytes;
  }
  hide() {
    this.root.hidden = true;
  }
  showOriginal(imported: boolean, stored: boolean) {
    this.root.querySelector<HTMLElement>("[data-export-original]")!.hidden =
      !imported;
    this.root.querySelector<HTMLElement>(
      "[data-export-stored-original]",
    )!.hidden = !stored;
  }
  readiness(state: HostReadiness, replaying: boolean, blocked: boolean) {
    this.notice.textContent = replaying
      ? "Replay mode. Live input, campaign storage and device effects are disabled."
      : blocked
        ? "Durable storage is required. Play is paused; export progress or retry Save campaign."
        : (state.reason ?? "");
    this.notice.hidden = !this.notice.textContent;
    // Exact checkpoints remain available during read-only replay.
    for (const control of this.root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >(
      "[data-save],[data-load],[data-import],[data-backup],[data-previous],[data-export],[data-export-original],[data-export-stored-original],[data-campaign-file]",
    ))
      control.disabled = replaying;
    return this.notice.textContent;
  }
  download(bytes: string | Uint8Array, name: string) {
    const url = URL.createObjectURL(
      new Blob(
        [typeof bytes === "string" ? bytes : new Uint8Array(bytes).buffer],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
