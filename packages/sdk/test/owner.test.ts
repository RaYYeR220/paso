import type { Address, Hex } from "viem";
import { base, baseSepolia, mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listEvmChains, NETWORKS } from "../src/networks";
import { codeKind, OWNER_CHAINS, ownerKind, type CodeKind, type OwnerChain, type OwnerKindOptions } from "../src/owner";
import { ISSUER, OWNER } from "./helpers";

/** What `eth_getCode` answers for an address that delegates to another through EIP-7702: `0xef0100` and 20 bytes. */
const DELEGATION = `0xef0100${"63c0c19a282a1b52b07dd5a65b58948a07dae32b"}` as Hex;
/** The start of ordinary contract code. */
const CONTRACT_CODE = "0x608060405234801561001057600080fd5b50" as Hex;

type Answer = Hex | undefined | Error | "never";

/** A reader that answers per chain id, and never touches the network. */
function reader(answers: Record<number, Answer>) {
  return vi.fn<NonNullable<OwnerKindOptions["getCode"]>>(({ chain }) => {
    const answer = answers[chain.id];
    if (answer === "never") return new Promise<never>(() => undefined);
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer);
  });
}

const codes = (check: { chains: { code: CodeKind }[] }) => check.chains.map(({ code }) => code);

/** Ethereum mainnet, Base and Base Sepolia: three chains, enough to show how answers combine. */
const TRIO: readonly OwnerChain[] = [{ chain: mainnet }, { chain: base }, { chain: baseSepolia }];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("codeKind", () => {
  it.each<[name: string, code: Hex | undefined | null, kind: CodeKind]>([
    ["no answer", undefined, "none"],
    ["null", null, "none"],
    ["empty code", "0x", "none"],
    ["an EIP-7702 delegation designator", DELEGATION, "delegated"],
    ["a delegation designator in capitals", `0x${DELEGATION.slice(2).toUpperCase()}`, "delegated"],
    ["a delegation to the zero address", `0xef0100${"00".repeat(20)}`, "delegated"],
    ["the delegation prefix and 19 bytes", `0xef0100${"11".repeat(19)}`, "contract"],
    ["the delegation prefix and 21 bytes", `0xef0100${"11".repeat(21)}`, "contract"],
    ["the delegation prefix alone", "0xef0100", "contract"],
    ["23 bytes that start differently", `0xef0101${"11".repeat(20)}`, "contract"],
    ["23 bytes of ordinary code", `0x60${"00".repeat(22)}`, "contract"],
    ["one byte of code", "0x00", "contract"],
    ["contract code", CONTRACT_CODE, "contract"],
  ])("reads %s as %s", (_name, code, kind) => {
    expect(codeKind(code)).toBe(kind);
  });

  it.each(["", "ef0100", "0xzz", "not code", `0xef0100${"1".repeat(39)}`])(
    "reads the answer %j, which is not a whole number of hex bytes, as unknown",
    (answer) => {
      expect(codeKind(answer as Hex)).toBe("unknown");
    },
  );
});

