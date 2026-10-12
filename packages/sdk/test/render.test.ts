import { Address, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { renderArg, renderCalls } from "../src/render";
import { fromHex, hex, ISSUER, sha256, USDC } from "./helpers";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

function expectHashFallback(value: xdr.ScVal, handWrittenXdr: string) {
  const bytes = fromHex(handWrittenXdr);
  expect(hex(value.toXdr())).toBe(hex(bytes));
  expect(renderArg(value)).toBe(`xdr:${hex(sha256(bytes))}`);
}

describe("renderArg", () => {
  it("renders an account address as its G strkey", () => {
    expect(renderArg(new Address(ISSUER).toScVal())).toBe(
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    );
  });

  it("renders a contract address as its C strkey", () => {
    expect(renderArg(new Address(USDC).toScVal())).toBe(
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    );
  });

  it("renders u32 and i32 in base 10", () => {
    expect(renderArg(xdr.ScVal.scvU32(0))).toBe("0");
    expect(renderArg(xdr.ScVal.scvU32(4294967295))).toBe("4294967295");
    expect(renderArg(xdr.ScVal.scvI32(-2147483648))).toBe("-2147483648");
    expect(renderArg(xdr.ScVal.scvI32(7))).toBe("7");
  });

  it("renders u64 and i64 in base 10", () => {
    expect(renderArg(xdr.ScVal.scvU64(U64_MAX))).toBe("18446744073709551615");
    expect(renderArg(xdr.ScVal.scvI64(-9223372036854775808n))).toBe("-9223372036854775808");
    expect(renderArg(xdr.ScVal.scvI64(42n))).toBe("42");
  });

  it("renders u128 in base 10", () => {
    const max = xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: U64_MAX, lo: U64_MAX }));
    expect(renderArg(max)).toBe("340282366920938463463374607431768211455");
    const small = xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 0n, lo: 1000n }));
    expect(renderArg(small)).toBe("1000");
  });

  it("renders i128 in base 10, with a minus sign for negatives", () => {
    const i128 = (hi: bigint, lo: bigint) => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi, lo }));
    expect(renderArg(i128(0n, 10_000_000n))).toBe("10000000");
    expect(renderArg(i128(1n, 0n))).toBe("18446744073709551616");
    expect(renderArg(i128(-1n, U64_MAX))).toBe("-1");
    expect(renderArg(i128(-1n, U64_MAX - 24n))).toBe("-25");
    expect(renderArg(i128(-(2n ** 63n), 0n))).toBe("-170141183460469231731687303715884105728");
    expect(renderArg(i128(0n, 0n))).toBe("0");
  });

  it("renders bool and void as words", () => {
    expect(renderArg(xdr.ScVal.scvBool(true))).toBe("true");
    expect(renderArg(xdr.ScVal.scvBool(false))).toBe("false");
    expect(renderArg(xdr.ScVal.scvVoid())).toBe("void");
  });

  it("renders a Symbol as its characters", () => {
    expect(renderArg(xdr.ScVal.scvSymbol("transfer"))).toBe("transfer");
    expect(renderArg(xdr.ScVal.scvSymbol(""))).toBe("");
  });

  it("renders a String as its bytes", () => {
    expect(renderArg(xdr.ScVal.scvString("invoice #42"))).toBe("invoice #42");
    expect(renderArg(xdr.ScVal.scvString("olá, Lisboa ✓"))).toBe("olá, Lisboa ✓");
    expect(renderArg(xdr.ScVal.scvString(""))).toBe("");
  });

  it("refuses a String that is not valid UTF-8", () => {
    const broken = xdr.ScVal.scvString(new Uint8Array([0x68, 0x69, 0xff]));
    expect(() => renderArg(broken)).toThrow(/UTF-8/);
  });

  it("renders Bytes and BytesN as 0x and lowercase hex", () => {
    expect(renderArg(xdr.ScVal.scvBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef])))).toBe("0xdeadbeef");
    expect(renderArg(xdr.ScVal.scvBytes(new Uint8Array(0)))).toBe("0x");
    const bytes32 = new Uint8Array(32).fill(0xab);
    expect(renderArg(xdr.ScVal.scvBytes(bytes32))).toBe(`0x${"ab".repeat(32)}`);
    const padded = new Uint8Array(32);
    padded.set(fromHex("f39fd6e51aad88f6f4ce6ab8827279cfffb92266"), 12);
    expect(renderArg(xdr.ScVal.scvBytes(padded))).toBe(
      "0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
  });

  it("binds a Vec by the hash of its XDR", () => {
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(7), xdr.ScVal.scvVoid()]);
    expectHashFallback(vec, "00000010 00000001 00000002 00000003 00000007 00000001");
  });

  it("binds a Map by the hash of its XDR", () => {
    const map = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("a"), val: xdr.ScVal.scvBool(true) }),
    ]);
    expectHashFallback(map, "00000011 00000001 00000001 0000000f 00000001 61000000 00000000 00000001");
  });

  it("binds every other value by the hash of its XDR", () => {
    const u256 = xdr.ScVal.scvU256(new xdr.Uint256Parts({ hiHi: 0n, hiLo: 0n, loHi: 0n, loLo: 1n }));
    expectHashFallback(u256, `0000000b ${"00".repeat(31)}01`);

    expectHashFallback(xdr.ScVal.scvTimepoint(1n), "00000007 0000000000000001");

    const muxed = xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeMuxedAccount(
        new xdr.MuxedEd25519Account({ id: 5n, ed25519: new Uint8Array(32).fill(0x22) }),
      ),
    );
    expectHashFallback(muxed, `00000012 00000002 0000000000000005 ${"22".repeat(32)}`);
  });
});

