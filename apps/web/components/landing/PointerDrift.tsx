"use client";

import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";

/**
 * A header that publishes the pointer's horizontal position as `--drift`
 * (−1…1, eased), for the layers of the scene inside it to shift against.
 */
export function PointerDrift({ className, children }: { className?: string; children: ReactNode }) {
  const header = useRef<HTMLElement>(null);
  const motion = useRef({ at: 0, target: 0, frame: 0 });

  useEffect(() => {
    const state = motion.current;
    return () => cancelAnimationFrame(state.frame);
  }, []);

  function step() {
    const state = motion.current;
    state.at += (state.target - state.at) * 0.09;
    const settled = Math.abs(state.target - state.at) < 0.002;
    header.current?.style.setProperty("--drift", (settled ? state.target : state.at).toFixed(4));
    state.frame = settled ? 0 : requestAnimationFrame(step);
  }

  function steer(target: number) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const state = motion.current;
    state.target = target;
    if (!state.frame) state.frame = requestAnimationFrame(step);
  }

  function follow(event: PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") steer(-(event.clientX / window.innerWidth - 0.5) * 2);
  }

  return (
    <header ref={header} className={className} onPointerMove={follow} onPointerLeave={() => steer(0)}>
      {children}
    </header>
  );
}
