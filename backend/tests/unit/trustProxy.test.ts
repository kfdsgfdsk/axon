/**
 * Proxy trust: the API always sits behind exactly one proxy hop (the
 * all-in-one nginx liaison sets X-Forwarded-For). Without `trust proxy`,
 * express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR and keys
 * every client as one IP — in every NODE_ENV, not just production.
 */
import express from 'express';
import { trustSingleProxy } from '../../src/middleware/proxy';
import app from '../../src/app';

describe('trustSingleProxy', () => {
  test('sets single-hop proxy trust on any express app', () => {
    const fresh = express();
    trustSingleProxy(fresh);
    expect(fresh.get('trust proxy')).toBe(1);
  });

  test('main API app trusts the proxy hop', () => {
    expect(app.get('trust proxy')).toBe(1);
  });
});
