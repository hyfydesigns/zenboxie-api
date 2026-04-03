/**
 * ImapService — wraps imapflow for all IMAP operations.
 *
 * Capabilities:
 *  - connect()          → open authenticated IMAP connection
 *  - fetchSenders()     → group all inbox emails by sender with stats
 *  - deleteFromSender() → permanently delete (or trash) all emails from a sender
 *  - getEmailSample()   → fetch N full emails from a sender for preview
 *  - disconnect()       → graceful logout
 */

const { ImapFlow } = require("imapflow");

// Known IMAP hosts for popular providers
const IMAP_PRESETS = {
  "gmail.com": { host: "imap.gmail.com", port: 993, secure: true },
  "googlemail.com": { host: "imap.gmail.com", port: 993, secure: true },
  "outlook.com": { host: "outlook.office365.com", port: 993, secure: true },
  "hotmail.com": { host: "outlook.office365.com", port: 993, secure: true },
  "live.com": { host: "outlook.office365.com", port: 993, secure: true },
  "yahoo.com": { host: "imap.mail.yahoo.com", port: 993, secure: true },
  "icloud.com": { host: "imap.mail.me.com", port: 993, secure: true },
  "me.com": { host: "imap.mail.me.com", port: 993, secure: true },
  "protonmail.com": { host: "127.0.0.1", port: 1143, secure: false }, // Proton Bridge
  "proton.me": { host: "127.0.0.1", port: 1143, secure: false },
  "zoho.com": { host: "imap.zoho.com", port: 993, secure: true },
  "aol.com": { host: "imap.aol.com", port: 993, secure: true },
};

const BATCH_SIZE = 500; // fetch envelope headers in batches
const TRASH_FOLDERS = ["[Gmail]/Trash", "Trash", "Deleted Items", "Deleted Messages"];

class ImapService {
  /**
   * @param {object} config
   * @param {string} config.email
   * @param {string} config.password
   * @param {string} [config.host]   - override auto-detection
   * @param {number} [config.port]   - override auto-detection
   * @param {boolean} [config.secure]
   */
  constructor(config) {
    const domain = config.email.split("@")[1]?.toLowerCase();
    const preset = IMAP_PRESETS[domain] || {};

    this.config = {
      host: config.host || preset.host,
      port: config.port || preset.port || 993,
      secure: config.secure ?? preset.secure ?? true,
      email: config.email,
      password: config.password,
    };

    if (!this.config.host) {
      throw new Error(`Unknown mail provider for domain "${domain}". Please specify host and port manually.`);
    }

    this.client = null;
    this.trashFolder = null;
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async connect() {
    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.email,
        pass: this.config.password,
      },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 30000,
    });

    await this.client.connect();
    this.trashFolder = await this._findTrashFolder();
    return this;
  }

  async disconnect() {
    if (this.client?.usable) {
      await this.client.logout();
    }
  }

  // ─── Fetch & Group ──────────────────────────────────────────────────────────

  /**
   * Fetch all emails from INBOX and group by sender.
   * Returns array of SenderGroup sorted by count descending.
   *
   * @param {function} [onProgress] - called with (processed, total)
   * @param {string} [folder="INBOX"] - mailbox folder to scan
   */
  async fetchSenders(onProgress, folder = "INBOX", limit = Infinity) {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const status = await this.client.status(folder, { messages: true, unseen: true });
      const total = status.messages;

      if (total === 0) return [];

      const senderMap = new Map();
      let processed = 0;

      // For limited scans, scan the most recent `limit` emails (highest seq numbers)
      const scanFrom = limit < total ? total - limit + 1 : 1;

      // Fetch in batches to avoid memory issues on huge inboxes
      for (let start = scanFrom; start <= total; start += BATCH_SIZE) {
        const end = Math.min(start + BATCH_SIZE - 1, total);
        const range = `${start}:${end}`;

        for await (const msg of this.client.fetch(range, {
          envelope: true,
          size: true,
          flags: true,
        })) {
          const from = msg.envelope?.from?.[0];
          if (!from) continue;

          const senderEmail = (from.address || "").toLowerCase().trim();
          const senderName = from.name || from.mailbox || senderEmail;

          if (!senderEmail) continue;

          if (!senderMap.has(senderEmail)) {
            senderMap.set(senderEmail, {
              email: senderEmail,
              name: senderName,
              count: 0,
              totalSize: 0,
              uids: [],
              subjects: [],
              dates: [],
            });
          }

          const group = senderMap.get(senderEmail);
          group.count++;
          group.totalSize += msg.size || 0;
          group.uids.push(msg.uid);

          if (group.subjects.length < 3 && msg.envelope?.subject) {
            group.subjects.push(msg.envelope.subject);
          }
          if (msg.envelope?.date) {
            group.dates.push(new Date(msg.envelope.date));
          }

          processed++;
        }

        if (onProgress) onProgress(processed, total - scanFrom + 1);
      }

      // Build final output
      const results = [];
      for (const [, group] of senderMap) {
        group.dates.sort((a, b) => b - a);
        results.push({
          email: group.email,
          name: group.name,
          count: group.count,
          sizeMb: parseFloat((group.totalSize / 1024 / 1024).toFixed(2)),
          sizeBytes: group.totalSize,
          subjects: group.subjects,
          latestDate: group.dates[0]?.toISOString().split("T")[0] ?? null,
          oldestDate: group.dates[group.dates.length - 1]?.toISOString().split("T")[0] ?? null,
          // UIDs stored for deletion — NOT sent to frontend
          _uids: group.uids,
        });
      }

      return results.sort((a, b) => b.count - a.count);
    } finally {
      lock.release();
    }
  }

  // ─── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Delete all emails from a specific sender email address.
   *
   * @param {string} senderEmail
   * @param {object} options
   * @param {boolean} [options.permanent=false] - skip trash, permanently delete
   * @param {function} [options.onProgress]
   * @returns {{ deleted: number, freedBytes: number }}
   */
