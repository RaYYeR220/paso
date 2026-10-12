import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { hexToBytes, isHex } from "viem";

const INTEGER_TYPES = ["u32", "i32", "u64", "i64", "u128", "i128"] as const;
type IntegerType = (typeof INTEGER_TYPES)[number];

const isIntegerType = (type: string): type is IntegerType => (INTEGER_TYPES as readonly string[]).includes(type);

/**
 * Reads one contract argument written as `type:value`:
 *
 *   address:C…   i128:50000000   u32:1200   bool:true
 *   symbol:transfer   string:hello   bytes:0xdeadbeef   void
 */
export function parseArgument(text: string): xdr.ScVal {
  const input = text.trim();
  if (input === "void") return xdr.ScVal.scvVoid();
  const separator = input.indexOf(":");
  if (separator < 1) throw new Error(`"${input}" is not written as type:value`);
  const type = input.slice(0, separator).trim().toLowerCase();
  const value = input.slice(separator + 1).trim();

  if (isIntegerType(type)) {
    if (!/^-?\d+$/.test(value)) throw new Error(`"${value}" is not a whole number`);
    return nativeToScVal(BigInt(value), { type });
  }
  switch (type) {
    case "address":
      try {
        return new Address(value).toScVal();
      } catch {
        throw new Error(`"${value}" is not a Stellar address`);
      }
    case "bool":
      if (value !== "true" && value !== "false") throw new Error(`"${value}" is not true or false`);
      return xdr.ScVal.scvBool(value === "true");
    case "symbol":
      return xdr.ScVal.scvSymbol(value);
    case "string":
      return nativeToScVal(value, { type: "string" });
    case "bytes":
      if (!isHex(value)) throw new Error(`"${value}" is not hex (0x…)`);
      return xdr.ScVal.scvBytes(hexToBytes(value));
    default:
      throw new Error(`"${type}" is not a supported argument type`);
  }
}

/** Reads a list of arguments, one per line. Blank lines are skipped. */
export function parseArguments(text: string): xdr.ScVal[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseArgument);
}
