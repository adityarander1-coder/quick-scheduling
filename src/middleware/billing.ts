// middleware/billing.ts — company billing-status gating.
// Stripe is the source of truth; webhooks + the daily sync write the columns.
// Writes are allowed during trial, active, and past_due (grace). Blocked once
// the account is read_only, suspended, or canceled.

import { Request, Response, NextFunction } from 'express';
import { query } from '../db';

export type BillingStatus =
  | 'trial'
  | 'active'
  | 'past_due'
  | 'read_only'
  | 'suspended'
  | 'canceled';

export interface BillingInfo {
  status: BillingStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  /** True when the owner never finished card entry (abandoned Stripe Checkout). */
  needsPaymentMethod: boolean;
}

export function writesAllowed(status: BillingStatus): boolean {
  return status === 'trial' || status === 'active' || status === 'past_due';
}

function toIso(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  return null;
}

export async function loadBillingInfo(companyId: string): Promise<BillingInfo | null> {
  const { rows } = await query(
    `SELECT billing_status, trial_ends_at, current_period_end, grace_ends_at,
            cancel_at_period_end, stripe_subscription_id
     FROM companies WHERE id = $1`,
    [companyId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  const status = r.billing_status as BillingStatus;
  const hasSubscription = !!r.stripe_subscription_id;
  const trialExpired =
    status === 'trial' && r.trial_ends_at && new Date(r.trial_ends_at).getTime() < Date.now();
  return {
    status,
    trialEndsAt: toIso(r.trial_ends_at),
    currentPeriodEnd: toIso(r.current_period_end),
    graceEndsAt: toIso(r.grace_ends_at),
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    hasSubscription,
    // Card was never collected and the free trial ran out: must finish checkout.
    needsPaymentMethod: !hasSubscription && (trialExpired || status !== 'trial'),
  };
}

/**
 * Global write gate for /api mutations. Mounted after the session middleware.
 * Exempts /api/auth/* and /api/billing/* (login, webhook, portal, checkout).
 * Reads are never blocked. Non-authenticated requests pass through to requireAuth.
 */
export function billingWriteGate(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH' && method !== 'DELETE') {
    next();
    return;
  }
  // req.path here is relative to the '/api' mount point.
  const p = req.path || '';
  if (p.startsWith('/auth') || p.startsWith('/billing')) {
    next();
    return;
  }
  const companyId = req.session?.companyId;
  if (!companyId) {
    next(); // requireAuth downstream returns 401.
    return;
  }
  loadBillingInfo(companyId)
    .then((info) => {
      if (!info) {
        next();
        return;
      }
      if (!writesAllowed(info.status) || info.needsPaymentMethod) {
        res.status(402).json({
          error:
            'Your workspace billing needs attention. Please update your payment method to keep making changes.',
          billingStatus: info.status,
          needsPaymentMethod: info.needsPaymentMethod,
        });
        return;
      }
      next();
    })
    .catch((err) => {
      console.error('[billing] write gate check failed:', err);
      // Fail closed: a billing outage must not silently allow writes on a
      // suspended account, nor block a paying account on a transient DB error.
      // Default to allowing; the daily Stripe sync + webhooks remain the
      // enforcement path and the UI banner still warns.
      next();
    });
}
