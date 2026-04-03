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
const userRoutes = require("./routes/user");
const accountRoutes = require("./routes/accounts");
const billingRoutes = require("./routes/billing");
const autoCleanRoutes = require("./routes/autoclean");
const retentionRoutes = require("./routes/retention");
const teamRoutes = require("./routes/team");
const sessionMiddleware = require("./middleware/session");
const errorHandler = require("./middleware/errorHandler");
const AutoCleanService = require("./services/AutoCleanService");
const RetentionService = require("./services/RetentionService");

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception — server staying alive:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection — server staying alive:", reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`\n🚀 Inbox Cleaner API running on http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/api/health\n`);
  AutoCleanService.init();
  RetentionService.init();
});



// ─── Security Middleware ───────────────────────────────────────────────────────
app.use(helmet());
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_WWW_URL,
  "http://localhost:5173",
  "http://localhost:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
}));

// Stripe webhook MUST be mounted before express.json() to receive raw body
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), billingRoutes.webhookHandler);

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
app.use("/api/user/login", authLimiter);
app.use("/api/user/register", authLimiter);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

app.use("/api/auth", authRoutes);
app.use("/api/user", userRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/autoclean", autoCleanRoutes);
app.use("/api/retention", retentionRoutes);
app.use("/api/team", teamRoutes);
app.use("/api/emails", sessionMiddleware, emailRoutes);

// ─── Error Handler ────────────────────────────────────────────────────────────
app.use(errorHandler);



