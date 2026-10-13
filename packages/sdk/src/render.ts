import { Address, hash, xdr } from "@stellar/stellar-sdk";
import { toHex } from "viem";

/** One contract call the way the wallet shows it and the account contract rebuilds it. */
export interface Call {
  contract: string;
  fn: string;
  args: string[];
}

/**
 * Something a reader of the signed message should be told about a text or a
 * value. The message is text only, with no types and no escaping, so
 * different values can look the same in a wallet.
 *
 * - `control`: a control character. Line feed and carriage return count as `newline` only.
 * - `newline`: a line break, which lets one argument look like several lines.
 * - `bidi`: a character that changes the direction text is drawn in.
 * - `invisible`: a character that takes no room, such as a zero-width space.
 * - `looks_like_field`: text shaped like another line of the message (`fn:`, `args:`).
 * - `looks_like_address`: text that holds the shape of an address; an address argument renders the same.
 * - `looks_like_hash`: text that reads like bytes or like a value bound by hash.
 * - `hashed`: the value is bound by the hash of its XDR and cannot be read.
 */
export type ArgConcern =
  | "control"
  | "newline"
  | "bidi"
  | "invisible"
  | "looks_like_field"
  | "looks_like_address"
  | "looks_like_hash"
  | "hashed";

/** One argument with what the signed text leaves out: its type, and what to be careful about. */
export interface DescribedArg {
  /** The text that is signed, exactly as `renderArg` gives it. */
  text: string;
  /**
   * Soroban type in a word: "address", "u32", "i32", "u64", "i64", "u128",
   * "i128", "bool", "void", "symbol", "string", "bytes"; for values bound by
   * hash the kind: "vec", "map", "u256", "i256", "timepoint", "duration",
   * "error", "muxed address", or "other".
   */
  type: string;
  /** True when the text is `xdr:<sha256>` and the value itself cannot be read. */
  hashed: boolean;
  concerns: ArgConcern[];
}

/** One call with every argument described. Plain JSON. */
export interface DescribedCall {
  contract: string;
  fn: string;
  /** Concerns about the function name itself. */
  fnConcerns: ArgConcern[];
  args: DescribedArg[];
}

/**
 * The account contract hashes the bytes of a `String` or `Symbol` as they
 * are, and a wallet hashes the UTF-8 encoding of the text it is given. The
 * two agree only when decoding loses nothing: a leading byte-order mark is
 * kept (`ignoreBOM`), and bytes that are not UTF-8 are refused (`fatal`).
 */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function text(value: xdr.XdrString, what: string): string {
  try {
    return utf8.decode(value.bytes);
  } catch {
    throw new Error(`${what} is not valid UTF-8 and cannot be shown in a wallet`);
  }
}

function fromParts(hi: bigint, lo: bigint): string {
  return ((hi << 64n) | lo).toString();
}

function hashOf(value: xdr.ScVal): string {
  return `xdr:${toHex(hash(value.toXdr())).slice(2)}`;
}

/** The signed text of a value, with the two things the text does not say. */
interface Rendered {
  text: string;
  type: string;
  hashed: boolean;
}

const shown = (type: string, text: string): Rendered => ({ text, type, hashed: false });
const bound = (type: string, value: xdr.ScVal): Rendered => ({ text: hashOf(value), type, hashed: true });

function render(value: xdr.ScVal): Rendered {
  switch (value.type) {
    case "scvAddress":
      switch (value.address.type) {
        case "scAddressTypeAccount":
        case "scAddressTypeContract":
          return shown("address", Address.fromScAddress(value.address).toString());
        case "scAddressTypeMuxedAccount":
          return bound("muxed address", value);
        default:
          return bound("other", value);
      }
    case "scvU32":
      return shown("u32", value.u32.toString());
    case "scvI32":
      return shown("i32", value.i32.toString());
    case "scvU64":
      return shown("u64", value.u64.toString());
    case "scvI64":
      return shown("i64", value.i64.toString());
    case "scvU128":
      return shown("u128", fromParts(value.u128.hi, value.u128.lo));
    case "scvI128":
      return shown("i128", fromParts(value.i128.hi, value.i128.lo));
    case "scvBool":
      return shown("bool", value.b ? "true" : "false");
    case "scvVoid":
      return shown("void", "void");
    case "scvSymbol":
      return shown("symbol", text(value.sym, "Symbol"));
    case "scvString":
      return shown("string", text(value.str, "String"));
    case "scvBytes":
      return shown("bytes", toHex(value.bytes.toBytes()));
    case "scvVec":
      return bound("vec", value);
    case "scvMap":
      return bound("map", value);
    case "scvU256":
      return bound("u256", value);
    case "scvI256":
      return bound("i256", value);
    case "scvTimepoint":
      return bound("timepoint", value);
    case "scvDuration":
      return bound("duration", value);
    case "scvError":
      return bound("error", value);
    default:
      return bound("other", value);
  }
}

