/**
 * RetentionService — cron-based service that enforces per-sender retention rules.
 *
 * A RetentionRule says: for a given sender, keep only the N most recent emails
 * (keepCount) OR only emails from the last N days (keepDays). Older emails are
 * deleted on the configured schedule.
 *
 * Architecture mirrors AutoCleanService: manages in-memory cron jobs, opens
 * fresh IMAP/Gmail connections per run, never touches SessionStore.
 */

const cron = require("node-cron");
const db = require("../db");
const EncryptionService = require("./EncryptionService");
const ImapService = require("./ImapService");
const GmailService = require("./GmailService");

const jobs = new Map();

// ─── Run a single rule ────────────────────────────────────────────────────────

async function runRule(ruleId) {
  let rule;
  try {
    rule = await db.retentionRule.findUnique({
      where: { id: ruleId },
      include: { connectedAccount: true },
    });
    if (!rule || !rule.isActive) return;

    const { connectedAccount, senderEmail } = rule;
    if (!connectedAccount?.isActive) throw new Error("Connected account no longer active.");

    const creds = JSON.parse(EncryptionService.decrypt(connectedAccount.encryptedCredentials));
    let deleted = 0;

    if (connectedAccount.provider === "IMAP") {
      const imap = new ImapService(creds);
      await imap.connect();
      try {
        deleted = await _applyRetention(imap, rule);
      } finally {
        await imap.disconnect().catch(() => {});
      }
    } else if (connectedAccount.provider === "GMAIL") {
      if (!creds.refreshToken) throw new Error("No refresh token for Gmail account.");
      const tokens = await GmailService.refreshToken(
        creds.refreshToken,
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      const gmail = new GmailService(tokens.access_token);
      deleted = await _applyRetentionGmail(gmail, rule);
    }

    db.usageLog.create({ data: { userId: rule.userId, action: "DELETE_SENDER" } }).catch(() => {});

    await db.retentionRule.update({
      where: { id: ruleId },
      data: { lastRunAt: new Date(), lastRunStatus: `success:${deleted}` },
    });

    console.log(`[Retention] Rule ${ruleId}: removed ${deleted} emails from ${senderEmail}`);
  } catch (err) {
    console.error(`[Retention] Rule ${ruleId} failed:`, err.message);
    if (rule) {
      await db.retentionRule.update({
        where: { id: ruleId },
        data: { lastRunAt: new Date(), lastRunStatus: `error:${err.message.slice(0, 120)}` },
      }).catch(() => {});
    }
  }
}

async function _applyRetention(imap, rule) {
  const { senderEmail, keepCount, keepDays } = rule;
  const lock = await imap.client.getMailboxLock("INBOX");
  try {
    let uids = await imap.client.search({ from: senderEmail }, { uid: true });
    if (!uids?.length) return 0;

    let toDelete = [];

    if (keepCount != null && uids.length > keepCount) {
      // UIDs are ordered ascending — keep the last keepCount, delete the rest
      toDelete = uids.slice(0, uids.length - keepCount);
    } else if (keepDays != null) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - keepDays);
      // Fetch dates for all UIDs
      const oldUids = [];
      for await (const msg of imap.client.fetch(uids.join(","), { envelope: true }, { uid: true })) {
        if (msg.envelope?.date && new Date(msg.envelope.date) < cutoff) {
          oldUids.push(msg.uid);
        }
      }
      toDelete = oldUids;
    }

    if (!toDelete.length) return 0;

    await imap.client.messageFlagsAdd(toDelete.join(","), ["\\Deleted"], { uid: true });
    await imap.client.messageDelete(toDelete.join(","), { uid: true });
    return toDelete.length;
  } finally {
    lock.release();
  }
}

async function _applyRetentionGmail(gmail, rule) {
  const { senderEmail, keepCount, keepDays } = rule;
  let ids = await gmail._listMessageIds(`from:${senderEmail} in:inbox`);
  if (!ids.length) return 0;

  let toDelete = [];

  if (keepCount != null && ids.length > keepCount) {
    toDelete = ids.slice(0, ids.length - keepCount);
  } else if (keepDays != null) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - keepDays);
    const cutoffStr = cutoff.toISOString().split("T")[0].replace(/-/g, "/");
    const oldIds = await gmail._listMessageIds(
      `from:${senderEmail} in:inbox before:${cutoffStr}`
    ).catch(() => []);
    toDelete = oldIds;
  }

  if (!toDelete.length) return 0;

  // Gmail batch delete (trash)
  for (const id of toDelete) {
    await gmail._req(`/users/me/messages/${id}/trash`, { method: "POST" }).catch(() => {});
  }
  return toDelete.length;
}

// ─── Schedule / unschedule ────────────────────────────────────────────────────

function scheduleRule(rule) {
  if (jobs.has(rule.id)) { jobs.get(rule.id).stop(); jobs.delete(rule.id); }
  if (!rule.isActive || !cron.validate(rule.schedule)) return;
  const task = cron.schedule(rule.schedule, () => runRule(rule.id), { timezone: "UTC" });
  jobs.set(rule.id, task);
  console.log(`[Retention] Scheduled rule ${rule.id} (${rule.senderEmail}) at "${rule.schedule}"`);
}

function unscheduleRule(ruleId) {
  if (jobs.has(ruleId)) { jobs.get(ruleId).stop(); jobs.delete(ruleId); }
}

async function init() {
  try {
    const rules = await db.retentionRule.findMany({ where: { isActive: true } });
    for (const rule of rules) scheduleRule(rule);
    console.log(`[Retention] Initialized ${rules.length} rule(s)`);
  } catch (err) {
    console.error("[Retention] Init failed:", err.message);
  }
}

const SCHEDULES = {
  daily: "0 4 * * *",
  weekly: "0 4 * * 1",
  monthly: "0 4 1 * *",
};

module.exports = { init, scheduleRule, unscheduleRule, runRule, SCHEDULES };
