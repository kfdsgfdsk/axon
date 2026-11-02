/**
 * Approval Service types.
 * Private key lives only in the approval process.
 */

export type GrantKind = 'withdrawal' | 'swap';

export type GrantStatus = 'PENDING' | 'ISSUED' | 'CONSUMED' | 'REVOKED' | 'EXPIRED';

export interface ApprovalTokenPayload {
  id: string;
  kind: GrantKind;
  networkId: string;
  tokenId: string;
  amount: string;
  toAddress: string;
  exp: number;
  nonce: string;
}

export interface ApprovalToken {
  payload: ApprovalTokenPayload;
  sig: string;
}

export interface CreateGrantInput {
  entityId: string;
  kind: GrantKind;
  networkId: string;
  tokenId: string;
  amount: string;
  toAddress: string;
  makerAdminId: string;
}

export interface ConfirmGrantInput {
  grantId: string;
  checkerAdminId: string;
}

export interface IssueResult {
  grantId: string;
  token: ApprovalToken;
  expiresAt: Date;
}
