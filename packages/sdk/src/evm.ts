import { StrKey } from "@stellar/stellar-sdk";
import {
  concat,
  numberToHex,
  stringToHex,
  toHex,
  zeroHash,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { decodeBurnMessage, FAST_FINALITY, fetchBurnFee, maxFeeFor, STANDARD_FINALITY } from "./iris";
import { evmChain, resolveNetwork, type EvmChainConfig, type EvmChainName, type Network } from "./networks";
import { twinAddress, twinContractId } from "./twin";

export const erc20Abi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const tokenMessengerAbi = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const messageTransmitterAbi = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "usedNonces",
    stateMutability: "view",
    inputs: [{ name: "nonce", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * How USDC burned on an EVM chain reaches a Stellar account.
 *
 * - `forwarder`: mint to Circle's CctpForwarder, which passes the USDC on to
 *   the account named in the hook data. This is the route Circle documents.
 * - `direct`: mint straight to the account's contract id.
 */
export type InboundRoute = "forwarder" | "direct";

export const DEFAULT_INBOUND_ROUTE: InboundRoute = "forwarder";

const HOOK_DATA_VERSION = 0;

/**
 * Hook data that tells Circle's CctpForwarder where to send the minted USDC.
 *
 *   bytes  0–23  reserved, zero
 *   bytes 24–27  hook data version, big-endian u32, 0
 *   bytes 28–31  byte length of the recipient, big-endian u32
 *   bytes 32–    the recipient strkey as UTF-8 text
 *
 * Layout from circlefin/stellar-cctp: `contracts/cctp-forwarder/src/message.rs`
 * (the parser) and `examples/stellar-utils.ts` (`buildCctpForwarderHookData`).
 */
export function forwardRecipientHookData(recipient: string): Hex {
  const valid =
    StrKey.isValidContract(recipient) ||
    StrKey.isValidEd25519PublicKey(recipient) ||
    StrKey.isValidMed25519PublicKey(recipient);
  if (!valid) {
    throw new Error(`"${recipient}" is not a Stellar address (expected C…, G… or M…)`);
  }
  const text = stringToHex(recipient);
  return concat([
    toHex(0, { size: 24 }),
    numberToHex(HOOK_DATA_VERSION, { size: 4 }),
    numberToHex((text.length - 2) / 2, { size: 4 }),
    text,
  ]);
}

/** The part of a viem public client used to read an EVM chain. Clients for any chain fit. */
export type EvmReader = Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;

export interface FundFromEvmArgs {
  /** Pays the USDC and the gas. Must have its account set and be connected to the chain the USDC leaves. */
  walletClient: WalletClient;
  publicClient: EvmReader;
  /**
   * USDC to burn, in 6-decimal units: the USDC token's units on every chain,
   * Arc included, where the native balance counts the same USDC in 18.
   */
  amount: bigint;
  /** The Ethereum address whose Stellar account receives the USDC. It need not be the payer. */
  owner: Address;
  network: Network;
  /** The chain the USDC leaves. Defaults to Base. */
  chain?: EvmChainName;
  route?: InboundRoute;
  /**
   * Defaults to a fast transfer where Circle offers one from the chain, and
   * to a standard transfer elsewhere (Arc), which is attested within seconds
   * there and costs nothing.
   */
  minFinalityThreshold?: number;
  /** Fee cap in 6-decimal units. Defaults to Circle's current fee for the finality asked for, plus headroom. */
  maxFee?: bigint;
}

export interface FundFromEvmResult {
  burnTxHash: Hex;
  /** Present when an approval had to be sent first. */
  approveTxHash?: Hex;
  route: InboundRoute;
  /** The Stellar account being funded. */
  twin: string;
  maxFee: bigint;
}

/**
 * A transaction was included on an EVM chain and reverted. This is a known
 * outcome: unlike a timeout or a transport error, it says the transaction did
 * not do what it was sent for and never will.
 */
export class TransactionRevertedError extends Error {
  constructor(
    readonly hash: Hex,
    what: string,
    /** The chain, by the name it has on every network: "Base", "Arc". */
    chainLabel = "Base",
  ) {
    super(`The ${what} reverted on ${chainLabel}: ${hash}`);
    this.name = "TransactionRevertedError";
  }
}

async function confirmed(
  publicClient: EvmReader,
  hash: Hex,
  what: string,
  chain: Pick<EvmChainConfig, "shortLabel">,
  confirmations?: number,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt(confirmations ? { hash, confirmations } : { hash });
  if (receipt.status !== "success") {
    throw new TransactionRevertedError(hash, what, chain.shortLabel);
  }
}

/** The finality a burn on this chain asks for unless told otherwise: fast where Circle offers it, standard elsewhere. */
export function defaultFinalityOf(chain: Pick<EvmChainConfig, "fastTransfer">): number {
  return chain.fastTransfer ? FAST_FINALITY : STANDARD_FINALITY;
}

/**
 * An approval that has just been mined is not yet known to every node. A
 * burn asked for at that moment can reach one that still sees the old
 * allowance, and be turned down as exceeding it before anything is sent.
 * So the burn waits until the reader shows the approval, and a wallet whose
 * own endpoint is a step behind is asked again after a pause, a few times.
 */
const APPROVAL_POLL_MS = 1_000;
const APPROVAL_POLLS = 15;
const BURN_ATTEMPTS = 3;
const BURN_RETRY_MS = 2_500;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Everything an error and its causes say, for telling one refusal from another. */
function wordsOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    const { shortMessage, details, message, cause } = current as Record<string, unknown>;
    for (const part of [shortMessage, details, message]) if (typeof part === "string") parts.push(part);
    current = cause;
  }
  return parts.join(" ");
}

const SHORT_ALLOWANCE = /exceeds allowance|insufficient allowance/i;

/**
 * Sends USDC from an EVM chain, Base unless `chain` names another, to the
 * Stellar account of `owner`: approves Circle's TokenMessenger when the
 * allowance is short, waits for the approval to be seen, then burns, with a
 * fast transfer where the chain has one.
 *
 * On Arc the USDC token and the gas come out of one balance: the payer needs
 * the amount and the gas on top of it.
 *
 * The USDC appears on Stellar once the burn is attested and delivered there;
 * see `waitForAttestation`, which takes the chain's name as its source, and
 * `deliverOperation`.
 */
export async function fundFromEvm(args: FundFromEvmArgs): Promise<FundFromEvmResult> {
  const { walletClient, publicClient, amount, owner, route = DEFAULT_INBOUND_ROUTE } = args;
  const config = resolveNetwork(args.network);
  const source = evmChain(config, args.chain);
  const { chain, usdc, tokenMessenger, cctpDomain } = source;
  const destinationDomain = config.stellar.cctpDomain;
  const minFinalityThreshold = args.minFinalityThreshold ?? defaultFinalityOf(source);

  if (amount <= 0n) {
    throw new Error("The amount to send must be positive");
  }
  const account = walletClient.account;
  if (!account) {
    throw new Error("The wallet client has no account to pay from");
  }
  const twin = twinAddress(owner, config);

  const maxFee =
    args.maxFee ??
    maxFeeFor(amount, await fetchBurnFee(cctpDomain, destinationDomain, config, { finalityThreshold: minFinalityThreshold }));
  if (maxFee >= amount) {
    throw new Error(`The fee cap (${maxFee}) must be less than the amount (${amount})`);
  }

  let approveTxHash: Hex | undefined;
  const readAllowance = () =>
    publicClient.readContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, tokenMessenger],
    });
  const allowance = await readAllowance();
  if (allowance < amount) {
    approveTxHash = await walletClient.writeContract({
      address: usdc,
      abi: erc20Abi,
      functionName: "approve",
      args: [tokenMessenger, amount],
      chain,
      account,
    });
    await confirmed(publicClient, approveTxHash, "approval", source);
    for (let poll = 0; poll < APPROVAL_POLLS && (await readAllowance()) < amount; poll += 1) {
      await pause(APPROVAL_POLL_MS);
    }
  }

  const burn = (): Promise<Hex> => {
    if (route === "forwarder") {
      const forwarder = toHex(StrKey.decodeContract(config.stellar.forwarder));
      return walletClient.writeContract({
        address: tokenMessenger,
        abi: tokenMessengerAbi,
        functionName: "depositForBurnWithHook",
        args: [amount, destinationDomain, forwarder, usdc, forwarder, maxFee, minFinalityThreshold, forwardRecipientHookData(twin)],
        chain,
        account,
      });
    }
    return walletClient.writeContract({
      address: tokenMessenger,
      abi: tokenMessengerAbi,
      functionName: "depositForBurn",
      args: [amount, destinationDomain, twinContractId(owner, config), usdc, zeroHash, maxFee, minFinalityThreshold],
      chain,
      account,
    });
  };

  let burnTxHash: Hex;
  for (let attempt = 1; ; attempt += 1) {
    try {
      burnTxHash = await burn();
      break;
    } catch (error) {
      // Turned down for the allowance right after this call approved it: the approval has not reached that node yet.
      const behind = approveTxHash !== undefined && SHORT_ALLOWANCE.test(wordsOf(error));
      if (!behind || attempt === BURN_ATTEMPTS) throw error;
      await pause(BURN_RETRY_MS);
    }
  }
  await confirmed(publicClient, burnTxHash, "burn", source);

  return { burnTxHash, approveTxHash, route, twin, maxFee };
}

