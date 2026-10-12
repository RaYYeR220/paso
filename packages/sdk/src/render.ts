import { Address, hash, xdr } from "@stellar/stellar-sdk";
import { toHex } from "viem";

/** One contract call the way the wallet shows it and the account contract rebuilds it. */
export interface Call {
  contract: string;
  fn: string;
  args: string[];
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

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

/**
 * Renders one argument to the text that is signed.
 *
 * Addresses, integers up to 128 bits, booleans, void, symbols, strings and
 * bytes are shown as text. Every other value is bound by the hash of its XDR.
 */
export function renderArg(value: xdr.ScVal): string {
  switch (value.type) {
    case "scvAddress":
      switch (value.address.type) {
        case "scAddressTypeAccount":
        case "scAddressTypeContract":
          return Address.fromScAddress(value.address).toString();
        default:
          return hashOf(value);
      }
    case "scvU32":
      return value.u32.toString();
    case "scvI32":
      return value.i32.toString();
    case "scvU64":
      return value.u64.toString();
    case "scvI64":
      return value.i64.toString();
    case "scvU128":
      return fromParts(value.u128.hi, value.u128.lo);
    case "scvI128":
      return fromParts(value.i128.hi, value.i128.lo);
    case "scvBool":
      return value.b ? "true" : "false";
    case "scvVoid":
      return "void";
    case "scvSymbol":
      return text(value.sym, "Symbol");
    case "scvString":
      return text(value.str, "String");
    case "scvBytes":
      return toHex(value.bytes.toBytes());
    default:
      return hashOf(value);
  }
}

function renderInvocation(invocation: xdr.SorobanAuthorizedInvocation, calls: Call[]): void {
  const fn = invocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") {
    throw new Error("Only contract function calls can be authorised; this request creates a contract");
  }
  const { contractAddress, functionName, args } = fn.contractFn;
  calls.push({
    contract: Address.fromScAddress(contractAddress).toString(),
    fn: text(functionName, "Function name"),
    args: args.map(renderArg),
  });
  for (const sub of invocation.subInvocations) {
    renderInvocation(sub, calls);
  }
}

/**
 * Lists the calls an authorisation entry covers, in the order the account
 * contract receives them: the root call, then each sub-invocation depth first.
 */
export function renderCalls(entry: xdr.SorobanAuthorizationEntry): Call[] {
  const calls: Call[] = [];
  renderInvocation(entry.rootInvocation, calls);
  return calls;
}
