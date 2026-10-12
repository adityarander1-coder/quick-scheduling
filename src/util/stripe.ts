// util/stripe.ts — Stripe SDK singleton (test mode via STRIPE_SECRET_KEY).
// All billing amounts/prices come from env (STRIPE_PRICE_ID); the price itself
// is created in the Stripe dashboard after Deepika picks the pricing model.

import Stripe from 'stripe';

let stripe: Stripe | null = null;

export function getStripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  if (!stripe) {
    stripe = new Stripe(key, { apiVersion: '2026-09-30.endive' });
  }
  return stripe;
}

export function stripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID;
}

export function billingPriceId(): string | null {
  return process.env.STRIPE_PRICE_ID || null;
}

/** Base URL of this app, for Stripe redirect URLs. */
export function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ||
    (process.env.NODE_ENV === 'production'
      ? 'https://quick-scheduling.onrender.com'
      : 'http://localhost:3000')
  );
}
