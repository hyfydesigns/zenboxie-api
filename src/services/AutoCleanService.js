/**
 * AutoCleanService — runs scheduled sender-deletion jobs for Pro/Premium users.
 *
 * Each AutoCleanRule has a cron schedule. On startup this service loads all
 * active rules from the DB and schedules them. When rules are created or
 * deleted via the API, the caller notifies this service to add/remove the job.
 *
 * The service deliberately avoids the SessionStore — background jobs open a
 * fresh IMAP/Gmail connection, perform the delete, then close it.
 */

const cron = require("node-cron");
const db = require("../db");
const EncryptionService = require("./EncryptionService");
const ImapService = require("./ImapService");
const GmailService = require("./GmailService");

// Map of ruleId → cron.ScheduledTask
const jobs = new Map();

// ─── Run a single rule ────────────────────────────────────────────────────────

async function runRule(ruleId) {
  let rule;
  try {
    rule = await db.autoCleanRule.findUnique({
      where: { id: ruleId },
      include: { connectedAccount: true },
    });

    if (!rule || !rule.isActive) return;

    const { connectedAccount, senderEmail, permanent } = rule;
    if (!connectedAccount || !connectedAccount.isActive) {
      throw new Error("Connected account is no longer active.");
    }

    const creds = JSON.parse(EncryptionService.decrypt(connectedAccount.encryptedCredentials));
    let deleted = 0;

    if (connectedAccount.provider === "IMAP") {
      const imap = new ImapService(creds);
      await imap.connect();
      try {
        const result = await imap.deleteFromSender(senderEmail, { permanent });
        deleted = result?.deleted ?? 0;
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
      const result = await gmail.deleteFromSender(senderEmail, permanent);
      deleted = result?.deleted ?? 0;
    } else {
      throw new Error(`Provider not supported: ${connectedAccount.provider}`);
    }

    // Log usage
    db.usageLog.create({
      data: { userId: rule.userId, action: "DELETE_SENDER" },
    }).catch(() => {});

    await db.autoCleanRule.update({
      where: { id: ruleId },
      data: { lastRunAt: new Date(), lastRunStatus: `success:${deleted}` },
    });

    console.log(`[AutoClean] Rule ${ruleId}: deleted ${deleted} emails from ${senderEmail}`);
  } catch (err) {
    console.error(`[AutoClean] Rule ${ruleId} failed:`, err.message);
    if (rule) {
      await db.autoCleanRule.update({
        where: { id: ruleId },
        data: { lastRunAt: new Date(), lastRunStatus: `error:${err.message.slice(0, 120)}` },
      }).catch(() => {});
    }
  }
}

// ─── Schedule / unschedule ────────────────────────────────────────────────────

function scheduleRule(rule) {
  if (jobs.has(rule.id)) {
    jobs.get(rule.id).stop();
    jobs.delete(rule.id);
  }

  if (!rule.isActive) return;

  if (!cron.validate(rule.schedule)) {
    console.warn(`[AutoClean] Invalid cron expression for rule ${rule.id}: ${rule.schedule}`);
    return;
  }

  const task = cron.schedule(rule.schedule, () => runRule(rule.id), {
    timezone: "UTC",
  });

  jobs.set(rule.id, task);
  console.log(`[AutoClean] Scheduled rule ${rule.id} (${rule.senderEmail}) at "${rule.schedule}"`);
}

function unscheduleRule(ruleId) {
  if (jobs.has(ruleId)) {
    jobs.get(ruleId).stop();
    jobs.delete(ruleId);
    console.log(`[AutoClean] Unscheduled rule ${ruleId}`);
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

async function init() {
  try {
    const rules = await db.autoCleanRule.findMany({ where: { isActive: true } });
    for (const rule of rules) {
      scheduleRule(rule);
    }
    console.log(`[AutoClean] Initialized ${rules.length} scheduled rule(s)`);
  } catch (err) {
    console.error("[AutoClean] Failed to initialize:", err.message);
  }
}

// ─── Preset schedules ─────────────────────────────────────────────────────────

const SCHEDULES = {
  daily: "0 3 * * *",      // 3am UTC every day
  weekly: "0 3 * * 1",     // 3am UTC every Monday
  monthly: "0 3 1 * *",    // 3am UTC on 1st of month
};

module.exports = { init, scheduleRule, unscheduleRule, runRule, SCHEDULES };
