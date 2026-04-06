/**
 * GmailService — Gmail-specific operations via Gmail REST API.
 *
 * Uses OAuth2 access tokens (obtained via frontend Google Sign-In or
 * server-side OAuth flow). Falls back to IMAP for delete operations
 * since Gmail API delete is simpler via REST.
 *
 * Prerequisites (set in .env):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_REDIRECT_URI
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

class GmailService {
  /**
   * @param {string} accessToken - OAuth2 access token
   */
  constructor(accessToken) {
    this.accessToken = accessToken;
  }

  // ─── Auth helpers ───────────────────────────────────────────────────────────

static getAuthUrl(clientId, redirectUri, scopes, state) {
  const defaultScopes = [
    "https://www.googleapis.com/auth/gmail.modify",  // move to trash
    "https://mail.google.com/",                       // permanent delete (batchDelete requires this)
    "email",
    "profile",
  ];
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: (scopes || defaultScopes).join(" "),
      access_type: "offline",
      prompt: "consent",
      ...(state && { state }),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

static async exchangeCode(code, clientId, clientSecret, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const json = await res.json();
  console.log("Google token response:", JSON.stringify(json, null, 2)); // add this

  if (!res.ok) {
    throw new Error(json.error_description || json.error || "Failed to exchange OAuth code");
  }
  return json;
}

  static async refreshToken(refreshToken, clientId, clientSecret) {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "refresh_token",
      }),
    });
    if (!res.ok) throw new Error("Failed to refresh token");
    return res.json();
  }

  // ─── Core API request ───────────────────────────────────────────────────────

  async _req(path, options = {}, retries = 3) {
    const res = await fetch(`${GMAIL_API}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (res.status === 401) {
      const e = new Error("OAuth token expired or revoked");
      e.tokenExpired = true;
      throw e;
    }

    // Retry on rate limit (403 rateLimitExceeded or 429)
    if ((res.status === 429 || res.status === 403) && retries > 0) {
      const body = await res.text();
      if (body.includes("rateLimitExceeded") || body.includes("RATE_LIMIT_EXCEEDED") || res.status === 429) {
        const delay = (4 - retries) * 2000; // 2s, 4s, 6s
        await new Promise(r => setTimeout(r, delay));
        return this._req(path, options, retries - 1);
      }
      throw new Error(`Gmail API ${path} returned ${res.status}: ${body}`);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gmail API ${path} returned ${res.status}: ${body}`);
    }

    return res.status === 204 ? null : res.json();
  }

  // ─── User Info ──────────────────────────────────────────────────────────────

  async getProfile() {
    return this._req("/users/me/profile");
  }

  // ─── Fetch & Group ──────────────────────────────────────────────────────────

  /**
   * List all messages and group by sender.
   * Uses batched list calls + metadata fetch (From, Subject, Date headers only).
   *
   * @param {function} [onProgress] - (processed, total)
   */
