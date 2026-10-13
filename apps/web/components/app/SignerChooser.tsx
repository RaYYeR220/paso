import type { NetworkName } from "@paso/sdk";
import type { ReactNode } from "react";

export interface WalletOption {
  id: string;
  name: string;
}

export interface SignerChooserProps {
  /** The network the key will sign on. Mainnet takes a wallet and nothing else. */
  network: NetworkName;
  /** The wallets found in this browser. */
  wallets: readonly WalletOption[];
  onConnect: (walletId: string) => void;
  /** The wallet being connected right now. */
  connectingId?: string;
  /** Starts the no-wallet demo. It exists on testnet only. */
  onTryWithoutWallet: () => void;
  /** On mainnet: goes to testnet, where the no-wallet demo is. */
  onUseTestnet: () => void;
  /** True while the throwaway key is being set up. */
  startingDemo?: boolean;
  /** A problem with the last attempt. */
  status?: ReactNode;
}

/** The first decision: which key crosses. A wallet the visitor already has, or on testnet a throwaway one. */
export function SignerChooser({
  network,
  wallets,
  onConnect,
  connectingId,
  onTryWithoutWallet,
  onUseTestnet,
  startingDemo = false,
  status,
}: SignerChooserProps) {
  const busy = connectingId !== undefined || startingDemo;
  const mainnet = network === "mainnet";
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
          <p>
            {mainnet
              ? "A regular wallet: MetaMask, Rabby, Coinbase Wallet or a Ledger. A smart-contract wallet cannot sign for a Stellar account."
              : "MetaMask, Rabby, Coinbase Wallet or a Ledger. Nothing to install, no seed phrase, no XLM."}
          </p>
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
            <p className="way-none">
              {mainnet ? "No wallet was found in this browser. Install one to use mainnet." : "No wallet was found in this browser. Install one, or take the other road."}
            </p>
          )}
        </div>
        {mainnet ? (
          <div className="way">
            <h2>No wallet? Use testnet</h2>
            <p>
              Trying Paso without a wallet works on testnet only. The demo key is kept in this browser in the open, so it
              must never hold real USDC.
            </p>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={onUseTestnet}>
              Switch to testnet
            </button>
          </div>
        ) : (
          <div className="way">
            <h2>Try it without a wallet</h2>
            <p>
              Testnet only. A throwaway key is created in this browser and funded with test USDC. It signs the same
              readable messages a wallet would, and is only as safe as this tab.
            </p>
            <button type="button" className="btn btn-outline" disabled={busy} onClick={onTryWithoutWallet}>
              {startingDemo ? "Creating a key" : "Try it without a wallet"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
