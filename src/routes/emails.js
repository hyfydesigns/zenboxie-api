/**
 * Email Routes (all require X-Session-Id header)
 *
 * GET  /api/emails/analyze             - Fetch & group inbox by sender
 * GET  /api/emails/analyze/stream      - SSE stream with live progress
 * GET  /api/emails/sample/:sender      - Preview emails from a sender
 * POST /api/emails/delete              - Delete all emails from a sender
 * GET  /api/emails/export              - Export sender list as CSV
 */

const express = require("express");
const router = express.Router();
const ImapService = require("../services/ImapService");
const GmailService = require("../services/GmailService");
const sessionStore = require("../store/SessionStore");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Rebuild an IMAP service from session config.
 * ImapFlow connections can drop; we reconnect on demand.
 */
async function getImapService(session) {
  // Always create a fresh connection — stored clients go stale
  const svc = new ImapService(session.imapConfig);
  await svc.connect();
  console.log("Fresh IMAP connection established, trash folder:", svc.trashFolder);
  return svc;
}

function getGmailService(session) {
  return new GmailService(session.accessToken);
}

// ─── Analyze (standard JSON response) ────────────────────────────────────────

/**
 * GET /api/emails/analyze
 * Returns full grouped sender list once analysis is complete.
 */
router.get("/analyze", async (req, res, next) => {
  const { session } = req;

  try {
    let senders;

    if (session.provider === "gmail") {
      const gmail = getGmailService(session);
      senders = await gmail.fetchSenders();
    } else {
      // IMAP
      const imap = await getImapService(session);
      try {
        senders = await imap.fetchSenders();
      } finally {
        await imap.disconnect();
      }
    }

    // Strip internal _uids before sending to client
   const safe = senders
    .filter(s => s && s.email)  // filter nulls
    .map(({ _uids, ...s }) => s);

    // Cache the full result (with UIDs) in the session for delete operations
    sessionStore.update(req.sessionId, { cachedSenders: senders });

    res.json({ senders: safe, total: safe.length });
  } catch (err) {
    next(err);
  }
});

// ─── Analyze via Server-Sent Events (live progress) ──────────────────────────

/**
 * GET /api/emails/analyze/stream
 * Streams live progress events as SSE.
 *
 * Events:
 *   data: { type: "progress", processed: N, total: N }
 *   data: { type: "done", senders: [...] }
 *   data: { type: "error", message: "..." }
 */
router.get("/analyze/stream", async (req, res, next) => {
  const { session } = req;

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onProgress = (processed, total) => {
    send({ type: "progress", processed, total });
  };

  try {
    let senders;

    if (session.provider === "gmail") {
      const gmail = getGmailService(session);
      senders = await gmail.fetchSenders(onProgress);
    } else {
      const imap = await getImapService(session);
      try {
        senders = await imap.fetchSenders(onProgress);
      } finally {
        await imap.disconnect();
      }
    }

    sessionStore.update(req.sessionId, { cachedSenders: senders });

    const safe = senders.map(({ _uids, ...s }) => s);
    send({ type: "done", senders: safe, total: safe.length });
    res.end();
  } catch (err) {
    send({ type: "error", message: err.message });
    res.end();
  }
});

// ─── Sample Emails from Sender ────────────────────────────────────────────────

/**
 * GET /api/emails/sample/:sender
 * Query: ?limit=5
 */
router.get("/sample/:sender", async (req, res, next) => {
  const { sender } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 5, 20);
  const { session } = req;

  try {
    let emails;

    if (session.provider === "gmail") {
      const gmail = getGmailService(session);
      const ids = await gmail._listMessageIds(`from:${sender} in:inbox`);
      const sample = ids.slice(-limit);
      emails = await Promise.all(
        sample.map(id =>
          gmail._req(`/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&fields=id,sizeEstimate,payload`)
            .then(msg => {
              const h = {};
              for (const header of msg.payload?.headers || []) h[header.name.toLowerCase()] = header.value;
              return {
                id: msg.id,
                subject: h.subject || "(no subject)",
                from: h.from,
                date: h.date ? new Date(h.date).toISOString().split("T")[0] : null,
                sizeMb: parseFloat(((msg.sizeEstimate || 0) / 1024 / 1024).toFixed(3)),
              };
            })
            .catch(() => null)
        )
      ).then(r => r.filter(Boolean).reverse());
    } else {
      const imap = await getImapService(session);
      try {
        emails = await imap.getEmailSample(sender, limit);
      } finally {
        await imap.disconnect();
      }
    }

    res.json({ sender, emails, count: emails.length });
  } catch (err) {
    next(err);
  }
});

// ─── Delete Emails from Sender ────────────────────────────────────────────────

/**
 * POST /api/emails/delete
 * Body: { senderEmail, permanent?: boolean }
 */
router.post("/delete", async (req, res, next) => {
  console.log("DELETE request:", req.body);
  console.log("Session provider:", req.session?.provider);
  const { senderEmail, permanent = false } = req.body;
  const { session } = req;

  if (!senderEmail) {
    return res.status(400).json({ error: "senderEmail is required." });
  }

  try {
    let result;

    if (session.provider === "gmail") {
      const gmail = getGmailService(session);
      result = await gmail.deleteFromSender(senderEmail, permanent);
    } else {
      let imap;
      try {
        imap = await getImapService(session);
        result = await imap.deleteFromSender(senderEmail, { permanent });
      } catch (imapErr) {
        console.error("IMAP delete failed:", imapErr.message);
        throw new Error("IMAP delete failed: " + imapErr.message);
      } finally {
        if (imap) {
          try { await imap.disconnect(); } catch (_) {}
        }
      }
    }

    // Remove from cached sender list
    if (session.cachedSenders) {
      const updated = session.cachedSenders.filter(s => s.email !== senderEmail);
      sessionStore.update(req.sessionId, { cachedSenders: updated });
    }

    return res.json({
      success: true,
      senderEmail,
      deleted: result?.deleted ?? 0,
      freedMb: parseFloat(((result?.freedBytes ?? 0) / 1024 / 1024).toFixed(2)),
      permanent,
    });

  } catch (err) {
    console.error("Delete error:", err);
    // Always return JSON even on error
    return res.status(500).json({
      error: err.message || "Delete failed",
      success: false,
    });
  }
});

// ─── Export CSV ───────────────────────────────────────────────────────────────

/**
 * GET /api/emails/export
 * Returns a CSV download of the cached sender list.
 */
router.get("/export", (req, res) => {
  const { session } = req;
  const senders = session.cachedSenders;

  if (!senders || senders.length === 0) {
    return res.status(404).json({ error: "No data to export. Run /analyze first." });
  }

  const rows = [
    ["Name", "Email", "Email Count", "Size (MB)", "Latest Date", "Oldest Date", "Sample Subject"],
    ...senders.map(s => [
      `"${(s.name || "").replace(/"/g, '""')}"`,
      s.email,
      s.count,
      s.sizeMb,
      s.latestDate || "",
      s.oldestDate || "",
      `"${(s.subjects?.[0] || "").replace(/"/g, '""')}"`,
    ]),
  ];

  const csv = rows.map(r => r.join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="inbox-analysis-${Date.now()}.csv"`);
  res.send(csv);
});

module.exports = router;
