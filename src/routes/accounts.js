/**
 * Accounts Routes — manage connected email accounts
 *
 * GET    /api/accounts                - List all connected accounts for logged-in user
 * POST   /api/accounts/:id/reconnect  - Rebuild email session from stored credentials
 * DELETE /api/accounts/:id            - Soft-delete (disconnect) an account
 */

const express = require("express");
const router = express.Router();
const requireUser = require("../middleware/requireUser");
const SessionReconnectService = require("../services/SessionReconnectService");
const db = require("../db");

// ─── List ─────────────────────────────────────────────────────────────────────

router.get("/", requireUser, async (req, res, next) => {
  try {
    const accounts = await db.connectedAccount.findMany({
      where: { userId: req.user.id, isActive: true },
      select: { id: true, provider: true, email: true, lastUsedAt: true, createdAt: true },
      orderBy: { lastUsedAt: { sort: "desc", nulls: "last" } },
    });
    res.json({ accounts });
  } catch (err) {
    next(err);
  }
});

// ─── Reconnect ────────────────────────────────────────────────────────────────

router.post("/:id/reconnect", requireUser, async (req, res, next) => {
  try {
    // Ensure the account belongs to this user
    const account = await db.connectedAccount.findFirst({
      where: { id: req.params.id, userId: req.user.id, isActive: true },
    });
    if (!account) {
      return res.status(404).json({ error: "Account not found." });
    }

    const result = await SessionReconnectService.reconnect(account.id);
    res.json({
      sessionId: result.sessionId,
      email: result.email,
      provider: result.provider,
      message: "Reconnected successfully.",
    });
  } catch (err) {
    next(err);
  }
});

// ─── Disconnect ───────────────────────────────────────────────────────────────

router.delete("/:id", requireUser, async (req, res, next) => {
  try {
    const updated = await db.connectedAccount.updateMany({
      where: { id: req.params.id, userId: req.user.id },
      data: { isActive: false },
    });
    if (updated.count === 0) {
      return res.status(404).json({ error: "Account not found." });
    }
    res.json({ message: "Account disconnected." });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
