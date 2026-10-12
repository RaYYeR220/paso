/**
 * Writes `fixtures/vectors.json`: the signing vectors that the Soroban
 * contracts and the TypeScript SDK both have to reproduce byte for byte.
 *
 * Every argument is listed next to the text a wallet must show for it. Those
 * texts are typed out here by hand, straight from the encoding table, so the
 * file can catch a renderer that is wrong in the same way on both sides. The
 * digest and the signature come from viem.
 *
 * The private keys below are fixed test keys. They control nothing.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Address, StrKey, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

const types = {
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

const KEY_A: Hex = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OWNER_A = "0xFCAd0B19bB29D4674531d6f115237E16AfCE377c";
const KEY_B: Hex = "0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const OWNER_B = "0x6A9296CEb89D12e1F53b2Dd5Df45d3ADB3A814c2";

const ACCOUNT_A = "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG";
const ACCOUNT_B = "CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K";
const HUB = "CDB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4G2F3";
const OTHER_CONTRACT = "CDKNJVGU2TKNJVGU2TKNJVGU2TKNJVGU2TKNJVGU2TKNJVGU2TKNJJM5";
const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_MAINNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const ALICE = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const BOB = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

interface Arg {
  value: xdr.ScVal;
  text: string;
}

interface Call {
  contract: string;
  fn: string;
  args: Arg[];
}

interface Case {
  name: string;
  network: "testnet" | "mainnet";
  privateKey: Hex;
  owner: string;
  account: string;
  calls: Call[];
}

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();
const hex = (data: Uint8Array): Hex => `0x${Buffer.from(data).toString("hex")}`;

const arg = (value: xdr.ScVal, text: string): Arg => ({ value, text });

/** Values with no text form are shown as the hash of their XDR. */
const hashed = (value: xdr.ScVal): Arg => ({
  value,
  text: `xdr:${sha256(value.toXDR()).toString("hex")}`,
});