/**
 * Renders one argument to the text that is signed.
 *
 * Addresses, integers up to 128 bits, booleans, void, symbols, strings and
 * bytes are shown as text. Every other value is bound by the hash of its XDR.
 */
export function renderArg(value: xdr.ScVal): string {
  return render(value).text;
}

/** Visits the contract calls of an invocation tree: the call itself, then each sub-invocation depth first. */
function eachCall(invocation: xdr.SorobanAuthorizedInvocation, visit: (call: xdr.InvokeContractArgs) => void): void {
  const fn = invocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("Only contract function calls can be authorised; this request creates a contract");
  }
  visit(fn.contractFn);
  for (const sub of invocation.subInvocations) {
    eachCall(sub, visit);
  }
}

/**
 * Lists the calls an authorisation entry covers, in the order the account
 * contract receives them: the root call, then each sub-invocation depth first.
 */
export function renderCalls(entry: xdr.SorobanAuthorizationEntry): Call[] {
  const calls: Call[] = [];
  eachCall(entry.rootInvocation, ({ contractAddress, functionName, args }) => {
    calls.push({
      contract: Address.fromScAddress(contractAddress).toString(),
      fn: text(functionName, "Function name"),
      args: args.map(renderArg),
    });
  });
  return calls;
}

/** What to look for in a text, in the order concerns are reported. */
const TEXT_CONCERNS: readonly (readonly [ArgConcern, RegExp])[] = [
  ["control", /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/],
  ["newline", /[\n\r\u0085\u2028\u2029]/],
  ["bidi", /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/],
  ["invisible", /[\u00ad\u180e\u200b-\u200d\u2060\ufeff]/],
  [
    "looks_like_field",
    /(?:^|[^a-z0-9_])(?:fn|contract|account|args|payload|calls)[\s"'`\u2018\u2019\u201c\u201d]*[:=]/i,
  ],
  ["looks_like_address", /[GCM][A-Z2-7]{55}|0[xX][0-9a-fA-F]{40}/],
  ["looks_like_hash", /xdr:[0-9a-f]{64}|^\s*0x(?:[0-9a-f]{2})*\s*$/i],
];

/**
 * What a reader should be told about a text that will be shown in a wallet as
 * it is. Pure, and defined for any string.
 *
 * - `control`: U+0000 to U+001F except line feed and carriage return, and U+007F to U+009F.
 * - `newline`: line feed, carriage return, U+0085, U+2028, U+2029. U+0085 is a control character as well.
 * - `bidi`: U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F, U+061C.
 * - `invisible`: U+200B to U+200D, U+2060, U+FEFF, U+00AD, U+180E.
 * - `looks_like_field`: a field name of the message (`fn`, `contract`, `account`, `args`, `payload`, `calls`,
 *   in any case, quoted or not) followed by `:` or `=`.
 * - `looks_like_address`: the text is or contains the shape of a Stellar strkey (`G`, `C` or `M` and 55
 *   more base32 characters) or of an Ethereum address (`0x` and 40 hex digits).
 * - `looks_like_hash`: the text contains `xdr:` and 64 hex digits, or is `0x` and an even number of hex
 *   digits, which is how bytes are shown.
 *
 * Concerns come in that order, each at most once. These are shapes, not
 * proofs: a look-alike letter from another alphabet is not caught.
 */
export function textConcerns(text: string): ArgConcern[] {
  return TEXT_CONCERNS.flatMap(([concern, shape]) => (shape.test(text) ? [concern] : []));
}

/**
 * Describes one argument: the text that is signed, the type the text does
 * not carry, and what a reader should be told.
 *
 * A `String` or a `Symbol` is checked with `textConcerns`, because its text is
 * chosen freely and can imitate any other argument. A value bound by hash
 * gets `hashed`. Every other value is what it looks like and has no concerns.
 *
 * None of this is signed. It is for a front end to show next to the wallet
 * prompt, where the text alone would mislead.
 */
export function describeArg(value: xdr.ScVal): DescribedArg {
  const rendered = render(value);
  const freeText = value.type === "scvString" || value.type === "scvSymbol";
  const concerns: ArgConcern[] = rendered.hashed ? ["hashed"] : freeText ? textConcerns(rendered.text) : [];
  return { ...rendered, concerns };
}

/**
 * The calls of an authorisation entry, described: the same calls in the same
 * order and with the same text as `renderCalls`, plus the type and the
 * concerns of every argument and the concerns about every function name.
 */
export function describeCalls(entry: xdr.SorobanAuthorizationEntry): DescribedCall[] {
  const calls: DescribedCall[] = [];
  eachCall(entry.rootInvocation, ({ contractAddress, functionName, args }) => {
    const fn = text(functionName, "Function name");
    calls.push({
      contract: Address.fromScAddress(contractAddress).toString(),
      fn,
      fnConcerns: textConcerns(fn),
      args: args.map(describeArg),
    });
  });
  return calls;
}
