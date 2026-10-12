import { describe, expect, it } from "vitest";
import { refusal } from "@/lib/server/relayer";

const TWIN = "CCI3UVOB35NEJCTKPCLSPJVT745BNT2QNACV3QP46CRYTVD3QCOH2VME";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** Explanations as testnet words them, shortened to the lines that matter. */
const CHECK_AUTH_REFUSED = `HostError: Error(Auth, InvalidAction)

Event log (newest first):
   0: [Diagnostic Event] contract:${USDC}, topics:[error, Error(Auth, InvalidAction)], data:["failed account authentication with error", ${TWIN}, Error(Contract, #2)]
   1: [Failed Diagnostic Event (not emitted)] contract:${TWIN}, topics:[error, Error(Contract, #2)], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"`;

const NO_MATCHING_ENTRY = `HostError: Error(Auth, InvalidAction)

Event log (newest first):
   0: [Diagnostic Event] contract:${USDC}, topics:[error, Error(Auth, InvalidAction)], data:["Unauthorized function call for address", ${TWIN}]`;

const EXPIRED = `HostError: Error(Auth, InvalidInput)

Event log (newest first):
   0: [Diagnostic Event] contract:${USDC}, topics:[error, Error(Auth, InvalidInput)], data:["signature has expired", ${TWIN}, 5159742, 5159739]`;

const INSUFFICIENT = `HostError: Error(Contract, #10)

Event log (newest first):
   0: [Diagnostic Event] contract:${USDC}, topics:[error, Error(Contract, #10)], data:["balance is not sufficient to spend", ${TWIN}, 0, 1000000]`;

/** The hub's own error #2 (dust) must not be mistaken for the account's error #2. */
const HUB_DUST = `HostError: Error(Contract, #2)

Event log (newest first):
   0: [Diagnostic Event] contract:CBNSNERNVI7NW7JWDLOFJQJYMJC67EMVZLQONBBPWR4HLQMP53QGFOBO, topics:[error, Error(Contract, #2)], data:"escalating error to panic"`;

describe("refusal", () => {
  it("names the account's error when __check_auth refuses the signature", () => {
    const error = refusal(CHECK_AUTH_REFUSED);

    expect(error.code).toBe("bad_signature");
    expect(error.status).toBe(422);
    expect(error.detail).toMatch(/BadSignature \(account error #2\)/);
    expect(error.extra.diagnostic).toContain("failed account authentication");
  });

  it.each([
    ["1", "UnsupportedContext"],
    ["3", "BadRecoveryId"],
  ])("names account error #%s as %s", (code, name) => {
    expect(refusal(CHECK_AUTH_REFUSED.replaceAll("#2", `#${code}`)).detail).toContain(name);
  });

  it("treats a call no entry covers as a refused authorisation", () => {
    const error = refusal(NO_MATCHING_ENTRY);

    expect(error.code).toBe("bad_signature");
    expect(error.detail).toMatch(/does not cover the call/);
  });

  it("reports an expired signature as expired, whoever noticed", () => {
    expect(refusal(EXPIRED).code).toBe("expired");
    expect(refusal(INSUFFICIENT, true).code).toBe("expired");
    expect(refusal(EXPIRED).status).toBe(409);
  });

  it("reports any other failure as the call's own, with the network's words", () => {
    const error = refusal(INSUFFICIENT);

    expect(error.code).toBe("simulation_failed");
    expect(error.detail).toBe("HostError: Error(Contract, #10): balance is not sufficient to spend");
  });

  it("does not take another contract's error #2 for a refused signature", () => {
    expect(refusal(HUB_DUST).code).toBe("simulation_failed");
  });

  it("keeps the diagnostic text bounded", () => {
    const error = refusal(`${INSUFFICIENT}\n${"x".repeat(10_000)}`);
    expect(error.extra.diagnostic?.length).toBeLessThanOrEqual(4_001);
  });
});
