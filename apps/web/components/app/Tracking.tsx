"use client";

import { useId, useState, type FormEvent, type ReactNode } from "react";

export interface StopTrackingProps {
  /** What stopping means for the money: it is still the owner's, and where to see it. */
  children: ReactNode;
  onStop: () => void;
}

/**
 * Taking a transfer in flight off the screen. It asks twice, because the
 * tracker is the easy way to see the money arrive, and says what does not
 * change: the USDC.
 */
export function StopTracking({ children, onStop }: StopTrackingProps) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="linkbtn" onClick={() => setAsking(true)}>
        Stop tracking
      </button>
    );
  }
  return (
    <span className="stop" role="group" aria-label="Stop tracking this transfer">
      <span>{children}</span>
      <button type="button" className="linkbtn" onClick={onStop}>
        Stop tracking it
      </button>
      <button type="button" className="linkbtn" onClick={() => setAsking(false)}>
        Keep following
      </button>
    </span>
  );
}

export interface FollowBurnProps {
  /** Starts following the burn; false when the text is not a transaction hash or another burn is being followed. */
  onFollow: (hash: string) => boolean;
  /** Name of the chain the burn was made on. */
  chain: string;
}

/** Following a burn by its transaction hash: one made elsewhere, or one the wallet never confirmed. */
export function FollowBurn({ onFollow, chain }: FollowBurnProps) {
  const id = useId();
  const [hash, setHash] = useState("");
  const [refused, setRefused] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setRefused(!onFollow(hash.trim()));
  };

  return (
    <form className="follow" onSubmit={submit}>
      <label className="vh" htmlFor={`${id}-hash`}>
        Burn transaction on {chain}
      </label>
      <span className="field" data-invalid={refused || undefined}>
        <input
          id={`${id}-hash`}
          type="text"
          value={hash}
          placeholder="0x… burn transaction"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={refused || undefined}
          aria-describedby={refused ? `${id}-problem` : undefined}
          onChange={(event) => setHash(event.target.value)}
        />
      </span>
      <button type="submit" className="btn btn-inline">
        Follow
      </button>
      {refused ? (
        <span id={`${id}-problem`} data-tone="problem" role="alert">
          That is not a transaction hash: 0x and 64 hex digits.
        </span>
      ) : null}
    </form>
  );
}
