/**
 * Team Routes  (Premium feature — teamSeats: 3)
 *
 * GET    /api/team/members              - List invited members + their status
 * POST   /api/team/invite               - Invite a user by email
 * DELETE /api/team/members/:id          - Revoke invite / remove member
 * GET    /api/team/my-invites           - Invites addressed to current user
 * POST   /api/team/my-invites/:id/accept - Accept an invite → get PRO access
 */

const express = require("express");
const router = express.Router();
const requireUser = require("../middleware/requireUser");
const { getLimits, getTier } = require("../config/tiers");
const db = require("../db");

router.use(requireUser);

// ─── Owner routes (require Premium) ──────────────────────────────────────────

router.get("/members", async (req, res, next) => {
  try {
    const limits = getLimits(req.user);
    if (!limits.teamSeats) {
      return res.status(403).json({ error: "Team seats is a Premium feature.", upgradeRequired: true, currentTier: getTier(req.user) });
    }
    const invites = await db.teamInvite.findMany({
      where: { ownerId: req.user.id },
      include: { invitee: { select: { email: true, createdAt: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ invites, seatsUsed: invites.length, seatsTotal: limits.teamSeats });
  } catch (err) { next(err); }
});

router.post("/invite", async (req, res, next) => {
  try {
    const limits = getLimits(req.user);
    if (!limits.teamSeats) {
      return res.status(403).json({ error: "Team seats is a Premium feature.", upgradeRequired: true, currentTier: getTier(req.user) });
    }

    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "email is required." });
    if (email.toLowerCase() === req.user.email.toLowerCase()) {
      return res.status(400).json({ error: "You cannot invite yourself." });
    }

    // Check seat limit (owner counts as 1, so max members = teamSeats - 1)
    const existing = await db.teamInvite.count({ where: { ownerId: req.user.id } });
    if (existing >= limits.teamSeats - 1) {
      return res.status(400).json({ error: `Your plan allows ${limits.teamSeats - 1} team member(s). All seats are filled.` });
    }

    // If the invitee already has a Zenboxie account, link them immediately
    const invitee = await db.user.findUnique({ where: { email: email.toLowerCase() } });

    const invite = await db.teamInvite.upsert({
      where: { ownerId_inviteeEmail: { ownerId: req.user.id, inviteeEmail: email.toLowerCase() } },
      create: {
        ownerId: req.user.id,
        inviteeEmail: email.toLowerCase(),
        inviteeId: invitee?.id ?? null,
        status: "PENDING",
      },
      update: { status: "PENDING" },
    });

    res.status(201).json({ invite });
  } catch (err) { next(err); }
});

router.delete("/members/:id", async (req, res, next) => {
  try {
    const invite = await db.teamInvite.findFirst({
      where: { id: req.params.id, ownerId: req.user.id },
    });
    if (!invite) return res.status(404).json({ error: "Invite not found." });

    await db.teamInvite.delete({ where: { id: invite.id } });

    // Downgrade the member back to FREE if they were elevated
    if (invite.inviteeId) {
      await db.subscription.updateMany({
        where: { userId: invite.inviteeId, tier: "PRO" },
        data: { tier: "FREE" },
      }).catch(() => {});
    }

    res.json({ removed: true });
  } catch (err) { next(err); }
});

// ─── Invitee routes ───────────────────────────────────────────────────────────

router.get("/my-invites", async (req, res, next) => {
  try {
    const invites = await db.teamInvite.findMany({
      where: { inviteeEmail: req.user.email.toLowerCase(), status: "PENDING" },
      include: { owner: { select: { email: true } } },
    });
    res.json({ invites });
  } catch (err) { next(err); }
});

router.post("/my-invites/:id/accept", async (req, res, next) => {
  try {
    const invite = await db.teamInvite.findFirst({
      where: { id: req.params.id, inviteeEmail: req.user.email.toLowerCase(), status: "PENDING" },
    });
    if (!invite) return res.status(404).json({ error: "Invite not found or already accepted." });

    // Mark accepted and link invitee
    await db.teamInvite.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED", inviteeId: req.user.id },
    });

    // Elevate invitee to PRO
    await db.subscription.upsert({
      where: { userId: req.user.id },
      create: { userId: req.user.id, tier: "PRO", status: "ACTIVE" },
      update: { tier: "PRO", status: "ACTIVE" },
    });

    res.json({ accepted: true });
  } catch (err) { next(err); }
});

module.exports = router;
