import {
  ChargeAssembly,
  CHARGE_ASSEMBLY_CONTENT,
  CHARGE_ASSEMBLY_DESCRIPTOR,
} from "@onepage/game-runtime/charge";
import type { ChargeIdentity } from "@onepage/game-runtime/charge";
/** Both hosts own their own isolated assembly; controls forward public semantic commands. */
export function mountChargePanel(
  parent: HTMLElement,
  identity: ChargeIdentity,
) {
  const assembly = new ChargeAssembly(identity);
  const panel = document.createElement("section");
  panel.className = "panel";
  panel.innerHTML = `<h2>Charge workshop</h2><p>Every ${CHARGE_ASSEMBLY_DESCRIPTOR.limits.rewardThreshold} charge earns ${CHARGE_ASSEMBLY_CONTENT.rewardPerThreshold} rewards. Up to ${CHARGE_ASSEMBLY_DESCRIPTOR.limits.commands} commands.</p><div>${[1, 2, 3].map((amount) => `<button data-charge="${amount}">Add ${amount} charge</button>`).join(" ")}</div><p role="status" data-charge-status></p><pre data-charge-summary></pre><details><summary>Exact checkpoint and recording</summary><button data-charge-action="capture">Capture</button><button data-charge-action="restore">Restore checkpoint</button><button data-charge-action="replay">Replay recording</button><label>Checkpoint<textarea aria-label="Charge checkpoint"></textarea></label><label>Recording<textarea aria-label="Charge recording"></textarea></label><pre data-charge-descriptor></pre></details>`;
  parent.append(panel);
  const summary = panel.querySelector<HTMLElement>("[data-charge-summary]")!;
  const status = panel.querySelector<HTMLElement>("[data-charge-status]")!;
  const checkpoint = panel.querySelector<HTMLTextAreaElement>(
    '[aria-label="Charge checkpoint"]',
  )!;
  const recording = panel.querySelector<HTMLTextAreaElement>(
    '[aria-label="Charge recording"]',
  )!;
  panel.querySelector<HTMLElement>("[data-charge-descriptor]")!.textContent =
    JSON.stringify(
      { identity, descriptor: CHARGE_ASSEMBLY_DESCRIPTOR },
      null,
      2,
    );
  const render = () => {
    summary.textContent = JSON.stringify(assembly.observe(), null, 2);
    panel
      .querySelectorAll<HTMLButtonElement>("[data-charge]")
      .forEach(
        (button) => (button.disabled = assembly.observe().revision === 64),
      );
  };
  panel.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button",
    );
    if (!button) return;
    try {
      if (button.dataset.charge)
        assembly.execute({
          kind: "charge",
          amount: Number(button.dataset.charge),
          revision: assembly.observe().revision,
        });
      else if (button.dataset.chargeAction === "capture") {
        checkpoint.value = assembly.checkpoint();
        recording.value = assembly.recording();
      } else if (button.dataset.chargeAction === "restore")
        assembly.restore(checkpoint.value);
      else if (button.dataset.chargeAction === "replay")
        assembly.replay(recording.value);
      status.textContent = "Accepted";
    } catch (error) {
      status.textContent = `Rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
    render();
  });
  render();
  return panel;
}
