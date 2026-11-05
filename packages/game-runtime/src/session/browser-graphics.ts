/** Own browser graphics resources and listener lifetimes; presentation stays in the host. */
export interface BrowserGraphicsResource {
  init(): Promise<void>;
  dispose(): void;
  readonly canvas: EventTarget;
}
declare const graphicsLease: unique symbol;
/** An identity token; candidate resources and mutable lifecycle state remain private. */
export interface BrowserGraphicsLease {
  readonly [graphicsLease]: true;
}
export interface BrowserGraphicsOptions<T> {
  onContextLost?: (resource: T, event: Event) => void;
  /** Counts releases of adopted resources, including final owner disposal. */
  onActiveRelease?: (resource: T) => void;
}
interface ResourceLease<T> {
  resource: T;
  token: BrowserGraphicsLease;
  state: "pending" | "active" | "released";
  initialized: boolean;
  ready?: Promise<boolean>;
  listener?: AbortController;
}

export class BrowserGraphicsOwner<T extends BrowserGraphicsResource> {
  private readonly leases = new WeakMap<
    BrowserGraphicsLease,
    ResourceLease<T>
  >();
  private readonly resources = new WeakSet<T>();
  private activeLease?: ResourceLease<T>;
  private pendingLease?: ResourceLease<T>;
  private disposed = false;

  constructor(private readonly options: BrowserGraphicsOptions<T> = {}) {}
  get active(): T | undefined {
    return this.activeLease?.resource;
  }
  get pending(): T | undefined {
    return this.pendingLease?.resource;
  }
  begin(resource: T): BrowserGraphicsLease {
    if (this.resources.has(resource))
      throw Error("Graphics resource already owned");
    this.resources.add(resource);
    const token = Object.freeze({}) as BrowserGraphicsLease;
    const lease: ResourceLease<T> = {
      resource,
      token,
      state: "pending",
      initialized: false,
    };
    this.leases.set(token, lease);
    if (this.disposed) {
      this.release(lease);
      return token;
    }
    const previous = this.pendingLease;
    this.pendingLease = lease;
    try {
      if (previous) this.release(previous);
    } catch (error) {
      // A rejected replacement must not strand the newly supplied resource.
      if (this.pendingLease === lease) this.pendingLease = undefined;
      this.release(lease);
      throw error;
    }
    return token;
  }
  isCurrent(token: BrowserGraphicsLease): boolean {
    const lease = this.leases.get(token);
    return (
      !this.disposed &&
      lease !== undefined &&
      lease.state === "pending" &&
      this.pendingLease === lease
    );
  }
  ready(token: BrowserGraphicsLease): Promise<boolean> {
    const lease = this.leases.get(token);
    if (!lease || !this.isCurrent(token)) return Promise.resolve(false);
    lease.ready ??= this.initialize(lease);
    return lease.ready;
  }
  private async initialize(lease: ResourceLease<T>): Promise<boolean> {
    try {
      await lease.resource.init();
      lease.initialized = true;
      return this.isCurrent(lease.token);
    } catch (error) {
      // Leave a current failed candidate owned until the caller classifies the
      // failure and discards it. Stale init failures cannot affect a newer view.
      if (this.isCurrent(lease.token)) throw error;
      return false;
    }
  }
  /** Call after synchronous first-frame/UI preflight. No resource await belongs here.
   * Cleanup errors after transfer leave active pointing at the adopted candidate;
   * callers must inspect that identity before deciding whether UI can roll back. */
  publish(token: BrowserGraphicsLease): boolean {
    const lease = this.leases.get(token);
    if (!lease || !this.isCurrent(token)) return false;
    if (!lease.initialized) throw Error("Graphics candidate is not ready");
    const listener = new AbortController();
    try {
      // The resource may not expose a canvas until initialization has completed.
      lease.resource.canvas.addEventListener(
        "webglcontextlost",
        (event) => {
          if (
            this.disposed ||
            this.activeLease !== lease ||
            lease.state !== "active"
          )
            return;
          event.preventDefault();
          this.options.onContextLost?.(lease.resource, event);
        },
        { signal: listener.signal },
      );
    } catch (error) {
      listener.abort();
      throw error;
    }
    if (!this.isCurrent(token)) {
      listener.abort();
      return false;
    }
    const previous = this.activeLease;
    lease.listener = listener;
    lease.state = "active";
    this.activeLease = lease;
    this.pendingLease = undefined;
    if (previous) this.release(previous, true);
    return true;
  }
  discard(token: BrowserGraphicsLease): void {
    const lease = this.leases.get(token);
    if (!lease || lease.state !== "pending") return;
    if (this.pendingLease === lease) this.pendingLease = undefined;
    this.release(lease);
  }
  cancelPending(): void {
    const lease = this.pendingLease;
    this.pendingLease = undefined;
    if (lease) this.release(lease);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.cancelPending();
    } finally {
      const active = this.activeLease;
      this.activeLease = undefined;
      if (active) this.release(active, true);
    }
  }
  private release(lease: ResourceLease<T>, active = false): void {
    if (lease.state === "released") return;
    lease.state = "released";
    lease.listener?.abort();
    lease.listener = undefined;
    try {
      // Init owns late-allocation cleanup after this one cancellation signal.
      lease.resource.dispose();
    } finally {
      if (active) this.options.onActiveRelease?.(lease.resource);
    }
  }
}
