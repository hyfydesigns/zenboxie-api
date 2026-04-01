#!/usr/bin/env node
/**
 * Quick IMAP connection test script.
 * Usage: EMAIL=you@gmail.com PASSWORD=yourapppassword node scripts/test-imap.js
 */

require("dotenv").config();
const ImapService = require("../src/services/ImapService");

const email = process.env.TEST_EMAIL || process.env.EMAIL;
const password = process.env.TEST_PASSWORD || process.env.PASSWORD;

if (!email || !password) {
  console.error("Usage: TEST_EMAIL=you@example.com TEST_PASSWORD=secret node scripts/test-imap.js");
  process.exit(1);
}

(async () => {
  console.log(`\n📬 Testing IMAP connection for ${email}...\n`);

  try {
    const imap = new ImapService({ email, password });
    await imap.connect();

    console.log("✅ Connected successfully!");
    console.log(`   Host: ${imap.config.host}:${imap.config.port}`);
    console.log(`   Trash folder: ${imap.trashFolder || "(none detected)"}`);

    console.log("\n⏳ Fetching sender stats (first 100 emails)...");

    let count = 0;
    const senders = await imap.fetchSenders((processed, total) => {
      if (processed % 100 === 0) process.stdout.write(`   Progress: ${processed}/${total}\r`);
    });

    console.log(`\n\n✅ Found ${senders.length} unique senders from ${senders.reduce((a, s) => a + s.count, 0)} emails`);
    console.log("\n📊 Top 10 senders:");
    senders.slice(0, 10).forEach((s, i) => {
      console.log(`   ${i + 1}. ${s.name} <${s.email}> — ${s.count} emails (${s.sizeMb} MB)`);
    });

    await imap.disconnect();
    console.log("\n✅ Disconnected cleanly.\n");
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}\n`);

    if (err.message.includes("Invalid credentials")) {
      console.log("💡 For Gmail: make sure you're using an App Password (not your regular password).");
      console.log("   https://myaccount.google.com/apppasswords\n");
    }

    process.exit(1);
  }
})();
