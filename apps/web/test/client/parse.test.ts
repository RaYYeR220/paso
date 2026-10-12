import { describe, expect, it } from "vitest";
import { buildAction } from "@/lib/client/action/build";
import { parseArgument, parseArguments } from "@/lib/client/action/args";
import { NameNotFoundError } from "@/lib/client/ens";
import { decodeParam, parseOwnerInput, parseRecipient } from "@/lib/client/parse";
import { network, RECIPIENT, twin, owner } from "./helpers";

const CHECKSUMMED = "0x7880DA9a52Af491f76421869d4e28DC0A4D1767C";
const USDC = network.stellar.usdc;

describe("parseOwnerInput", () => {
  it("knows nothing was typed", () => {
    expect(parseOwnerInput("")).toEqual({ kind: "empty" });
    expect(parseOwnerInput("   ")).toEqual({ kind: "empty" });
  });

  it("reads an address in any single case and returns it checksummed", () => {
    expect(parseOwnerInput(CHECKSUMMED)).toEqual({ kind: "address", address: CHECKSUMMED });
    expect(parseOwnerInput(CHECKSUMMED.toLowerCase())).toEqual({ kind: "address", address: CHECKSUMMED });
    expect(parseOwnerInput(`0x${CHECKSUMMED.slice(2).toUpperCase()}`)).toEqual({ kind: "address", address: CHECKSUMMED });
    expect(parseOwnerInput(`0X${CHECKSUMMED.slice(2).toLowerCase()}`)).toEqual({ kind: "address", address: CHECKSUMMED });
    expect(parseOwnerInput(`  ${CHECKSUMMED}\n`)).toEqual({ kind: "address", address: CHECKSUMMED });
  });

  it("refuses a mixed-case address whose checksum does not match", () => {
    const typo = CHECKSUMMED.replace("DA9a", "dA9A");
    const parsed = parseOwnerInput(typo);
    expect(parsed.kind).toBe("invalid");
    expect(parsed.kind === "invalid" && parsed.reason).toMatch(/checksum/);
  });

  it("says what is wrong with something that only starts like an address", () => {
    expect(parseOwnerInput("0x1234")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/40 hex digits/) });
    expect(parseOwnerInput(`${CHECKSUMMED}00`)).toMatchObject({ kind: "invalid" });
    expect(parseOwnerInput("0xZZ80DA9a52Af491f76421869d4e28DC0A4D1767C")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/hex/) });
  });

  it("reads ENS names and normalises them", () => {
    expect(parseOwnerInput("vitalik.eth")).toEqual({ kind: "ens", name: "vitalik.eth" });
    expect(parseOwnerInput("Vitalik.ETH")).toEqual({ kind: "ens", name: "vitalik.eth" });
    expect(parseOwnerInput("sub.name.eth")).toEqual({ kind: "ens", name: "sub.name.eth" });
    expect(parseOwnerInput("jesse.base.eth")).toEqual({ kind: "ens", name: "jesse.base.eth" });
  });

  it("refuses what is neither", () => {
    expect(parseOwnerInput("vitalik")).toMatchObject({ kind: "invalid" });
    expect(parseOwnerInput("two words.eth")).toMatchObject({ kind: "invalid" });
    expect(parseOwnerInput(".eth")).toMatchObject({ kind: "invalid" });
    expect(parseOwnerInput("name..eth")).toMatchObject({ kind: "invalid" });
    expect(parseOwnerInput(RECIPIENT)).toMatchObject({ kind: "invalid" });
  });
});

describe("parseRecipient", () => {
  it("accepts Stellar accounts and contracts as they are", () => {
    expect(parseRecipient(RECIPIENT)).toEqual({ kind: "stellar", address: RECIPIENT });
    expect(parseRecipient(` ${USDC} `)).toEqual({ kind: "stellar", address: USDC });
  });

  it("accepts Ethereum addresses and names", () => {
    expect(parseRecipient(CHECKSUMMED)).toEqual({ kind: "address", address: CHECKSUMMED });
    expect(parseRecipient("vitalik.eth")).toEqual({ kind: "ens", name: "vitalik.eth" });
  });

  it("catches a Stellar address with a typo, and muxed addresses", () => {
    const typo = `${RECIPIENT.slice(0, -1)}${RECIPIENT.endsWith("A") ? "B" : "A"}`;
    expect(parseRecipient(typo)).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/typo/) });
    expect(parseRecipient(`M${"A".repeat(68)}`)).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/Muxed/) });
  });

  it("says what it takes when it gets nothing useful", () => {
    expect(parseRecipient("")).toEqual({ kind: "empty" });
    expect(parseRecipient("hello")).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/G… or C…/) });
  });
});

