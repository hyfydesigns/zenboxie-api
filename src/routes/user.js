/**
 * User Account Routes
 *
 * POST /api/user/register  - Create a new Zenboxie account
 * POST /api/user/login     - Log in, receive access + refresh tokens
 * POST /api/user/refresh   - Exchange refresh token for new token pair
 * GET  /api/user/me        - Get current user info (requires auth)
 * POST /api/user/logout    - Client-side logout acknowledgement
 */

const express = require("express");
const router = express.Router();
const db = require("../db");
const AuthService = require("../services/AuthService");
const requireUser = require("../middleware/requireUser");

// ─── Register ─────────────────────────────────────────────────────────────────

router.post("/register", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const passwordHash = await AuthService.hashPassword(password);
    const user = await db.user.create({
      data: { email, passwordHash },
      include: { subscription: true },
    });

    const { accessToken, refreshToken } = AuthService.signTokens(user.id);

    res.status(201).json({
      user: { id: user.id, email: user.email, tier: user.subscription?.tier ?? "FREE" },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Login ────────────────────────────────────────────────────────────────────

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const user = await db.user.findUnique({
      where: { email },
      include: { subscription: true },
    });

    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const valid = await AuthService.verifyPassword(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const { accessToken, refreshToken } = AuthService.signTokens(user.id);

    res.json({
      user: { id: user.id, email: user.email, tier: user.subscription?.tier ?? "FREE" },
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Refresh Token ────────────────────────────────────────────────────────────

router.post("/refresh", async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "Refresh token is required." });
    }

    const payload = AuthService.verifyRefreshToken(refreshToken);
    if (!payload) {
      return res.status(401).json({ error: "Invalid or expired refresh token. Please log in again." });
    }

    const user = await db.user.findUnique({
      where: { id: payload.userId },
      include: { subscription: true },
    });
    if (!user) {
      return res.status(401).json({ error: "User not found." });
    }

    const { accessToken, refreshToken: newRefreshToken } = AuthService.signTokens(user.id);

    res.json({
      user: { id: user.id, email: user.email, tier: user.subscription?.tier ?? "FREE" },
      accessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Me ───────────────────────────────────────────────────────────────────────

router.get("/me", requireUser, (req, res) => {
  const { id, email, subscription } = req.user;
  res.json({ user: { id, email, tier: subscription?.tier ?? "FREE" } });
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  // Tokens are stateless JWTs — the client removes them.
  // Phase 3 will add a refresh token blocklist.
  res.json({ message: "Logged out." });
});

module.exports = router;
