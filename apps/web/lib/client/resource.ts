import { describeFailure } from "./errors";
import { createStore, type Listener } from "./store";

/** Something read from the network: what is known, how fresh it is, and what went wrong last. */
export interface ResourceState<T> {
  /** `ready` once a read has succeeded; it stays `ready` when a later read fails. */
  status: "idle" | "loading" | "ready" | "error";
  data: T | null;
  /** Why the latest read failed, or `null`. Older data is kept next to it. */
  error: string | null;
  /** When `data` was read, in milliseconds. */
  updatedAt: number | null;
  /** True while a read is under way. */
  refreshing: boolean;
}

export interface Resource<T> {
  getState(): ResourceState<T>;
  /** Watching starts the reads: the first watcher triggers one, the last to leave stops the interval. */
  subscribe(listener: Listener): () => void;
  /** Reads now. Calls made while a read is under way share it. */
  refresh(): Promise<void>;
}

/** The page's clock and visibility, so tests can drive both. */
export interface ResourceEnvironment {
  now(): number;
  isVisible(): boolean;
  /** Calls back whenever the page becomes visible again. */
  onVisible(callback: () => void): () => void;
  every(ms: number, callback: () => void): () => void;
}

export const browserEnvironment: ResourceEnvironment = {
  now: () => Date.now(),
  isVisible: () => typeof document === "undefined" || document.visibilityState === "visible",
  onVisible(callback) {
    if (typeof document === "undefined") return () => undefined;
    const listener = () => {
      if (document.visibilityState === "visible") callback();
    };
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    return () => clearInterval(timer);
  },
};

export interface ResourceOptions {
  /** Read again this often while someone is watching and the page is visible. Omit to read on demand only. */
  intervalMs?: number;
  environment?: ResourceEnvironment;
}

const IDLE: ResourceState<never> = { status: "idle", data: null, error: null, updatedAt: null, refreshing: false };

export function idleResource<T>(): ResourceState<T> {
  return IDLE;
}

/**
 * Wraps a read in a watchable value that refreshes on demand and, while the
 * page is visible and someone is watching, on an interval. A hidden tab makes
 * no requests; coming back to it reads once straight away.
 */
export function createResource<T>(load: () => Promise<T>, options: ResourceOptions = {}): Resource<T> {
  const { intervalMs, environment = browserEnvironment } = options;
  const store = createStore<ResourceState<T>>(IDLE);
  let watchers = 0;
  let stop: (() => void) | null = null;
  let reading: Promise<void> | null = null;

  function refresh(): Promise<void> {
    reading ??= (async () => {
      const before = store.get();
      store.set({ ...before, status: before.status === "idle" ? "loading" : before.status, refreshing: true });
      try {
        const data = await load();
        store.set({ status: "ready", data, error: null, updatedAt: environment.now(), refreshing: false });
      } catch (error) {
        const current = store.get();
        store.set({
          ...current,
          status: current.data === null ? "error" : "ready",
          error: describeFailure(error).message,
          refreshing: false,
        });
      } finally {
        reading = null;
      }
    })();
    return reading;
  }

  function start(): void {
    const stops: (() => void)[] = [];
    if (intervalMs) {
      stops.push(
        environment.every(intervalMs, () => {
          if (environment.isVisible()) void refresh();
        }),
      );
      stops.push(environment.onVisible(() => void refresh()));
    }
    stop = () => stops.forEach((end) => end());
    if (environment.isVisible() || store.get().status === "idle") void refresh();
  }

  return {
    getState: store.get,
    subscribe(listener) {
      const unsubscribe = store.subscribe(listener);
      watchers += 1;
      if (watchers === 1) start();
      return () => {
        unsubscribe();
        watchers -= 1;
        if (watchers === 0) {
          stop?.();
          stop = null;
        }
      };
    },
    refresh,
  };
}

/** One resource per key, created on first use and shared by everyone who asks for that key. */
export function keyedResources<T>(create: (key: string) => Resource<T>): (key: string) => Resource<T> {
  const resources = new Map<string, Resource<T>>();
  return (key) => {
    let resource = resources.get(key);
    if (!resource) {
      resource = create(key);
      resources.set(key, resource);
    }
    return resource;
  };
}
