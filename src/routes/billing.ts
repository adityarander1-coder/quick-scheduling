// routes/billing.ts — self-serve signup + Stripe billing.
//
// Flow: owner signs up -> POST /api/billing/checkout creates a Stripe
// Checkout Session (subscription mode, 14-day trial) -> owner enters card on
// Stripe -> webhook checkout.session.completed links the subscription ->
// Stripe auto-charges when the trial ends -> invoice.payment_succeeded marks
// the company active. Failures move the company through
// past_due (7-day grace) -> read_only -> suspended. Cancel keeps access until
// the period ends, then the company is downgraded to canceled.
//
// Stripe is the source of truth; every webhook updates the companies row.
// A daily sync job reconciles anything the webhooks missed and applies the
// time-based grace -> read_only -> suspended transitions.

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { query } from '../db';
import { requireAuth, requireRole } from '../middleware/auth';
import { loadBillingInfo, writesAllowed, BillingStatus } from '../middleware/billing';
import { getStripe, billingPriceId, appBaseUrl, stripeConfigured } from '../util/stripe';

export const billingRouter = Router();

const TRIAL_DAYS = 14;
const GRACE_DAYS = 7;
const READ_ONLY_DAYS = 30; // read_only -> suspended after this long

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findCompanyByCustomer(customerId: string): Promise<string | null> {
  const { rows } = await query('SELECT id FROM companies WHERE stripe_customer_id = $1', [
    customerId,
  ]);
  return rows.length ? rows[0].id : null;
}

async function setBilling(
  companyId: string,
  patch: {
    status?: BillingStatus;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    trialEndsAt?: Date | null;
    currentPeriodEnd?: Date | null;
    graceEndsAt?: Date | null;
    cancelAtPeriodEnd?: boolean;
  }
): Promise<void> {
  const sets: string[] = ['billing_updated_at = now()'];
  const vals: any[] = [];
  let i = 1;
  const push = (col: string, v: any) => {
    sets.push(`${col} = $${i++}`);
    vals.push(v);
  };
  if (patch.status !== undefined) push('billing_status', patch.status);
  if (patch.stripeCustomerId !== undefined) push('stripe_customer_id', patch.stripeCustomerId);
  if (patch.stripeSubscriptionId !== undefined)
    push('stripe_subscription_id', patch.stripeSubscriptionId);
  if (patch.trialEndsAt !== undefined) push('trial_ends_at', patch.trialEndsAt);
  if (patch.currentPeriodEnd !== undefined) push('current_period_end', patch.currentPeriodEnd);
  if (patch.graceEndsAt !== undefined) push('grace_ends_at', patch.graceEndsAt);
  if (patch.cancelAtPeriodEnd !== undefined) push('cancel_at_period_end', patch.cancelAtPeriodEnd);
  vals.push(companyId);
  await query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  console.log(`[billing] company ${companyId} ->`, JSON.stringify(patch));
}

function subscriptionPeriodEnd(sub: Stripe.Subscription): Date | null {
  const ts = (sub as any).current_period_end;
  return typeof ts === 'number' ? new Date(ts * 1000) : null;
}

function subscriptionTrialEnd(sub: Stripe.Subscription): Date | null {
  const ts = (sub as any).trial_end;
  return typeof ts === 'number' ? new Date(ts * 1000) : null;
}

/** Map a live Stripe subscription to our billing status (cancel-at-period-end keeps access). */
async function syncFromSubscription(companyId: string, sub: Stripe.Subscription): Promise<void> {
  const status = sub.status; // trialing | active | past_due | canceled | unpaid | incomplete...
  const cancelAtPeriodEnd = !!sub.cancel_at_period_end;
  const patch: Parameters<typeof setBilling>[1] = {
    stripeSubscriptionId: sub.id,
    stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id,
    currentPeriodEnd: subscriptionPeriodEnd(sub),
    cancelAtPeriodEnd,
  };
  const trialEnd = subscriptionTrialEnd(sub);
  if (trialEnd) patch.trialEndsAt = trialEnd;

  if (status === 'trialing') {
    patch.status = 'trial';
    patch.graceEndsAt = null;
  } else if (status === 'active') {
    patch.status = 'active';
    patch.graceEndsAt = null;
  } else if (status === 'past_due' || status === 'unpaid') {
    patch.status = 'past_due';
    if (!patch.graceEndsAt) patch.graceEndsAt = new Date(Date.now() + GRACE_DAYS * 86400_000);
  } else if (status === 'canceled') {
    // Access already continued to period end; the subscription is gone.
    patch.status = 'canceled';
  }
  // incomplete / incomplete_expired / paused: leave status alone; daily sync retries.
  await setBilling(companyId, patch);
}

