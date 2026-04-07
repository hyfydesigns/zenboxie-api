/**
 * BillingService — Stripe helpers for subscriptions.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET
 *   STRIPE_PRO_PRICE_ID
 *   STRIPE_PREMIUM_PRICE_ID
 *   FRONTEND_URL
 */

const db = require("../db");
const { sendSubscriptionEmail } = require("./EmailService");

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY.");
  }
  return require("stripe")(process.env.STRIPE_SECRET_KEY.trim(), {
    timeout: 30000,
    maxNetworkRetries: 1,
  });
}

const PRICE_IDS = {
  PRO: () => process.env.STRIPE_PRO_PRICE_ID,
  PREMIUM: () => process.env.STRIPE_PREMIUM_PRICE_ID,
};

// Map Stripe subscription status → our SubStatus enum
const STATUS_MAP = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  canceled: "CANCELED",
  unpaid: "PAST_DUE",
  incomplete: "PAST_DUE",
  incomplete_expired: "CANCELED",
};

// ─── Customer ─────────────────────────────────────────────────────────────────

async function ensureCustomer(user) {
  const stripe = getStripe();

  // Reuse existing Stripe customer
  if (user.subscription?.stripeCustomerId) {
    return user.subscription.stripeCustomerId;
  }

  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { userId: user.id },
  });

  // Upsert the subscription record with the new customer ID
  await db.subscription.upsert({
    where: { userId: user.id },
    create: { userId: user.id, stripeCustomerId: customer.id },
    update: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

async function createCheckoutSession(user, tier) {
  const stripe = getStripe();
  const priceId = PRICE_IDS[tier]?.();
  if (!priceId) throw new Error(`No Stripe price configured for tier: ${tier}`);

  const base = process.env.FRONTEND_URL || "http://localhost:5173";

  // If the user already has an active subscription, upgrade it in-place
  // instead of creating a second subscription.
  const existingSub = await db.subscription.findUnique({ where: { userId: user.id } });
  if (existingSub?.stripeSubId && existingSub.status !== "CANCELED") {
    const stripeSub = await stripe.subscriptions.retrieve(existingSub.stripeSubId);
    const currentItemId = stripeSub.items.data[0]?.id;

    if (currentItemId) {
      await stripe.subscriptions.update(existingSub.stripeSubId, {
        items: [{ id: currentItemId, price: priceId }],
        proration_behavior: "always_invoice", // charge/credit difference immediately
        metadata: { userId: user.id },
      });
      // Return the success URL directly — no new checkout session needed
      return `${base}/account?upgraded=1`;
    }
  }

  const customerId = await ensureCustomer(user);

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${base}/account?upgraded=1`,
    cancel_url: `${base}/pricing`,
    allow_promotion_codes: true,
    client_reference_id: user.id,
    subscription_data: { metadata: { userId: user.id } },
  });

  return session.url;
}

// ─── Customer Portal ──────────────────────────────────────────────────────────

async function createPortalSession(user) {
  const stripe = getStripe();
  const customerId = await ensureCustomer(user);
  const base = process.env.FRONTEND_URL || "http://localhost:5173";

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${base}/account`,
    });
    return session.url;
  } catch (err) {
    console.error("[BillingService] Portal error:", err.type, err.code, err.message, err.statusCode);
    throw err;
  }
}

// ─── Subscription sync (from Stripe object) ───────────────────────────────────

