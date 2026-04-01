# 📬 Inbox Cleaner — Backend API

A Node.js/Express REST API that connects to email accounts via **IMAP** or **Google OAuth2 (Gmail)**, analyzes inboxes by grouping emails by sender, and provides bulk deletion capabilities.

---

## 🏗 Architecture

```
inbox-cleaner-api/
├── src/
│   ├── server.js                 # Express app entry point
│   ├── routes/
│   │   ├── auth.js               # Login, OAuth, logout
│   │   └── emails.js             # Analyze, delete, export
│   ├── services/
│   │   ├── ImapService.js        # Generic IMAP (imapflow)
│   │   └── GmailService.js       # Gmail REST API + OAuth2
│   ├── store/
│   │   └── SessionStore.js       # In-memory session management
│   └── middleware/
│       ├── session.js            # Session validation middleware
│       └── errorHandler.js       # Global error handling
├── scripts/
│   └── test-imap.js              # Connection test utility
├── .env.example                  # Environment variable template
└── README.md
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env with your values
```

### 3. Start the server

```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

### 4. Test IMAP connection

```bash
TEST_EMAIL=you@gmail.com TEST_PASSWORD=yourapppassword npm test
```

---

## 🔌 API Reference

All protected endpoints require the `X-Session-Id` header returned from a login endpoint.

### Authentication

#### `POST /api/auth/imap`
Connect via IMAP credentials (works with any provider).

> ⚠️ For Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not your regular password.

**Request:**
```json
{
  "email": "you@gmail.com",
  "password": "your-app-password",
  "host": "imap.gmail.com",   // optional — auto-detected for popular providers
  "port": 993,                 // optional
  "secure": true               // optional
}
```

**Response:**
```json
{
  "sessionId": "uuid-v4",
  "provider": "imap",
  "email": "you@gmail.com",
  "host": "imap.gmail.com"
}
```

---

#### `GET /api/auth/google/url`
Get the Google OAuth2 consent URL. Redirect the user here.

**Response:**
```json
{ "url": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

---

#### `POST /api/auth/google`
Exchange an OAuth2 code (or provide tokens directly) for a session.

**Request (server-side code exchange):**
```json
{ "code": "4/0AfJohXn..." }
```

**Request (frontend token — e.g. Google Identity Services):**
```json
{ "accessToken": "ya29...", "refreshToken": "1//0g..." }
```

**Response:**
```json
{
  "sessionId": "uuid-v4",
  "provider": "gmail",
  "email": "you@gmail.com"
}
```

---

#### `GET /api/auth/session`
Validate a session.

**Headers:** `X-Session-Id: <sessionId>`

**Response:**
```json
{ "valid": true, "provider": "gmail", "email": "you@gmail.com" }
```

---

#### `POST /api/auth/logout`
Destroy session and close IMAP connection.

---

### Email Operations

All require `X-Session-Id` header.

---

#### `GET /api/emails/analyze`
Fetch all inbox emails and return grouped sender statistics.

> For large inboxes (5000+ emails), use the streaming endpoint instead.

**Response:**
```json
{
  "total": 47,
  "senders": [
    {
      "email": "newsletter@medium.com",
      "name": "Medium Daily Digest",
      "count": 342,
      "sizeMb": 128.4,
      "sizeBytes": 134614016,
      "subjects": ["Your daily reads for today", "Stories you'll love"],
      "latestDate": "2026-03-09",
      "oldestDate": "2024-01-15"
    }
  ]
}
```

---

#### `GET /api/emails/analyze/stream`
Same as above but streams live progress as **Server-Sent Events**.

**Event types:**
```
data: {"type":"progress","processed":500,"total":2847}
data: {"type":"done","senders":[...],"total":47}
data: {"type":"error","message":"..."}
```

**Frontend usage:**
```javascript
const es = new EventSource("/api/emails/analyze/stream", {
  headers: { "X-Session-Id": sessionId }
});
es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  if (data.type === "progress") updateProgressBar(data.processed, data.total);
  if (data.type === "done") showResults(data.senders);
};
```

---

#### `GET /api/emails/sample/:sender`
Preview emails from a specific sender before deletion.

**Query params:** `?limit=5` (max 20)

**Response:**
```json
{
  "sender": "newsletter@medium.com",
  "count": 5,
  "emails": [
    {
      "subject": "Your daily reads for today",
      "from": "newsletter@medium.com",
      "date": "2026-03-09",
      "sizeMb": 0.042
    }
  ]
}
```

---

#### `POST /api/emails/delete`
Delete all emails from a sender.

**Request:**
```json
{
  "senderEmail": "newsletter@medium.com",
  "permanent": false
}
```

- `permanent: false` (default) — moves to Trash (recoverable)
- `permanent: true` — immediately purges (irreversible)

**Response:**
```json
{
  "success": true,
  "senderEmail": "newsletter@medium.com",
  "deleted": 342,
  "freedMb": 128.4,
  "permanent": false
}
```

---

#### `GET /api/emails/export`
Download the current sender list as a CSV file.

Returns `Content-Type: text/csv` with filename `inbox-analysis-{timestamp}.csv`.

---

## 🔐 Security Notes

- **No credential storage**: Passwords and tokens exist only in memory during the session.
- **Session expiry**: Sessions auto-expire after 30 minutes of inactivity.
- **Rate limiting**: Auth endpoints are limited to 10 requests per 15 minutes; general API to 100 per 15 minutes.
- **CORS**: Only requests from `FRONTEND_URL` are accepted.
- **Helmet**: HTTP security headers are set automatically.

### Gmail App Password Setup
For IMAP access to Gmail, you **must** use an App Password:
1. Enable 2FA on your Google account
2. Visit https://myaccount.google.com/apppasswords
3. Generate a password for "Mail"
4. Use that 16-character password instead of your regular password

---

## 🔧 Provider IMAP Settings

| Provider    | Host                       | Port | Secure |
|-------------|----------------------------|------|--------|
| Gmail       | imap.gmail.com             | 993  | ✅     |
| Outlook     | outlook.office365.com      | 993  | ✅     |
| Yahoo       | imap.mail.yahoo.com        | 993  | ✅     |
| iCloud      | imap.mail.me.com           | 993  | ✅     |
| Zoho        | imap.zoho.com              | 993  | ✅     |
| ProtonMail  | 127.0.0.1 (Bridge)         | 1143 | ❌     |

---

## 🏭 Production Deployment

For production, consider these upgrades:

1. **Session storage**: Replace in-memory `SessionStore` with Redis
   ```bash
   npm install ioredis connect-redis
   ```

2. **HTTPS**: Put behind nginx/Caddy with TLS

3. **Token encryption**: Encrypt OAuth tokens at rest before storing in Redis

4. **Process manager**: Use PM2 for zero-downtime restarts
   ```bash
   npm install -g pm2
   pm2 start src/server.js --name inbox-cleaner-api
   ```

5. **Environment**: Set `NODE_ENV=production` to disable error stack traces in API responses

---

## 📦 Connecting to the Frontend

In your React frontend, point API calls to this server:

```javascript
const API = "http://localhost:3001/api";

// 1. Login
const res = await fetch(`${API}/auth/imap`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password })
});
const { sessionId } = await res.json();

// 2. Analyze
const analysis = await fetch(`${API}/emails/analyze`, {
  headers: { "X-Session-Id": sessionId }
});
const { senders } = await analysis.json();

// 3. Delete
await fetch(`${API}/emails/delete`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
  body: JSON.stringify({ senderEmail: "newsletter@example.com" })
});
```
