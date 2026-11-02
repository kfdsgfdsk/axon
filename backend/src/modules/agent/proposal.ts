/**
 * Structured proposal parsing for Muse.
 *
 * The model is asked to emit JSON, but model output is untrusted:
 *  - extract the JSON object (tolerates fences / prose)
 *  - schema-validate every field
 *  - cap the number of actions
 *  - redact any outbound-transfer / withdraw intent (AgentKeys can never withdraw)
 *  - fall back to a safe HOLD proposal when parsing fails
 *
 * A Proposal is NEVER an executable order. Execution stays behind the
 * deterministic Policy Engine.
 */

import { randomUUID } from 'crypto';
import { z } from 'zod';
import { extractJsonObject, safeJsonParse, sanitizeUntrusted } from './safety';
import type { MuseCapability, Proposal, ProposalAction } from './types';

const amountSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v == null ? undefined : String(v)));

const actionSchema = z.object({
  type: z.enum(['MARKET_SWAP', 'TAKE_PROFIT', 'STOP_LOSS', 'CANCEL_ORDER', 'HOLD', 'REBALANCE']),
  fromNetworkId: z.string().max(64).optional(),
  toNetworkId: z.string().max(64).optional(),
  fromTokenId: z.string().max(128).nullable().optional(),
  toTokenId: z.string().max(128).nullable().optional(),
  amount: amountSchema,
  rationale: z.string().min(1).max(2000),
  estimatedNotionalUsd: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => {
      if (v == null) return undefined;
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : undefined;
    }),
  evidence: z.array(z.string().max(128)).max(20).optional(),
  meta: z.record(z.unknown()).optional(),
});

const modelProposalSchema = z.object({
  summary: z.string().max(2000).optional(),
  actions: z.array(actionSchema).max(50).optional(),
  risks: z.array(z.string().max(1000)).max(50).optional(),
  assumptions: z.array(z.string().max(1000)).max(50).optional(),
  critique: z.string().max(8000).optional(),
});

const DANGEROUS = /withdraw|private\s*key|mnemonic|seed\s*phrase|signer\s*secret/i;

function redactDangerous(value: string): string {
  return value.replace(/withdraw/gi, 'outbound transfer (blocked by agent policy)');
}

/** Sanitize a proposal in place (copy) so it never carries outbound/key intent. */
export function enforceProposalSafety(
  proposal: Proposal,
  maxActions: number
): Proposal {
  const actions: ProposalAction[] = proposal.actions
    .filter((a) => !DANGEROUS.test(`${a.type} ${a.rationale}`))
    .slice(0, Math.max(1, maxActions))
    .map((a) => ({
      ...a,
      rationale: redactDangerous(sanitizeUntrusted(a.rationale, 2000)),
      amount: a.amount != null ? sanitizeUntrusted(a.amount, 64) : undefined,
      evidence: a.evidence
        ?.map((e) => sanitizeUntrusted(e, 128))
        .filter(Boolean)
        .slice(0, 20),
    }));

  if (actions.length === 0) {
    actions.push({
      type: 'HOLD',
      rationale: 'No safe, policy-compliant action could be derived. Holding.',
    });
  }

  return {
    ...proposal,
    summary: redactDangerous(sanitizeUntrusted(proposal.summary, 2000)),
    actions,
    risks: proposal.risks.map((r) => redactDangerous(sanitizeUntrusted(r, 1000))).slice(0, 50),
    assumptions: proposal.assumptions
      .map((r) => sanitizeUntrusted(r, 1000))
      .slice(0, 50),
    critique: proposal.critique
      ? redactDangerous(sanitizeUntrusted(proposal.critique, 8000))
      : undefined,
  };
}

export function fallbackProposal(input: {
  capability: MuseCapability;
  summary: string;
  risks?: string[];
  critique?: string;
  maxActions?: number;
}): Proposal {
  const proposal: Proposal = {
    id: randomUUID(),
    capability: input.capability,
    summary: sanitizeUntrusted(input.summary, 500) || 'Proposal-only response from the Muse crew.',
    actions: [
      {
        type: 'HOLD',
        rationale:
          'Crew produced a proposal-only recommendation. Any live trade requires a Policy ALLOW ' +
          'and an explicit non-dry-run confirmation.',
      },
    ],
    risks: (input.risks || []).map((r) => sanitizeUntrusted(r, 500)).slice(0, 50),
    assumptions: ['Model output treated as untrusted', 'Execution remains policy-gated'],
    critique: input.critique ? sanitizeUntrusted(input.critique, 8000) : undefined,
    createdAt: new Date().toISOString(),
  };
  return enforceProposalSafety(proposal, input.maxActions ?? 10);
}