describe("OWNER_CHAINS", () => {
  it("asks every EVM chain Paso lists, mainnet first, Ethereum first on each", () => {
    expect(OWNER_CHAINS.map(({ chain }) => chain.id)).toEqual([1, 8453, 42161, 10, 5042, 11155111, 84532, 421614, 11155420, 5042002]);
    expect(OWNER_CHAINS.slice(0, 2).map(({ chain }) => chain)).toEqual([mainnet, base]);
    expect(new Set(OWNER_CHAINS.map(({ chain }) => chain.id)).size).toBe(OWNER_CHAINS.length);
  });

  it("takes each chain and its public endpoints from the networks the SDK serves", () => {
    const listed = [...listEvmChains("mainnet"), ...listEvmChains("testnet")];
    expect(OWNER_CHAINS).toHaveLength(listed.length);
    for (const { chain, rpcUrls } of OWNER_CHAINS) {
      const config = listed.find((entry) => entry.chain.id === chain.id);
      expect(chain).toBe(config?.chain);
      expect(rpcUrls).toEqual(config?.rpcUrls);
      expect(rpcUrls?.length).toBeGreaterThan(0);
    }
    expect(OWNER_CHAINS.find(({ chain }) => chain.id === 8453)?.chain).toBe(NETWORKS.mainnet.evm.chain);
    expect(OWNER_CHAINS.find(({ chain }) => chain.id === 84532)?.chain).toBe(NETWORKS.testnet.evm.chain);
  });

  it("is what ownerKind asks when no chains are given", async () => {
    const getCode = reader({ 5042002: CONTRACT_CODE });
    const check = await ownerKind(OWNER, { getCode });

    expect(getCode.mock.calls).toEqual(OWNER_CHAINS.map((chain) => [chain, OWNER]));
    expect(check.kind).toBe("contract");
    expect(check.chains.filter(({ code }) => code === "contract")).toEqual([{ name: "Arc Testnet", chainId: 5042002, code: "contract" }]);
  });
});