function invocation(
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      }),
    ),
    subInvocations,
  });
}

function entryFor(root: xdr.SorobanAuthorizedInvocation): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddressV2(
      new xdr.SorobanAddressCredentials({
        address: new Address(USDC).toScAddress(),
        nonce: 1n,
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

describe("renderCalls", () => {
  const hub = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
  const other = "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY";

  it("walks the tree root first, then each sub-invocation depth first", () => {
    const tree = invocation(hub, "exit", [xdr.ScVal.scvU32(6)], [
      invocation(USDC, "transfer", [xdr.ScVal.scvBool(true)], [
        invocation(other, "notify", [xdr.ScVal.scvSymbol("deep")]),
      ]),
      invocation(other, "burn", []),
    ]);

    expect(renderCalls(entryFor(tree))).toEqual([
      { contract: hub, fn: "exit", args: ["6"] },
      { contract: USDC, fn: "transfer", args: ["true"] },
      { contract: other, fn: "notify", args: ["deep"] },
      { contract: other, fn: "burn", args: [] },
    ]);
  });

  it("renders a single call with every argument in order", () => {
    const amount = xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo: 2_500_000n }));
    const tree = invocation(USDC, "transfer", [
      new Address(hub).toScVal(),
      new Address(ISSUER).toScVal(),
      amount,
    ]);

    expect(renderCalls(entryFor(tree))).toEqual([
      { contract: USDC, fn: "transfer", args: [hub, ISSUER, "2500000"] },
    ]);
  });

  it("rejects a tree that creates a contract", () => {
    const create = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeCreateContractHostFn(
        new xdr.CreateContractArgs({
          contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
            new xdr.ContractIdPreimageFromAddress({
              address: new Address(hub).toScAddress(),
              salt: new Uint8Array(32),
            }),
          ),
          executable: xdr.ContractExecutable.contractExecutableWasm(new Uint8Array(32)),
        }),
      ),
      subInvocations: [],
    });

    expect(() => renderCalls(entryFor(create))).toThrow(/contract function/);
    expect(() => renderCalls(entryFor(invocation(hub, "exit", [], [create])))).toThrow(/contract function/);
  });
});
