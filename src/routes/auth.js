/**
 * Auth Routes
 *
 * POST /api/auth/imap        - Connect via IMAP credentials
 * POST /api/auth/google      - Exchange Google OAuth code for session
 * GET  /api/auth/google/url  - Get Google OAuth redirect URL
 * POST /api/auth/logout      - Destroy session
 * GET  /api/auth/session     - Validate current session
 */

const express = require("express");
const router = express.Router();
const ImapService = require("../services/ImapService");
const GmailService = require("../services/GmailService");
const sessionStore = require("../store/SessionStore");
const sessionMiddleware = require("../middleware/session");

const pendingOAuth = new Map();


// ─── IMAP Login ───────────────────────────────────────────────────────────────

/**
 * POST /api/auth/imap
 * Body: { email, password, host?, port?, secure? }
 */
router.post("/imap", async (req, res, next) => {
  try {
    const { email, password, host, port, secure } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required." });
    }

    const imap = new ImapService({ email, password, host, port, secure });
    await imap.connect();

    // Store the live IMAP client in the session
    const sessionId = sessionStore.create({
      provider: "imap",
      email,
      imapConfig: { 
        email, 
        password, 
        host: imap.config.host, 
        port: imap.config.port, 
        secure: imap.config.secure 
      },
    });

    // Don't return the IMAP client to the frontend — just the session ID
    res.json({
      sessionId,
      provider: "imap",
      email,
      host: imap.config.host,
      message: "Connected successfully.",
    });
  } catch (err) {
    next(err);
  }
});

// ─── Google OAuth ─────────────────────────────────────────────────────────────

/**
 * GET /api/auth/google/url
 * Returns the Google OAuth2 consent page URL.
 */
router.get("/google/url", (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://localhost:3001/api/auth/google/callback";

  if (!clientId) {
    return res.status(503).json({ error: "Google OAuth is not configured on this server." });
  }

  const url = GmailService.getAuthUrl(clientId, redirectUri);
  res.json({ url });
});

/**
 * POST /api/auth/google
 * Body: { code } — auth code from Google OAuth redirect
 * OR   { accessToken, refreshToken } — tokens from frontend Sign-In button
 */
router.post("/google", async (req, res, next) => {
  try {
    const { code, accessToken, refreshToken } = req.body;

    let tokens = {};

    if (accessToken) {
      // Frontend already has the token (e.g. Google Identity Services button)
      tokens = { access_token: accessToken, refresh_token: refreshToken };
    } else if (code) {
      // Server-side code exchange
      if (!process.env.GOOGLE_CLIENT_ID) {
        return res.status(503).json({ error: "Google OAuth not configured." });
      }
      tokens = await GmailService.exchangeCode(
        code,
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
      );
    } else {
      return res.status(400).json({ error: "Provide either 'code' or 'accessToken'." });
    }

    const gmail = new GmailService(tokens.access_token);
    const profile = await gmail.getProfile();

    const sessionId = sessionStore.create({
      provider: "gmail",
      email: profile.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    });

    res.json({
      sessionId,
      provider: "gmail",
      email: profile.emailAddress,
      message: "Connected to Gmail successfully.",
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/google/callback
 * Handles the redirect from Google during server-side OAuth flow.
 */
router.get("/google/callback", async (req, res, next) => {
  try {
    const { code, error } = req.query;

    if (error) {
      return res.send("<html><body><p>Authentication failed: " + error + "</p></body></html>");
    }

    const tokens = await GmailService.exchangeCode(
      code,
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const gmail = new GmailService(tokens.access_token);
    const profile = await gmail.getProfile();

    const sessionId = sessionStore.create({
      provider: "gmail",
      email: profile.emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
    });

    // Generate short-lived token and store session data
    const oauthToken = require("crypto").randomBytes(16).toString("hex");
    pendingOAuth.set(oauthToken, { sessionId, email: profile.emailAddress });
    setTimeout(() => pendingOAuth.delete(oauthToken), 5 * 60 * 1000);

    // Redirect popup to frontend callback page — oauthToken is now in scope
    res.redirect(`${process.env.FRONTEND_URL}/oauth-callback.html?token=${oauthToken}`);

  } catch (err) {
    next(err);
  }
});

router.get("/google/pending/:token", (req, res) => {
  const data = pendingOAuth.get(req.params.token);
  if (!data) return res.status(404).json({ error: "Token not found or expired" });
  pendingOAuth.delete(req.params.token);
  res.json(data);
});

// ─── Logout ───────────────────────────────────────────────────────────────────

/**
 * POST /api/auth/logout
 * Header: X-Session-Id
 */
router.post("/logout", sessionMiddleware, async (req, res) => {
  sessionStore.destroy(req.sessionId);
  res.json({ message: "Logged out. Session destroyed." });
});

/**
 * GET /api/auth/session
 * Header: X-Session-Id
 * Returns current session info (no credentials).
 */
router.get("/session", sessionMiddleware, (req, res) => {
  const { provider, email } = req.session;
  res.json({ valid: true, provider, email });
});

module.exports = router;
