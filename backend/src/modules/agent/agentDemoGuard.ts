/**
 * Fail-closed demo guard for the agent HTTP surface.
 *
 * Without a model key the crew serves deterministic DEMO responses
 * (demoMode 'auto'). In production/staging that silent demo is a footgun:
 * an operator could mistake scripted output for live model reasoning.
 *
 * This guard returns 503 from every agent endpoint (except health) when
 * running prod-like without a key — unless the operator explicitly set
 * AGENT_DEMO_MODE=true (intentional demo, still labeled demo:true).
 *
 * Non-prod environments are unaffected: dev/test keep the demo UX.
 */
import { Request, Response, NextFunction } from 'express';
import config from '../../config';

export interface AgentModeInput {
  isProdLike: boolean;
  demoMode: string;
  hasModelKey: boolean;
}

function liveInput(): AgentModeInput {
  return {
    isProdLike: config.isProdLike,
    demoMode: config.agent.demoMode,
    hasModelKey: Boolean(config.agent.modelApiKey),
  };
}

/** True when agent endpoints must refuse to serve (prod-like, no key). */
export function shouldBlockAgentDemo(input: AgentModeInput): boolean {
  return input.isProdLike && !input.hasModelKey && input.demoMode !== 'true';
}

/** Non-secret flags for health endpoints (never include the key itself). */
export function agentModeFlags(input?: Partial<AgentModeInput>): {
  demoMode: string;
  hasModelKey: boolean;
  blocked: boolean;
} {
  const merged: AgentModeInput = { ...liveInput(), ...input };
  return {
    demoMode: merged.demoMode,
    hasModelKey: merged.hasModelKey,
    blocked: shouldBlockAgentDemo(merged),
  };
}

/**
 * Boot-time operator notice. Returns null when the mode needs no comment
 * (key configured, or demo explicitly requested).
 */
export function agentModeNotice(
  input: AgentModeInput
): { level: 'error' | 'warn'; message: string } | null {
  if (input.hasModelKey) return null;
  if (shouldBlockAgentDemo(input)) {
    return {
      level: 'error',
      message:
        'Agent endpoints will return 503: prod-like environment without a ' +
        'model key and AGENT_DEMO_MODE is not "true". Set MUSE_API_KEY ' +
        '(or MODEL_API_KEY), or AGENT_DEMO_MODE=true for an intentional demo.',
    };
  }
  if (input.demoMode !== 'true') {
    return {
      level: 'warn',
      message:
        'Agent running without a model key: serving deterministic DEMO ' +
        'responses (demoMode=auto). Set MUSE_API_KEY for live reasoning, or ' +
        'AGENT_DEMO_MODE=true to silence this warning.',
    };
  }
  return null;
}

/**
 * Express middleware: 503 when the agent surface must not serve.
 * GET /health is always exempt so ops can read the mode flags.
 */
export function agentDemoGuard(req: Request, res: Response, next: NextFunction): void {
  const path = req.path === '/health' || req.path === '/health/';
  if (req.method === 'GET' && path) {
    next();
    return;
  }
  if (shouldBlockAgentDemo(liveInput())) {
    res.status(503).json({
      success: false,
      message:
        'Agent unavailable: no model key configured in this environment and ' +
        'demo responses are disabled here. Set MUSE_API_KEY, or ' +
        'AGENT_DEMO_MODE=true for an intentional demo.',
    });
    return;
  }
  next();
}
