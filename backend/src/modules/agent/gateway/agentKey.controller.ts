/**
 * PURPOSE
 * -------
 * HTTP handlers for AgentKey lifecycle (create / list / revoke).
 */

import { Request, Response, NextFunction } from 'express';
import { createAgentKeySchema } from '../schemas';
import * as agentKeyService from './agentKey.service';
import { ValidationError } from '../../../utils/errors';

export async function createKey(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ValidationError('Authentication required');
    const parsed = createAgentKeySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors.map((e) => e.message).join('; '));
    }
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    const result = await agentKeyService.createAgentKey({
      userId: req.user.id,
      name: parsed.data.name,
      scopes: parsed.data.scopes,
      expiresAt,
    });
    res.status(201).json({
      success: true,
      data: result,
      message: 'Store the key securely; it will not be shown again',
    });
  } catch (err) {
    next(err);
  }
}

export async function listKeys(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ValidationError('Authentication required');
    const data = await agentKeyService.listAgentKeys(req.user.id);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

export async function rotateKey(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ValidationError('Authentication required');
    const keyId = req.params.id;
    if (!keyId) throw new ValidationError('Key id required');
    const result = await agentKeyService.rotateAgentKey(req.user.id, keyId);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Key rotated; the old secret is revoked. Store the new key securely.',
    });
  } catch (err) {
    next(err);
  }
}

export async function revokeKey(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.user) throw new ValidationError('Authentication required');
    const keyId = req.params.id;
    if (!keyId) throw new ValidationError('Key id required');
    await agentKeyService.revokeAgentKey(req.user.id, keyId);
    res.json({ success: true, message: 'AgentKey revoked' });
  } catch (err) {
    next(err);
  }
}
