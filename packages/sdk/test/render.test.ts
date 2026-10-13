import { Account, Address, MuxedAccount, xdr } from "@stellar/stellar-sdk";
import { concat, hashStruct, keccak256, toBytes } from "viem";
import { describe, expect, it } from "vitest";
import {
  describeArg,
  describeCalls,
  renderArg,
  renderCalls,
  textConcerns,
  type ArgConcern,
  type DescribedArg,
  type DescribedCall,
} from "../src/render";
import { concat as concatBytes, fromHex, hex, ISSUER, sha256, USDC } from "./helpers";

const U64_MAX = 0xffff_ffff_ffff_ffffn;

/** A struct with a single `string` field, to hash one string the way a wallet does. */
const ONE_STRING = {
  types: { Text: [{ name: "value", type: "string" }] },
  primaryType: "Text",
} as const;

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

  it("keeps a byte-order mark at the start of a String", () => {
    const bytes = fromHex("ef bb bf 68 69");
    const rendered = renderArg(xdr.ScVal.scvString(bytes));
    expect(rendered).toBe("\ufeffhi");
    expect(hex(new TextEncoder().encode(rendered))).toBe(hex(bytes));
  });

  it("keeps a byte-order mark in the middle of a String", () => {
    const bytes = fromHex("68 ef bb bf 69");
    const rendered = renderArg(xdr.ScVal.scvString(bytes));
    expect(rendered).toBe("h\ufeffi");
    expect(hex(new TextEncoder().encode(rendered))).toBe(hex(bytes));
  });

  it("renders a lone byte-order mark as one character, not as the empty string", () => {
    const bytes = fromHex("ef bb bf");
    expect(renderArg(xdr.ScVal.scvString(bytes))).toBe("\ufeff");
    expect(renderArg(xdr.ScVal.scvString(fromHex("ef bb bf ef bb bf")))).toBe("\ufeff\ufeff");
  });

  it("keeps a byte-order mark at the start of a Symbol", () => {
    const bytes = fromHex("ef bb bf 61 62");
    const rendered = renderArg(xdr.ScVal.scvSymbol(bytes));
    expect(rendered).toBe("\ufeffab");
    expect(hex(new TextEncoder().encode(rendered))).toBe(hex(bytes));
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

/** Valid UTF-8 that a careless decoder changes: each has to reach the wallet as the same bytes. */
const TRICKY_UTF8: [name: string, bytes: string][] = [
  ["a byte-order mark first", "ef bb bf 68 69"],
  ["a byte-order mark alone", "ef bb bf"],
  ["two byte-order marks", "ef bb bf ef bb bf 61"],
  ["a byte-order mark in the middle", "68 ef bb bf 69"],
  ["a byte-order mark last", "68 69 ef bb bf"],
  ["a NUL byte", "61 00 62"],
  ["only NUL bytes", "00 00"],
  ["a 4-byte code point", "f0 9f 98 80"],
  ["the last code point, U+10FFFF", "f4 8f bf bf"],
  ["a byte-order mark before a 4-byte code point", "ef bb bf f0 9f 98 80"],
  ["a combining mark after its letter", "65 cc 81"],
  ["a combining mark with nothing before it", "cc 81 65"],
  ["the precomposed form of that letter", "c3 a9"],
  ["the replacement character itself", "ef bf bd"],
  ["the noncharacters U+FFFE and U+FFFF", "ef bf be ef bf bf"],
  ["the edges of the 2-byte and 3-byte ranges", "c2 80 df bf e0 a0 80 ef bf bf"],
  ["the code points around the surrogates", "ed 9f bf ee 80 80"],
  ["line breaks and a tab", "0d 0a 09 e2 80 a8 e2 80 a9"],
  ["a right-to-left override and a zero-width space", "e2 80 ae e2 80 8b"],
  ["nothing", ""],
];

describe.each(TRICKY_UTF8)("text holding %s", (_name, encoded) => {
  const bytes = fromHex(encoded);

  it.each([
    ["String", xdr.ScVal.scvString(bytes)],
    ["Symbol", xdr.ScVal.scvSymbol(bytes)],
  ])("renders a %s to text that encodes back to the same bytes", (_type, value) => {
    expect(hex(new TextEncoder().encode(renderArg(value)))).toBe(hex(bytes));
  });

  it("hashes as an EIP-712 string to the hash of the raw bytes", () => {
    const rendered = renderArg(xdr.ScVal.scvString(bytes));
    expect(keccak256(toBytes(rendered))).toBe(keccak256(bytes));
    expect(hashStruct({ ...ONE_STRING, data: { value: rendered } })).toBe(
      keccak256(concat([keccak256(toBytes("Text(string value)")), keccak256(bytes)])),
    );
  });
});

/** A small seeded generator, so the random cases are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("text of any content", () => {
  it("renders random valid text to text that encodes back to the same bytes", () => {
    const random = seeded(1);
    const pick = (below: number) => Math.floor(random() * below);
    const marks = [0xfeff, 0x00, 0x301, 0x0a, 0x202e, 0x200b, 0xfffd, 0xffff, 0x10ffff];
    const codePoint = (): number => {
      const kind = pick(4);
      if (kind === 0) return marks[pick(marks.length)]!;
      if (kind === 1) return pick(0x80);
      if (kind === 2) return 0x10000 + pick(0x100000);
      const inPlane = pick(0x10000 - 0x800);
      return inPlane < 0xd800 ? inPlane : inPlane + 0x800;
    };

    for (let i = 0; i < 2_000; i++) {
      const original = String.fromCodePoint(...Array.from({ length: pick(12) }, codePoint));
      const bytes = new TextEncoder().encode(original);
      const rendered = renderArg(xdr.ScVal.scvString(bytes));

      expect(rendered, `case ${i}`).toBe(original);
      expect(hex(new TextEncoder().encode(rendered)), `case ${i}`).toBe(hex(bytes));
    }
  });

  it("either refuses random bytes or keeps every one of them", () => {
    const random = seeded(2);
    const pick = (below: number) => Math.floor(random() * below);
    const pieces = ["ef bb bf", "68 69", "f0 9f 98 80", "c3 a9", "00", "e2 82", "80", "ff", "ed a0 80"].map(fromHex);
    const piece = () => (pick(4) === 0 ? Uint8Array.of(pick(256)) : pieces[pick(pieces.length)]!);
    let kept = 0;
    let refused = 0;

    for (let i = 0; i < 5_000; i++) {
      const bytes = concatBytes(...Array.from({ length: pick(5) }, piece));
      let rendered: string;
      try {
        rendered = renderArg(xdr.ScVal.scvString(bytes));
      } catch (error) {
        expect((error as Error).message, `case ${i}`).toBe("String is not valid UTF-8 and cannot be shown in a wallet");
        refused++;
        continue;
      }
      expect(hex(new TextEncoder().encode(rendered)), `case ${i}`).toBe(hex(bytes));
      expect(keccak256(toBytes(rendered)), `case ${i}`).toBe(keccak256(bytes));
      kept++;
    }

    expect(kept).toBeGreaterThan(1_000);
    expect(refused).toBeGreaterThan(1_000);
  });
});

describe("text that is not valid UTF-8", () => {
  it.each([
    ["a byte that never appears in UTF-8", "68 69 ff"],
    ["a continuation byte on its own", "80"],
    ["a sequence cut short", "e2 82"],
    ["a 4-byte sequence cut short", "f0 9f 98"],
    ["an overlong encoding of /", "c0 af"],
    ["an encoded surrogate half", "ed a0 80"],
    ["a code point above U+10FFFF", "f4 90 80 80"],
    ["a byte-order mark followed by a bad byte", "ef bb bf ff"],
    ["a byte-order mark cut short", "ef bb"],
  ])("refuses %s in a String and in a Symbol", (_name, encoded) => {
    const bytes = fromHex(encoded);
    const refusal = "is not valid UTF-8 and cannot be shown in a wallet";
    expect(() => renderArg(xdr.ScVal.scvString(bytes))).toThrow(`String ${refusal}`);
    expect(() => renderArg(xdr.ScVal.scvSymbol(bytes))).toThrow(`Symbol ${refusal}`);
  });

  it("does not change how the next text is read", () => {
    const marked = fromHex("ef bb bf 68 69");
    expect(() => renderArg(xdr.ScVal.scvString(fromHex("ef bb bf ff")))).toThrow(/UTF-8/);
    expect(hex(new TextEncoder().encode(renderArg(xdr.ScVal.scvString(marked))))).toBe(hex(marked));
    expect(() => renderArg(xdr.ScVal.scvString(fromHex("f0 9f 98")))).toThrow(/UTF-8/);
    expect(renderArg(xdr.ScVal.scvString(fromHex("68 69")))).toBe("hi");
  });

  it("refuses a function name that is not valid UTF-8", () => {
    const call = new xdr.InvokeContractArgs({
      contractAddress: new Address(USDC).toScAddress(),
      functionName: fromHex("66 6e ff"),
      args: [],
    });
    const root = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    });

    expect(() => renderCalls(entryFor(root))).toThrow(
      "Function name is not valid UTF-8 and cannot be shown in a wallet",
    );
    expect(() => describeCalls(entryFor(root))).toThrow(/Function name is not valid UTF-8/);
  });

  it("keeps a byte-order mark at the start of a function name", () => {
    const name = fromHex("ef bb bf 66 6e");
    const call = new xdr.InvokeContractArgs({
      contractAddress: new Address(USDC).toScAddress(),
      functionName: name,
      args: [],
    });
    const root = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(call),
      subInvocations: [],
    });

    const [rendered] = renderCalls(entryFor(root));
    expect(hex(new TextEncoder().encode(rendered!.fn))).toBe(hex(name));
    expect(describeCalls(entryFor(root))[0]?.fnConcerns).toEqual(["invisible"]);
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

const at = (codePoint: number): string => String.fromCodePoint(codePoint);
const named = (codePoints: number[]): [name: string, codePoint: number][] =>
  codePoints.map((codePoint) => [`U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`, codePoint]);
const range = (first: number, last: number): number[] => Array.from({ length: last - first + 1 }, (_, i) => first + i);

const NEXT_LINE = 0x85;
const CONTROL = [...range(0x00, 0x09), 0x0b, 0x0c, ...range(0x0e, 0x1f), ...range(0x7f, 0x84), ...range(0x86, 0x9f)];
const NEWLINE = [0x0a, 0x0d, 0x2028, 0x2029];
const BIDI = [...range(0x202a, 0x202e), ...range(0x2066, 0x2069), 0x200e, 0x200f, 0x061c];
const INVISIBLE = [...range(0x200b, 0x200d), 0x2060, 0xfeff, 0x00ad, 0x180e];

const ETH_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const MUXED = new MuxedAccount(new Account(ISSUER, "0"), "5").accountId();
const HASH_TEXT = `xdr:${"ab".repeat(32)}`;

describe("textConcerns", () => {
  const ORDINARY = ["hello", "transfer", "USDC", "5", "", "-5", "true", "void", "invoice #42", "olá, Lisboa ✓"];

  it.each(ORDINARY)("finds nothing in the ordinary text %j", (text) => {
    expect(textConcerns(text)).toEqual([]);
  });

  it.each([
    ["a letter with a combining mark", `e${at(0x301)}`],
    ["a 4-byte code point", at(0x1f600)],
    ["text in another script", "日本語 кириллица"],
    ["a tab-free sentence with punctuation", "Pay 5 USDC to Ana (2nd invoice); thanks!"],
    ["an e-mail address and a URL", "ana@example.com https://example.com/a?b=1"],
    ["half of a surrogate pair", String.fromCharCode(0xd800)],
  ])("finds nothing in %s", (_name, text) => {
    expect(textConcerns(text)).toEqual([]);
  });

  describe.each([
    ["control", CONTROL],
    ["newline", NEWLINE],
    ["bidi", BIDI],
    ["invisible", INVISIBLE],
  ] as [ArgConcern, number[]][])("%s", (concern, codePoints) => {
    it.each(named(codePoints))("is reported for %s, inside a text and alone", (_name, codePoint) => {
      expect(textConcerns(`pay${at(codePoint)}me`)).toEqual([concern]);
      expect(textConcerns(at(codePoint))).toEqual([concern]);
    });
  });

  it("covers the whole of each class and nothing between them", () => {
    expect(CONTROL).toHaveLength(62);
    expect(NEWLINE).toHaveLength(4);
    expect(BIDI).toHaveLength(12);
    expect(INVISIBLE).toHaveLength(7);
    const flagged = range(0x00, 0xffff).filter(
      (codePoint) => (codePoint < 0xd800 || codePoint > 0xdfff) && textConcerns(at(codePoint)).length > 0,
    );
    expect(flagged).toEqual([...CONTROL, NEXT_LINE, ...NEWLINE, ...BIDI, ...INVISIBLE].sort((a, b) => a - b));
  });

  it("reports U+0085, a control character that also breaks a line, as both", () => {
    expect(textConcerns(`a${at(NEXT_LINE)}b`)).toEqual(["control", "newline"]);
  });

  it("does not take a tab for a line break", () => {
    expect(textConcerns("a\tb")).toEqual(["control"]);
    expect(textConcerns("fn\t: transfer")).toEqual(["control", "looks_like_field"]);
  });

  it.each([
    "fn: transfer",
    "fn:transfer",
    "FN: transfer",
    "Fn : transfer",
    "contract: CBIELTK6",
    "Contract: x",
    "account: x",
    "args: [",
    "payload: 0x00",
    "calls: [",
    "fn=transfer",
    "fn = transfer",
    "ARGS=[]",
    '"fn": "transfer"',
    '"fn" : "transfer"',
    "'args' = [1]",
    "`payload`:x",
    '{"contract":"C","fn":"approve"}',
    "thanks (account: mine)",
    "see;calls:2",
  ])("takes %j for something shaped like a field of the message", (text) => {
    expect(textConcerns(text)).toEqual(["looks_like_field"]);
  });

  it.each([
    "fn",
    "contract",
    "account",
    "args",
    "payload",
    "calls",
    "the calls were made",
    "subaccount: 5",
    "SUBACCOUNT: 5",
    "kwargs: 1",
    "my_fn: 1",
    "fn2: x",
    "accounts: 3",
    "calls 5: none",
    "function: transfer",
    "amount: 5",
    "a=b",
  ])("does not take %j for a field of the message", (text) => {
    expect(textConcerns(text)).toEqual([]);
  });

  it("reports a field on a line of its own as a line break and a field", () => {
    expect(textConcerns("thanks\nfn: approve")).toEqual(["newline", "looks_like_field"]);
    expect(textConcerns(`thanks${at(0x2028)}"args": ["${USDC}"]`)).toEqual([
      "newline",
      "looks_like_field",
      "looks_like_address",
    ]);
  });

  it.each([
    ["an account strkey", ISSUER],
    ["a contract strkey", USDC],
    ["a muxed strkey", MUXED],
    ["a strkey inside a sentence", `pay ${ISSUER} today`],
    ["a strkey with text glued to it", `to${USDC}now`],
    ["an Ethereum address inside a sentence", `pay ${ETH_ADDRESS} today`],
    ["a lowercase Ethereum address inside a sentence", `pay ${ETH_ADDRESS.toLowerCase()} today`],
  ])("takes %s for an address", (_name, text) => {
    expect(textConcerns(text)).toEqual(["looks_like_address"]);
  });

  it.each([
    ["an Ethereum address", ETH_ADDRESS],
    ["a lowercase Ethereum address", ETH_ADDRESS.toLowerCase()],
    ["an uppercase Ethereum address", `0x${ETH_ADDRESS.slice(2).toUpperCase()}`],
    ["an Ethereum address padded to 32 bytes", `0x${"00".repeat(12)}${ETH_ADDRESS.slice(2).toLowerCase()}`],
  ])("takes %s on its own for an address and for bytes", (_name, text) => {
    expect(textConcerns(text)).toEqual(["looks_like_address", "looks_like_hash"]);
  });

  it.each([
    ["a strkey one character short", ISSUER.slice(0, -1)],
    ["a strkey in lowercase", ISSUER.toLowerCase()],
    ["a strkey that starts with another letter", `S${ISSUER.slice(1)}`],
    ["56 characters outside the strkey alphabet", `G${"1".repeat(55)}`],
    ["an Ethereum address one digit short", `pay ${ETH_ADDRESS.slice(0, -1)} today`],
    ["40 hex digits without 0x", ETH_ADDRESS.slice(2)],
    ["a short uppercase word", "GABC"],
  ])("does not take %s for an address", (_name, text) => {
    expect(textConcerns(text)).toEqual([]);
  });

  it.each([
    ["the text of a hashed value", HASH_TEXT],
    ["the text of a hashed value inside a sentence", `see ${HASH_TEXT} for details`],
    ["the text of a hashed value in capitals", HASH_TEXT.toUpperCase()],
    ["the text of bytes", "0xdeadbeef"],
    ["the text of bytes in capitals", "0xDEADBEEF"],
    ["the text of one byte", "0x00"],
    ["the text of empty bytes", "0x"],
    ["the text of bytes with a space after it", "0xdeadbeef "],
    ["the text of bytes with a space before it", " 0xdeadbeef"],
  ])("takes %s for a hash or bytes", (_name, text) => {
    expect(textConcerns(text)).toEqual(["looks_like_hash"]);
  });

  it.each([
    ["xdr: and 63 hex digits", HASH_TEXT.slice(0, -1)],
    ["xdr: and something that is not hex", `xdr:${"zz".repeat(32)}`],
    ["64 hex digits without xdr:", "ab".repeat(32)],
    ["0x and an odd number of hex digits", "0xabc"],
    ["0x and something that is not hex", "0xzz"],
    ["bytes inside a sentence", "see 0xdeadbeef for details"],
    ["the letter x", "x"],
    ["a zero", "0"],
  ])("does not take %s for a hash or bytes", (_name, text) => {
    expect(textConcerns(text)).toEqual([]);
  });

  it("lists every concern once, in a fixed order", () => {
    const everything = [
      HASH_TEXT,
      ISSUER,
      "fn: a",
      "args: b",
      at(0x200b),
      at(0xfeff),
      at(0x202e),
      at(0x2066),
      "\n",
      "\r\n",
      at(0x07),
      at(0x1b),
    ].join(" ");
    expect(textConcerns(everything)).toEqual([
      "control",
      "newline",
      "bidi",
      "invisible",
      "looks_like_field",
      "looks_like_address",
      "looks_like_hash",
    ]);
  });

  it("never reports a text as hashed, which only a value can be", () => {
    expect(textConcerns(HASH_TEXT)).not.toContain("hashed");
  });

  it("answers for a long text without delay", () => {
    const words = `${"fn ".repeat(50_000)}${"g".repeat(50_000)}${'"'.repeat(50_000)}!`;
    const almostBytes = `${" ".repeat(50_000)}0x${"ab".repeat(10)}${" ".repeat(50_000)}!`;
    const started = performance.now();
    expect(textConcerns(words)).toEqual([]);
    expect(textConcerns(almostBytes)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

const u128 = (lo: bigint) => xdr.ScVal.scvU128(new xdr.Uint128Parts({ hi: 0n, lo }));
const i128 = (lo: bigint) => xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: 0n, lo }));
const muxedAddress = xdr.ScVal.scvAddress(
  xdr.ScAddress.scAddressTypeMuxedAccount(
    new xdr.MuxedEd25519Account({ id: 5n, ed25519: new Uint8Array(32).fill(0x22) }),
  ),
);

/** Every kind of value that is shown as text, with the word for its type. */
const SHOWN: [type: string, value: xdr.ScVal, text: string][] = [
  ["address", new Address(ISSUER).toScVal(), ISSUER],
  ["address", new Address(USDC).toScVal(), USDC],
  ["u32", xdr.ScVal.scvU32(5), "5"],
  ["i32", xdr.ScVal.scvI32(-5), "-5"],
  ["u64", xdr.ScVal.scvU64(5n), "5"],
  ["i64", xdr.ScVal.scvI64(-5n), "-5"],
  ["u128", u128(5n), "5"],
  ["i128", i128(5n), "5"],
  ["bool", xdr.ScVal.scvBool(true), "true"],
  ["bool", xdr.ScVal.scvBool(false), "false"],
  ["void", xdr.ScVal.scvVoid(), "void"],
  ["symbol", xdr.ScVal.scvSymbol("transfer"), "transfer"],
  ["symbol", xdr.ScVal.scvSymbol(""), ""],
  ["string", xdr.ScVal.scvString("hello"), "hello"],
  ["string", xdr.ScVal.scvString(""), ""],
  ["bytes", xdr.ScVal.scvBytes(fromHex("deadbeef")), "0xdeadbeef"],
  ["bytes", xdr.ScVal.scvBytes(new Uint8Array(0)), "0x"],
];

/** Every kind of value that is bound by the hash of its XDR, with the word for what it is. */
const HASHED: [type: string, value: xdr.ScVal][] = [
  ["vec", xdr.ScVal.scvVec([xdr.ScVal.scvU32(7), xdr.ScVal.scvVoid()])],
  ["vec", xdr.ScVal.scvVec([])],
  ["vec", xdr.ScVal.scvVec([new Address(ISSUER).toScVal()])],
  ["map", xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("a"), val: xdr.ScVal.scvBool(true) })])],
  ["u256", xdr.ScVal.scvU256(new xdr.Uint256Parts({ hiHi: 0n, hiLo: 0n, loHi: 0n, loLo: 5n }))],
  ["i256", xdr.ScVal.scvI256(new xdr.Int256Parts({ hiHi: 0n, hiLo: 0n, loHi: 0n, loLo: 5n }))],
  ["timepoint", xdr.ScVal.scvTimepoint(5n)],
  ["duration", xdr.ScVal.scvDuration(5n)],
  ["error", xdr.ScVal.scvError(xdr.ScError.sceContract(5))],
  ["muxed address", muxedAddress],
  [
    "other",
    xdr.ScVal.scvAddress(
      xdr.ScAddress.scAddressTypeClaimableBalance(xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(new Uint8Array(32))),
    ),
  ],
  [
    "other",
    xdr.ScVal.scvAddress(xdr.ScAddress.scAddressTypeLiquidityPool(xdr.PoolId.fromXdrObject(new Uint8Array(32)))),
  ],
  ["other", xdr.ScVal.scvLedgerKeyContractInstance()],
  ["other", xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: 5n }))],
];

