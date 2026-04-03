const sessionStore = require("../store/SessionStore");
const db = require("../db");

module.exports = async function sessionMiddleware(req, res, next) {
  // Accept session ID from header OR query param (needed for EventSource)
  const sessionId = req.headers["x-session-id"] || req.query.sessionId;

  if (!sessionId) {
    return res.status(401).json({ error: "Missing session ID. Please log in first." });
  }

  const session = sessionStore.get(sessionId);
  if (!session) {
    return res.status(401).json({ error: "Session expired or invalid. Please log in again." });
  }

  req.sessionId = sessionId;
  req.session = session;

  // Attach user from session for tier enforcement (Phase 3+).
  // If the session carries a userId (set when user connected while logged in), load the user.
  if (session.userId && !req.user) {
    const user = await db.user
      .findUnique({ where: { id: session.userId }, include: { subscription: true } })
      .catch(() => null);
    if (user) {
      const pendingInvite = await db.teamInvite
        .findFirst({ where: { inviteeEmail: user.email.toLowerCase(), status: "PENDING" }, include: { owner: { select: { email: true } } } })
        .catch(() => null);
      if (pendingInvite) user.pendingTeamInvite = pendingInvite;
      req.user = user;
    }
  }

  next();
};
