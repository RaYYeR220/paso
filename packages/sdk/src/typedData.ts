import { hashTypedData, type Hex } from "viem";
import { networkId, type Network } from "./networks";
import type { Call } from "./render";

export const DOMAIN_NAME = "Paso";
export const DOMAIN_VERSION = "1";

export const TYPES = {
  Authorization: [
    { name: "account", type: "string" },
    { name: "calls", type: "Call[]" },
    { name: "payload", type: "bytes32" },
  ],
  Call: [
    { name: "contract", type: "string" },
    { name: "fn", type: "string" },
    { name: "args", type: "string[]" },
  ],
} as const;

/** What the wallet is asked to sign. Accepted as is by viem's `signTypedData` and `hashTypedData`. */
export interface AuthorizationTypedData {
  /** No chain id and no verifying contract: the network id in `salt` separates networks. */
  domain: { name: typeof DOMAIN_NAME; version: typeof DOMAIN_VERSION; salt: Hex };
  types: typeof TYPES;
  primaryType: "Authorization";
  message: {
    /** Strkey of the account contract that will check the signature. */
    account: string;
    /** Every call being authorised, root first. */
    calls: Call[];
    /** The 32-byte Soroban authorisation payload: binds network, nonce, expiry and the full call tree. */
    payload: Hex;
  };
}

export interface AuthorizationInput {
  account: string;
  calls: Call[];
  payload: Hex;
  network: Network;
}

export function typedData({ account, calls, payload, network }: AuthorizationInput): AuthorizationTypedData {
  return {
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, salt: networkId(network) },
    types: TYPES,
    primaryType: "Authorization",
    message: { account, calls, payload },
  };
}

/** The EIP-712 digest the wallet signs and the account contract recomputes. */
export function digest(input: AuthorizationInput): Hex {
  return hashTypedData(typedData(input));
}
