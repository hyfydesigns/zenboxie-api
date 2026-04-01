/**
 * SessionStore — In-memory session storage.
 * Stores IMAP connections and OAuth tokens keyed by session ID.
 * Sessions auto-expire after TIMEOUT_MS of inactivity.
 *
 * ⚠️  In production, replace with Redis for multi-instance deployments.
 */

const { v4: uuidv4 } = require("uuid");

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

class SessionStore {
  constructor() {
    this.sessions = new Map();
    // Sweep expired sessions every 5 minutes
    setInterval(() => this._cleanup(), 5 * 60 * 1000);
  }

  /**
   * Create a new session and return its ID.
   * @param {object} data - { provider, credentials, client? }
   */
  create(data) {
    const id = uuidv4();
    this.sessions.set(id, {
      ...data,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    });
    return id;
  }

  /**
   * Get a session by ID. Returns null if not found or expired.
   */
  get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;

    if (Date.now() - session.lastAccessedAt > TIMEOUT_MS) {
      this._destroySession(id, session);
      return null;
    }

    // Refresh last access
    session.lastAccessedAt = Date.now();
    return session;
  }

  /**
   * Update session data.
   */
  update(id, updates) {
    const session = this.sessions.get(id);
    if (!session) return false;
    Object.assign(session, updates, { lastAccessedAt: Date.now() });
    return true;
  }

  /**
   * Destroy a session (logout / cleanup).
   */
  destroy(id) {
    const session = this.sessions.get(id);
    if (session) this._destroySession(id, session);
  }

  /**
   * Internal: close IMAP client if open, then delete.
   */
  async _destroySession(id, session) {
    try {
      if (session.imapClient && session.imapClient.usable) {
        await session.imapClient.logout();
      }
    } catch (_) {}
    this.sessions.delete(id);
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessedAt > TIMEOUT_MS) {
        this._destroySession(id, session);
      }
    }
  }

  get size() {
    return this.sessions.size;
  }
}

// Singleton
module.exports = new SessionStore();
