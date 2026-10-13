import type { NetworkName } from "paso-sdk";
import Link from "next/link";

export interface TopBarProps {
  /** The network the page is on. Absent while that is not known yet: nothing is claimed then. */
  network?: NetworkName;
  /** Switches the page to another network. Without it the network is shown and cannot be changed here. */
  onNetworkChange?: (network: NetworkName) => void;
  /** The address that signs, already shortened; absent before one is chosen. */
  signer?: string;
  /** A wallet, or the throwaway key kept in this browser. */
  signerKind?: "wallet" | "demo";
  /** Label of the control that lets go of the signer. */
  leaveLabel?: string;
  onLeave?: () => void;
  links?: readonly { href: string; label: string }[];
}

const NETWORKS: readonly { name: NetworkName; label: string }[] = [
  { name: "testnet", label: "Testnet" },
  { name: "mainnet", label: "Mainnet" },
];

export function TopBar({
  network,
  onNetworkChange,
  signer,
  signerKind = "wallet",
  leaveLabel = "Disconnect",
  onLeave,
  links = [],
}: TopBarProps) {
  return (
    <header className="bar">
      <Link className="wordmark" href="/" prefetch={false} aria-label="Paso, home">
        Paso
      </Link>
      {network && onNetworkChange ? (
        <fieldset className="netswitch">
          <legend className="vh">Network</legend>
          {NETWORKS.map(({ name, label }) => (
            <label key={name}>
              <input type="radio" name="paso-network" value={name} checked={network === name} onChange={() => onNetworkChange(name)} />
              <span data-network={name}>{label}</span>
            </label>
          ))}
        </fieldset>
      ) : network ? (
        <span className="net" data-network={network}>
          {network === "mainnet" ? "Mainnet" : "Testnet"}
        </span>
      ) : null}
      {links.length > 0 ? (
        <nav className="barlinks" aria-label="Paso">
          {links.map((link) => (
            <Link key={link.href} href={link.href}>
              {link.label}
            </Link>
          ))}
        </nav>
      ) : null}
      {signer ? (
        <div className="who-group">
          <span className="who" title={signerKind === "demo" ? "Throwaway key kept in this browser" : "Connected wallet"}>
            <i aria-hidden="true" />
            {signerKind === "demo" ? <span className="who-kind">Demo key</span> : null}
            {signer}
          </span>
          {onLeave ? (
            <button type="button" className="linkbtn" onClick={onLeave}>
              {leaveLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
