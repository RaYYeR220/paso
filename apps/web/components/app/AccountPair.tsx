"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { PairScene } from "./art/PairScene";
import { ExternalLink, Skeleton } from "./primitives";

export interface AccountPairProps {
  /** The Ethereum address in full; absent before a signer is chosen. */
  evmAddress?: string;
  /** Its Stellar account in full; absent while it is being derived. */
  stellarAddress?: string;
  /** USDC held on Stellar, formatted: "12.50". Absent while loading. */
  balance?: string;
  /** False when the account contract is not on the ledger yet. */
  deployed?: boolean;
  evmHref?: string;
  /** The chain `evmHref` leads to: "Base", "Arbitrum". */
  evmHrefLabel?: string;
  stellarHref?: string;
  /** A remark about the key itself: that it is a throwaway one, say. */
  evmNote?: string;
  /** False where the pair illustrates an account rather than reporting on one. */
  showBalance?: boolean;
}

interface SceneSize {
  width: number;
  height: number;
  passX: number;
}

const COMPACT_BELOW = 1100;
const INITIAL_SCENE: SceneSize = { width: 1440, height: 104, passX: 664 };

/** The two addresses of one key, a road between them, and what the Stellar side holds. */
export function AccountPair({
  evmAddress,
  stellarAddress,
  balance,
  deployed,
  evmHref,
  evmHrefLabel = "Base",
  stellarHref,
  evmNote,
  showBalance = true,
}: AccountPairProps) {
  const frame = useRef<HTMLDivElement>(null);
  const tag = useRef<HTMLSpanElement>(null);
  const [scene, setScene] = useState<SceneSize>(INITIAL_SCENE);

  useLayoutEffect(() => {
    const frameNode = frame.current;
    const tagNode = tag.current;
    if (!frameNode || !tagNode) return;

    const measure = () => {
      const box = frameNode.getBoundingClientRect();
      if (box.width === 0) return;
      const mark = tagNode.getBoundingClientRect();
      const passX = box.width < COMPACT_BELOW ? box.width * 0.47 : mark.left + mark.width / 2 - box.left;
      setScene((current) =>
        current.width === box.width && current.height === box.height && current.passX === passX
          ? current
          : { width: box.width, height: box.height, passX },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frameNode);
    observer.observe(tagNode);
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => observer.disconnect();
  }, []);

  return (
    <section className="pair" aria-label="Your account on both chains">
      <div className="pair-row">
        <div className="end">
          <span className="lbl">Ethereum</span>
          {evmAddress ? (
            <span className="addr">{evmAddress}</span>
          ) : (
            <span className="addr addr-empty">No key chosen yet</span>
          )}
          {evmAddress && (evmHref || evmNote) ? (
            <span className="end-meta">
              {evmHref ? <ExternalLink href={evmHref}>{evmHrefLabel}</ExternalLink> : null}
              {evmNote ? <span>{evmNote}</span> : null}
            </span>
          ) : null}
        </div>
        <div className="samekey">
          <span className="rd" />
          <span className="tag" ref={tag}>
            same key
          </span>
          <span className="rd" />
        </div>
        <div className="end">
          <span className="lbl">Stellar</span>
          {stellarAddress ? (
            <span className="addr">
              <span>{stellarAddress.slice(0, 28)}</span>
              <span>{stellarAddress.slice(28)}</span>
            </span>
          ) : evmAddress ? (
            <span className="addr">
              <Skeleton width="17em" />
              <Skeleton width="17em" />
            </span>
          ) : (
            <span className="addr addr-empty">Derived from the same key</span>
          )}
          {stellarAddress ? (
            <span className="end-meta">
              {stellarHref ? <ExternalLink href={stellarHref}>Stellar</ExternalLink> : null}
              {deployed === false ? <span>not deployed yet, can already receive</span> : null}
            </span>
          ) : null}
        </div>
        {evmAddress && showBalance ? (
          <div className="bal">
            <span className="lbl">Balance</span>
            <span className="num">
              {balance ?? <Skeleton width="3.4em" height="0.8em" />} <small>USDC</small>
            </span>
          </div>
        ) : null}
      </div>
      <div className="scene-frame" ref={frame}>
        <PairScene
          width={scene.width}
          height={scene.height}
          passX={scene.passX}
          evmAddress={evmAddress}
          stellarAddress={stellarAddress}
          compact={scene.width < COMPACT_BELOW}
        />
      </div>
    </section>
  );
}
