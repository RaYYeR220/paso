"use client";

import { useEffect, useId, useRef } from "react";
import { MAINNET_CAUTION } from "./site";

/** Shown under the top bar for as long as a page is on mainnet. */
export function MainnetStrip() {
  return (
    <p className="mainnet-strip" role="note">
      <span className="mainnet-mark" aria-hidden="true" />
      {MAINNET_CAUTION}
    </p>
  );
}

export interface MainnetConfirmProps {
  /** True while mainnet has been asked for and not yet confirmed in this browser. */
  open: boolean;
  /** The most one transfer brings over on mainnet, as text: "25". */
  ceiling: string;
  onConfirm: () => void;
  onDecline: () => void;
}

/**
 * Asked once per browser, before anything on the page works with real funds.
 * Closing it any other way than by confirming is a no.
 */
export function MainnetConfirm({ open, ceiling, onConfirm, onDecline }: MainnetConfirmProps) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className="mainnet-dialog"
      aria-labelledby={`${id}-h`}
      onCancel={(event) => {
        event.preventDefault();
        onDecline();
      }}
    >
      <div className="mainnet-sheet">
        <h2 id={`${id}-h`}>Switch to mainnet</h2>
        <p>On mainnet everything here moves real USDC, between Base and Stellar.</p>
        <ul>
          <li>This software has not been audited. The contracts cannot be paused, upgraded or recovered. Use small amounts.</li>
          <li>You sign with your own wallet. The demo key and the faucet exist on testnet only.</li>
          <li>Your account on mainnet has a different Stellar address than on testnet.</li>
          <li>Bringing USDC over is limited to {ceiling} USDC a transfer in this app.</li>
        </ul>
        <div className="mainnet-actions">
          <button type="button" className="btn btn-slab" onClick={onConfirm}>
            Use mainnet
          </button>
          <button type="button" className="linkbtn" onClick={onDecline}>
            Stay on testnet
          </button>
        </div>
      </div>
    </dialog>
  );
}
