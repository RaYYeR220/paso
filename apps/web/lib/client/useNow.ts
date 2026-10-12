"use client";

import { useSyncExternalStore } from "react";
import { noSubscription, type Listener } from "./store";

/** A clock that ticks only while someone is watching it. */
function createClock(intervalMs: number) {
  const listeners = new Set<Listener>();
  let current: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    current = Date.now();
    for (const listener of [...listeners]) listener();
  };

  return {
    get: () => current,
    subscribe(listener: Listener) {
      listeners.add(listener);
      if (listeners.size === 1) {
        current = Date.now();
        timer = setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) clearInterval(timer);
      };
    },
  };
}

const seconds = createClock(1_000);
const slow = createClock(15_000);

const none = () => null;

/**
 * The current time in milliseconds, updated every second (`"second"`) or
 * every quarter of a minute (`"slow"`), for timers and "2 min ago". It is
 * `null` on the server and during hydration, and it stops ticking when
 * `active` is false.
 */
export function useNow(pace: "second" | "slow" = "second", active = true): number | null {
  const clock = pace === "second" ? seconds : slow;
  return useSyncExternalStore(active ? clock.subscribe : noSubscription, active ? clock.get : none, none);
}
