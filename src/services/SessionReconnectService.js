/**
 * SessionReconnectService
 *
 * Rebuilds a live IMAP or Gmail session from stored (encrypted) credentials.
 * Called when a user's email session has expired but their account is saved in DB.
 */

const ImapService = require("./ImapService");
const GmailService = require("./GmailService");
const EncryptionService = require("./EncryptionService");
const sessionStore = require("../store/SessionStore");
const db = require("../db");

module.exports = {
  /**
   * Reconnect a specific ConnectedAccount by ID.
   * Returns { sessionId, email, provider } on success.
   */
  async reconnect(connectedAccountId) {
    const account = await db.connectedAccount.findUnique({
      where: { id: connectedAccountId },
    });
    if (!account || !account.isActive) {
      throw new Error("Connected account not found.");
    }

    const creds = JSON.parse(EncryptionService.decrypt(account.encryptedCredentials));
    let sessionId;

    if (account.provider === "IMAP") {
      const imap = new ImapService(creds);
      await imap.connect();
      sessionId = sessionStore.create({
        provider: "imap",
        email: account.email,
        imapConfig: creds,
        userId: account.userId,
        connectedAccountId: account.id,
      });
    } else if (account.provider === "GMAIL") {
      if (!creds.refreshToken) throw new Error("No refresh token stored for this Gmail account.");
      const tokens = await GmailService.refreshToken(
        creds.refreshToken,
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      sessionId = sessionStore.create({
        provider: "gmail",
        email: account.email,
        accessToken: tokens.access_token,
        refreshToken: creds.refreshToken,
        tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        userId: account.userId,
        connectedAccountId: account.id,
      });
    } else {
      throw new Error(`Reconnect not supported for provider: ${account.provider}`);
    }

    await db.connectedAccount.update({
      where: { id: account.id },
      data: { lastUsedAt: new Date() },
    });

    return {
      sessionId,
      email: account.email,
      provider: account.provider.toLowerCase(),
    };
  },

  /**
   * Find the most recently used active account for a user and reconnect it.
   * Returns null if the user has no saved accounts.
   */
  async reconnectLatest(userId) {
    const account = await db.connectedAccount.findFirst({
      where: { userId, isActive: true },
      orderBy: { lastUsedAt: "desc" },
    });
    if (!account) return null;
    return this.reconnect(account.id);
  },
};
