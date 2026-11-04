/* Shared domain types mirroring the exchange API contracts. */

export interface Balance {
  networkId: string;
  tokenId: string; // '' = native
  available: string;
  locked: string;
  total: string;
}

export interface PriceTick {
  asset: string;
  key: string;
  price: number | null;
  source: string | null;
  updatedAt: string | null;
  stale: boolean;
  ageMs: number | null;
}

export interface PricePoint { t: number; p: number; /** Base-asset volume (Binance klines; absent in demo series). */ v?: number }

export interface Deposit {
  id: string;
  networkId: string;
  tokenId: string | null;
  txHash: string;
  amount: string;
  confirmations: number;
  requiredConf: number;
  status: 'PENDING' | 'CONFIRMING' | 'CREDITED' | 'FAILED';
  detectedAt: string;
  creditedAt: string | null;
}

export interface Withdrawal {
  id: string;
  networkId: string;
  tokenId: string | null;
  toAddress: string;
  amount: string;
  status: string;
  txHash: string | null;
  createdAt: string;
}

export interface TokenInfo {
  id: string;
  networkId: string;
  symbol: string;
  decimals: number;
  active?: boolean;
}

export interface Order {
  id: string;
  kind: string;
  status: string;
  fromNetworkId?: string;
  toNetworkId?: string;
  amount?: string;
  createdAt: string;
  [k: string]: unknown;
}

export interface Position {
  id: string;
  side: 'BUY' | 'SELL';
  assetNetworkId: string;
  assetTokenId?: string | null;
  marginStable: string;
  leverage?: number;
  status: string;
  pnlUsd?: string | number | null;
  entryPriceUsd?: number | null;
  createdAt: string;
  [k: string]: unknown;
}

export interface TxRow {
  id: string;
  type: string;
  networkId?: string;
  tokenId?: string | null;
  amount?: string;
  status?: string;
  createdAt: string;
  [k: string]: unknown;
}

export type Capability = 'reactive' | 'copilot' | 'plan' | 'strategy' | 'critique';

export interface ProposalAction {
  type: 'MARKET_SWAP' | 'TAKE_PROFIT' | 'STOP_LOSS' | 'CANCEL_ORDER' | 'HOLD' | 'REBALANCE';
  fromNetworkId?: string;
  toNetworkId?: string;
  fromTokenId?: string | null;
  toTokenId?: string | null;
  amount?: string;
  rationale: string;
  estimatedNotionalUsd?: number;
}

export interface Proposal {
  id: string;
  capability: Capability;
  summary: string;
  actions: ProposalAction[];
  risks: string[];
  assumptions: string[];
  critique?: string;
  createdAt: string;
}

export interface AgentThread {
  id: string;
  title: string;
  summary: string | null;
  runCount: number;
  lastActionId: string | null;
  updatedAt: string;
  createdAt: string;
}

export interface ExecutionReceipt {
  executionId: string;
  status: 'PENDING' | 'SUBMITTED' | 'FILLED' | 'FAILED' | 'REJECTED';
  orderId: string | null;
  proposalId: string;
  actionType: string;
  policyKind: string;
  confirmationId: string;
  idempotentReplay: boolean;
  narration: string;
  simulated: boolean;
  createdAt: string;
}

export interface AgentMemory {
  riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  preferredAssets: string[];
  preferredNetworks: string[];
  notes: string | null;
  updatedAt: string | null;
  recentDecisions: Array<{
    actionId: string;
    at: string;
    goal: string;
    policyKind: string | null;
    actions: string[];
  }>;
}

export type CrewEvent =
  | { type: 'start'; [k: string]: unknown }
  | { type: 'thread'; threadId: string; followUp: boolean; parentActionId?: string | null }
  | { type: 'verification'; [k: string]: unknown }
  | { type: 'repair'; [k: string]: unknown }
  | { type: 'role_start'; role: string; label?: string }
  | { type: 'role_complete'; role: string; summary?: string }
  | { type: 'tool_start'; tool: string; params?: unknown }
  | { type: 'tool_result'; tool: string; ok: boolean; summary?: string }
  | { type: 'proposal'; proposal: Proposal }
  | { type: 'policy'; decision: string; reasons?: string[] }
  | { type: 'message'; text: string }
  | { type: 'done'; result?: unknown }
  | { type: 'error'; message: string };

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export interface RunMeta {
  provider: string;
  models: string[];
  reasoningEffort?: string;
  deepModel?: string | null;
}

export interface AgentHealth {
  enabled: boolean;
  demoMode: string;
  hasModelKey: boolean;
  blocked: boolean;
  provider: string;
  endpoint: string;
  models: { fast: string; strong: string; deep: string | null };
  reasoningEffort: string;
  structuredOutput: boolean;
  capabilities: string[];
}
