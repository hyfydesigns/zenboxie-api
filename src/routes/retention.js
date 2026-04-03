/**
 * Retention Routes  (Premium feature)
 *
 * GET    /api/retention/rules          - List rules for current user
 * POST   /api/retention/rules          - Create rule
 * PATCH  /api/retention/rules/:id      - Toggle isActive
 * DELETE /api/retention/rules/:id      - Delete rule
 * POST   /api/retention/rules/:id/run  - Trigger immediately
 */

const express = require("express");
const router = express.Router();
const requireUser = require("../middleware/requireUser");
const { getLimits } = require("../config/tiers");
const RetentionService = require("../services/RetentionService");
const nodeCron = require("node-cron");
const db = require("../db");

router.use(requireUser);

router.use((req, res, next) => {
  if (!getLimits(req.user).retentionRules) {
    return res.status(403).json({
      error: "Retention rules is a Premium feature.",
      upgradeRequired: true,
      currentTier: req.user?.subscription?.tier ?? "FREE",
    });
  }
  next();
});

router.get("/rules", async (req, res, next) => {
  try {
    const rules = await db.retentionRule.findMany({
      where: { userId: req.user.id },
      include: { connectedAccount: { select: { email: true, provider: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ rules });
  } catch (err) { next(err); }
});

router.post("/rules", async (req, res, next) => {
  try {
    const { connectedAccountId, senderEmail, senderName, keepCount, keepDays, schedule, label } = req.body;

    if (!connectedAccountId || !senderEmail || !schedule) {
      return res.status(400).json({ error: "connectedAccountId, senderEmail, and schedule are required." });
    }
    if (!keepCount && !keepDays) {
      return res.status(400).json({ error: "Either keepCount or keepDays is required." });
    }

    const cronExpr = RetentionService.SCHEDULES[schedule] ?? schedule;
    if (!nodeCron.validate(cronExpr)) {
      return res.status(400).json({ error: `Invalid schedule: "${schedule}".` });
    }

    const account = await db.connectedAccount.findFirst({
      where: { id: connectedAccountId, userId: req.user.id, isActive: true },
    });
    if (!account) return res.status(404).json({ error: "Connected account not found." });

    const count = await db.retentionRule.count({ where: { userId: req.user.id } });
    if (count >= 20) return res.status(400).json({ error: "Maximum 20 retention rules per account." });

    const rule = await db.retentionRule.create({
      data: {
        userId: req.user.id,
        connectedAccountId,
        senderEmail,
        senderName: senderName || null,
        keepCount: keepCount ? parseInt(keepCount) : null,
        keepDays: keepDays ? parseInt(keepDays) : null,
        schedule: cronExpr,
        label: label || null,
      },
      include: { connectedAccount: { select: { email: true, provider: true } } },
    });

    RetentionService.scheduleRule(rule);
    res.status(201).json({ rule });
  } catch (err) { next(err); }
});

router.patch("/rules/:id", async (req, res, next) => {
  try {
    const rule = await db.retentionRule.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!rule) return res.status(404).json({ error: "Rule not found." });

    const updated = await db.retentionRule.update({
      where: { id: rule.id },
      data: { isActive: Boolean(req.body.isActive) },
      include: { connectedAccount: { select: { email: true, provider: true } } },
    });

    updated.isActive ? RetentionService.scheduleRule(updated) : RetentionService.unscheduleRule(updated.id);
    res.json({ rule: updated });
  } catch (err) { next(err); }
});

router.delete("/rules/:id", async (req, res, next) => {
  try {
    const rule = await db.retentionRule.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!rule) return res.status(404).json({ error: "Rule not found." });

    RetentionService.unscheduleRule(rule.id);
    await db.retentionRule.delete({ where: { id: rule.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post("/rules/:id/run", async (req, res, next) => {
  try {
    const rule = await db.retentionRule.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!rule) return res.status(404).json({ error: "Rule not found." });

    RetentionService.runRule(rule.id).catch(() => {});
    res.json({ triggered: true });
  } catch (err) { next(err); }
});

module.exports = router;