async function syncSubscription(stripeSub) {
  const userId = stripeSub.metadata?.userId;
  const priceId = stripeSub.items?.data?.[0]?.price?.id;

  console.log("[BillingService] syncSubscription", {
    subId: stripeSub.id,
    status: stripeSub.status,
    userId,
    priceId,
    PRO_PRICE: process.env.STRIPE_PRO_PRICE_ID,
    PREMIUM_PRICE: process.env.STRIPE_PREMIUM_PRICE_ID,
  });

  if (!userId) {
    console.error("[BillingService] syncSubscription: no userId in metadata — subscription not updated");
    return;
  }

  // Determine tier from price ID
  let tier = "FREE";
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) tier = "PRO";
  else if (priceId === process.env.STRIPE_PREMIUM_PRICE_ID) tier = "PREMIUM";

  console.log("[BillingService] resolvedTier:", tier);

  const status = STATUS_MAP[stripeSub.status] ?? "ACTIVE";
  const currentPeriodEnd = stripeSub.current_period_end
    ? new Date(stripeSub.current_period_end * 1000)
    : null;
  const cancelAtPeriodEnd = stripeSub.cancel_at_period_end ?? false;

  await db.subscription.upsert({
    where: { userId },
    create: {
      userId,
      tier,
      status,
      stripeSubId: stripeSub.id,
      currentPeriodEnd,
      cancelAtPeriodEnd,
    },
    update: {
      tier: status === "CANCELED" ? "FREE" : tier,
      status,
      stripeSubId: stripeSub.id,
      currentPeriodEnd,
      cancelAtPeriodEnd,
    },
  });
}

// ─── Webhook Handler ──────────────────────────────────────────────────────────

async function handleWebhook(rawBody, signature) {
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not set.");

  const event = stripe.webhooks.constructEvent(rawBody, signature, secret);
  console.log("[Webhook] received event:", event.type);

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      if (session.mode === "subscription" && session.subscription) {
        const sub = await stripe.subscriptions.retrieve(session.subscription);

        // Resolve userId: prefer client_reference_id (guaranteed on session),
        // fall back to subscription metadata, then customer metadata
        let userId = session.client_reference_id
          || sub.metadata?.userId;

        if (!userId) {
          const customer = await stripe.customers.retrieve(session.customer);
          userId = customer.metadata?.userId;
        }

        if (userId) {
          sub.metadata = { ...sub.metadata, userId };
          // Also persist userId on subscription metadata for future events
          await stripe.subscriptions.update(sub.id, {
            metadata: { ...sub.metadata, userId },
          }).catch(() => {});
        }

        await syncSubscription(sub);

        // Send subscription confirmation email
        if (userId) {
          const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
          const tier = sub.items.data[0]?.price?.id === process.env.STRIPE_PREMIUM_PRICE_ID ? "PREMIUM" : "PRO";
          if (user?.email) sendSubscriptionEmail(user.email, tier).catch(() => {});
        }
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const prevSub = event.data.previous_attributes;
      await syncSubscription(sub);

      // Send confirmation email when price changes (i.e. tier upgrade)
      if (event.type === "customer.subscription.updated" && prevSub?.items) {
        const userId = sub.metadata?.userId;
        if (userId) {
          const priceId = sub.items?.data?.[0]?.price?.id;
          const tier = priceId === process.env.STRIPE_PREMIUM_PRICE_ID ? "PREMIUM"
                     : priceId === process.env.STRIPE_PRO_PRICE_ID ? "PRO" : null;
          if (tier) {
            const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
            if (user?.email) sendSubscriptionEmail(user.email, tier).catch(() => {});
          }
        }
      }
      break;
    }
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object);
      break;

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      if (invoice.subscription) {
        await db.subscription.updateMany({
          where: { stripeSubId: invoice.subscription },
          data: { status: "PAST_DUE" },
        });
      }
      break;
    }
  }
}

// ─── Manual sync (called after checkout redirect as webhook fallback) ──────────

async function syncFromStripe(user) {
  const stripe = getStripe();
  const sub = await db.subscription.findUnique({ where: { userId: user.id } });
  if (!sub?.stripeSubId) {
    // No sub record yet — try finding via customer ID
    if (!sub?.stripeCustomerId) return null;
    const subs = await stripe.subscriptions.list({ customer: sub.stripeCustomerId, limit: 1, status: "active" });
    if (!subs.data.length) return null;
    const stripeSub = subs.data[0];
    stripeSub.metadata = { ...stripeSub.metadata, userId: user.id };
    await syncSubscription(stripeSub);
  } else {
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubId);
    stripeSub.metadata = { ...stripeSub.metadata, userId: user.id };
    await syncSubscription(stripeSub);
  }
  return db.subscription.findUnique({ where: { userId: user.id } });
}

module.exports = { createCheckoutSession, createPortalSession, handleWebhook, syncFromStripe };
