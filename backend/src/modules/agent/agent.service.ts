/**
 * PURPOSE
 * -------
 * Application service for the Agent layer. Translates controller requests
 * into Muse orchestrator calls with the correct capability and policy.
 * Muse never moves money from this layer.
 */

import { orchestrate } from './muse.orchestrator';
import type {
  AgentPrincipal,
  AgentServiceResult,
  CrewEvent,
  CrewMode,
  MuseCapability,
  PolicyDecision,
  Proposal,
} from './types';

async function run(
  principal: AgentPrincipal,
  capability: MuseCapability,
  userMessage: string,
  dryRun: boolean,
  policy: PolicyDecision
): Promise<AgentServiceResult> {
  return orchestrate({
    principal,
    capability,
    userMessage,
    dryRun: dryRun || policy.kind !== 'ALLOW',
    policy,
  });
}

/** Generic entry used by the SSE streaming endpoint. */
export async function runWithEvents(
  principal: AgentPrincipal,
  capability: MuseCapability,
  userMessage: string,
  dryRun: boolean,
  policy: PolicyDecision,
  opts?: { mode?: CrewMode; onEvent?: (event: CrewEvent) => void; demoBook?: boolean }
): Promise<AgentServiceResult> {
  return orchestrate({
    principal,
    capability,
    userMessage,
    dryRun: dryRun || policy.kind !== 'ALLOW',
    policy,
    mode: opts?.mode,
    onEvent: opts?.onEvent,
    demoBook: opts?.demoBook,
  });
}

export async function chat(
  principal: AgentPrincipal,
  message: string,
  dryRun: boolean,
  policy: PolicyDecision
): Promise<AgentServiceResult> {
  return run(principal, 'reactive', message, dryRun, policy);
}

export async function copilot(
  principal: AgentPrincipal,
  focus: string | undefined,
  dryRun: boolean,
  policy: PolicyDecision
): Promise<AgentServiceResult> {
  const msg = focus
    ? `Proactively review my portfolio with focus: ${focus}`
    : 'Proactively review my portfolio and surface risks and opportunities.';
  return run(principal, 'copilot', msg, dryRun, policy);
}

export async function plan(
  principal: AgentPrincipal,
  goal: string,
  dryRun: boolean,
  policy: PolicyDecision,
  constraints?: { maxNotionalUsd?: number; preferStable?: boolean }
): Promise<AgentServiceResult> {
  const constraintText = constraints
    ? ` Constraints: ${JSON.stringify(constraints)}`
    : '';
  return run(principal, 'plan', `Goal: ${goal}.${constraintText}`, dryRun, policy);
}

export async function strategy(
  principal: AgentPrincipal,
  description: string,
  dryRun: boolean,
  policy: PolicyDecision
): Promise<AgentServiceResult> {
  return run(
    principal,
    'strategy',
    `Design a conditional strategy from: ${description}`,
    dryRun,
    policy
  );
}

export async function critique(
  principal: AgentPrincipal,
  proposal: Proposal | undefined,
  proposalId: string | undefined,
  dryRun: boolean,
  policy: PolicyDecision
): Promise<AgentServiceResult> {
  const body = proposal
    ? JSON.stringify(proposal)
    : `proposalId=${proposalId || 'unknown'}`;
  return run(principal, 'critique', `Critique the following proposal:\n${body}`, dryRun, policy);
}
