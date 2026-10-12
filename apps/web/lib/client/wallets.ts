/** A wallet the visitor can connect. */
export interface WalletOption {
  /** Pass this to `connect(id)`. */
  id: string;
  name: string;
  /**
   * Whether choosing it can work right now. A browser wallet is ready once
   * the browser has one; Coinbase Wallet always is, since it can also open on
   * a phone. `false` on the server and in the first render, where the browser
   * has not been asked yet.
   */
  ready: boolean;
  icon?: string;
}

/** The part of a wagmi connector the list is made from. */
export interface ConnectorLike {
  id: string;
  name: string;
  type: string;
  icon?: string;
}

/** The connector for whatever sits at `window.ethereum`, when no wallet has introduced itself by name. */
export const GENERIC_INJECTED_ID = "injected";

/** A wallet the browser announced itself (EIP-6963), as opposed to one named in the configuration. */
export function isDiscovered(connector: ConnectorLike): boolean {
  return connector.type === "injected" && connector.id !== GENERIC_INJECTED_ID;
}

/**
 * The wallets to offer. Wallets that announced themselves are listed by
 * name, and the generic "browser wallet" entry is dropped once any has: it
 * would be the same wallet twice.
 */
export function walletOptions(connectors: readonly ConnectorLike[], injectedProviderPresent: boolean): WalletOption[] {
  const anyDiscovered = connectors.some(isDiscovered);
  return connectors
    .filter((connector) => !(anyDiscovered && connector.id === GENERIC_INJECTED_ID))
    .map((connector) => ({
      id: connector.id,
      name: connector.id === GENERIC_INJECTED_ID ? "Browser wallet" : connector.name,
      ready: connector.id === GENERIC_INJECTED_ID ? injectedProviderPresent : true,
      ...(connector.icon ? { icon: connector.icon } : {}),
    }));
}

/**
 * Which connector a click on "connect" means: the one named, else the first
 * wallet that announced itself, else the browser's, else whatever is first.
 */
export function pickConnector<T extends ConnectorLike>(connectors: readonly T[], connectorId?: string): T | undefined {
  return (
    connectors.find((candidate) => candidate.id === connectorId) ??
    (connectorId === undefined
      ? (connectors.find(isDiscovered) ?? connectors.find((candidate) => candidate.id === GENERIC_INJECTED_ID) ?? connectors[0])
      : undefined)
  );
}
