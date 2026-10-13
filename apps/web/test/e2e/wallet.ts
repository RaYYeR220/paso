import { erc20Abi, messageTransmitterAbi, tokenMessengerAbi, type NetworkConfig } from "@paso/sdk";
import type { Page } from "@playwright/test";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  http,
  isAddressEqual,
  numberToHex,
  type Address,
  type Chain,
  type Hex,
  type TypedDataDomain,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

/** What the wallet sent on Base, in the order it sent it. */
export interface SentTransaction {
  kind: "approve" | "burn" | "mint";
  hash: Hex;
}

export interface SyntheticWalletOptions {
  account: PrivateKeyAccount;
  /** The network of the run. The wallet sends transactions on its Base and nowhere else. */
  network: NetworkConfig;
  /** RPC endpoint for that Base. The chain's public endpoint when absent. */
  rpcUrl?: string;
  /** The most USDC, in 6-decimal units, the wallet will approve or burn in one transaction. */
  spendLimit: bigint;
  /** The chain the wallet is on when the page opens. Ethereum mainnet by default, so the app has to ask for a switch. */
  startChainId?: number;
}

class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A wallet for the page, with no extension: an EIP-1193 provider at
 * `window.ethereum` whose every request is answered here, by a viem account
 * and a real RPC endpoint. It approves whatever it is asked, with one
 * exception: it sends only the three transactions the journey consists of,
 * to Circle's contracts and to USDC on the network's Base, within the spend
 * limit, with no ETH attached. Anything else it refuses, and the run fails.
 *
 * The private key stays in this process. The page sees the address.
 */
export class SyntheticWallet {
  readonly sent: SentTransaction[] = [];
  readonly signedTypedData: string[] = [];
  readonly switches: number[] = [];
  /** Requests the wallet answered with an error, as `method: reason`. */
  readonly refused: string[] = [];
  private chainId: number;
  private readonly chains: Map<number, { chain: Chain; rpcUrl?: string }>;

  constructor(private readonly options: SyntheticWalletOptions) {
    const base = options.network.evm.chain;
    this.chains = new Map([
      [mainnet.id, { chain: mainnet, rpcUrl: "https://ethereum-rpc.publicnode.com" }],
      [base.id, { chain: base, rpcUrl: options.rpcUrl }],
    ]);
    this.chainId = options.startChainId ?? mainnet.id;
  }

  get address(): Address {
    return this.options.account.address;
  }

