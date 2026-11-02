/**
 * Regression test for S-M7: approval HTTP nonces are single-use.
 * A captured request replayed with the same nonce is rejected even inside
 * the timestamp skew window.
 */

const SECRET = 'x'.repeat(40);
process.env.APPROVAL_SHARED_SECRET = SECRET;
process.env.APPROVAL_PORT = '0';

jest.mock('../../src/lib/prisma', () => ({
  __esModule: true,
  default: {
    $queryRaw: jest.fn(async () => [{ nonce: 'approval:n' }]),
  },
}));

jest.mock('../../src/services/approval/service', () => ({
  __esModule: true,
  createGrant: jest.fn(async () => {
    throw new Error('MAKER_REQUIRED');
  }),
  confirmAndIssue: jest.fn(),
  createAndIssue: jest.fn(),
}));

import crypto from 'crypto';
import http from 'http';
import { startApprovalServer } from '../../src/services/approval/http';
import { createGrant } from '../../src/services/approval/service';

function post(port: number, body: string, nonce: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const ts = String(Date.now());
    const sig = crypto.createHmac('sha256', SECRET).update(`${ts}.${nonce}.${body}`).digest('hex');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/grants',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Approval-Timestamp': ts,
          'X-Approval-Nonce': nonce,
          'X-Approval-Signature': sig,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('S-M7 approval nonce replay', () => {
  test('same nonce twice → second is NONCE_REPLAY, handler runs once', async () => {
    const server = startApprovalServer();
    await new Promise<void>((r) => server.on('listening', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      const nonce = crypto.randomBytes(8).toString('hex');
      const body = JSON.stringify({ entityId: 'x' });
      const first = await post(port, body, nonce);
      expect(first.status).toBe(400); // past auth, fails validation (mocked)
      const second = await post(port, body, nonce);
      expect(second.status).toBe(401);
      expect(second.text).toMatch(/NONCE_REPLAY/);
      expect(createGrant).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
