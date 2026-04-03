/**
 * Billing Routes
 *
 * POST /api/billing/checkout     - Create Stripe Checkout session → returns { url }
 * POST /api/billing/portal       - Create Stripe Customer Portal session → returns { url }
 * GET  /api/billing/subscription - Return current subscription info
 * POST /api/billing/sync         - Pull latest subscription from Stripe and update DB
 * POST /api/billing/webhook      - Stripe webhook (raw body, registered separately in server.js)
 */

const express = require("express");
const router = express.Router();
const requireUser = require("../middleware/requireUser");
const BillingService = require("../services/BillingService");
const db = require("../db");

// ─── Checkout ─────────────────────────────────────────────────────────────────

router.post("/checkout", requireUser, async (req, res, next) => {
  try {
    const { tier } = req.body;
    if (!["PRO", "PREMIUM"].includes(tier)) {
      return res.status(400).json({ error: "tier must be PRO or PREMIUM." });
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Payments are not configured yet." });
    }
    const url = await BillingService.createCheckoutSession(req.user, tier);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// ─── Customer Portal ──────────────────────────────────────────────────────────

router.post("/portal", requireUser, async (req, res, next) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Payments are not configured yet." });
    }
    const url = await BillingService.createPortalSession(req.user);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

// ─── Subscription info ────────────────────────────────────────────────────────

router.get("/subscription", requireUser, async (req, res) => {
  const sub = await db.subscription.findUnique({ where: { userId: req.user.id } });
  res.json({
    tier: sub?.tier ?? "FREE",
    status: sub?.status ?? "ACTIVE",
    currentPeriodEnd: sub?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
  });
});

// ─── Sync subscription from Stripe (fallback for webhook lag) ─────────────────

router.post("/sync", requireUser, async (req, res, next) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Payments are not configured yet." });
    }
    const sub = await BillingService.syncFromStripe(req.user);
    res.json({
      tier: sub?.tier ?? "FREE",
      status: sub?.status ?? "ACTIVE",
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Webhook (exported separately — mounted with raw body parser in server.js) ─

const webhookHandler = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  if (!sig) return res.status(400).json({ error: "Missing stripe-signature header." });
  try {
    await BillingService.handleWebhook(req.body, sig);
    res.json({ received: true });
  } catch (err) {
    console.error("[Webhook] Error:", err.message);
    res.status(400).json({ error: err.message });
  }
};

module.exports = router;
module.exports.webhookHandler = webhookHandler;
