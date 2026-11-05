/** One outcome per field-slide attempt; unfinished attempts and windows are censored. */
export class SlideTracker {
  active = new Map();
  whiffs = [];
  attempts = 0;
  intercepts = 0;
  contacts = 0;
  observe(previous, current, events) {
    for (const e of events) {
      if (e.type === "slide" && e.playerId) {
        this.attempts++;
        this.active.set(e.playerId, {
          playerId: e.playerId,
          team: e.team,
          startTick: e.tick,
          intercept: false,
        });
      }
      if (
        (e.type === "slide-contact" || e.type === "slide-block") &&
        e.playerId
      ) {
        this.contacts++;
        const attempt = this.active.get(e.playerId);
        if (attempt && !attempt.intercept) {
          attempt.intercept = true;
        }
      }
    }
    for (const [id, attempt] of this.active) {
      const p = current.players.find((p) => p.id === id);
      if (!p?.slideTicks || current.phase !== "play") {
        if (attempt.intercept) this.intercepts++;
        if (!attempt.intercept)
          this.whiffs.push({
            ...attempt,
            endTick: current.tick,
            conceded: false,
          });
        this.active.delete(id);
      }
    }
    for (const whiff of this.whiffs) {
      if (
        current.tick - whiff.endTick <= 120 &&
        current.score[1 - whiff.team] > previous.score[1 - whiff.team]
      )
        whiff.conceded = true;
    }
  }
  result(tick) {
    const observed = this.whiffs.filter((w) => tick - w.endTick >= 120);
    return {
      attempts: this.attempts,
      intercepts: this.intercepts,
      contacts: this.contacts,
      whiffs: this.whiffs.length,
      pendingAttempts: this.active.size,
      interceptFraction:
        this.attempts - this.active.size
          ? this.intercepts / (this.attempts - this.active.size)
          : null,
      whiffsWithFullTwoSecondWindow: observed.length,
      whiffsConcedingWithinTwoSeconds: observed.filter((w) => w.conceded)
        .length,
      whiffPenaltyFraction: observed.length
        ? observed.filter((w) => w.conceded).length / observed.length
        : null,
      censoredWhiffWindows: this.whiffs.length - observed.length,
    };
  }
}
