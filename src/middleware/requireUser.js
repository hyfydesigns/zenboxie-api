const AuthService = require("../services/AuthService");
const db = require("../db");

module.exports = async function requireUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required." });
  }

  const token = authHeader.slice(7);
  const payload = AuthService.verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }

  const user = await db.user
    .findUnique({ where: { id: payload.userId }, include: { subscription: true } })
    .catch(() => null);

  if (!user) {
    return res.status(401).json({ error: "User not found." });
  }

  // Surface any pending team invites so the frontend can prompt acceptance
  const pendingInvite = await db.teamInvite
    .findFirst({ where: { inviteeEmail: user.email.toLowerCase(), status: "PENDING" }, include: { owner: { select: { email: true } } } })
    .catch(() => null);
  if (pendingInvite) user.pendingTeamInvite = pendingInvite;

  req.user = user;
  next();
};
