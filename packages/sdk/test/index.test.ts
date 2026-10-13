import { describe, expect, it } from "vitest";
import * as sdk from "../src";
import type {
  ArgConcern,
  BurnSource,
  CctpEndpoint,
  EvmChainConfig,
  EvmChainName,
  CodeKind,
  DescribedArg,
  DescribedCall,
  OwnerChain,
  OwnerCheck,
  OwnerKind,
  OwnerKindOptions,
  Prepared,
} from "../src";

describe("the package entry point", () => {
  it("exports the limits on how long a signature lasts", () => {
    expect(sdk.DEFAULT_VALIDITY_LEDGERS).toBe(24);
    expect(sdk.MAX_VALIDITY_LEDGERS).toBe(120);
    expect(sdk.LEDGER_SECONDS).toBe(5);
    expect(sdk.validForSeconds({ validUntilLedger: 110 } satisfies Pick<Prepared, "validUntilLedger">, 100)).toBe(50);
  });

  it("exports the description of arguments", () => {
    const concerns: ArgConcern[] = sdk.textConcerns("fn: a");
    const arg: DescribedArg = { text: "5", type: "u32", hashed: false, concerns: [] };
    const call: DescribedCall = { contract: "C", fn: "f", fnConcerns: concerns, args: [arg] };

    expect(call.fnConcerns).toEqual(["looks_like_field"]);
    expect(sdk.describeArg).toBeTypeOf("function");
    expect(sdk.describeCalls).toBeTypeOf("function");
  });

  it("exports the check on who owns an address", async () => {
    const chains: readonly OwnerChain[] = sdk.OWNER_CHAINS;
    const options: OwnerKindOptions = { chains, getCode: async () => "0x" };
    const check: OwnerCheck = await sdk.ownerKind("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", options);
    const kind: OwnerKind = check.kind;
    const code: CodeKind = sdk.codeKind("0x");

    expect(chains).toHaveLength(10);
    expect(kind).toBe("wallet");
    expect(code).toBe("none");
  });

  it("exports the EVM chains and what reads them", () => {
    const names: readonly EvmChainName[] = sdk.EVM_CHAIN_NAMES;
    const arc: EvmChainConfig = sdk.evmChain("testnet", "arc");
    const endpoint: CctpEndpoint = "arc";
    const notFound: BurnSource = { state: "not_found" };

    expect(names).toContain(sdk.DEFAULT_EVM_CHAIN);
    expect(sdk.listEvmChains("mainnet")).toHaveLength(names.length);
    expect(sdk.cctpDomainOf(endpoint, "testnet")).toBe(arc.cctpDomain);
    expect(sdk.evmChainForDomain("testnet", 26)).toBe(arc);
    expect(sdk.evmChainForId("testnet", 5042002)).toBe(arc);
    expect(sdk.isEvmChainName("arc")).toBe(true);
    expect(sdk.CCTP_DOMAINS.arc).toBe(26);
    expect(sdk.defaultFinalityOf(arc)).toBe(sdk.STANDARD_FINALITY);
    expect(sdk.nativeUsdcToEvmUnits(sdk.evmUnitsToNativeUsdc(5n))).toBe(5n);
    expect(sdk.findBurnSource).toBeTypeOf("function");
    expect(notFound.state).toBe("not_found");
  });

  it("exports the network a salt stands for", () => {
    expect(sdk.saltNetwork(sdk.networkId("testnet"))).toBe("testnet");
  });
});