/**
 * Whether Circle's MessageTransmitter on an EVM chain, Base unless `chain`
 * names another, has taken a message already. A message is received once:
 * its nonce is marked as used when it is. `publicClient` has to read that
 * chain.
 */
export async function isReceivedOnEvm(
  publicClient: Pick<EvmReader, "readContract">,
  message: Hex,
  network: Network,
  chain?: EvmChainName,
): Promise<boolean> {
  const used = await publicClient.readContract({
    address: evmChain(network, chain).messageTransmitter,
    abi: messageTransmitterAbi,
    functionName: "usedNonces",
    args: [decodeBurnMessage(message).nonce],
  });
  return used !== 0n;
}

export interface ReceiveOnEvmArgs {
  /** Pays the gas. Must have its account set and be connected to the chain the message is for. */
  walletClient: WalletClient;
  publicClient: EvmReader;
  /** The attested message and its attestation, as Circle's Iris service returned them. */
  message: Hex;
  attestation: Hex;
  network: Network;
  /**
   * The chain the message is for. Defaults to Base. A message whose
   * destination domain is not this chain's is refused before anything is sent.
   */
  chain?: EvmChainName;
  /**
   * Gas limit for the call. When given, the wallet does not estimate it, so
   * nothing stops a call that would revert: simulate first.
   */
  gas?: bigint;
  /** Fee caps for the call, in wei per gas. Left to the wallet when not given. */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  /** How many blocks deep the mint has to be before this resolves. Defaults to one. */
  confirmations?: number;
  /** Called with the transaction hash as soon as the wallet has sent it, before it is confirmed. */
  onSubmitted?: (hash: Hex) => void;
}

