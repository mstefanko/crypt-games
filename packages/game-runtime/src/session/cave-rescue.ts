import { boundedJSON, record } from "@onepage/game-project/runtime";
import { CaveRescueOwner } from "@onepage/game-simulation/cave-rescue";
import type { CaveContent } from "@onepage/game-project/cave-types";
import { validateCaveContent } from "@onepage/game-project/cave-validation";
/** Host wrapper embeds the actual realization and pins the build-derived rules identity. */
export class CaveSession {
  owner: CaveRescueOwner;
  constructor(
    content: CaveContent,
    readonly rulesBuildId: string,
  ) {
    this.owner = new CaveRescueOwner(content, rulesBuildId);
  }
  export(kind: "checkpoint" | "progress" = "checkpoint"): string {
    const data =
      kind === "checkpoint"
        ? this.owner.capture()
        : this.owner.captureProgress();
    const bytes = JSON.stringify({
      format: "cave-portable-v1",
      kind,
      rulesBuildId: this.rulesBuildId,
      data,
    });
    if (
      new TextEncoder().encode(bytes).length >
      (kind === "checkpoint" ? 4 : 1) * 1024 * 1024
    )
      throw Error("Combined cave save byte cap");
    return bytes;
  }
  import(bytes: string): void {
    if (new TextEncoder().encode(bytes).length > 4 * 1024 * 1024)
      throw Error("Cave save byte cap");
    const value = record(
      boundedJSON(bytes, 4 * 1024 * 1024, { rejectNegativeZero: true }),
      ["format", "kind", "rulesBuildId", "data"],
    );
    if (
      !value ||
      Object.keys(value).sort().join() !== "data,format,kind,rulesBuildId" ||
      value.format !== "cave-portable-v1" ||
      value.rulesBuildId !== this.rulesBuildId ||
      typeof value.kind !== "string" ||
      !["checkpoint", "progress"].includes(value.kind)
    )
      throw Error("Incompatible cave save");
    if (
      value.kind === "progress" &&
      new TextEncoder().encode(bytes).length > 1024 * 1024
    )
      throw Error("Progress byte cap");
    const candidate = new CaveRescueOwner(
      validateCaveContent(
        value.kind === "checkpoint"
          ? (value.data as { content: unknown })?.content
          : (value.data as { checkpoint?: { content: unknown } })?.checkpoint
              ?.content,
      ),
      this.rulesBuildId,
    );
    if (value.kind === "checkpoint") candidate.restore(value.data);
    else candidate.restoreProgress(value.data);
    this.owner = candidate;
  }
}