// ---------------------------------------------------------------------------
// POST /api/billing/checkout — owner starts card collection (Stripe Checkout).
// ---------------------------------------------------------------------------
billingRouter.post('/checkout', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    const priceId = billingPriceId();
    if (!stripe || !priceId) {
      res.status(503).json({
        error: 'Online billing is not set up yet. Please contact support to activate your workspace.',
      });
      return;
    }
    const companyId = req.session.companyId!;
    const { rows } = await query(
      'SELECT name, stripe_customer_id FROM companies WHERE id = $1',
      [companyId]
    );
    if (!rows.length) {
      res.status(404).json({ error: 'Company not found.' });
      return;
    }
    const company = rows[0];
    const { rows: urows } = await query('SELECT email FROM users WHERE id = $1', [
      req.session.userId,
    ]);
    const ownerEmail = urows.length ? urows[0].email : undefined;

    let customerId: string | null = company.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: company.name,
        email: ownerEmail,
        metadata: { companyId },
      });
      customerId = customer.id;
      await setBilling(companyId, { stripeCustomerId: customerId });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { companyId },
      },
      metadata: { companyId },
      success_url: `${appBaseUrl()}/app.html?billing=success`,
      cancel_url: `${appBaseUrl()}/app.html?billing=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing] checkout failed:', err);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/billing/status — for banners / read-only UI.
// ---------------------------------------------------------------------------
billingRouter.get('/status', requireAuth, async (req: Request, res: Response) => {
  const info = await loadBillingInfo(req.session.companyId!);
  if (!info) {
    res.status(404).json({ error: 'Company not found.' });
    return;
  }
  res.json({ ...info, writesAllowed: writesAllowed(info.status) && !info.needsPaymentMethod });
});

// ---------------------------------------------------------------------------
// POST /api/billing/portal — Stripe-hosted billing portal (update card/cancel).
// ---------------------------------------------------------------------------
billingRouter.post('/portal', requireAuth, requireRole('owner'), async (req: Request, res: Response) => {
  try {
    const stripe = getStripe();
    if (!stripe) {
      res.status(503).json({ error: 'Online billing is not set up yet.' });
      return;
    }
    const { rows } = await query('SELECT stripe_customer_id FROM companies WHERE id = $1', [
      req.session.companyId,
    ]);
    const customerId: string | null = rows.length ? rows[0].stripe_customer_id : null;
    if (!customerId) {
      res.status(400).json({ error: 'No billing account yet. Please complete checkout first.' });
      return;
    }
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appBaseUrl()}/app.html`,
    });
    res.json({ url: portal.url });
  } catch (err) {
    console.error('[billing] portal failed:', err);
    res.status(500).json({ error: 'Could not open the billing portal. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Webhook — mounted with express.raw() in index.ts (signature verification
// needs the untouched request body). No auth; Stripe signs every call.
// ---------------------------------------------------------------------------
export async function handleBillingWebhook(req: Request, res: Response): Promise<void> {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) {
    console.error('[billing] webhook received but Stripe is not configured');
    res.status(500).send('billing not configured');
    return;
  }
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'] as string, webhookSecret);
  } catch (err: any) {
    console.error('[billing] webhook signature verification failed:', err.message);
    res.status(400).send('invalid signature');
    return;
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const companyId = s.metadata?.companyId;
        const customerId = typeof s.customer === 'string' ? s.customer : (s.customer as any)?.id;
        const subscriptionId =
          typeof s.subscription === 'string' ? s.subscription : (s.subscription as any)?.id;
        if (companyId && customerId && subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          await setBilling(companyId, {
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            status: 'trial',
            trialEndsAt: subscriptionTrialEnd(sub) || new Date(Date.now() + TRIAL_DAYS * 86400_000),
            currentPeriodEnd: subscriptionPeriodEnd(sub),
            graceEndsAt: null,
            cancelAtPeriodEnd: false,
          });
        } else {
          console.error('[billing] checkout.session.completed missing ids:', s.id);
        }
        break;
      }
      case 'invoice.payment_succeeded': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === 'string' ? inv.customer : (inv.customer as any)?.id;
        const companyId = customerId ? await findCompanyByCustomer(customerId) : null;
        if (companyId) {
          const subId = typeof (inv as any).subscription === 'string' ? (inv as any).subscription : null;
          const patch: Parameters<typeof setBilling>[1] = {
            status: 'active',
            graceEndsAt: null,
            cancelAtPeriodEnd: false,
          };
          if (subId) {
            const sub = await stripe.subscriptions.retrieve(subId);
            patch.stripeSubscriptionId = sub.id;
            patch.currentPeriodEnd = subscriptionPeriodEnd(sub);
            const trialEnd = subscriptionTrialEnd(sub);
            if (trialEnd) patch.trialEndsAt = trialEnd;
          }
          await setBilling(companyId, patch);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = typeof inv.customer === 'string' ? inv.customer : (inv.customer as any)?.id;
        const companyId = customerId ? await findCompanyByCustomer(customerId) : null;
        if (companyId) {
          await setBilling(companyId, {
            status: 'past_due',
            graceEndsAt: new Date(Date.now() + GRACE_DAYS * 86400_000),
          });
        }
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;
        const companyId = customerId ? await findCompanyByCustomer(customerId) : null;
        if (companyId) await syncFromSubscription(companyId, sub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer as any)?.id;
        const companyId = customerId ? await findCompanyByCustomer(customerId) : null;
        if (companyId) {
          await setBilling(companyId, { status: 'canceled', cancelAtPeriodEnd: false });
        }
        break;
      }
      default:
        // Unhandled event types are fine — acknowledge so Stripe stops retrying.
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('[billing] webhook handler failed:', err);
    // Return 500 so Stripe retries the event.
    res.status(500).send('handler error');
  }
}