const address = (strkey: string) => new Address(strkey).toScVal();
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const i32 = (n: number) => xdr.ScVal.scvI32(n);
const u64 = (n: bigint) => nativeToScVal(n, { type: "u64" });
const i64 = (n: bigint) => nativeToScVal(n, { type: "i64" });
const u128 = (n: bigint) => nativeToScVal(n, { type: "u128" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const u256 = (n: bigint) => nativeToScVal(n, { type: "u256" });
const i256 = (n: bigint) => nativeToScVal(n, { type: "i256" });
const bool = (b: boolean) => xdr.ScVal.scvBool(b);
const symbol = (s: string) => xdr.ScVal.scvSymbol(s);
const string = (s: string) => xdr.ScVal.scvString(Buffer.from(s, "utf8"));
const bytes = (h: string) => xdr.ScVal.scvBytes(Buffer.from(h, "hex"));
const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items);
const map = (entries: [xdr.ScVal, xdr.ScVal][]) =>
  xdr.ScVal.scvMap(entries.map(([key, val]) => new xdr.ScMapEntry({ key, val })));
const muxed = (account: string, id: bigint) =>
  xdr.ScVal.scvAddress(
    xdr.ScAddress.scAddressTypeMuxedAccount(
      new xdr.MuxedEd25519Account({
        id: xdr.Uint64.fromString(id.toString()),
        ed25519: Buffer.from(StrKey.decodeEd25519PublicKey(account)),
      }),
    ),
  );

const cases: Case[] = [
  {
    name: "usdc_transfer",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: USDC_TESTNET,
        fn: "transfer",
        args: [
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(address(ALICE), "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"),
          arg(i128(10_000_000n), "10000000"),
        ],
      },
    ],
  },
  {
    name: "exit_with_nested_transfer",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: HUB,
        fn: "exit",
        args: [
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(i128(5_000_000n), "5000000"),
          arg(u32(6), "6"),
          arg(
            bytes("000000000000000000000000fcad0b19bb29d4674531d6f115237e16afce377c"),
            "0x000000000000000000000000fcad0b19bb29d4674531d6f115237e16afce377c",
          ),
          arg(i128(500n), "500"),
          arg(u32(1000), "1000"),
        ],
      },
      {
        contract: USDC_TESTNET,
        fn: "transfer",
        args: [
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(address(HUB), "CDB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4HQ6DYPB4G2F3"),
          arg(i128(5_000_000n), "5000000"),
        ],
      },
    ],
  },
  {
    name: "three_calls_two_levels",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: OTHER_CONTRACT,
        fn: "swap",
        args: [
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(i128(250_000_000n), "250000000"),
          arg(i128(249_000_000n), "249000000"),
        ],
      },
      {
        contract: HUB,
        fn: "route",
        args: [arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"), arg(u32(2), "2")],
      },
      {
        contract: USDC_TESTNET,
        fn: "transfer",
        args: [
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(address(OTHER_CONTRACT), "CDKNJVGU2TKNJVGU2TKNJVGU2TKNJVGU2TKNJVGU2TKNJVGU2TKNJJM5"),
          arg(i128(250_000_000n), "250000000"),
        ],
      },
    ],
  },
  {
    name: "negative_i128",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: OTHER_CONTRACT,
        fn: "adjust",
        args: [
          arg(i128(-1n), "-1"),
          arg(i128(-10_000_000n), "-10000000"),
          arg(i128(-12345678901234567890123n), "-12345678901234567890123"),
          arg(i128(-(2n ** 127n)), "-170141183460469231731687303715884105728"),
          arg(i128(2n ** 127n - 1n), "170141183460469231731687303715884105727"),
          arg(i128(0n), "0"),
        ],
      },
    ],
  },
  {
    name: "integers_bool_void",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: OTHER_CONTRACT,
        fn: "configure",
        args: [
          arg(u32(0), "0"),
          arg(u32(4_294_967_295), "4294967295"),
          arg(i32(-2_147_483_648), "-2147483648"),
          arg(i32(2_147_483_647), "2147483647"),
          arg(u64(18_446_744_073_709_551_615n), "18446744073709551615"),
          arg(u64(1_000n), "1000"),
          arg(i64(-9_223_372_036_854_775_808n), "-9223372036854775808"),
          arg(i64(9_223_372_036_854_775_807n), "9223372036854775807"),
          arg(u128(2n ** 128n - 1n), "340282366920938463463374607431768211455"),
          arg(u128(10n ** 19n), "10000000000000000000"),
          arg(bool(true), "true"),
          arg(bool(false), "false"),
          arg(xdr.ScVal.scvVoid(), "void"),
        ],
      },
    ],
  },
  {
    name: "symbol_and_string",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: OTHER_CONTRACT,
        fn: "set_label_with_a_32_char_fn_name",
        args: [
          arg(symbol("ok"), "ok"),
          arg(symbol("USDC_2026"), "USDC_2026"),
          arg(symbol("a_symbol_longer_than_nine_chars"), "a_symbol_longer_than_nine_chars"),
          arg(symbol(""), ""),
          arg(string("hello world"), "hello world"),
          arg(string("Día de pago — ¥ 100 → 🚀"), "Día de pago — ¥ 100 → 🚀"),
          arg(string(""), ""),
          arg(string("true"), "true"),
        ],
      },
    ],
  },
  {
    name: "bytes_and_bytesn",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: OTHER_CONTRACT,
        fn: "store",
        args: [
          arg(bytes(""), "0x"),
          arg(bytes("00"), "0x00"),
          arg(bytes("deadbeef"), "0xdeadbeef"),
          arg(bytes("00ff10a0090f"), "0x00ff10a0090f"),
          arg(
            bytes("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"),
            "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
          ),
          arg(
            bytes("fcad0b19bb29d4674531d6f115237e16afce377c"),
            "0xfcad0b19bb29d4674531d6f115237e16afce377c",
          ),
        ],
      },
    ],
  },
  {
    name: "vec_and_map_hashed",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: OTHER_CONTRACT,
        fn: "batch",
        args: [
          hashed(vec([u32(1), u32(2), u32(3)])),
          hashed(vec([])),
          hashed(
            map([
              [symbol("amount"), i128(10_000_000n)],
              [symbol("to"), address(ALICE)],
            ]),
          ),
          hashed(vec([address(ALICE), vec([i128(-5n), bytes("c0ffee")])])),
          hashed(u256(1n)),
          hashed(u256(2n ** 255n + 12345n)),
          hashed(i256(-7n)),
          hashed(xdr.ScVal.scvTimepoint(xdr.Uint64.fromString("1791849600"))),
          hashed(xdr.ScVal.scvDuration(xdr.Uint64.fromString("86400"))),
          hashed(muxed(BOB, 42n)),
          arg(u32(7), "7"),
        ],
      },
    ],
  },
  {
    name: "no_arguments",
    network: "testnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [{ contract: OTHER_CONTRACT, fn: "ping", args: [] }],
  },
  {
    name: "second_owner",
    network: "testnet",
    privateKey: KEY_B,
    owner: OWNER_B,
    account: ACCOUNT_B,
    calls: [
      {
        contract: USDC_TESTNET,
        fn: "transfer",
        args: [
          arg(address(ACCOUNT_B), "CCZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLFMVSWKZLEB3K"),
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(i128(1n), "1"),
        ],
      },
    ],
  },
  {
    name: "usdc_transfer_on_mainnet",
    network: "mainnet",
    privateKey: KEY_A,
    owner: OWNER_A,
    account: ACCOUNT_A,
    calls: [
      {
        contract: USDC_MAINNET,
        fn: "transfer",
        args: [
          arg(address(ACCOUNT_A), "CCQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2DINBUGQ2CNSG"),
          arg(address(ALICE), "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"),
          arg(i128(10_000_000n), "10000000"),
        ],
      },
    ],
  },
];

const passphrases = { testnet: TESTNET, mainnet: MAINNET };

async function build(c: Case) {
  const signer = privateKeyToAccount(c.privateKey);
  if (signer.address !== c.owner) {
    throw new Error(`${c.name}: owner does not match the private key`);
  }

  const networkPassphrase = passphrases[c.network];
  const networkId = hex(sha256(networkPassphrase));
  const payload = hex(sha256(`paso vector: ${c.name}`));

  const typedData = {
    domain: { name: "Paso", version: "1", salt: networkId },
    types,
    primaryType: "Authorization",
    message: {
      account: c.account,
      calls: c.calls.map((call) => ({
        contract: call.contract,
        fn: call.fn,
        args: call.args.map((a) => a.text),
      })),
      payload,
    },
  } as const;

  return {
    name: c.name,
    network: c.network,
    networkPassphrase,
    networkId,
    owner: c.owner,
    privateKey: c.privateKey,
    account: c.account,
    payload,
    calls: c.calls.map((call) => ({
      contract: call.contract,
      fn: call.fn,
      argsXdr: call.args.map((a) => a.value.toXDR("base64")),
      argsText: call.args.map((a) => a.text),
    })),
    digest: hashTypedData(typedData),
    signature: await signer.signTypedData(typedData),
  };
}

const vectors = [];
for (const c of cases) {
  vectors.push(await build(c));
}

const out = {
  networkPassphrase: TESTNET,
  networkId: hex(sha256(TESTNET)),
  vectors,
};

const target = fileURLToPath(new URL("../vectors.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${vectors.length} vectors written to ${target}`);