/**
 * Parse a model-emitted JSON proposal. Returns null when nothing usable is
 * present so callers can fall back to text summarisation.
 */
export function parseModelProposal(
  raw: string,
  capability: MuseCapability,
  maxActions = 10
): Proposal | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  // Some models wrap the payload: { proposal: { ... } }
  const candidate =
    obj.proposal && typeof obj.proposal === 'object' && !Array.isArray(obj.proposal)
      ? (obj.proposal as Record<string, unknown>)
      : obj;

  const parsed = modelProposalSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const data = parsed.data;
  const actions = (data.actions || []).map((a) => ({
    type: a.type,
    fromNetworkId: a.fromNetworkId,
    toNetworkId: a.toNetworkId,
    fromTokenId: a.fromTokenId ?? null,
    toTokenId: a.toTokenId ?? null,
    amount: a.amount,
    rationale: a.rationale,
    estimatedNotionalUsd: a.estimatedNotionalUsd,
    evidence: a.evidence,
    meta: a.meta,
  })) as ProposalAction[];

  const proposal: Proposal = {
    id: randomUUID(),
    capability,
    summary: data.summary || actions[0]?.rationale || 'Muse proposal',
    actions,
    risks: data.risks || [],
    assumptions: data.assumptions || [],
    critique: data.critique,
    createdAt: new Date().toISOString(),
  };

  return enforceProposalSafety(proposal, maxActions);
}

/**
 * Plain-text rendering of a parsed proposal for SSE/UI display. Structured
 * roles (strategist/judge) must emit schema-valid JSON, but the UI must
 * show straight text — never the raw blob. The raw JSON stays in the
 * transcript/audit trail; this is display-only.
 */
export function renderProposalText(p: Proposal): string {
  const lines = [`Proposal: ${p.summary}`];
  p.actions.forEach((a, i) => {
    const legs: string[] = [];
    if (a.fromNetworkId || a.fromTokenId) {
      legs.push(`from ${a.fromTokenId || a.fromNetworkId || '?'}`);
    }
    if (a.toNetworkId || a.toTokenId) {
      legs.push(`to ${a.toTokenId || a.toNetworkId || '?'}`);
    }
    if (a.amount != null && a.amount !== '') legs.push(`amount ${a.amount}`);
    const notion =
      typeof a.estimatedNotionalUsd === 'number'
        ? ` (~$${a.estimatedNotionalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })})`
        : '';
    const detail = legs.length > 0 ? ` [${legs.join(' · ')}]` : '';
    lines.push(`${i + 1}. ${a.type}${detail}${notion}: ${a.rationale}`);
  });
  if (p.risks.length > 0) lines.push(`Risks: ${p.risks.join('; ')}`);
  if (p.assumptions.length > 0) lines.push(`Assumptions: ${p.assumptions.join('; ')}`);
  if (p.critique) lines.push(`Critique: ${p.critique}`);
  return lines.join('\n');
}

function isJsonObjectSpan(text: string): boolean {
  const parsed = safeJsonParse<Record<string, unknown>>(text);
  return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
}

/**
 * Remove a model-emitted JSON blob from mixed prose, keeping the human
 * reasoning. Only spans that actually parse as JSON objects are stripped,
 * so ordinary prose containing braces is left untouched. Returns '' when
 * the whole input is one JSON object (caller renders the parsed form).
 */
export function stripProposalJson(text: string): string {
  if (!text || !text.includes('{')) return text;
  // Fenced blocks first (```json ... ```).
  let out = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, (m, inner) =>
    isJsonObjectSpan(String(inner).trim()) ? '' : m,
  );
  if (isJsonObjectSpan(out.trim())) return '';
  // First balanced {...} span (strings-aware), removed only if it parses.
  const start = out.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < out.length; i++) {
      const ch = out[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const span = out.slice(start, i + 1);
          if (isJsonObjectSpan(span)) {
            out = `${out.slice(0, start)}${out.slice(i + 1)}`;
          }
          break;
        }
      }
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * UI display text for a structured role's output: the model's own prose
 * (JSON blob removed) plus the parsed proposal rendered as text. Pure
 * JSON outputs render as the proposal alone.
 */
export function roleDisplaySummary(content: string, proposal: Proposal): string {
  const prose = stripProposalJson(content).trim();
  const rendered = renderProposalText(proposal);
  if (!prose) return rendered;
  const head = prose.length > 1500 ? `${prose.slice(0, 1500)}…` : prose;
  return `${head}\n\n${rendered}`;
}