// ---------------------------------------------------------------------------
// Daily sync — reconciles Stripe state and applies time-based transitions:
// past_due past grace -> read_only; read_only past 30d -> suspended.
// Runs in-process on a 24h interval; safe to run on multiple instances
// (updates are idempotent).
// ---------------------------------------------------------------------------
export async function syncBillingOnce(): Promise<void> {
  const stripe = getStripe();
  if (!stripe) return;
  const { rows } = await query(
    `SELECT id, billing_status, stripe_subscription_id, grace_ends_at, billing_updated_at
     FROM companies
     WHERE billing_status IN ('trial','past_due','read_only')
       AND stripe_subscription_id IS NOT NULL`
  );
  const now = Date.now();
  for (const r of rows) {
    try {
      const sub = await stripe.subscriptions.retrieve(r.stripe_subscription_id);
      await syncFromSubscription(r.id, sub);

      // Time-based downgrades (only when Stripe still reports non-paying).
      if ((sub.status === 'past_due' || sub.status === 'unpaid') && r.grace_ends_at) {
        if (new Date(r.grace_ends_at).getTime() < now) {
          await setBilling(r.id, { status: 'read_only' });
        }
      }
      if (r.billing_status === 'read_only' && r.billing_updated_at) {
        const readOnlySince = new Date(r.billing_updated_at).getTime();
        if (now - readOnlySince > READ_ONLY_DAYS * 86400_000) {
          await setBilling(r.id, { status: 'suspended' });
        }
      }
    } catch (err) {
      console.error(`[billing] sync failed for company ${r.id}:`, (err as Error).message);
    }
  }
}

let syncTimer: NodeJS.Timeout | null = null;
export function startBillingSync(): void {
  if (syncTimer) return;
  // First run 60s after boot (lets the DB/migrations settle), then daily.
  setTimeout(() => {
    syncBillingOnce().catch((e) => console.error('[billing] initial sync failed:', e));
  }, 60_000);
  syncTimer = setInterval(() => {
    syncBillingOnce().catch((e) => console.error('[billing] daily sync failed:', e));
  }, 24 * 60 * 60 * 1000);
  console.log('[billing] daily sync scheduled');
}
