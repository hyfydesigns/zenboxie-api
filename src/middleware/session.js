const sessionStore = require("../store/SessionStore");

module.exports = function sessionMiddleware(req, res, next) {
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
  next();
};