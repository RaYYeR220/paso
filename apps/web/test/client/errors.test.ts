import { RelayError, SimulationError } from "paso-sdk";
import { describe, expect, it } from "vitest";
import { ApiFailure, faucetStatus, relayerStatus, type HealthResponse, type RelayerReport } from "@/lib/client/api";
import { NameNotFoundError } from "@/lib/client/ens";
import { describeError, describeFailure, isUserRejection, refusalSummary, relayMessage } from "@/lib/client/errors";

const message = (error: unknown) => describeFailure(error).message;
const code = (error: unknown) => describeFailure(error).code;

describe("wallet rejection", () => {
  it("is recognised in every shape wallets use", () => {
    expect(isUserRejection(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toBe(true);
    expect(isUserRejection(Object.assign(new Error("nope"), { name: "UserRejectedRequestError" }))).toBe(true);
    expect(isUserRejection({ code: "ACTION_REJECTED" })).toBe(true);
    expect(isUserRejection(new Error("MetaMask Tx Signature: User denied transaction signature."))).toBe(true);
  });

  it("is found under the errors a library wraps it in", () => {
    const wrapped = new Error("The contract function reverted", {
      cause: new Error("Request failed", { cause: Object.assign(new Error("declined"), { code: 4001 }) }),
    });
    expect(isUserRejection(wrapped)).toBe(true);
  });

  it("is not an error", () => {
    expect(describeError(Object.assign(new Error("User rejected the request."), { code: 4001 }))).toEqual({ kind: "rejected" });
  });

  it("is not seen where there is none", () => {
    expect(isUserRejection(new Error("execution reverted"))).toBe(false);
    expect(isUserRejection(undefined)).toBe(false);
  });
});

describe("relayer refusals", () => {
  it("says what BadSignature means in the product's words", () => {
    const described = describeFailure(new RelayError("bad_signature", 422, "The account refused the signature with BadSignature"));
    expect(described.code).toBe("bad_signature");
    expect(described.message).toBe("BadSignature (#2): the transaction does not match what was signed. Nothing moved.");
    expect(described.detail).toContain("BadSignature");
    expect(described.retryable).toBe(false);
  });

  it("asks to sign again when the signature expired", () => {
    const described = describeFailure(new RelayError("expired", 409, "valid up to ledger 5"));
    expect(described.code).toBe("expired");
    expect(described.message).toMatch(/sign again/i);
    expect(described.retryable).toBe(true);
  });

  it("explains a call that would fail", () => {
    expect(message(new RelayError("simulation_failed", 422, "HostError: Error(Contract, #10)\nbalance is not sufficient to spend"))).toBe(
      "The call would fail, so it was not sent. The account does not hold enough USDC.",
    );
    expect(message(new RelayError("simulation_failed", 422, "resulting balance is not within the allowed range"))).toMatch(
      /^The call would fail, so it was not sent\. resulting balance/,
    );
  });

  it("treats limits and outages as worth another try", () => {
    for (const relayCode of ["rate_limited", "unavailable", "relay_failed"] as const) {
      expect(describeFailure(new RelayError(relayCode, 503)).retryable).toBe(true);
    }
    expect(describeFailure(new RelayError("transaction_failed", 502)).retryable).toBe(false);
  });

  it("has a sentence for every code, and for one it has never seen", () => {
    for (const relayCode of ["expired", "bad_signature", "simulation_failed", "bad_request", "rate_limited", "transaction_failed", "unavailable", "relay_failed"]) {
      expect(relayMessage(relayCode).length).toBeGreaterThan(10);
    }
    expect(relayMessage("something_new")).toBe(relayMessage("relay_failed"));
  });

  it("summarises a refusal for a list", () => {
    expect(refusalSummary("bad_signature")).toBe("did not match the signature");
    expect(refusalSummary("simulation_failed")).toBe("the call would have failed");
  });
});

describe("API refusals", () => {
  it("carries the route's own sentence and the wait", () => {
    const described = describeFailure(new ApiFailure("rate_limited", 429, "Too many requests; try again shortly", 12));
    expect(described.code).toBe("rate_limited");
    expect(described.retryAfterSeconds).toBe(12);
    expect(described.retryable).toBe(true);
  });

  it("tells an unreachable server from a refusal", () => {
    expect(code(new ApiFailure("network", 0, "The server could not be reached"))).toBe("network");
    expect(describeFailure(new ApiFailure("bad_request", 400, "owner must be an Ethereum address")).message).toBe(
      "owner must be an Ethereum address",
    );
  });
});

describe("SDK and wallet errors", () => {
  it("explains a simulation that failed while preparing", () => {
    const described = describeFailure(new SimulationError("HostError: Error(Contract, #10)"));
    expect(described.code).toBe("simulation_failed");
    expect(described.message).toBe("This call would fail. The account does not hold enough USDC.");
  });

  it("names a smart-contract wallet for what it is", () => {
    const error = new Error("Expected a signature of 65 bytes (r, s, v) and got 1024; smart-contract wallets cannot sign for a Paso account");
    expect(code(error)).toBe("smart_wallet");
    expect(message(error)).toMatch(/regular wallet/);
  });

  it("notices a signature from another address", () => {
    const error = new Error(`This request was signed by 0x${"11".repeat(20)}, but the account belongs to 0x${"22".repeat(20)}`);
    expect(code(error)).toBe("wrong_signer");
  });

  it("covers a missing wallet, a busy wallet, the wrong chain and an empty one", () => {
    expect(code(Object.assign(new Error("Provider not found."), { name: "ProviderNotFoundError" }))).toBe("no_wallet");
    expect(code(Object.assign(new Error("Request of type 'wallet_requestPermissions' already pending"), { code: -32002 }))).toBe("wallet_busy");
    expect(code(Object.assign(new Error("Unrecognized chain ID"), { code: 4902 }))).toBe("wrong_network");
    expect(code(new Error("insufficient funds for gas * price + value"))).toBe("insufficient_gas");
    expect(code(new Error("ERC20: transfer amount exceeds balance"))).toBe("insufficient_usdc");
  });

  it("recognises a network that did not answer", () => {
    expect(code(new TypeError("Failed to fetch"))).toBe("network");
    expect(code(new Error("Iris answered 503 for the burn fee (https://example)"))).toBe("circle_unreachable");
  });

  it("passes on the SDK's own sentence for invalid input", () => {
    expect(message(new Error('"abc" is not a valid amount'))).toBe('"abc" is not a valid amount');
    expect(describeFailure(new NameNotFoundError("nobody.eth"))).toMatchObject({
      code: "name_not_found",
      message: "nobody.eth does not resolve to an Ethereum address",
    });
  });

  it("never throws on something that is not an error", () => {
    expect(message(undefined)).toBe("Something went wrong");
    expect(message("plain text")).toBe("plain text");
  });
});

describe("a transaction the wallet would not send", () => {
  it("is told apart from one whose fate is unknown: the wallet's own check failed, so nothing was sent", () => {
    const fromWallet = Object.assign(new Error("Execution reverted with reason: ERC20: transfer amount exceeds allowance."), { code: -32603 });
    const fromViem = Object.assign(new Error("The contract function \"depositForBurnWithHook\" reverted."), {
      name: "ContractFunctionExecutionError",
      shortMessage: "execution reverted: ERC20: transfer amount exceeds allowance",
    });

    for (const error of [fromWallet, fromViem]) {
      expect(describeError(error)).toMatchObject({
        kind: "error",
        code: "would_revert",
        message: "The wallet says this transaction would fail, so it was not sent. Nothing left the wallet.",
        retryable: true,
      });
    }
    // A transaction that was included and reverted is another matter, and keeps its own words.
    expect(describeError(new Error("The burn reverted on Base: 0xabc"))).toMatchObject({ code: "reverted" });
  });
});

describe("faucetStatus", () => {
  type Payer = RelayerReport["payer"];
  const report = (network: "testnet" | "mainnet", payer: Payer, paysFees = true): RelayerReport => ({
    enabled: true,
    ok: true,
    network,
    hub: "C",
    latestLedger: 1,
    relayer: { address: "G", xlm: "10" },
    payer,
    fees: { maxResourceFee: "5000000", inclusionFee: "1000", maxDailyFees: "500000000", spentToday: "0", remainingToday: "500000000", minBalance: "0" },
    limits: {
      relay: { perCallerPerHour: 120, perHour: 1200 },
      deploy: { perCallerPerHour: 60, perHour: 600 },
      deliver: { perCallerPerHour: 60, perHour: 600 },
    },
    paysFees,
    paysBaseMints: true,
    faucet: payer !== null,
  });
  const health = (testnet: HealthResponse["networks"]["testnet"], mainnet: HealthResponse["networks"]["mainnet"] = { enabled: false }): HealthResponse => ({
    ok: true,
    default: "testnet",
    networks: { testnet, mainnet },
  });
  const payer = (usdc: string | null, eth: string | null) => ({ address: `0x${"11".repeat(20)}` as const, chain: "Base Sepolia", usdc, eth });

  it("reads the faucet's state off testnet's part of the health report, and nobody else's", () => {
    expect(faucetStatus(null)).toBe("unknown");
    expect(faucetStatus(health(report("testnet", null)))).toBe("off");
    expect(faucetStatus(health({ enabled: false }, report("mainnet", payer("25", "0.01"))))).toBe("off");
    expect(faucetStatus(health(report("testnet", payer("0", "0.01"))))).toBe("empty");
    expect(faucetStatus(health(report("testnet", payer("25", "0"))))).toBe("empty");
    expect(faucetStatus(health(report("testnet", payer(null, "0.01"))))).toBe("unknown");
    expect(faucetStatus(health(report("testnet", payer("25", "0.01"))))).toBe("ready");
  });

  it("tells whether the hosted relayer is there to pay on a network", () => {
    const both = health(report("testnet", null), report("mainnet", null, false));

    expect(relayerStatus(null, "mainnet")).toBe("unknown");
    expect(relayerStatus(health(report("testnet", null)), "mainnet")).toBe("not_serving");
    expect(relayerStatus(both, "testnet")).toBe("serving");
    expect(relayerStatus(both, "mainnet")).toBe("not_paying");
    expect(relayerStatus(health(report("testnet", null), report("mainnet", null)), "mainnet")).toBe("serving");
  });
});