describe("ownerKind", () => {
  it("calls an address with no code on any chain a wallet", async () => {
    const getCode = reader({ 1: undefined, 8453: "0x", 84532: undefined });

    expect(await ownerKind(OWNER, { chains: TRIO, getCode })).toEqual({
      kind: "wallet",
      chains: [
        { name: "Ethereum", chainId: 1, code: "none" },
        { name: "Base", chainId: 8453, code: "none" },
        { name: "Base Sepolia", chainId: 84532, code: "none" },
      ],
    });
    expect(getCode.mock.calls).toEqual(TRIO.map((chain) => [chain, OWNER]));
  });

  it("calls an address that delegates through EIP-7702 a wallet: it still has a key", async () => {
    const check = await ownerKind(OWNER, { chains: TRIO, getCode: reader({ 1: DELEGATION, 8453: undefined, 84532: DELEGATION }) });

    expect(check.kind).toBe("wallet");
    expect(codes(check)).toEqual(["delegated", "none", "delegated"]);
  });

  it.each([1, 8453, 84532])("calls an address with code on chain %d alone a contract", async (chainId) => {
    const check = await ownerKind(OWNER, { chains: TRIO, getCode: reader({ [chainId]: CONTRACT_CODE }) });

    expect(check.kind).toBe("contract");
    expect(check.chains.filter(({ code }) => code === "contract").map((chain) => chain.chainId)).toEqual([chainId]);
    expect(codes(check).filter((code) => code === "none")).toHaveLength(2);
  });

  it("calls it a contract when one chain has code, even if another failed", async () => {
    const getCode = reader({ 1: new Error("502 Bad Gateway"), 8453: CONTRACT_CODE, 84532: undefined });
    const check = await ownerKind(OWNER, { chains: TRIO, getCode });

    expect(check.kind).toBe("contract");
    expect(codes(check)).toEqual(["unknown", "contract", "none"]);
  });

  it("calls it a contract when one chain has code and another has a delegation", async () => {
    const check = await ownerKind(OWNER, { chains: TRIO, getCode: reader({ 1: DELEGATION, 8453: CONTRACT_CODE }) });

    expect(check.kind).toBe("contract");
    expect(codes(check)).toEqual(["delegated", "contract", "none"]);
  });

  it("answers unknown when a chain fails and no chain has code", async () => {
    const getCode = reader({ 1: undefined, 8453: new Error("fetch failed"), 84532: undefined });
    const check = await ownerKind(OWNER, { chains: TRIO, getCode });

    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["none", "unknown", "none"]);
  });

  it("answers unknown, without throwing, when every chain fails", async () => {
    const getCode = vi.fn<NonNullable<OwnerKindOptions["getCode"]>>(() => Promise.reject(new Error("offline")));
    const check = await ownerKind(OWNER, { chains: TRIO, getCode });

    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["unknown", "unknown", "unknown"]);
  });

  it("answers unknown when a reader throws instead of rejecting", async () => {
    const getCode = (({ chain }: OwnerChain) => {
      if (chain.id === 1) throw new Error("no client for this chain");
      return Promise.resolve(undefined);
    }) satisfies OwnerKindOptions["getCode"];

    const check = await ownerKind(OWNER, { chains: TRIO, getCode });
    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["unknown", "none", "none"]);
  });

  it("answers unknown when a chain answers with something that is not code", async () => {
    const check = await ownerKind(OWNER, { chains: TRIO, getCode: reader({ 1: "<html>" as Hex }) });

    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["unknown", "none", "none"]);
  });

  it("asks every chain at once, not one after another", async () => {
    vi.useFakeTimers();
    const getCode = reader({ 1: "never", 8453: "never", 84532: "never" });
    const pending = ownerKind(OWNER, { chains: TRIO, getCode });

    await vi.advanceTimersByTimeAsync(0);
    expect(getCode).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6_000);
    expect((await pending).kind).toBe("unknown");
  });

  it("gives a chain 6 seconds by default and then reports it as unknown", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = ownerKind(OWNER, { chains: TRIO, getCode: reader({ 1: undefined, 8453: "never", 84532: undefined }) });
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(5_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const check = await pending;
    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["none", "unknown", "none"]);
  });

  it("honours the timeout it is given", async () => {
    vi.useFakeTimers();
    let settled = false;
    const getCode = reader({ 1: "never", 8453: undefined, 84532: undefined });
    const pending = ownerKind(OWNER, { chains: TRIO, getCode, timeoutMs: 250 });
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(codes(await pending)).toEqual(["unknown", "none", "none"]);
  });

  it("still finds a contract when another chain never answers", async () => {
    vi.useFakeTimers();
    const pending = ownerKind(OWNER, { chains: TRIO, getCode: reader({ 1: "never", 8453: CONTRACT_CODE, 84532: undefined }) });

    await vi.advanceTimersByTimeAsync(6_000);
    const check = await pending;
    expect(check.kind).toBe("contract");
    expect(codes(check)).toEqual(["unknown", "contract", "none"]);
  });

  it("does not wait for the timeout when every chain answers, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const check = await ownerKind(OWNER, { chains: TRIO, getCode: reader({}) });

    expect(check.kind).toBe("wallet");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an answer that arrives after the timeout", async () => {
    vi.useFakeTimers();
    let answerLate: (code: Hex) => void = () => undefined;
    const getCode = vi.fn<NonNullable<OwnerKindOptions["getCode"]>>(({ chain }) =>
      chain.id === 1 ? new Promise<Hex>((resolve) => (answerLate = resolve)) : Promise.resolve(undefined),
    );
    const pending = ownerKind(OWNER, { chains: TRIO, getCode, timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(100);
    const check = await pending;
    answerLate(CONTRACT_CODE);
    await vi.advanceTimersByTimeAsync(0);

    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["unknown", "none", "none"]);
  });

  it("asks the chains it is given, in the order given, and hands each to the reader", async () => {
    const chains: OwnerChain[] = [
      { chain: baseSepolia, rpcUrls: ["https://one.example", "https://two.example"] },
      { chain: mainnet },
    ];
    const getCode = reader({ 1: CONTRACT_CODE });
    const check = await ownerKind(OWNER, { chains, getCode });

    expect(check).toEqual({
      kind: "contract",
      chains: [
        { name: "Base Sepolia", chainId: 84532, code: "none" },
        { name: "Ethereum", chainId: 1, code: "contract" },
      ],
    });
    expect(getCode.mock.calls).toEqual([
      [chains[0], OWNER],
      [chains[1], OWNER],
    ]);
  });

  it("answers unknown when it is given no chain to ask", async () => {
    expect(await ownerKind(OWNER, { chains: [], getCode: reader({}) })).toEqual({ kind: "unknown", chains: [] });
  });

  it("accepts an address in any case and hands the reader its checksummed form", async () => {
    const getCode = reader({});
    await ownerKind(OWNER.toLowerCase() as Address, { getCode, chains: [{ chain: base }] });

    expect(getCode).toHaveBeenCalledWith({ chain: base }, OWNER);
  });

  it.each(["nobody", "", "0x1234", `0x${"zz".repeat(20)}`, `${OWNER}00`, ISSUER])(
    "throws for %j, which is not an Ethereum address, and asks no chain",
    async (address) => {
      const getCode = reader({});

      await expect(ownerKind(address as Address, { getCode })).rejects.toThrow(/is not an Ethereum address/);
      expect(getCode).not.toHaveBeenCalled();
    },
  );

  it("asks no chain when the caller has already given up", async () => {
    const getCode = reader({ 8453: CONTRACT_CODE });
    const check = await ownerKind(OWNER, { chains: TRIO, getCode, signal: AbortSignal.abort() });

    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["unknown", "unknown", "unknown"]);
    expect(getCode).not.toHaveBeenCalled();
  });

  it("stops waiting when the caller gives up, keeping the answers it has", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const getCode = reader({ 1: undefined, 8453: "never", 84532: "never" });
    const pending = ownerKind(OWNER, { chains: TRIO, getCode, signal: controller.signal });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const check = await pending;

    expect(check.kind).toBe("unknown");
    expect(codes(check)).toEqual(["none", "unknown", "unknown"]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ownerKind, reading through JSON-RPC", () => {
  /** Stands in for `fetch`: answers `eth_getCode` per endpoint and records what was asked. */
  function rpc(answers: Record<string, Hex | "down">) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input).replace(/\/$/, "");
      const answer = answers[url];
      if (answer === undefined) throw new Error(`unexpected endpoint ${url}`);
      if (answer === "down") return new Response("Bad Gateway", { status: 502 });
      const { id } = JSON.parse(String(init?.body)) as { id: number };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: answer }), {
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  const asked = (fetchMock: ReturnType<typeof rpc>) =>
    fetchMock.mock.calls.map(([input, init]) => {
      const url = String(input instanceof Request ? input.url : input).replace(/\/$/, "");
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      return { url, method, params };
    });

  it("asks the chain's public endpoint for the code at the address", async () => {
    const endpoint = base.rpcUrls.default.http[0].replace(/\/$/, "");
    const fetchMock = rpc({ [endpoint]: "0x" });
    vi.stubGlobal("fetch", fetchMock);

    const check = await ownerKind(OWNER, { chains: [{ chain: base }] });

    expect(check).toEqual({ kind: "wallet", chains: [{ name: "Base", chainId: 8453, code: "none" }] });
    expect(asked(fetchMock)).toEqual([{ url: endpoint, method: "eth_getCode", params: [OWNER, "latest"] }]);
  });

  it("uses the public endpoint when the list of endpoints is empty", async () => {
    const endpoint = mainnet.rpcUrls.default.http[0].replace(/\/$/, "");
    const fetchMock = rpc({ [endpoint]: DELEGATION });
    vi.stubGlobal("fetch", fetchMock);

    const check = await ownerKind(OWNER, { chains: [{ chain: mainnet, rpcUrls: [] }] });

    expect(check).toEqual({ kind: "wallet", chains: [{ name: "Ethereum", chainId: 1, code: "delegated" }] });
    expect(asked(fetchMock).map(({ url }) => url)).toEqual([endpoint]);
  });

  it("tries the endpoints it is given in order and stops at the first that answers", async () => {
    const fetchMock = rpc({
      "https://one.example": "down",
      "https://two.example": CONTRACT_CODE,
      "https://three.example": "0x",
    });
    vi.stubGlobal("fetch", fetchMock);

    const rpcUrls = ["https://one.example", "https://two.example", "https://three.example"];
    const check = await ownerKind(OWNER, { chains: [{ chain: base, rpcUrls }] });

    expect(check).toEqual({ kind: "contract", chains: [{ name: "Base", chainId: 8453, code: "contract" }] });
    expect(asked(fetchMock).map(({ url }) => url)).toEqual(["https://one.example", "https://two.example"]);
  });
});
