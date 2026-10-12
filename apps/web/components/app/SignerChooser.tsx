import type { ReactNode } from "react";

export interface WalletOption {
  id: string;
  name: string;
}

export interface SignerChooserProps {
  /** The wallets found in this browser. */
  wallets: readonly WalletOption[];
  onConnect: (walletId: string) => void;
  /** The wallet being connected right now. */
  connectingId?: string;
  onTryWithoutWallet: () => void;
  /** True while the throwaway key is being set up. */
  startingDemo?: boolean;
  /** A problem with the last attempt. */
  status?: ReactNode;
}

/** The first decision: which key crosses. A wallet the visitor already has, or a throwaway one. */
export function SignerChooser({ wallets, onConnect, connectingId, onTryWithoutWallet, startingDemo = false, status }: SignerChooserProps) {
  const busy = connectingId !== undefined || startingDemo;
  return (
    <section className="chooser" aria-labelledby="chooser-h">
      <div className="chooser-lead">
        <h1 id="chooser-h">Which key crosses?</h1>
        <p>
          Your Ethereum address already has a Stellar account. Paso derives it from the address; the same key signs for
          both.
        </p>
        {status}
      </div>
      <div className="chooser-ways">
        <div className="way">
          <h2>Connect an EVM wallet</h2>
          <p>MetaMask, Rabby, Coinbase Wallet or a Ledger. Nothing to install, no seed phrase, no XLM.</p>
          {wallets.length > 0 ? (
            <ul className="wallets">
              {wallets.map((wallet) => (
                <li key={wallet.id}>
                  <button type="button" className="btn" disabled={busy} onClick={() => onConnect(wallet.id)}>
                    {connectingId === wallet.id ? `Opening ${wallet.name}` : wallet.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="way-none">No wallet was found in this browser. Install one, or take the other road.</p>
          )}
        </div>
        <div className="way">
          <h2>Try it without a wallet</h2>
          <p>
            A throwaway key is created in this browser and funded with test USDC. It signs the same readable messages a
            wallet would, and is only as safe as this tab.
          </p>
          <button type="button" className="btn btn-outline" disabled={busy} onClick={onTryWithoutWallet}>
            {startingDemo ? "Creating a key" : "Try it without a wallet"}
          </button>
        </div>
      </div>
    </section>
  );
}
