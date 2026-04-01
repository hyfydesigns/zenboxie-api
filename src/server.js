/**
 * Inbox Cleaner - Backend API Server
 * Supports: IMAP (generic), Gmail (OAuth2), Outlook (OAuth2 via Graph API)
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/auth");
const emailRoutes = require("./routes/emails");
const sessionMiddleware = require("./middleware/session");
const errorHandler = require("./middleware/errorHandler");

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception — server staying alive:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection — server staying alive:", reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Inbox Cleaner API running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
});



// ─── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:3000",
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));

// Rate limiting — protect against abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 500,
  message: { error: "Too many requests. Please wait before trying again." },
});
app.use("/api/", limiter);

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many login attempts. Please wait 15 minutes." },
});

// Only apply strict limit to login/connect routes, not logout
app.use("/api/auth/imap", authLimiter);
app.use("/api/auth/google", authLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/emails", sessionMiddleware, emailRoutes);

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);