async fetchSenders(onProgress, limit = Infinity) {
  const safeDate = (val) => {
    if (!val) return null;
    try {
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    } catch (_) {
      return null;
    }
  };

  const safeISO = (d) => {
    try {
      return d && !isNaN(d.getTime()) ? d.toISOString().split("T")[0] : null;
    } catch (_) {
      return null;
    }
  };

  const senderMap = new Map();
  let pageToken = null;
  let totalFetched = 0;

  // Step 1: collect message IDs (stop early once limit is reached)
  const allIds = [];
  do {
    const params = new URLSearchParams({ maxResults: 500, q: "in:inbox" });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await this._req(`/users/me/messages?${params}`);
    if (!page?.messages) break;
    allIds.push(...page.messages.map(m => m.id));
    pageToken = page.nextPageToken || null;
    if (allIds.length >= limit) break;
  } while (pageToken);

  // Enforce scan limit — Gmail returns newest first, so take the first `limit` IDs
  const limitedIds = limit < Infinity ? allIds.slice(0, limit) : allIds;

  // Step 2: fetch metadata in batches
  const CONCURRENCY = 10;
  const total = limitedIds.length;

  for (let i = 0; i < limitedIds.length; i += CONCURRENCY) {
    const batch = limitedIds.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(id =>
        this._req(`/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)
      )
    );

    for (const result of results) {
      if (result.status !== "fulfilled" || !result.value) continue;
      const msg = result.value;

      const headers = {};
      for (const h of msg.payload?.headers || []) {
        headers[h.name.toLowerCase()] = h.value;
      }

      const fromRaw = headers["from"] || "";
      const { email, name } = parseFrom(fromRaw);
      if (!email) continue;

      if (!senderMap.has(email)) {
        senderMap.set(email, {
          email,
          name,
          count: 0,
          sizeBytes: 0,
          subjects: [],
          dates: [],
        });
      }

      const group = senderMap.get(email);
      group.count++;
      group.sizeBytes += msg.sizeEstimate || 0;

      if (group.subjects.length < 3 && headers.subject) {
        group.subjects.push(headers.subject);
      }

      // Use internalDate (ms timestamp) first, fall back to Date header
      if (msg.internalDate) {
        const d = new Date(parseInt(msg.internalDate));
        if (!isNaN(d.getTime())) group.dates.push(d);
      } else {
        const d = safeDate(headers["date"]);
        if (d) group.dates.push(d);
      }

      totalFetched++;
    }

    if (onProgress) onProgress(totalFetched, total);
  }

  // Build final output
  const results = [];
  for (const [, group] of senderMap) {
    group.dates.sort((a, b) => b - a);
    results.push({
      email: group.email,
      name: group.name,
      count: group.count,
      sizeMb: parseFloat((group.sizeBytes / 1024 / 1024).toFixed(2)),
      sizeBytes: group.sizeBytes,
      subjects: group.subjects,
      latestDate: safeISO(group.dates[0]) ?? "Unknown",
      oldestDate: safeISO(group.dates[group.dates.length - 1]) ?? "Unknown",
    });
  }

  return results.sort((a, b) => b.count - a.count);
}

  // ─── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Move all emails from a sender to Gmail Trash.
   * @param {string} senderEmail
   * @param {boolean} [permanent=false] - use batchDelete instead of batchModify
   */
  async deleteFromSender(senderEmail, permanent = false) {
    const ids = await this._listMessageIds(`from:${senderEmail} in:inbox`);
    if (ids.length === 0) return { deleted: 0, freedBytes: 0 };

    // Calculate size estimate
  const sizeRes = ids.length > 0
    ? await this._req(`/users/me/messages/${ids[0]}?format=metadata&fields=sizeEstimate`).catch(() => ({ sizeEstimate: 0 }))
    : { sizeEstimate: 0 };
    const avgSize = sizeRes?.sizeEstimate || 0;
    const freedBytes = avgSize * ids.length;

    const BATCH = 1000;
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      if (permanent) {
        await this._req("/users/me/messages/batchDelete", {
          method: "POST",
          body: JSON.stringify({ ids: chunk }),
        });
      } else {
        await this._req("/users/me/messages/batchModify", {
          method: "POST",
          body: JSON.stringify({
            ids: chunk,
            addLabelIds: ["TRASH"],
            removeLabelIds: ["INBOX"],
          }),
        });
      }
    }

    return { deleted: ids.length, freedBytes };
  }

  async _listMessageIds(query) {
    const ids = [];
    let pageToken = null;
    do {
      const params = new URLSearchParams({ q: query, maxResults: 500 });
      if (pageToken) params.set("pageToken", pageToken);
      const page = await this._req(`/users/me/messages?${params}&fields=messages(id),nextPageToken`);
      if (!page?.messages) break;
      ids.push(...page.messages.map(m => m.id));
      pageToken = page.nextPageToken || null;
    } while (pageToken);
    return ids;
  }

  // ─── Label / folder listing ──────────────────────────────────────────────────

  async listLabels() {
    const data = await this._req("/users/me/labels");
    return (data.labels || []).map((l) => ({ path: l.id, name: l.name, type: l.type }));
  }

  // ─── Unsubscribe link ─────────────────────────────────────────────────────────

  async getUnsubscribeLink(senderEmail) {
    const ids = await this._listMessageIds(`from:${senderEmail} in:inbox`);
    if (!ids.length) return null;

    const msgId = ids[ids.length - 1];
    const msg = await this._req(
      `/users/me/messages/${msgId}?format=metadata&metadataHeaders=List-Unsubscribe&metadataHeaders=List-Unsubscribe-Post`
    ).catch(() => null);
    if (!msg) return null;

    const headers = msg.payload?.headers || [];
    const header = headers.find((h) => h.name.toLowerCase() === "list-unsubscribe");
    if (header?.value) {
      const parsed = this._parseUnsubscribeHeader(header.value);
      // Prefer HTTP URL — only fall through to body scan if we only got mailto
      if (parsed.url) return parsed;
    }

    // Fall back: scan the email body for an unsubscribe link
    const full = await this._req(`/users/me/messages/${msgId}?format=full`).catch(() => null);
    if (full) {
      const bodyUrl = this._extractUnsubscribeFromBody(full.payload);
      if (bodyUrl) return { url: bodyUrl, mailto: null };
    }

    // Last resort: return the mailto if we have it
    if (header?.value) return this._parseUnsubscribeHeader(header.value);
    return null;
  }

  _extractUnsubscribeFromBody(payload) {
    if (!payload) return null;
    let html = "";

    const extractParts = (part) => {
      if (part.mimeType === "text/html" && part.body?.data) {
        html += Buffer.from(part.body.data, "base64").toString("utf-8");
      }
      if (part.parts) part.parts.forEach(extractParts);
    };
    extractParts(payload);

    if (!html) return null;

    // Find all href links containing "unsubscribe"
    const linkRegex = /href=["']([^"']*unsubscribe[^"']*)["']/gi;
    const match = linkRegex.exec(html);
    if (match && match[1].startsWith("http")) return match[1];
    return null;
  }

  _parseUnsubscribeHeader(header) {
    const urls = [];
    const mailto = [];
    const parts = header.split(/,\s*(?=<)/);
    for (const part of parts) {
      const m = part.match(/<([^>]+)>/);
      if (!m) continue;
      const val = m[1].trim();
      if (val.startsWith("mailto:")) mailto.push(val);
      else if (val.startsWith("http")) urls.push(val);
    }
    return { url: urls[0] || null, mailto: mailto[0] || null };
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Parse a "From" header like:
 *   "John Doe <john@example.com>"
 *   "john@example.com"
 */
function parseFrom(raw = "") {
  const match = raw.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].toLowerCase().trim() };
  }
  const emailOnly = raw.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  if (emailOnly) {
    return { name: emailOnly[0], email: emailOnly[0].toLowerCase() };
  }
  return { name: raw, email: "" };
}

module.exports = GmailService;
