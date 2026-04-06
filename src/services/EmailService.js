/**
 * EmailService — transactional emails via Resend.
 * Required env vars:
 *   RESEND_API_KEY
 *   FRONTEND_URL
 *   EMAIL_FROM  (e.g. "Zenboxie <hello@zenboxie.com>")
 */

const { Resend } = require("resend");

function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = process.env.EMAIL_FROM || "Zenboxie <hello@zenboxie.com>";
const BASE = process.env.FRONTEND_URL || "https://zenboxie.com";

async function sendWelcomeEmail(email, verificationToken) {
  const resend = getResend();
  if (!resend) {
    console.warn("[EmailService] RESEND_API_KEY not set — skipping welcome email");
    return;
  }

  const verifyUrl = `${BASE}/verify?token=${verificationToken}`;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Welcome to Zenboxie — verify your email",
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f0fdfd;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfd;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid #99f6e4;overflow:hidden;max-width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0cb8b6,#2dd4bf);padding:32px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:800;color:#ffffff;font-family:Georgia,serif;letter-spacing:-0.5px;">
                Zenboxie
              </h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">
                Clean inbox. Calm mind.
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0f2a2a;">
                Welcome aboard! 🎉
              </h2>
              <p style="margin:0 0 16px;font-size:15px;color:#475569;line-height:1.7;">
                Thanks for creating your Zenboxie account. You're one step away from a cleaner inbox.
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.7;">
                Click the button below to verify your email address and activate your account:
              </p>

              <!-- CTA Button -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${verifyUrl}"
                       style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#0cb8b6,#2dd4bf);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;box-shadow:0 4px 14px rgba(12,184,182,0.35);">
                      Verify my email
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:28px 0 0;font-size:13px;color:#94a3b8;line-height:1.6;">
                Or copy and paste this link into your browser:<br>
                <a href="${verifyUrl}" style="color:#0cb8b6;word-break:break-all;">${verifyUrl}</a>
              </p>

              <p style="margin:20px 0 0;font-size:13px;color:#94a3b8;">
                This link expires in 24 hours. If you didn't create a Zenboxie account, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- What's next -->
          <tr>
            <td style="padding:0 40px 32px;">
              <div style="background:#f0fdfd;border-radius:10px;border:1px solid #99f6e4;padding:20px 24px;">
                <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#0f2a2a;text-transform:uppercase;letter-spacing:0.05em;">
                  What you can do with Zenboxie
                </p>
                <table cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="padding:4px 0;font-size:14px;color:#475569;">📬 &nbsp;Scan your inbox and see who's clogging it</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;font-size:14px;color:#475569;">🗑 &nbsp;Delete all emails from a sender in one click</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;font-size:14px;color:#475569;">🕐 &nbsp;Set auto-clean rules to keep your inbox tidy</td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;font-size:14px;color:#475569;">📊 &nbsp;See how much storage you're wasting</td>
                  </tr>
                </table>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 32px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                © ${new Date().getFullYear()} Zenboxie &nbsp;·&nbsp;
                <a href="${BASE}/privacy" style="color:#94a3b8;text-decoration:none;">Privacy Policy</a>
                &nbsp;·&nbsp;
                <a href="${BASE}/help" style="color:#94a3b8;text-decoration:none;">Help Center</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

async function sendVerificationSuccessEmail(email) {
  const resend = getResend();
  if (!resend) return;

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Your Zenboxie email is verified ✓",
    html: `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:40px 20px;background:#f0fdfd;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid #99f6e4;overflow:hidden;max-width:100%;">
          <tr>
            <td style="background:linear-gradient(135deg,#0cb8b6,#2dd4bf);padding:32px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:800;color:#ffffff;font-family:Georgia,serif;">Zenboxie</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;text-align:center;">
              <div style="font-size:48px;margin-bottom:16px;">✅</div>
              <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0f2a2a;">Email verified!</h2>
              <p style="margin:0 0 28px;font-size:15px;color:#475569;line-height:1.7;">
                Your account is fully activated. Start cleaning your inbox now.
              </p>
              <a href="${BASE}" style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#0cb8b6,#2dd4bf);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;">
                Go to Zenboxie
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 40px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">© ${new Date().getFullYear()} Zenboxie</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

async function sendSubscriptionEmail(email, tier) {
  const resend = getResend();
  if (!resend) {
    console.warn("[EmailService] RESEND_API_KEY not set — skipping subscription email");
    return;
  }

  const tierLabel = tier === "PRO" ? "Pro" : "Premium";
  const tierEmoji = tier === "PRO" ? "⚡" : "👑";
  const features = tier === "PRO"
    ? ["Up to 3 connected email accounts", "Unlimited email scanning", "Unlimited daily deletions", "Permanent delete & bulk delete", "Scheduled Auto-Clean rules"]
    : ["Unlimited connected accounts", "All Pro features", "Retention Rules", "AI smart filters", "3 team seats"];

  await resend.emails.send({
    from: FROM,
    to: email,
    subject: `You're now on Zenboxie ${tierLabel} ${tierEmoji}`,
    html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f0fdfd;font-family:'DM Sans',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdfd;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid #99f6e4;overflow:hidden;max-width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0cb8b6,#2dd4bf);padding:32px;text-align:center;">
              <h1 style="margin:0;font-size:28px;font-weight:800;color:#ffffff;font-family:Georgia,serif;letter-spacing:-0.5px;">
                Zenboxie
              </h1>
              <p style="margin:6px 0 0;color:rgba(255,255,255,0.85);font-size:14px;">
                Clean inbox. Calm mind.
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:40px 40px 32px;">
              <div style="font-size:48px;text-align:center;margin-bottom:16px;">${tierEmoji}</div>
              <h2 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#0f2a2a;text-align:center;">
                Welcome to ${tierLabel}!
              </h2>
              <p style="margin:0 0 24px;font-size:15px;color:#475569;line-height:1.7;text-align:center;">
                Your subscription is active. Here's what you now have access to:
              </p>

              <!-- Features list -->
              <div style="background:#f0fdfd;border-radius:10px;border:1px solid #99f6e4;padding:20px 24px;margin-bottom:28px;">
                <table cellpadding="0" cellspacing="0" width="100%">
                  ${features.map(f => `
                  <tr>
                    <td style="padding:5px 0;font-size:14px;color:#0f2a2a;">✅ &nbsp;${f}</td>
                  </tr>`).join("")}
                </table>
              </div>

              <!-- CTA -->
              <table cellpadding="0" cellspacing="0" width="100%">
                <tr>
                  <td align="center">
                    <a href="${BASE}/account"
                       style="display:inline-block;padding:14px 36px;background:linear-gradient(135deg,#0cb8b6,#2dd4bf);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;border-radius:10px;box-shadow:0 4px 14px rgba(12,184,182,0.35);">
                      Go to my account
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0;font-size:13px;color:#94a3b8;line-height:1.6;text-align:center;">
                To manage your subscription, visit your account dashboard or email us at
                <a href="mailto:support@zenboxie.com" style="color:#0cb8b6;">support@zenboxie.com</a>.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 32px;border-top:1px solid #e2e8f0;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                © ${new Date().getFullYear()} Zenboxie &nbsp;·&nbsp;
                <a href="${BASE}/privacy" style="color:#94a3b8;text-decoration:none;">Privacy Policy</a>
                &nbsp;·&nbsp;
                <a href="${BASE}/help" style="color:#94a3b8;text-decoration:none;">Help Center</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim(),
  });
}

module.exports = { sendWelcomeEmail, sendVerificationSuccessEmail, sendSubscriptionEmail };
