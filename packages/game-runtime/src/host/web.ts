import type { BrowserLifecyclePlatform } from "../session/browser-lifecycle.ts";
import {
  HostRequests,
  WEB_GAME_DECLARATION,
  type HostDeclaration,
  type CapabilityStatus,
  type DeviceOperation,
  type HostOutcome,
} from "./capabilities.ts";
export type CampaignStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface HostReadiness {
  ready: boolean;
  saving: "durable" | "memory";
  reason?: string;
}
export interface HostViewport {
  width: number;
  height: number;
  safeArea: { top: number; right: number; bottom: number; left: number };
}
export interface WebHostEnvironment {
  lifecycle: BrowserLifecyclePlatform;
  storage: () => CampaignStore;
  viewport: () => HostViewport;
  subscribeViewport?: (listener: () => void) => () => void;
  platformReady: { viewport: boolean; input: boolean };
  device: Partial<
    Record<
      DeviceOperation,
      (payload: string) => HostOutcome | Promise<HostOutcome>
    >
  >;
}
function browserEnvironment(element: HTMLElement): WebHostEnvironment {
  return {
    lifecycle: {
      window,
      document,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle),
    },
    storage: () => localStorage,
    viewport: () => {
      const probe = document.createElement("div");
      probe.style.cssText =
        "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
      document.documentElement.append(probe);
      try {
        const style = getComputedStyle(probe);
        const inset = (value: string) =>
          Math.max(0, Number.parseFloat(value) || 0);
        return {
          width: window.visualViewport?.width ?? window.innerWidth,
          height: window.visualViewport?.height ?? window.innerHeight,
          safeArea: {
            top: inset(style.paddingTop),
            right: inset(style.paddingRight),
            bottom: inset(style.paddingBottom),
            left: inset(style.paddingLeft),
          },
        };
      } finally {
        probe.remove();
      }
    },
    subscribeViewport: (listener) => {
      const targets: [EventTarget | null | undefined, string][] = [
        [window, "resize"],
        [window, "orientationchange"],
        [window.visualViewport, "resize"],
        [window.visualViewport, "scroll"],
        [window.screen?.orientation, "change"],
      ];
      for (const [target, event] of targets)
        target?.addEventListener(event, listener);
      // A monitor/DPR change need not change the CSS surface or fire its observer.
      let resolution: MediaQueryList | undefined;
      const changed = () => {
        watchResolution();
        listener();
      };
      const watchResolution = () => {
        resolution?.removeEventListener("change", changed);
        resolution = window.matchMedia?.(
          `(resolution: ${window.devicePixelRatio || 1}dppx)`,
        );
        resolution?.addEventListener("change", changed);
      };
      watchResolution();
      return () => {
        resolution?.removeEventListener("change", changed);
        for (const [target, event] of targets)
          target?.removeEventListener(event, listener);
      };
    },
    platformReady: {
      viewport:
        Number.isFinite(window.innerWidth) &&
        Number.isFinite(window.innerHeight),
      input: typeof window.addEventListener === "function",
    },
    device: {
      ...(element.requestFullscreen
        ? {
            fullscreen: async () => {
              await element.requestFullscreen();
              return "success" as const;
            },
          }
        : {}),
      ...(navigator.vibrate
        ? {
            haptics: () =>
              navigator.vibrate(30)
                ? ("success" as const)
                : ("denied" as const),
          }
        : {}),
      ...(navigator.share
        ? {
            share: async (text: string) => {
              await navigator.share({ text });
              return "success" as const;
            },
          }
        : {}),
    },
  };
}
/** Synchronous web storage preserves CampaignStorage's exact publication/conflict contract. */
export class WebHost {
  readonly requests: HostRequests;
  readonly lifecycle: BrowserLifecyclePlatform;
  readonly capabilities: Readonly<Record<string, CapabilityStatus>>;
  private disposed = false;
  private replay = false;
  private probed = false;
  private readinessListeners = new Set<(state: HostReadiness) => void>();
  private viewportSubscriptions = new Set<() => void>();
  private saving: "durable" | "memory" = "memory";
  readonly declaration: HostDeclaration;
  constructor(
    element: HTMLElement,
    declaration: HostDeclaration = WEB_GAME_DECLARATION,
    private readonly environment: WebHostEnvironment = browserEnvironment(
      element,
    ),
  ) {
    this.declaration = Object.freeze({
      ...declaration,
      required: Object.freeze([...declaration.required]),
      optional: Object.freeze([...declaration.optional]),
    });
    this.lifecycle = environment.lifecycle;
    this.capabilities = Object.freeze({
      lifecycle: "supported",
      storage: "supported",
      viewport: environment.platformReady.viewport
        ? "supported"
        : "unavailable",
      input: environment.platformReady.input ? "supported" : "unavailable",
      fullscreen: environment.device.fullscreen ? "supported" : "unavailable",
      haptics: environment.device.haptics ? "experimental" : "unavailable",
      share: environment.device.share ? "supported" : "unavailable",
      orientation: "unavailable",
      purchases: "unavailable",
      ads: "unavailable",
      cloudSave: "unavailable",
    });
    this.requests = new HostRequests((request, reply) => {
      if (!this.declaration.optional.includes(request.operation)) {
        reply({
          id: request.id,
          session: request.session,
          scene: request.scene,
          operation: request.operation,
          outcome: "unsupported",
        });
        return;
      }
      const action = environment.device[request.operation];
      if (!action) {
        reply({
          id: request.id,
          session: request.session,
          scene: request.scene,
          operation: request.operation,
          outcome: "unsupported",
        });
        return;
      }
      void Promise.resolve()
        .then(() => {
          if (this.disposed || this.replay || !this.requests.isCurrent(request))
            return "cancelled" as const;
          return action(request.payload);
        })
        .then(
          (outcome) =>
            reply({
              id: request.id,
              session: request.session,
              scene: request.scene,
              operation: request.operation,
              outcome,
            }),
          (error) =>
            reply({
              id: request.id,
              session: request.session,
              scene: request.scene,
              operation: request.operation,
              outcome: this.failure(error),
            }),
        );
    });
  }
  private failure(error: unknown): HostOutcome {
    const name = error instanceof Error ? error.name : "";
    return name === "AbortError"
      ? "cancelled"
      : name === "NotAllowedError" || name === "SecurityError"
        ? "denied"
        : "transient-failure";
  }
  currentReadiness(): HostReadiness {
    if (this.disposed)
      return { ready: false, saving: this.saving, reason: "Host disposed" };
    const ready =
      this.declaration.required.every(
        (name) => this.capabilities[name] === "supported",
      ) &&
      (this.saving === "durable" ||
        this.declaration.durableStorage === "memory-fallback");
    return {
      ready,
      saving: this.saving,
      ...(this.saving === "memory"
        ? { reason: "Durable storage unavailable; export progress to keep it." }
        : {}),
    };
  }
  private storageOutcome(saving: "durable" | "memory"): void {
    this.probed = true;
    if (this.saving === saving) return;
    this.saving = saving;
    for (const listener of this.readinessListeners) {
      // Observers cannot change the storage result or mask its original exception.
      try {
        listener(this.currentReadiness());
      } catch {
        /* UI observer failure */
      }
    }
  }
  readiness(): HostReadiness {
    if (this.probed || this.disposed || this.replay)
      return this.currentReadiness();
    this.probed = true;
    try {
      const store = this.environment.storage(),
        key = "pocket-game:host-readiness",
        previous = store.getItem(key);
      try {
        store.setItem(key, "ready");
      } finally {
        if (previous === null) store.removeItem(key);
        else store.setItem(key, previous);
      }
      this.storageOutcome("durable");
    } catch {
      this.storageOutcome("memory");
    }
    return this.currentReadiness();
  }
  subscribeReadiness(listener: (state: HostReadiness) => void): () => void {
    if (!this.disposed) this.readinessListeners.add(listener);
    listener(this.currentReadiness());
    return () => {
      this.readinessListeners.delete(listener);
    };
  }
  viewport(): HostViewport {
    const value = this.environment.viewport();
    const numbers = [
      value.width,
      value.height,
      value.safeArea.top,
      value.safeArea.right,
      value.safeArea.bottom,
      value.safeArea.left,
    ];
    if (
      numbers.some(
        (number) =>
          !Number.isFinite(number) || number < 0 || number > 1_000_000,
      )
    )
      throw new Error("Invalid host viewport metrics");
    return {
      width: value.width,
      height: value.height,
      safeArea: { ...value.safeArea },
    };
  }
  observeViewport(listener: (viewport: HostViewport) => void): () => void {
    if (this.disposed) return () => {};
    listener(this.viewport());
    let active = true;
    const detach = this.environment.subscribeViewport?.(() => {
      if (!active || this.disposed) return;
      let value: HostViewport;
      try {
        value = this.viewport();
      } catch {
        return;
      }
      listener(value);
    });
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      detach?.();
      this.viewportSubscriptions.delete(unsubscribe);
    };
    this.viewportSubscriptions.add(unsubscribe);
    return unsubscribe;
  }
  /** Do not cache storage: denial and later failures retain the original exceptions. */
  readonly storage = (): CampaignStore => {
    const available = () => {
      if (this.disposed || this.replay)
        throw new Error("Host side effects suppressed");
    };
    available();
    let store: CampaignStore;
    try {
      store = this.environment.storage();
    } catch (error) {
      this.storageOutcome("memory");
      throw error;
    }
    const execute = <T>(operation: () => T, write = false): T => {
      available();
      try {
        const result = operation();
        if (write) this.storageOutcome("durable");
        return result;
      } catch (error) {
        this.storageOutcome("memory");
        throw error;
      }
    };
    return {
      getItem: (key) => execute(() => store.getItem(key)),
      setItem: (key, value) => execute(() => store.setItem(key, value), true),
      removeItem: (key) => execute(() => store.removeItem(key)),
    };
  };
  sceneChanged(): void {
    this.requests.sceneChanged();
  }
  setReplay(value: boolean): void {
    this.replay = value;
    this.requests.setReplay(value);
  }
  disconnect(): void {
    this.requests.disconnect();
    this.dispose();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.requests.dispose();
    for (const unsubscribe of [...this.viewportSubscriptions]) unsubscribe();
    for (const listener of this.readinessListeners) {
      try {
        listener(this.currentReadiness());
      } catch {
        /* UI observer failure */
      }
    }
    this.readinessListeners.clear();
  }
}