describe("describeArg", () => {
  it.each(SHOWN)("describes a value of type %s as readable text of that type", (type, value, text) => {
    expect(describeArg(value)).toEqual({ text, type, hashed: false, concerns: [] } satisfies DescribedArg);
    expect(describeArg(value).text).toBe(renderArg(value));
  });

  it.each(HASHED)("describes a %s as a value that cannot be read", (type, value) => {
    const described = describeArg(value);
    expect(described).toEqual({ text: renderArg(value), type, hashed: true, concerns: ["hashed"] });
    expect(described.text).toMatch(/^xdr:[0-9a-f]{64}$/);
  });

  it("names every type that is shown as text", () => {
    expect([...new Set(SHOWN.map(([type]) => type))]).toEqual([
      "address",
      "u32",
      "i32",
      "u64",
      "i64",
      "u128",
      "i128",
      "bool",
      "void",
      "symbol",
      "string",
      "bytes",
    ]);
    expect([...new Set(HASHED.map(([type]) => type))]).toEqual([
      "vec",
      "map",
      "u256",
      "i256",
      "timepoint",
      "duration",
      "error",
      "muxed address",
      "other",
    ]);
  });

  it("tells apart the eight values a wallet shows as 5", () => {
    const fives = [
      xdr.ScVal.scvU32(5),
      xdr.ScVal.scvI32(5),
      xdr.ScVal.scvU64(5n),
      xdr.ScVal.scvI64(5n),
      u128(5n),
      i128(5n),
      xdr.ScVal.scvString("5"),
      xdr.ScVal.scvSymbol("5"),
    ].map(describeArg);

    expect(fives.map(({ text }) => text)).toEqual(Array(8).fill("5"));
    expect(fives.map(({ type }) => type)).toEqual(["u32", "i32", "u64", "i64", "u128", "i128", "string", "symbol"]);
    expect(fives.flatMap(({ concerns }) => concerns)).toEqual([]);
  });

  it("flags a String that reads like an address, and not the address itself", () => {
    expect(describeArg(new Address(ISSUER).toScVal())).toEqual({
      text: ISSUER,
      type: "address",
      hashed: false,
      concerns: [],
    });
    expect(describeArg(xdr.ScVal.scvString(ISSUER))).toEqual({
      text: ISSUER,
      type: "string",
      hashed: false,
      concerns: ["looks_like_address"],
    });
    expect(describeArg(xdr.ScVal.scvSymbol(USDC)).concerns).toEqual(["looks_like_address"]);
  });

  it("flags a String that reads like bytes, and not the bytes themselves", () => {
    const bytes = describeArg(xdr.ScVal.scvBytes(fromHex("deadbeef")));
    const lookalike = describeArg(xdr.ScVal.scvString("0xdeadbeef"));

    expect(lookalike.text).toBe(bytes.text);
    expect(bytes).toMatchObject({ type: "bytes", concerns: [] });
    expect(lookalike).toMatchObject({ type: "string", hashed: false, concerns: ["looks_like_hash"] });
  });

  it("does not look for addresses in bytes, which are shown as they are", () => {
    const twentyBytes = xdr.ScVal.scvBytes(fromHex(ETH_ADDRESS.slice(2)));
    expect(describeArg(twentyBytes)).toEqual({
      text: ETH_ADDRESS.toLowerCase(),
      type: "bytes",
      hashed: false,
      concerns: [],
    });
  });

  it("tells a hashed value from a String that holds the same text", () => {
    const vec = xdr.ScVal.scvVec([xdr.ScVal.scvU32(7)]);
    const hashed = describeArg(vec);
    const lookalike = describeArg(xdr.ScVal.scvString(hashed.text));

    expect(lookalike.text).toBe(hashed.text);
    expect(hashed).toMatchObject({ type: "vec", hashed: true, concerns: ["hashed"] });
    expect(lookalike).toMatchObject({ type: "string", hashed: false, concerns: ["looks_like_hash"] });
  });

  it("reports what is wrong with the text of a String or a Symbol", () => {
    expect(describeArg(xdr.ScVal.scvString("thanks\nfn: approve"))).toEqual({
      text: "thanks\nfn: approve",
      type: "string",
      hashed: false,
      concerns: ["newline", "looks_like_field"],
    });
    expect(describeArg(xdr.ScVal.scvSymbol(`USDC${at(0x202e)}`)).concerns).toEqual(["bidi"]);
    expect(describeArg(xdr.ScVal.scvString(`a${at(0x00)}b`)).concerns).toEqual(["control"]);
  });

  it("keeps and reports a byte-order mark at the start of a String", () => {
    const described = describeArg(xdr.ScVal.scvString(fromHex("ef bb bf 68 69")));
    expect(hex(new TextEncoder().encode(described.text))).toBe("efbbbf6869");
    expect(described.concerns).toEqual(["invisible"]);
  });

  it("refuses a String that is not valid UTF-8, as renderArg does", () => {
    expect(() => describeArg(xdr.ScVal.scvString(fromHex("68 69 ff")))).toThrow(
      "String is not valid UTF-8 and cannot be shown in a wallet",
    );
  });
});