export interface ReceiveOnEvmResult {
  /** The transaction that minted the USDC. Absent when the message had been received before. */
  hash?: Hex;
  alreadyReceived: boolean;
}

/**
 * Completes a transfer from Stellar on an EVM chain, Base unless `chain`
 * names another: hands the attested message to Circle's MessageTransmitter,
 * which mints the USDC to the recipient the message names. Anyone may do
 * this; the caller only pays the gas.
 *
 * A message is received once. If someone else got there first, before the
 * call or while it was on its way, this resolves with `alreadyReceived`
 * instead of failing: the USDC is where it belongs either way. A call that
 * fails for any other reason is reported and never sent a second time. A
 * `TransactionRevertedError` says the mint was included and reverted; any
 * other failure leaves its outcome unknown.
 */
export async function receiveMessageOnEvm(args: ReceiveOnEvmArgs): Promise<ReceiveOnEvmResult> {
  const { walletClient, publicClient, message, attestation, gas, maxFeePerGas, maxPriorityFeePerGas } = args;
  const config = resolveNetwork(args.network);
  const target = evmChain(config, args.chain);
  const account = walletClient.account;
  if (!account) {
    throw new Error("The wallet client has no account to pay from");
  }
  const { destinationDomain } = decodeBurnMessage(message);
  if (args.chain !== undefined && destinationDomain !== target.cctpDomain) {
    throw new Error(`The message is for CCTP domain ${destinationDomain}, not for ${target.label} (${target.cctpDomain})`);
  }
  if (await isReceivedOnEvm(publicClient, message, config, target.name)) {
    return { alreadyReceived: true };
  }

  try {
    const hash = await walletClient.writeContract({
      address: target.messageTransmitter,
      abi: messageTransmitterAbi,
      functionName: "receiveMessage",
      args: [message, attestation],
      chain: target.chain,
      account,
      ...(gas === undefined ? {} : { gas }),
      ...(maxFeePerGas === undefined ? {} : { maxFeePerGas }),
      ...(maxPriorityFeePerGas === undefined ? {} : { maxPriorityFeePerGas }),
    });
    args.onSubmitted?.(hash);
    await confirmed(publicClient, hash, "mint", target, args.confirmations);
    return { hash, alreadyReceived: false };
  } catch (error) {
    // A call that lost the race reverts with "Nonce already used". The chain is asked rather than the error read.
    if (await isReceivedOnEvm(publicClient, message, config, target.name).catch(() => false)) {
      return { alreadyReceived: true };
    }
    throw error;
  }
}
