import Link from "next/link";

export interface TopBarProps {
  /** "Testnet" or "Mainnet". */
  network: string;
  /** The address that signs, already shortened; absent before one is chosen. */
  signer?: string;
  /** A wallet, or the throwaway key kept in this browser. */
  signerKind?: "wallet" | "demo";
  /** Label of the control that lets go of the signer. */
  leaveLabel?: string;
  onLeave?: () => void;
  links?: readonly { href: string; label: string }[];
}

export function TopBar({ network, signer, signerKind = "wallet", leaveLabel = "Disconnect", onLeave, links = [] }: TopBarProps) {
  return (
    <header className="bar">
      <Link className="wordmark" href="/" prefetch={false} aria-label="Paso, home">
        Paso
      </Link>
      <span className="net">{network}</span>
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