async deleteFromSender(senderEmail, options = {}) {
  const { permanent = false, onProgress } = options;

  let lock;
  let uids = [];  // declare outside try so finally can access it

  try {
    lock = await this.client.getMailboxLock("INBOX");

    uids = await this.client.search({ from: senderEmail }, { uid: true });
    console.log("UIDs found:", uids?.length, "Trash folder:", this.trashFolder);

    if (!uids || uids.length === 0) {
      return { deleted: 0, freedBytes: 0 };
    }

    // Calculate size
    let freedBytes = 0;
    try {
      for await (const msg of this.client.fetch(
        uids.join(","),
        { size: true },
        { uid: true }
      )) {
        freedBytes += msg.size || 0;
      }
    } catch (_) {}

    if (permanent || !this.trashFolder) {
      console.log("Permanently deleting", uids.length, "emails...");
      await this.client.messageFlagsAdd(
        uids.join(","),
        ["\\Deleted"],
        { uid: true }
      );
      await this.client.messageDelete(
        uids.join(","),
        { uid: true }
      );
    } else {
      console.log("Moving", uids.length, "emails to trash:", this.trashFolder);
      await this.client.messageMove(
        uids.join(","),
        this.trashFolder,
        { uid: true }
      );
    }

    if (onProgress) onProgress(uids.length, uids.length);
    return { deleted: uids.length, freedBytes };

  } catch (err) {
    console.error("IMAP deleteFromSender error:", err.message);
    throw err;
  } finally {
    if (lock) lock.release();
  }
}

  /**
   * Fetch a sample of N full emails from a sender for preview before deletion.
   */
  async getEmailSample(senderEmail, limit = 5) {
    const lock = await this.client.getMailboxLock("INBOX");
    try {
      const uids = await this.client.search({ from: senderEmail }, { uid: true });
      const sample = uids.slice(-limit); // most recent N

      const emails = [];
      for await (const msg of this.client.fetch(
        sample.join(","),
        { envelope: true, bodyStructure: true, size: true },
        { uid: true }
      )) {
        emails.push({
          uid: msg.uid,
          subject: msg.envelope?.subject || "(no subject)",
          from: msg.envelope?.from?.[0]?.address,
          date: msg.envelope?.date?.toISOString().split("T")[0],
          sizeMb: parseFloat(((msg.size || 0) / 1024 / 1024).toFixed(2)),
        });
      }

      return emails.reverse(); // newest first
    } finally {
      lock.release();
    }
  }

  // ─── Folder listing ──────────────────────────────────────────────────────────

  async listFolders() {
    const tree = await this.client.listTree();
    const flatten = (folders, depth = 0) => {
      const result = [];
      for (const f of folders || []) {
        if (!f.flags?.has("\\Noselect")) {
          result.push({ path: f.path, name: f.name, specialUse: f.specialUse || null });
        }
        result.push(...flatten(f.folders, depth + 1));
      }
      return result;
    };
    return flatten(tree.folders);
  }

  // ─── Unsubscribe link ─────────────────────────────────────────────────────────

  async getUnsubscribeLink(senderEmail, folder = "INBOX") {
    const lock = await this.client.getMailboxLock(folder);
    try {
      const uids = await this.client.search({ from: senderEmail }, { uid: true });
      if (!uids?.length) return null;

      // Check the most recent email
      const uid = uids[uids.length - 1];
      let unsubscribeHeader = null;

      for await (const msg of this.client.fetch(
        String(uid),
        { headers: ["list-unsubscribe", "list-unsubscribe-post"] },
        { uid: true }
      )) {
        const raw = msg.headers?.toString() || "";
        const match = raw.match(/list-unsubscribe:\s*(.+)/i);
        if (match) unsubscribeHeader = match[1].trim();
      }

      if (!unsubscribeHeader) return null;
      return this._parseUnsubscribeHeader(unsubscribeHeader);
    } finally {
      lock.release();
    }
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

  // ─── Helpers ─────────────────────────────────────────────────────────────────

async _findTrashFolder() {
  try {
    const TRASH_NAMES = [
      "Trash", "[Gmail]/Trash", "Deleted Items", 
      "Deleted Messages", "Bulk Mail", "Junk"
    ];
    
    const tree = await this.client.listTree();
    
    const findTrash = (folders) => {
      for (const folder of folders) {
        // Check by special use flag first
        if (folder.specialUse === "\\Trash") return folder.path;
        // Then check by known names
        if (TRASH_NAMES.includes(folder.path)) return folder.path;
        if (folder.folders?.length) {
          const found = findTrash(folder.folders);
          if (found) return found;
        }
      }
      return null;
    };

    const found = findTrash(tree.folders || []);
    console.log("Detected trash folder:", found);
    return found;

  } catch (err) {
    console.error("Could not detect trash folder:", err.message);
    return null;
  }
}

  /** Return server capabilities (for debugging / feature detection) */
  async getCapabilities() {
    return this.client.capabilities
      ? [...this.client.capabilities]
      : [];
  }
}

module.exports = ImapService;