describe("describeCalls", () => {
  const hub = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
  const other = "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY";
  const asText = (calls: DescribedCall[]) =>
    calls.map(({ contract, fn, args }) => ({ contract, fn, args: args.map(({ text }) => text) }));

  it("lists the calls renderCalls lists, in the same order and with the same text", () => {
    const tree = invocation(hub, "exit", [xdr.ScVal.scvU32(6), xdr.ScVal.scvVec([xdr.ScVal.scvU32(7)])], [
      invocation(USDC, "transfer", [new Address(hub).toScVal(), muxedAddress, i128(2_500_000n)], [
        invocation(other, "notify", [xdr.ScVal.scvSymbol("deep"), xdr.ScVal.scvString("thanks\nfn: approve")]),
      ]),
      invocation(other, "burn", []),
    ]);
    const entry = entryFor(tree);

    const described = describeCalls(entry);
    expect(asText(described)).toEqual(renderCalls(entry));
    expect(described.map(({ fn }) => fn)).toEqual(["exit", "transfer", "notify", "burn"]);
  });

  it("describes a transfer: three readable arguments and nothing to worry about", () => {
    const tree = invocation(USDC, "transfer", [
      new Address(hub).toScVal(),
      new Address(ISSUER).toScVal(),
      i128(2_500_000n),
    ]);

    expect(describeCalls(entryFor(tree))).toEqual([
      {
        contract: USDC,
        fn: "transfer",
        fnConcerns: [],
        args: [
          { text: hub, type: "address", hashed: false, concerns: [] },
          { text: ISSUER, type: "address", hashed: false, concerns: [] },
          { text: "2500000", type: "i128", hashed: false, concerns: [] },
        ],
      },
    ] satisfies DescribedCall[]);
  });

  it("describes the recipient of a transfer to a muxed address as a value that cannot be read", () => {
    const tree = invocation(USDC, "transfer", [new Address(hub).toScVal(), muxedAddress, i128(1n)]);
    const [call] = describeCalls(entryFor(tree));

    expect(call?.args[1]).toEqual({
      text: renderArg(muxedAddress),
      type: "muxed address",
      hashed: true,
      concerns: ["hashed"],
    });
  });

  it("reports concerns about a function name", () => {
    const names: [fn: string, concerns: ArgConcern[]][] = [
      ["transfer", []],
      ["a\nfn: b", ["newline", "looks_like_field"]],
      [`pay${at(0x202e)}`, ["bidi"]],
      [`a${at(0x200b)}b`, ["invisible"]],
      ["calls=", ["looks_like_field"]],
      ["0xdeadbeef", ["looks_like_hash"]],
    ];
    const tree = invocation(hub, names[0]![0], [], names.slice(1).map(([fn]) => invocation(other, fn, [])));

    const described = describeCalls(entryFor(tree));
    expect(described.map(({ fn, fnConcerns }) => [fn, fnConcerns])).toEqual(names);
  });

  it("refuses a tree that creates a contract, as renderCalls does", () => {
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

    expect(() => describeCalls(entryFor(create))).toThrow(/contract function/);
    expect(() => describeCalls(entryFor(invocation(hub, "exit", [], [create])))).toThrow(/contract function/);
  });

  it("returns plain JSON", () => {
    const tree = invocation(USDC, "transfer", [new Address(hub).toScVal(), muxedAddress, xdr.ScVal.scvString("a\nb")]);
    const described = describeCalls(entryFor(tree));
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
  });
});