  /** Puts the provider into every page of the context, before any of the app's own code runs. */
  async install(page: Page): Promise<void> {
    await page.exposeBinding("__pasoWalletRequest", async (_source, method: string, params: unknown) => {
      try {
        return { result: await this.request(method, params) };
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : -32603;
        const message = error instanceof Error ? error.message : String(error);
        this.refused.push(`${method}: ${message.split("\n", 1)[0]}`);
        return { error: { code, message } };
      }
    });
    await page.addInitScript(() => {
      type Listener = (...args: unknown[]) => void;
      const listeners = new Map<string, Set<Listener>>();
      const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((listener) => listener(...args));
      const ask = (window as unknown as { __pasoWalletRequest: (method: string, params: unknown) => Promise<{ result?: unknown; error?: { code: number; message: string } }> })
        .__pasoWalletRequest;
      const provider = {
        isSyntheticWallet: true,
        async request({ method, params }: { method: string; params?: unknown }) {
          const answer = await ask(method, params ?? []);
          if (answer.error) throw Object.assign(new Error(answer.error.message), { code: answer.error.code });
          if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") {
            const chainId = (await ask("eth_chainId", [])).result;
            emit("chainChanged", chainId);
          }
          if (method === "eth_requestAccounts") emit("accountsChanged", answer.result);
          return answer.result;
        },
        on(event: string, listener: Listener) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
          return provider;
        },
        removeListener(event: string, listener: Listener) {
          listeners.get(event)?.delete(listener);
          return provider;
        },
      };
      Object.defineProperty(window, "ethereum", { value: provider, configurable: false, writable: false });
    });
  }

  private client(chainId = this.chainId) {
    const known = this.chains.get(chainId);
    if (!known) throw new ProviderError(4901, `The wallet is on chain ${chainId}, which it has no endpoint for`);
    return createPublicClient({ chain: known.chain, transport: http(known.rpcUrl) });
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const args = Array.isArray(params) ? params : [];
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [this.address];
      case "eth_chainId":
        return numberToHex(this.chainId);
      case "net_version":
        return String(this.chainId);
      case "wallet_requestPermissions":
      case "wallet_getPermissions":
        return [{ parentCapability: "eth_accounts" }];
      case "wallet_revokePermissions":
        return null;
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain": {
        const wanted = Number((args[0] as { chainId?: string } | undefined)?.chainId);
        if (!this.chains.has(wanted)) throw new ProviderError(4902, `Unrecognized chain ID ${wanted}`);
        this.chainId = wanted;
        this.switches.push(wanted);
        return null;
      }
      case "eth_signTypedData_v4":
        return this.signTypedData(args[0] as Address, args[1] as string);
      case "eth_sendTransaction":
        return this.sendTransaction(args[0] as { from?: Address; to?: Address; data?: Hex; value?: Hex; gas?: Hex });
      case "personal_sign":
      case "eth_sign":
      case "eth_signTransaction":
        throw new ProviderError(4200, `The synthetic wallet does not do ${method}`);
      default:
        return this.client().request({ method, params: args } as never);
    }
  }

  private async signTypedData(from: Address, json: string): Promise<Hex> {
    if (!isAddressEqual(from, this.address)) throw new ProviderError(4100, `The wallet does not hold ${from}`);
    const { domain, types, primaryType, message } = JSON.parse(json) as {
      domain: TypedDataDomain;
      types: Record<string, { name: string; type: string }[]>;
      primaryType: string;
      message: Record<string, unknown>;
    };
    // viem derives the domain's own type from the domain; it is not passed along with the others.
    const own = Object.fromEntries(Object.entries(types).filter(([name]) => name !== "EIP712Domain"));
    this.signedTypedData.push(primaryType);
    return this.options.account.signTypedData({ domain, types: own, primaryType, message });
  }

  /** The transaction the app asks for, if it is one of the three the journey has. Throws for anything else. */
  private vet(tx: { to?: Address; data?: Hex; value?: Hex }): SentTransaction["kind"] {
    const { usdc, tokenMessenger, messageTransmitter, chain } = this.options.network.evm;
    const { spendLimit } = this.options;
    if (this.chainId !== chain.id) throw new ProviderError(4901, `The wallet is on chain ${this.chainId}, not on ${chain.name}`);
    if (!tx.to || !tx.data) throw new ProviderError(4100, "The synthetic wallet sends contract calls only");
    if (tx.value !== undefined && BigInt(tx.value) !== 0n) throw new ProviderError(4100, "The synthetic wallet attaches no ETH");

    if (isAddressEqual(tx.to, usdc)) {
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (call.functionName !== "approve") throw new ProviderError(4100, `Not sending USDC.${call.functionName}`);
      const [spender, amount] = call.args;
      if (!isAddressEqual(spender, tokenMessenger)) throw new ProviderError(4100, `Not approving ${spender}`);
      if (amount > spendLimit) throw new ProviderError(4100, `Not approving ${amount}: the limit of this run is ${spendLimit}`);
      return "approve";
    }
    if (isAddressEqual(tx.to, tokenMessenger)) {
      const call = decodeFunctionData({ abi: tokenMessengerAbi, data: tx.data });
      const [amount] = call.args;
      if (amount > spendLimit) throw new ProviderError(4100, `Not burning ${amount}: the limit of this run is ${spendLimit}`);
      return "burn";
    }
    if (isAddressEqual(tx.to, messageTransmitter)) {
      const call = decodeFunctionData({ abi: messageTransmitterAbi, data: tx.data });
      if (call.functionName !== "receiveMessage") throw new ProviderError(4100, `Not sending ${call.functionName}`);
      return "mint";
    }
    throw new ProviderError(4100, `The synthetic wallet does not send to ${tx.to}`);
  }

  private async sendTransaction(tx: { from?: Address; to?: Address; data?: Hex; value?: Hex; gas?: Hex }): Promise<Hex> {
    if (tx.from && !isAddressEqual(tx.from, this.address)) throw new ProviderError(4100, `The wallet does not hold ${tx.from}`);
    const kind = this.vet(tx);
    const known = this.chains.get(this.chainId)!;
    const wallet = createWalletClient({ account: this.options.account, chain: known.chain, transport: http(known.rpcUrl) });
    const hash = await wallet.sendTransaction({
      to: tx.to!,
      data: tx.data!,
      ...(tx.gas ? { gas: BigInt(tx.gas) } : {}),
    });
    this.sent.push({ kind, hash });
    return hash;
  }
}
