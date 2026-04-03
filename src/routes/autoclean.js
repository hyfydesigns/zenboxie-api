/**
 * Auto-Clean Routes  (Pro/Premium feature)
 *
 * GET    /api/autoclean/rules          - List all rules for current user
 * POST   /api/autoclean/rules          - Create a new rule
 * PATCH  /api/autoclean/rules/:id      - Toggle isActive
 * DELETE /api/autoclean/rules/:id      - Delete a rule
 * POST   /api/autoclean/rules/:id/run  - Trigger a rule immediately (for testing)
 */

const express = require("express");
const router = express.Router();
const requireUser = require("../middleware/requireUser");
const { getLimits } = require("../config/tiers");
const AutoCleanService = require("../services/AutoCleanService");
const nodeCron = require("node-cron");
const db = require("../db");

// All routes require a logged-in user
router.use(requireUser);

// Tier check — all auto-clean routes require scheduledAutoClean
router.use((req, res, next) => {
  const limits = getLimits(req.user);
  if (!limits.scheduledAutoClean) {
    return res.status(403).json({
      error: "Scheduled auto-clean is a Pro feature.",
      upgradeRequired: true,
      currentTier: req.user?.subscription?.tier ?? "FREE",
    });
  }
  next();
});

// ─── List rules ───────────────────────────────────────────────────────────────

router.get("/rules", async (req, res, next) => {
  try {
    const rules = await db.autoCleanRule.findMany({
      where: { userId: req.user.id },
      include: { connectedAccount: { select: { email: true, provider: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ rules });
  } catch (err) {
    next(err);
  }
});

// ─── Create rule ──────────────────────────────────────────────────────────────

router.post("/rules", async (req, res, next) => {
  try {
    const { connectedAccountId, senderEmail, senderName, permanent = false, schedule, label } = req.body;

    if (!connectedAccountId || !senderEmail || !schedule) {
      return res.status(400).json({ error: "connectedAccountId, senderEmail, and schedule are required." });
    }

    // Resolve preset to cron expression
    const cronExpr = AutoCleanService.SCHEDULES[schedule] ?? schedule;

    if (!nodeCron.validate(cronExpr)) {
      return res.status(400).json({ error: `Invalid schedule: "${schedule}". Use daily, weekly, monthly, or a valid cron expression.` });
    }

    // Verify the connected account belongs to this user
    const account = await db.connectedAccount.findFirst({
      where: { id: connectedAccountId, userId: req.user.id, isActive: true },
    });
    if (!account) {
      return res.status(404).json({ error: "Connected account not found." });
    }

    // Limit total rules per user (prevent abuse)
    const count = await db.autoCleanRule.count({ where: { userId: req.user.id } });
    if (count >= 20) {
      return res.status(400).json({ error: "Maximum 20 auto-clean rules per account." });
    }

    const rule = await db.autoCleanRule.create({
      data: {
        userId: req.user.id,
        connectedAccountId,
        senderEmail,
        senderName: senderName || null,
        permanent,
        schedule: cronExpr,
        label: label || null,
        isActive: true,
      },
      include: { connectedAccount: { select: { email: true, provider: true } } },
    });

    AutoCleanService.scheduleRule(rule);
    res.status(201).json({ rule });
  } catch (err) {
    next(err);
  }
});

// ─── Toggle isActive ──────────────────────────────────────────────────────────

router.patch("/rules/:id", async (req, res, next) => {
  try {
    const rule = await db.autoCleanRule.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!rule) return res.status(404).json({ error: "Rule not found." });

    const { isActive } = req.body;
    const updated = await db.autoCleanRule.update({
      where: { id: rule.id },
      data: { isActive: Boolean(isActive) },
      include: { connectedAccount: { select: { email: true, provider: true } } },
    });

    if (updated.isActive) {
      AutoCleanService.scheduleRule(updated);
    } else {
      AutoCleanService.unscheduleRule(updated.id);
    }

    res.json({ rule: updated });
  } catch (err) {
    next(err);
  }
});

// ─── Delete rule ──────────────────────────────────────────────────────────────

router.delete("/rules/:id", async (req, res, next) => {
  try {
    const rule = await db.autoCleanRule.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!rule) return res.status(404).json({ error: "Rule not found." });

    AutoCleanService.unscheduleRule(rule.id);
    await db.autoCleanRule.delete({ where: { id: rule.id } });
    res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─── Run now (test trigger) ───────────────────────────────────────────────────

router.post("/rules/:id/run", async (req, res, next) => {
  try {
    const rule = await db.autoCleanRule.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!rule) return res.status(404).json({ error: "Rule not found." });

    // Run in background — respond immediately
    AutoCleanService.runRule(rule.id).catch(() => {});
    res.json({ triggered: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
