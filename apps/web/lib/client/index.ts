/**
 * The client side of Paso: the network choice, signers, the account, the
 * flows, activity and lookup. Hooks carry state and behaviour only; nothing
 * here renders. Every hook that touches a chain takes the network.
 */
export { ROUTES, contractName, networkConfig, networkLabel } from "./config";
export { evmAddress, evmTx, stellarAddress, stellarTx } from "./explorer";
export { chainOf, chainsOf, FAUCET_CHAIN, gasSymbol, serverMintsOn } from "./chains";
export { formatBaseUsdc, formatElapsed, formatUnits, formatUsdc, formatWait, relativeTime, shortAddress, shortHash } from "./format";
export { describeError, describeFailure, isUserRejection, relayMessage, type Problem, type ProblemError } from "./errors";
export { decodeParam, parseOwnerInput, parseRecipient, type ParsedOwner, type ParsedRecipient } from "./parse";
export {
  faucetStatus,
  relayerStatus,
  type DeclineReason,
  type FaucetStatus,
  type HealthResponse,
  type NetworkHealth,
  type RelayerReport,
  type RelayerStatus,
} from "./api";
export { DEMO_LABEL, demoAvailable } from "./demoKey";
export { networkHref, NETWORK_PARAM } from "./network";
export { useNetworkChoice, type NetworkChoice } from "./useNetworkChoice";

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
export { useFunding, type ChainOption, type Funding, type FundingLimits, type KeyCheck, type WalletHoldings } from "./useFunding";
export {
  burnAmountProblem,
  burnCeiling,
  FAUCET_AMOUNT,
  gasReserve,
  MAINNET_BURN_CEILING,
  USDC_GAS_RESERVE,
  WALLET_BURN_MIN,
  type BurnLimits,
} from "./funding/limits";
export { useAction, type ActionFlow } from "./useAction";
export { useExit, type Exit } from "./useExit";
export type { ExitStage, ExitState, ExitTransfer } from "./exit";
export { useActivity, type Activity } from "./useActivity";
export { useLookup, type Lookup } from "./useLookup";
export { useHealth, type Health } from "./useHealth";
export { useNow } from "./useNow";
export { useOwnerKind } from "./useOwnerKind";

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
export type { ActionRequest, ActionState, Caution, Recipient, RefusalCode, Review, Submission } from "./action/machine";
export type { PanelLabel, PanelLine, Panels, SignedMessage, Verdict } from "./action/panels";
export type { SignOptions, Tamper } from "./action/controller";
export type { ActivityItem, ActivityKind, ActivityStatus } from "./activity/merge";
