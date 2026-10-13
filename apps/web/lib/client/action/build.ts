import { DEFAULT_EVM_CHAIN, parseStellarAmount, twinAddress, type Action, type NetworkConfig } from "paso-sdk";
import { chainOf } from "../chains";
import type { Address } from "viem";
import { NameNotFoundError } from "../ens";
import { parseOwnerInput, parseRecipient } from "../parse";
import type { ActionRequest, Recipient } from "./machine";

export interface BuiltAction {
  /** The SDK action to prepare. */
  action: Action;
  recipient: Recipient | null;
  /** USDC moved, in 7-decimal units; `null` for a generic call. */
  amount: bigint | null;
}

export interface BuildContext {
  network: NetworkConfig;
  /** Resolves an ENS name to an address, or to `null` when it has none. */
  resolveName: (name: string) => Promise<Address | null>;
}

function units(amount: string | bigint): bigint {
  const value = typeof amount === "bigint" ? amount : parseStellarAmount(amount);
  if (value <= 0n) throw new Error("Enter an amount above zero");
  return value;
}

async function addressOf(name: string, resolveName: BuildContext["resolveName"]): Promise<Address> {
  const address = await resolveName(name);
  if (!address) throw new NameNotFoundError(name);
  return address;
}

/**
 * Turns what was typed into the call to prepare. An Ethereum address or ENS
 * name as the recipient of a transfer stands for that address's Stellar
 * account. Invalid input is refused here, before the network is asked.
 */
export async function buildAction(request: ActionRequest, context: BuildContext): Promise<BuiltAction> {
  const { network, resolveName } = context;

  switch (request.kind) {
    case "transfer": {
      const parsed = parseRecipient(request.to);
      const input = request.to.trim();
      let recipient: Recipient;
      switch (parsed.kind) {
        case "empty":
          throw new Error("Enter who receives the USDC");
        case "invalid":
          throw new Error(parsed.reason);
        case "stellar":
          recipient = { input, kind: "stellar", stellar: parsed.address };
          break;
        case "address":
          recipient = { input, kind: "evm", evm: parsed.address, stellar: twinAddress(parsed.address, network) };
          break;
        case "ens": {
          const evm = await addressOf(parsed.name, resolveName);
          recipient = { input, kind: "ens", name: parsed.name, evm, stellar: twinAddress(evm, network) };
          break;
        }
      }
      const amount = units(request.amount);
      return { action: { kind: "transfer", to: recipient.stellar!, amount }, recipient, amount };
    }

    case "exit": {
      const destination = chainOf(network, request.chain ?? DEFAULT_EVM_CHAIN);
      const parsed = parseOwnerInput(request.recipient);
      const input = request.recipient.trim();
      let recipient: Recipient & { evm: Address };
      switch (parsed.kind) {
        case "empty":
          throw new Error(`Enter the Ethereum address that receives the USDC on ${destination.label}`);
        case "invalid":
          throw new Error(parsed.reason);
        case "address":
          recipient = { input, kind: "evm", evm: parsed.address };
          break;
        case "ens":
          recipient = { input, kind: "ens", name: parsed.name, evm: await addressOf(parsed.name, resolveName) };
          break;
      }
      const amount = units(request.amount);
      return {
        action: { kind: "exit", amount, recipient: recipient.evm, destinationChain: destination.name },
        recipient,
        amount,
      };
    }

    case "invoke":
      return {
        action: { kind: "invoke", contract: request.contract, fn: request.fn, args: request.args },
        recipient: null,
        amount: null,
      };
  }
}
