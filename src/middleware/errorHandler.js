/**
 * Global Express error handler.
 * Catches errors thrown from route handlers and formats them consistently.
 */
module.exports = function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  // IMAP-specific errors
  if (err.authenticationFailed || err.message?.includes("Invalid credentials")) {
    return res.status(401).json({ error: "Authentication failed. Check your credentials or app password." });
  }

  if (err.message?.includes("ECONNREFUSED") || err.message?.includes("ENOTFOUND")) {
    return res.status(503).json({ error: "Could not connect to mail server. Check host/port settings." });
  }

  if (err.message?.includes("timeout")) {
    return res.status(504).json({ error: "Connection timed out. The mail server may be slow or unreachable." });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: err.message || "An unexpected error occurred.",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
};