describe("decodeParam", () => {
  it("decodes what a URL encoded and leaves the rest alone", () => {
    expect(decodeParam("vitalik.eth")).toBe("vitalik.eth");
    expect(decodeParam("caf%C3%A9.eth")).toBe("café.eth");
    expect(decodeParam("100%")).toBe("100%");
  });
});

describe("buildAction", () => {
  const resolveName = async (name: string) => (name === "owner.eth" ? owner.address : null);
  const context = { network, resolveName };

  it("sends to a Stellar address as typed", async () => {
    const built = await buildAction({ kind: "transfer", to: RECIPIENT, amount: "5" }, context);
    expect(built.action).toEqual({ kind: "transfer", to: RECIPIENT, amount: 50_000_000n });
    expect(built.recipient).toEqual({ input: RECIPIENT, kind: "stellar", stellar: RECIPIENT });
    expect(built.amount).toBe(50_000_000n);
  });

  it("sends to the Stellar account of an Ethereum address", async () => {
    const built = await buildAction({ kind: "transfer", to: owner.address, amount: 1n }, context);
    expect(built.action).toEqual({ kind: "transfer", to: twin, amount: 1n });
    expect(built.recipient).toMatchObject({ kind: "evm", evm: owner.address, stellar: twin });
  });

  it("resolves an ENS name to that address's Stellar account", async () => {
    const built = await buildAction({ kind: "transfer", to: "Owner.eth", amount: "0.5" }, context);
    expect(built.action).toEqual({ kind: "transfer", to: twin, amount: 5_000_000n });
    expect(built.recipient).toMatchObject({ kind: "ens", name: "owner.eth", evm: owner.address, stellar: twin });
  });

  it("stops at a name that points nowhere", async () => {
    await expect(buildAction({ kind: "transfer", to: "nobody.eth", amount: "1" }, context)).rejects.toBeInstanceOf(NameNotFoundError);
  });

  it("refuses bad recipients and amounts before asking the network", async () => {
    await expect(buildAction({ kind: "transfer", to: "", amount: "1" }, context)).rejects.toThrow(/who receives/);
    await expect(buildAction({ kind: "transfer", to: "hello", amount: "1" }, context)).rejects.toThrow(/G… or C…/);
    await expect(buildAction({ kind: "transfer", to: RECIPIENT, amount: "0" }, context)).rejects.toThrow(/above zero/);
    await expect(buildAction({ kind: "transfer", to: RECIPIENT, amount: "1.23456789" }, context)).rejects.toThrow(/decimal places/);
    await expect(buildAction({ kind: "transfer", to: RECIPIENT, amount: "ten" }, context)).rejects.toThrow(/not a valid amount/);
  });

  it("builds a withdrawal to Base for an address or a name, and for nothing else", async () => {
    const built = await buildAction({ kind: "exit", recipient: owner.address.toLowerCase(), amount: "2" }, context);
    expect(built.action).toEqual({ kind: "exit", amount: 20_000_000n, recipient: owner.address });
    expect(built.recipient).toMatchObject({ kind: "evm", evm: owner.address });
    expect((await buildAction({ kind: "exit", recipient: "owner.eth", amount: "2" }, context)).recipient).toMatchObject({
      kind: "ens",
      evm: owner.address,
    });
    await expect(buildAction({ kind: "exit", recipient: RECIPIENT, amount: "2" }, context)).rejects.toThrow(/Ethereum address/);
  });

  it("passes a generic call through", async () => {
    const args = parseArguments(`address:${twin}\ni128:1`);
    const built = await buildAction({ kind: "invoke", contract: USDC, fn: "approve", args }, context);
    expect(built).toEqual({ action: { kind: "invoke", contract: USDC, fn: "approve", args }, recipient: null, amount: null });
  });
});

describe("parseArguments", () => {
  it("reads one typed value per line", () => {
    const args = parseArguments(`address:${twin}\n\n  i128: 50000000 \nu32:1200\nbool:true\nsymbol:transfer\nstring:hello\nbytes:0xdeadbeef\nvoid`);
    expect(args.map((arg) => arg.type)).toEqual(["scvAddress", "scvI128", "scvU32", "scvBool", "scvSymbol", "scvString", "scvBytes", "scvVoid"]);
  });

  it("says which value it could not read", () => {
    expect(() => parseArgument("50000000")).toThrow(/type:value/);
    expect(() => parseArgument("i128:1.5")).toThrow(/whole number/);
    expect(() => parseArgument("address:nope")).toThrow(/Stellar address/);
    expect(() => parseArgument("bool:yes")).toThrow(/true or false/);
    expect(() => parseArgument("bytes:beef")).toThrow(/hex/);
    expect(() => parseArgument("vec:[1]")).toThrow(/supported/);
  });
});
