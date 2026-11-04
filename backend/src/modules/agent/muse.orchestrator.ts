/**
 * Muse Orchestrator — entry to the multi-agent crew.
 * Workshop-aligned: agentic tool loops, specialist roles, red-team debate,
 * verification/policy OUTSIDE the model (policy.middleware).
 *
 * Muse never moves money.
 */

import { runCrew, runSafetyRefusal } from './crew/crew.orchestrator';
import type {
  AgentPrincipal,
  AgentServiceResult,
  CrewEvent,
  CrewMode,
  IntentBrief,
  MuseCapability,
  MuseMessage,
  PolicyDecision,
} from './types';

export async function orchestrate(input: {
  principal: AgentPrincipal;
  capability: MuseCapability;
  userMessage: string;
  dryRun: boolean;
  policy: PolicyDecision;
  mode?: CrewMode;
  onEvent?: (event: CrewEvent) => void;
  extraMessages?: MuseMessage[];
  demoBook?: boolean;
  threadId?: string | null;
  followUp?: { parentActionId: string; block: string } | null;
  memoryBlock?: string;
  intentBrief?: IntentBrief | null;
}): Promise<AgentServiceResult> {
  const extra = (input.extraMessages || [])
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
  const userMessage = extra
    ? `${extra}\n\n${input.userMessage}`
    : input.userMessage;

  return runCrew({
    principal: input.principal,
    capability: input.capability,
    userMessage,
    dryRun: input.dryRun,
    policy: input.policy,
    mode: input.mode,
    onEvent: input.onEvent,
    demoBook: input.demoBook,
    threadId: input.threadId,
    followUp: input.followUp,
    memoryBlock: input.memoryBlock,
    intentBrief: input.intentBrief,
  });
}

/** Instant deterministic refusal — the gate blocks before the crew runs. */
export async function refuseFast(input: {
  principal: AgentPrincipal;
  capability: MuseCapability;
  userMessage: string;
  threadId?: string | null;
  onEvent?: (event: CrewEvent) => void;
}): Promise<AgentServiceResult> {
  return runSafetyRefusal(input);
}

export { runCrew };
