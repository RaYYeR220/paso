/**
 * The client side of Paso: signers, the account, the two flows, activity and
 * lookup. Hooks carry state and behaviour only; nothing here renders.
 */
export { NETWORK, NETWORK_NAME, ROUTES, contractName } from "./config";
export { baseAddress, baseTx, stellarAddress, stellarTx } from "./explorer";
export { formatBaseUsdc, formatElapsed, formatUnits, formatUsdc, formatWait, relativeTime, shortAddress, shortHash } from "./format";
export { describeError, describeFailure, isUserRejection, relayMessage, type Problem, type ProblemError } from "./errors";
export { decodeParam, parseOwnerInput, parseRecipient, type ParsedOwner, type ParsedRecipient } from "./parse";
export { faucetStatus, type FaucetStatus, type HealthResponse } from "./api";
export { DEMO_LABEL } from "./demoKey";

export {
  useSigner,
  type ActiveSigner,
  type DemoSigner,
  type Signer,
  type SignerKind,
  type SignerStatus,
  type WalletOption,
  type WalletSigner,
} from "./signer";
export { deriveTwin, useTwin, type Twin } from "./useTwin";
export { useFunding, type Funding } from "./useFunding";
export { useAction, type ActionFlow } from "./useAction";
export { useActivity, type Activity } from "./useActivity";
export { useLookup, type Lookup } from "./useLookup";
export { useHealth, type Health } from "./useHealth";
export { useNow } from "./useNow";

export type {
  AttestationProgress,
  FundingFailure,
  FundingFailureCode,
  FundingState,
  FundingVia,
  RequestStep,
  StageStatus,
  TrackerStage,
  Transfer,
} from "./funding/machine";
export type { ActionRequest, ActionState, Recipient, RefusalCode, Review, Submission } from "./action/machine";
export type { PanelLabel, PanelLine, Panels, SignedMessage, Verdict } from "./action/panels";
export type { SignOptions, Tamper } from "./action/controller";
export type { ActivityItem, ActivityKind, ActivityStatus } from "./activity/merge";
