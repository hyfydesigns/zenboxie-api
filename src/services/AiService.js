/**
 * AiService — Claude-powered inbox analysis for Premium users.
 *
 * Required env var: ANTHROPIC_API_KEY
 */

const Anthropic = require("@anthropic-ai/sdk");

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set.");
  }
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * Categorize a list of senders and surface cleanup recommendations.
 *
 * @param {Array<{email, name, count, sizeMb, subjects, latestDate}>} senders
 * @returns {{ categories: object, recommendations: Array, summary: string }}
 */
async function analyzeSenders(senders) {
  const client = getClient();

  // Keep the payload small — top 100 senders by count
  const top = [...senders]
    .sort((a, b) => b.count - a.count)
    .slice(0, 100)
    .map((s) => ({
      email: s.email,
      name: s.name,
      count: s.count,
      sizeMb: s.sizeMb,
      subject: s.subjects?.[0] ?? "",
      latestDate: s.latestDate ?? "",
    }));

  const prompt = `You are an email inbox assistant. Analyze this list of email senders and categorize each one.

Sender list (JSON):
${JSON.stringify(top, null, 2)}

Respond with valid JSON in exactly this shape:
{
  "categories": {
    "newsletter": ["email1@example.com", ...],
    "marketing": [...],
    "receipt": [...],
    "notification": [...],
    "social": [...],
    "spam_likely": [...],
    "important": [...]
  },
  "recommendations": [
    { "email": "...", "reason": "...", "priority": "high|medium|low" }
  ],
  "summary": "One or two sentence plain-English summary of the inbox health."
}

Rules:
- Every sender must appear in exactly one category.
- Put in "recommendations" only senders that are safe to delete (newsletters, marketing, spam).
- "important" = financial, legal, work, healthcare — never recommend deleting these.
- Limit recommendations to at most 20 items, highest priority first.
- Return only raw JSON, no markdown.`;

  const message = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text = message.content[0]?.text ?? "{}";

  // Strip markdown code fences if present
  const clean = text.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
  return JSON.parse(clean);
}

module.exports = { analyzeSenders };
