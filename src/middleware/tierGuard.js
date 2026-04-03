/**
 * tierGuard — composable middleware factories for tier enforcement.
 *
 * Every guard reads req.user (attached by sessionMiddleware or requireUser).
 * If req.user is absent the request is treated as FREE tier.
 *
 * Usage:
 *   router.post("/delete", tierGuard.canDelete(), tierGuard.canPermanentDelete(), handler);
 */

const db = require("../db");
const sessionStore = require("../store/SessionStore");
const { getLimits, getTier } = require("../config/tiers");

function denied(res, message, tier) {
  return res.status(403).json({
    error: message,
    upgradeRequired: true,
    currentTier: tier,
  });
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const tierGuard = {
  // Check daily sender-deletion quota
  canDelete() {
    return async (req, res, next) => {
      const limits = getLimits(req.user);
      if (limits.maxDailyDeletions === Infinity) return next();

      const tier = getTier(req.user);

      if (req.user) {
        // Authenticated user — check DB usage log
        const count = await db.usageLog.count({
          where: {
            userId: req.user.id,
            action: "DELETE_SENDER",
            createdAt: { gte: startOfToday() },
          },
        }).catch(() => 0);

        if (count >= limits.maxDailyDeletions) {
          return denied(
            res,
            `Free plan allows ${limits.maxDailyDeletions} sender deletions per day. Upgrade to Pro for unlimited deletions.`,
            tier
          );
        }
      } else {
        // Session-only (no JWT) — track in session store
        const session = req.sessionId ? sessionStore.get(req.sessionId) : null;
        if (session) {
          const today = startOfToday().getTime();
          const sessionDate = session.deletionDate || 0;
          const sessionCount = sessionDate === today ? (session.deletionCount || 0) : 0;

          if (sessionCount >= limits.maxDailyDeletions) {
            return denied(
              res,
              `Free plan allows ${limits.maxDailyDeletions} sender deletions per day. Create an account and upgrade for unlimited deletions.`,
              tier
            );
          }
          // Store updated count; incremented after successful delete in emails.js
          req._sessionDeleteCount = sessionCount;
        }
      }

      next();
    };
  },

  // Block permanent delete for Free users
  canPermanentDelete() {
    return (req, res, next) => {
      if (!req.body.permanent) return next();
      const limits = getLimits(req.user);
      if (limits.permanentDelete) return next();
      return denied(
        res,
        "Permanent delete is a Pro feature. Free plan only moves emails to trash.",
        getTier(req.user)
      );
    };
  },

  // Block bulk delete for Free users
  canBulkDelete() {
    return (req, res, next) => {
      const limits = getLimits(req.user);
      if (limits.bulkDelete) return next();
      return denied(
        res,
        "Bulk delete is a Pro feature.",
        getTier(req.user)
      );
    };
  },

  // Set req.scanLimit from tier — downstream route passes it to ImapService/GmailService
  canScan() {
    return (req, res, next) => {
      req.scanLimit = getLimits(req.user).maxScanEmails;
      next();
    };
  },

  // Block Gmail OAuth for Free users
  canUseGmailOAuth() {
    return (req, res, next) => {
      const limits = getLimits(req.user);
      if (limits.gmailOAuth) return next();
      return denied(
        res,
        "Gmail OAuth is a Pro feature. Free plan supports IMAP only.",
        getTier(req.user)
      );
    };
  },

  // Block adding more accounts than tier allows
  canAddAccount() {
    return async (req, res, next) => {
      const limits = getLimits(req.user);
      if (limits.maxConnectedAccounts === Infinity) return next();
      if (!req.user) return next();

      const count = await db.connectedAccount.count({
        where: { userId: req.user.id, isActive: true },
      }).catch(() => 0);

      if (count >= limits.maxConnectedAccounts) {
        return denied(
          res,
          `Your plan allows up to ${limits.maxConnectedAccounts} connected account(s). Upgrade to connect more.`,
          getTier(req.user)
        );
      }
      next();
    };
  },
};

module.exports = tierGuard;
