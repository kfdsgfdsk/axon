/**
 * API / worker client for the Approval Service.
 * Obtains tokens ephemerally — never stores them as authoritative DB fields.
 */

import crypto from 'crypto';
import config from '../../config';
import logger from '../../utils/logger';
import type { ApprovalToken, CreateGrantInput, IssueResult } from './types';

function baseUrl(): string {
  return (process.env.APPROVAL_URL || config.approval?.url || 'http://127.0.0.1:3200').replace(/\/$/, '');
}

function sharedSecret(): string {
  return process.env.APPROVAL_SHARED_SECRET || config.approval?.sharedSecret || '';
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const secret = sharedSecret();
  if (!secret || secret.length < 32) {
    throw new Error('APPROVAL_SHARED_SECRET (min 32 chars) required to obtain ApprovalTokens');
  }
  const bodyStr = JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(8).toString('hex');
  const msg = `${ts}.${nonce}.${bodyStr}`;
  const sig = crypto.createHmac('sha256', secret).update(msg).digest('hex');

  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Approval-Timestamp': ts,
      'X-Approval-Nonce': nonce,
      'X-Approval-Signature': sig,
    },
    body: bodyStr,
  });

  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    logger.warn('Approval service error', { path, status: res.status, error: data?.error });
    throw new Error(data?.error || `APPROVAL_HTTP_${res.status}`);
  }
  return data as T;
}

export async function requestCreateGrant(input: CreateGrantInput): Promise<{ grantId: string }> {
  return post('/grants', input);
}

export async function requestConfirmAndIssue(
  grantId: string,
  checkerAdminId: string
): Promise<{ grantId: string; token: ApprovalToken; expiresAt: string }> {
  return post('/grants/confirm', { grantId, checkerAdminId });
}

/**
 * Dual-control in one call: maker + checker distinct IDs required by service.
 * Returns token to pass ephemerally into requestSignAndBroadcast*.
 */
export async function requestCreateAndIssue(
  create: CreateGrantInput,
  checkerAdminId: string
): Promise<{ grantId: string; token: ApprovalToken; expiresAt: string }> {
  return post('/grants/create-and-issue', { ...create, checkerAdminId });
}

export type { ApprovalToken, IssueResult };
