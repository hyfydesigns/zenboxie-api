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
const crypto = require("crypto");
const db = require("../db");
const AuthService = require("../services/AuthService");
const requireUser = require("../middleware/requireUser");
const { sendWelcomeEmail, sendVerificationSuccessEmail } = require("../services/EmailService");

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
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const verificationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    const user = await db.user.create({
      data: {
        email,
        passwordHash,
        emailVerificationToken: verificationToken,
        emailVerificationExpiry: verificationExpiry,
      },
      include: { subscription: true },
    });

    // Send welcome email in background — don't block registration
    sendWelcomeEmail(email, verificationToken).catch((err) =>
      console.error("[EmailService] Failed to send welcome email:", err.message)
    );

    const { accessToken, refreshToken } = AuthService.signTokens(user.id);

    res.status(201).json({
      user: { id: user.id, email: user.email, tier: user.subscription?.tier ?? "FREE", emailVerified: false },
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

    if (!user.emailVerified) {
      return res.status(403).json({
        error: "Please verify your email before signing in. Check your inbox for the activation link.",
        emailNotVerified: true,
        email: user.email,
      });
    }

    const { accessToken, refreshToken } = AuthService.signTokens(user.id);

    res.json({
      user: { id: user.id, email: user.email, tier: user.subscription?.tier ?? "FREE", emailVerified: true },
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
  const { id, email, subscription, emailVerified } = req.user;
  res.json({ user: { id, email, tier: subscription?.tier ?? "FREE", emailVerified: emailVerified ?? false } });
});

// ─── Verify Email ─────────────────────────────────────────────────────────────

router.get("/verify", async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "Verification token is required." });

    const user = await db.user.findUnique({ where: { emailVerificationToken: token } });

    if (!user) return res.status(400).json({ error: "Invalid or expired verification link." });
    if (new Date() > new Date(user.emailVerificationExpiry)) {
      return res.status(400).json({ error: "Verification link has expired. Please request a new one." });
    }

    await db.user.update({
      where: { id: user.id },
      data: { emailVerified: true, emailVerificationToken: null, emailVerificationExpiry: null },
    });

    sendVerificationSuccessEmail(user.email).catch(() => {});

    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

// ─── Resend Verification Email (authenticated) ───────────────────────────────

router.post("/resend-verification", requireUser, async (req, res, next) => {
  try {
    if (req.user.emailVerified) return res.json({ message: "Email already verified." });

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.user.update({
      where: { id: req.user.id },
      data: { emailVerificationToken: token, emailVerificationExpiry: expiry },
    });

    await sendWelcomeEmail(req.user.email, token);
    res.json({ message: "Verification email sent." });
  } catch (err) {
    next(err);
  }
});

// ─── Resend Verification Email (by email — for login page) ───────────────────

router.post("/resend-verification-by-email", async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const user = await db.user.findUnique({ where: { email } });
    // Always return 200 to avoid email enumeration
    if (!user || user.emailVerified) return res.json({ message: "If an unverified account exists, an email has been sent." });

    const token = crypto.randomBytes(32).toString("hex");
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: token, emailVerificationExpiry: expiry },
    });

    sendWelcomeEmail(user.email, token).catch(() => {});
    res.json({ message: "If an unverified account exists, an email has been sent." });
  } catch (err) {
    next(err);
  }
});

// ─── Change Password ──────────────────────────────────────────────────────────

router.post("/change-password", requireUser, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password are required." });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters." });
    }

    const user = await db.user.findUnique({ where: { id: req.user.id } });
    if (!user?.passwordHash) {
      return res.status(400).json({ error: "Password change is not available for accounts signed in with Google." });
    }

    const valid = await AuthService.verifyPassword(currentPassword, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: "Current password is incorrect." });
    }

    const passwordHash = await AuthService.hashPassword(newPassword);
    await db.user.update({ where: { id: req.user.id }, data: { passwordHash } });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Delete Account ───────────────────────────────────────────────────────────

router.delete("/me", requireUser, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Cancel Stripe subscription immediately if one exists
    const subscription = await db.subscription.findUnique({ where: { userId } });
    if (subscription?.stripeSubId && process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY.trim(), { timeout: 30000 });
        await stripe.subscriptions.cancel(subscription.stripeSubId);
      } catch (stripeErr) {
        // Log but don't block account deletion if Stripe call fails
        console.error("[DeleteAccount] Stripe cancellation failed:", stripeErr.message);
      }
    }

    // Delete subscription record first (no cascade on User→Subscription)
    if (subscription) {
      await db.subscription.delete({ where: { userId } }).catch(() => {});
    }

    // Delete the user — cascades ConnectedAccounts, UsageLogs, AutoCleanRules,
    // RetentionRules, and TeamInvites (owner side)
    await db.user.delete({ where: { id: userId } });

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post("/logout", (req, res) => {
  res.json({ message: "Logged out." });
});

module.exports = router;
