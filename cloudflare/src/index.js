/**
 * Cloudflare Worker + D1 Backend for Bill Tribble Music Map
 * - Logs Star, Unstar, Track Download (MP3 / FLAC / Audio), and Track Request events in D1
 * - Sends instant email notifications on Track Star & Track Download (Resend API + Cloudflare Email Routing)
 *   with per-session & per-IP anti-spam deduplication
 * - Serves sanitized aggregate Hot List JSON (/api/hotlist) for billtribble.github.io/stats/
 */

const VALID_EVENT_TYPES = new Set(["star", "unstar", "download", "request"]);
const TRACK_ID_RE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const SESSION_HASH_RE = /^[a-f0-9]{12,64}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STAR_EMAIL_COOLDOWN_SEC = 12 * 3600;     // 12h per (session_hash, track_id) prevents ★/☆ toggle spam
const DOWNLOAD_EMAIL_COOLDOWN_SEC = 10 * 60;   // 10m per (session_hash, track_id, format) prevents double-click dupes
const REQUEST_EMAIL_COOLDOWN_SEC = 300;        // 5m per (session_hash, track_id, requester_email) prevents accidental double-submit
const IP_EMAIL_HOURLY_CAP = 15;                // Max 15 notification emails/hr per hashed IP
const IP_EVENTS_PER_MIN_CAP = 60;              // Max 60 event writes/min per hashed IP

let schemaInitialized = false;
const devOutbox = [];

function escHtml(val) {
  return String(val ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripCrLf(val, maxLen = 200) {
  return String(val ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, maxLen);
}

async function sha256Hex(input, hexLen = 24) {
  const bytes = new TextEncoder().encode(String(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const arr = Array.from(new Uint8Array(digest));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, hexLen);
}

function parseAllowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || "https://billtribble.github.io,https://billtribble.com,https://www.billtribble.com");
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function isOriginAllowed(origin, env) {
  if (!origin) return true;
  const allowed = parseAllowedOrigins(env);
  if (allowed.has(origin)) return true;
  if (env.ALLOW_LOCALHOST_ORIGIN === "1" || env.DEV_OUTBOX_ENABLED === "1") {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
      return true;
    }
  }
  return false;
}

function buildCorsHeaders(origin, env) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin, env)) {
    headers["Access-Control-Allow-Origin"] = origin;
  } else {
    headers["Access-Control-Allow-Origin"] = "https://billtribble.github.io";
  }
  return headers;
}

function jsonResponse(body, status = 200, corsHeaders = {}, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

async function ensureSchema(db) {
  if (schemaInitialized || !db) return;
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        era TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL CHECK (event_type IN ('star', 'unstar', 'download', 'request')),
        format TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        session_hash TEXT NOT NULL,
        ip_hash TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        referrer TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_created ON music_map_events(created_at DESC, id DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_track ON music_map_events(track_id, event_type)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_ip_window ON music_map_events(ip_hash, created_at DESC)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_track_stars (
        track_id TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        track_title TEXT NOT NULL,
        era TEXT NOT NULL DEFAULT '',
        starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (track_id, session_hash)
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_stars_track ON music_map_track_stars(track_id)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_track_totals (
        track_id TEXT PRIMARY KEY,
        track_title TEXT NOT NULL,
        era TEXT NOT NULL DEFAULT '',
        active_stars INTEGER NOT NULL DEFAULT 0,
        total_star_events INTEGER NOT NULL DEFAULT 0,
        total_downloads INTEGER NOT NULL DEFAULT 0,
        mp3_downloads INTEGER NOT NULL DEFAULT 0,
        flac_downloads INTEGER NOT NULL DEFAULT 0,
        total_requests INTEGER NOT NULL DEFAULT 0,
        last_starred_at TEXT,
        last_downloaded_at TEXT,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_email_dedup (
        dedup_key TEXT PRIMARY KEY,
        sent_at_epoch INTEGER NOT NULL,
        delivery_status TEXT NOT NULL DEFAULT ''
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_dedup_epoch ON music_map_email_dedup(sent_at_epoch)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_id TEXT NOT NULL,
        track_title TEXT NOT NULL,
        era TEXT NOT NULL DEFAULT '',
        requester_email TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        session_hash TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_requests_created ON music_map_requests(created_at DESC, id DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_requests_track ON music_map_requests(track_id, created_at DESC)`),
  ]);
  schemaInitialized = true;
}

function normalizeFormat(rawFormat, eventType) {
  const f = stripCrLf(rawFormat, 40).toLowerCase();
  if (!f) return eventType === "download" ? "audio" : "";
  if (f.includes("flac")) return "flac";
  if (f.includes("320")) return "mp3_320";
  if (f.includes("mp3")) return "mp3";
  if (f.includes("m4a") || f.includes("aac")) return "m4a";
  if (f.includes("wav")) return "wav";
  return f.replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "audio";
}

function formatHumanLabel(normFormat) {
  switch (normFormat) {
    case "mp3_320":
      return "MP3 (320 kbps)";
    case "mp3":
      return "MP3";
    case "flac":
      return "Lossless FLAC";
    case "m4a":
      return "M4A stream";
    case "wav":
      return "WAV";
    default:
      return normFormat ? normFormat.toUpperCase() : "Audio";
  }
}

function buildDeepLink(baseUrl, trackId) {
  const base = String(baseUrl || "https://billtribble.github.io/music-map/").replace(/\?.*$/, "");
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}?track=${encodeURIComponent(trackId)}`;
}

function buildNotificationEmail(ev, totals, env) {
  const deepLink = buildDeepLink(env.MUSIC_MAP_BASE_URL, ev.track_id);
  const statsUrl = "https://billtribble.github.io/stats/";
  const fmtLabel = formatHumanLabel(ev.format);
  const eraDisplay = ev.era || "Catalog";
  const countryDisplay = ev.country || "Unknown";
  const replyTo = ev.event_type === "request" ? stripCrLf(ev.requester_email || "", 254) : "";
  const noteDisplay = stripCrLf(ev.note || "", 500);

  let subject = "";
  let headline = "";
  const extraLines = [];

  if (ev.event_type === "star") {
    subject = `Starred on Music Map: ${ev.track_title}`;
    headline = `Someone starred "${ev.track_title}"`;
    extraLines.push("Event: Track Starred");
  } else if (ev.event_type === "download") {
    subject = `Downloaded on Music Map: ${ev.track_title} (${fmtLabel})`;
    headline = `Someone downloaded "${ev.track_title}"`;
    extraLines.push(`Format: ${fmtLabel}${ev.source ? ` (${ev.source})` : ""}`);
  } else {
    subject = `Track Request on Music Map: ${ev.track_title}`;
    headline = `Track requested: "${ev.track_title}"`;
    if (replyTo) extraLines.push(`Requester: ${replyTo}`);
    extraLines.push(`Note: ${noteDisplay || "(none)"}`);
  }

  subject = stripCrLf(subject, 160);
  const reqCount = Number(totals.total_requests || 0);
  const reqSummaryText = reqCount > 0 ? ` · ${reqCount} request${reqCount === 1 ? "" : "s"}` : "";

  const textLines = [
    headline,
    "",
    `Track: ${ev.track_title}`,
    `Era: ${eraDisplay}`,
    ...extraLines,
    `Cumulative totals: ${totals.active_stars} active star${totals.active_stars === 1 ? "" : "s"} · ${totals.total_downloads} download${totals.total_downloads === 1 ? "" : "s"}${reqSummaryText}`,
    `Location: ${countryDisplay}`,
    `Time (UTC): ${ev.created_at}`,
    "",
    `Open track on Music Map: ${deepLink}`,
    `View Hot List on Stats: ${statsUrl}`,
  ];
  const text = textLines.join("\n");

  const replyMailtoHref = replyTo
    ? `mailto:${encodeURIComponent(replyTo)}?subject=${encodeURIComponent(`Re: ${ev.track_title} (Bill Tribble Music Map)`)}`
    : "";

  const html = `<!doctype html>
<html>
<body style="margin:0;padding:24px;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f1f1f;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;">
    <div style="font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:#0b57d0;margin-bottom:8px;">
      Bill Tribble Music Map
    </div>
    <h2 style="margin:0 0 16px 0;font-size:20px;line-height:1.35;color:#1f1f1f;">
      ${escHtml(headline)}
    </h2>
    <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;line-height:1.6;margin-bottom:20px;">
      <tr><td style="padding:4px 0;color:#444746;width:130px;">Track</td><td style="padding:4px 0;font-weight:600;">${escHtml(ev.track_title)}</td></tr>
      <tr><td style="padding:4px 0;color:#444746;">Era</td><td style="padding:4px 0;">${escHtml(eraDisplay)}</td></tr>
      ${ev.event_type === "download" ? `<tr><td style="padding:4px 0;color:#444746;">Format</td><td style="padding:4px 0;font-weight:600;">${escHtml(fmtLabel)}</td></tr>` : ""}
      ${replyTo ? `<tr><td style="padding:4px 0;color:#444746;">Requester</td><td style="padding:4px 0;font-weight:600;"><a href="mailto:${escHtml(replyTo)}" style="color:#0b57d0;text-decoration:none;">${escHtml(replyTo)}</a></td></tr>` : ""}
      ${ev.event_type === "request" || noteDisplay ? `<tr><td style="padding:4px 0;color:#444746;">Note</td><td style="padding:4px 0;">${escHtml(noteDisplay || "—")}</td></tr>` : ""}
      <tr><td style="padding:4px 0;color:#444746;">Track totals</td><td style="padding:4px 0;font-weight:600;">${Number(totals.active_stars || 0)} star${totals.active_stars === 1 ? "" : "s"} &middot; ${Number(totals.total_downloads || 0)} download${totals.total_downloads === 1 ? "" : "s"}${reqCount > 0 ? ` &middot; ${reqCount} request${reqCount === 1 ? "" : "s"}` : ""}</td></tr>
      <tr><td style="padding:4px 0;color:#444746;">Country &middot; Time</td><td style="padding:4px 0;">${escHtml(countryDisplay)} &middot; ${escHtml(ev.created_at)}</td></tr>
    </table>
    <div style="margin-top:18px;">
      ${replyMailtoHref ? `<a href="${escHtml(replyMailtoHref)}" style="display:inline-block;padding:10px 18px;border-radius:9999px;background:#0b57d0;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;margin-right:8px;margin-bottom:8px;">Reply to requester</a>` : ""}
      <a href="${escHtml(deepLink)}" style="display:inline-block;padding:10px 18px;border-radius:9999px;background:${replyMailtoHref ? "#e8f0fe" : "#0b57d0"};color:${replyMailtoHref ? "#0b57d0" : "#ffffff"};text-decoration:none;font-size:14px;font-weight:600;margin-right:8px;margin-bottom:8px;">Open track on Music Map</a>
      <a href="${escHtml(statsUrl)}" style="display:inline-block;padding:10px 16px;border-radius:9999px;background:#e8f0fe;color:#0b57d0;text-decoration:none;font-size:14px;font-weight:600;margin-bottom:8px;">Open Stats Hot List</a>
    </div>
  </div>
</body>
</html>`;

  return { subject, text, html, deepLink, replyTo };
}

function utf8ToBase64(str) {
  return Buffer.from(String(str ?? ""), "utf8").toString("base64");
}

function encodeMimeSubject(subject) {
  const clean = stripCrLf(subject, 160);
  if (/^[\x20-\x7E]*$/.test(clean)) {
    return clean;
  }
  return `=?UTF-8?B?${utf8ToBase64(clean)}?=`;
}

function buildMimeMessage({ from, to, replyTo, subject, text, html }) {
  const boundary = `btmm_${crypto.randomUUID().replace(/-/g, "")}`;
  const msgId = `<${crypto.randomUUID()}@music-map.workers.dev>`;
  const dateHdr = new Date().toUTCString();
  const crlfText = text.replace(/\r?\n/g, "\r\n");
  const crlfHtml = html.replace(/\r?\n/g, "\r\n");
  const cleanReplyTo = stripCrLf(replyTo || "", 254);

  const headers = [
    `From: ${stripCrLf(from, 160)}`,
    `To: ${stripCrLf(to, 160)}`,
  ];
  if (cleanReplyTo && EMAIL_RE.test(cleanReplyTo) && !/[<>]/.test(cleanReplyTo)) {
    headers.push(`Reply-To: ${cleanReplyTo}`);
  }
  headers.push(
    `Subject: ${encodeMimeSubject(subject)}`,
    `Message-ID: ${msgId}`,
    `Date: ${dateHdr}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    crlfText,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    crlfHtml,
    ``,
    `--${boundary}--`,
    ``
  );

  return headers.join("\r\n");
}

function parseRecipients(raw) {
  return String(raw || "")
    .split(/[,;]+/)
    .map((s) => stripCrLf(s, 160))
    .filter((s) => s.includes("@"));
}

async function sendViaSmtps(mail, recipients, env) {
  const host = stripCrLf(env.SMTP_HOST, 120);
  const port = Number(env.SMTP_PORT || 465);
  const user = stripCrLf(env.SMTP_USER, 160);
  const pass = String(env.SMTP_PASS || "");
  if (!host || !user || !pass || !recipients.length) return null;

  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: host, port }, { secureTransport: "on", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";

  async function readCode() {
    while (true) {
      const lines = buf.split("\r\n");
      for (let i = 0; i < lines.length - 1; i++) {
        const ln = lines[i];
        if (/^\d{3} /.test(ln)) {
          buf = lines.slice(i + 1).join("\r\n");
          return parseInt(ln.slice(0, 3), 10);
        }
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP EOF");
      buf += dec.decode(value, { stream: true });
    }
  }

  async function cmd(line, expectedPrefix) {
    await writer.write(enc.encode(line + "\r\n"));
    const code = await readCode();
    if (Math.floor(code / 100) !== expectedPrefix) {
      throw new Error(`SMTP ${code}`);
    }
  }

  try {
    await readCode();
    await cmd("EHLO music-map.workers.dev", 2);
    await cmd("AUTH LOGIN", 3);
    await cmd(utf8ToBase64(user), 3);
    await cmd(utf8ToBase64(pass), 2);
    const fromAddr = user;
    await cmd(`MAIL FROM:<${fromAddr}>`, 2);
    for (const rcpt of recipients) {
      await cmd(`RCPT TO:<${rcpt}>`, 2);
    }
    await cmd("DATA", 3);
    const rawMime = buildMimeMessage({
      from: `Music Map <${fromAddr}>`,
      to: recipients.join(", "),
      replyTo: mail.replyTo,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    }).replace(/^\./gm, "..");
    await cmd(`${rawMime}\r\n.`, 2);
    await writer.write(enc.encode("QUIT\r\n"));
    return `smtps:sent:${recipients.length}`;
  } finally {
    try { await socket.close(); } catch (_) {}
  }
}

async function deliverEmailPayload(mail, env) {
  const recipients = parseRecipients(env.NOTIFY_TO_EMAIL);
  const statuses = [];
  let deliveredAll = false;

  if (env.RESEND_API_KEY && recipients.length) {
    const fromAddr = stripCrLf(env.NOTIFY_FROM_EMAIL || "Music Map <onboarding@resend.dev>", 160);
    const apiKey = String(env.RESEND_API_KEY).trim();
    const batchPayload = {
      from: fromAddr,
      to: recipients,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
    };
    const batchResp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(batchPayload),
    });
    if (batchResp.ok) {
      statuses.push(`resend:sent:${recipients.length}`);
      deliveredAll = true;
    } else if (recipients.length > 1) {
      // Fallback per-recipient in case onboarding@resend.dev only permits the verified signup address
      let okCount = 0;
      for (const rcpt of recipients) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromAddr,
            to: [rcpt],
            subject: mail.subject,
            text: mail.text,
            html: mail.html,
            ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
          }),
        });
        if (r.ok) okCount++;
      }
      if (okCount > 0) {
        statuses.push(`resend:partial:${okCount}/${recipients.length}`);
        if (okCount === recipients.length) deliveredAll = true;
      } else {
        statuses.push(`resend:err:${batchResp.status}`);
      }
    } else {
      statuses.push(`resend:err:${batchResp.status}`);
    }
  }

  if (!deliveredAll && env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && recipients.length) {
    try {
      const smtpRes = await sendViaSmtps(mail, recipients, env);
      if (smtpRes) {
        statuses.push(smtpRes);
        deliveredAll = true;
      }
    } catch (err) {
      statuses.push(`smtps:err:${String(err && err.message ? err.message : err).slice(0, 60)}`);
    }
  }

  if (!deliveredAll && env.EMAIL && typeof env.EMAIL.send === "function" && recipients.length) {
    try {
      const fromMailbox = stripCrLf(env.NOTIFY_FROM_EMAIL || `noreply@${env.EMAIL_DOMAIN || "billtribble.com"}`, 160);
      const cleanFrom = fromMailbox.replace(/^.*<|>$/g, "");
      const { EmailMessage } = await import("cloudflare:email");
      let cfSent = 0;
      for (const rcpt of recipients) {
        const rawMime = buildMimeMessage({
          from: `Music Map <${cleanFrom}>`,
          to: rcpt,
          replyTo: mail.replyTo,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        const message = new EmailMessage(cleanFrom, rcpt, rawMime);
        await env.EMAIL.send(message);
        cfSent++;
      }
      statuses.push(`cf_email:sent:${cfSent}`);
    } catch (err) {
      statuses.push(`cf_email:err:${String(err && err.message ? err.message : err).slice(0, 60)}`);
    }
  }

  if (!deliveredAll && env.WEB3FORMS_KEY) {
    const resp = await fetch("https://api.web3forms.com/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        access_key: String(env.WEB3FORMS_KEY).trim(),
        from_name: "Bill Tribble Music Map",
        subject: mail.subject,
        message: mail.text,
        ...(mail.replyTo ? { email: mail.replyTo, replyto: mail.replyTo } : {}),
        botcheck: "",
      }),
    });
    const wj = await resp.json().catch(() => ({}));
    if (resp.ok && wj && wj.success !== false) {
      statuses.push("web3forms:sent:1");
      deliveredAll = true;
    } else {
      statuses.push(`web3forms:err:${resp.status}`);
    }
  }

  if (env.DEV_OUTBOX_ENABLED === "1" && env.SIMULATE_NO_TRANSPORT !== "1") {
    statuses.push(`dev_outbox:captured:${recipients.length}`);
  }

  return statuses.length ? statuses.join(",") : "no_transport_configured";
}

function isSuccessfulDelivery(deliveryStatus) {
  return /(^|,)(resend:sent:|resend:partial:|smtps:sent:|cf_email:sent:|web3forms:sent:|dev_outbox:captured:)/.test(
    String(deliveryStatus || "")
  );
}

async function maybeSendNotification(ev, totals, wasNewlyStarred, env) {
  if (ev.event_type === "unstar") return;
  if (ev.event_type === "star" && !wasNewlyStarred) return;

  const nowEpoch = Math.floor(Date.now() / 1000);
  let dedupKey = "";
  let cooldownSec = 0;

  if (ev.event_type === "star") {
    dedupKey = `star:${ev.session_hash}:${ev.track_id}`;
    cooldownSec = STAR_EMAIL_COOLDOWN_SEC;
  } else if (ev.event_type === "download") {
    dedupKey = `download:${ev.session_hash}:${ev.track_id}:${ev.format || "audio"}`;
    cooldownSec = DOWNLOAD_EMAIL_COOLDOWN_SEC;
  } else if (ev.event_type === "request") {
    dedupKey = `req_v2:${ev.session_hash}:${ev.track_id}:${ev.requester_email || ""}`;
    cooldownSec = REQUEST_EMAIL_COOLDOWN_SEC;
  } else {
    return;
  }

  // Prune stale dedup entries older than 48h opportunistically
  await env.DB.prepare(`DELETE FROM music_map_email_dedup WHERE sent_at_epoch < ?`)
    .bind(nowEpoch - 48 * 3600)
    .run();

  const existing = await env.DB.prepare(
    `SELECT sent_at_epoch FROM music_map_email_dedup WHERE dedup_key = ?`
  )
    .bind(dedupKey)
    .first();

  if (existing && nowEpoch - Number(existing.sent_at_epoch || 0) < cooldownSec) {
    if (env.DEV_OUTBOX_ENABLED === "1") {
      devOutbox.push({
        suppressed: true,
        reason: "session_dedup_cooldown",
        event_type: ev.event_type,
        track_id: ev.track_id,
        track_title: ev.track_title,
        format: ev.format,
        created_at: ev.created_at,
      });
    }
    return;
  }

  // Per-IP hourly cap check (read-only before send; incremented strictly after confirmed delivery)
  let ipHourBucket = "";
  let ipSentCount = 0;
  if (ev.ip_hash) {
    ipHourBucket = `ipcap:${ev.ip_hash}:${Math.floor(nowEpoch / 3600)}`;
    const ipRow = await env.DB.prepare(
      `SELECT delivery_status FROM music_map_email_dedup WHERE dedup_key = ?`
    )
      .bind(ipHourBucket)
      .first();
    ipSentCount = ipRow ? Number(ipRow.delivery_status || 0) : 0;
    if (ipSentCount >= IP_EMAIL_HOURLY_CAP) {
      return;
    }
  }

  const mail = buildNotificationEmail(ev, totals, env);
  const deliveryStatus = await deliverEmailPayload(mail, env);
  const didDeliver = isSuccessfulDelivery(deliveryStatus);

  // Only persist cooldown & increment IP cap when an email was actually delivered
  if (didDeliver) {
    if (ipHourBucket) {
      await env.DB.prepare(
        `INSERT INTO music_map_email_dedup (dedup_key, sent_at_epoch, delivery_status)
         VALUES (?, ?, ?)
         ON CONFLICT(dedup_key) DO UPDATE SET sent_at_epoch = excluded.sent_at_epoch, delivery_status = excluded.delivery_status`
      )
        .bind(ipHourBucket, nowEpoch, String(ipSentCount + 1))
        .run();
    }
    await env.DB.prepare(
      `INSERT INTO music_map_email_dedup (dedup_key, sent_at_epoch, delivery_status)
       VALUES (?, ?, ?)
       ON CONFLICT(dedup_key) DO UPDATE SET sent_at_epoch = excluded.sent_at_epoch, delivery_status = excluded.delivery_status`
    )
      .bind(dedupKey, nowEpoch, deliveryStatus)
      .run();
  }

  if (env.DEV_OUTBOX_ENABLED === "1") {
    devOutbox.push({
      suppressed: false,
      did_deliver: didDeliver,
      delivery_status: deliveryStatus,
      to_configured: Boolean(env.NOTIFY_TO_EMAIL),
      reply_to: mail.replyTo || "",
      subject: mail.subject,
      mime_subject: encodeMimeSubject(mail.subject),
      deep_link: mail.deepLink,
      event_type: ev.event_type,
      track_id: ev.track_id,
      track_title: ev.track_title,
      era: ev.era,
      format: ev.format,
      requester_email: ev.requester_email || "",
      note: ev.note || "",
      active_stars: Number(totals.active_stars || 0),
      total_downloads: Number(totals.total_downloads || 0),
      total_requests: Number(totals.total_requests || 0),
      text: mail.text,
      html: mail.html,
      created_at: ev.created_at,
    });
    if (devOutbox.length > 100) devOutbox.shift();
  }
}

async function handlePostEvent(request, env, ctx, corsHeaders) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 8192) {
    return jsonResponse({ ok: false, error: "Payload too large" }, 413, corsHeaders);
  }

  let body;
  try {
    const rawText = await request.text();
    if (rawText.length > 8192) {
      return jsonResponse({ ok: false, error: "Payload too large" }, 413, corsHeaders);
    }
    body = JSON.parse(rawText);
  } catch (_) {
    return jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const trackId = stripCrLf(body.track_id, 120);
  const trackTitle = stripCrLf(body.track_title, 200) || trackId;
  const era = stripCrLf(body.era, 120);
  const eventType = stripCrLf(body.event_type, 24).toLowerCase();
  const source = stripCrLf(body.source, 64);
  const rawNote = stripCrLf(body.note, 500);
  const requesterEmail = stripCrLf(body.requester_email || body.email || "", 254).toLowerCase();
  const clientReferrer = stripCrLf(body.referrer || request.headers.get("referer") || "", 240);

  if (!trackId || !TRACK_ID_RE.test(trackId)) {
    return jsonResponse({ ok: false, error: "Invalid track_id" }, 400, corsHeaders);
  }
  if (!VALID_EVENT_TYPES.has(eventType)) {
    return jsonResponse({ ok: false, error: "Invalid event_type" }, 400, corsHeaders);
  }
  if (eventType === "request") {
    if (!requesterEmail || !EMAIL_RE.test(requesterEmail) || /[<>]/.test(requesterEmail)) {
      return jsonResponse({ ok: false, error: "Please enter a valid email address." }, 400, corsHeaders);
    }
  }

  const format = normalizeFormat(body.format, eventType);
  const publicEventNote = eventType === "request" ? "" : rawNote.slice(0, 360);

  const ipRaw = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const salt = String(env.IP_HASH_SALT || "btmm-d1-default-salt-v1");
  const ipHash = await sha256Hex(`${salt}:ip:${ipRaw}`, 20);

  let sessionHash = stripCrLf(body.session_hash, 64).toLowerCase();
  if (!SESSION_HASH_RE.test(sessionHash)) {
    const ua = request.headers.get("user-agent") || "";
    sessionHash = await sha256Hex(`${salt}:sess:${ipRaw}:${ua}`, 24);
  }

  const cfCountry = stripCrLf(
    (request.cf && request.cf.country) || request.headers.get("cf-ipcountry") || "",
    8
  ).toUpperCase();
  const country = cfCountry && cfCountry !== "XX" ? cfCountry : "";

  const nowDate = new Date();
  const nowIso = nowDate.toISOString().replace(/\.\d{3}Z$/, "Z");
  const oneMinAgoIso = new Date(nowDate.getTime() - 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const rateRow = await env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM music_map_events WHERE ip_hash = ? AND created_at >= ?`
  )
    .bind(ipHash, oneMinAgoIso)
    .first();
  if (Number((rateRow && rateRow.cnt) || 0) >= IP_EVENTS_PER_MIN_CAP) {
    return jsonResponse({ ok: false, error: "Rate limit exceeded" }, 429, corsHeaders);
  }

  // Ensure track totals row exists
  await env.DB.prepare(
    `INSERT INTO music_map_track_totals (track_id, track_title, era, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(track_id) DO UPDATE SET
       track_title = excluded.track_title,
       era = CASE WHEN excluded.era != '' THEN excluded.era ELSE music_map_track_totals.era END,
       updated_at = excluded.updated_at`
  )
    .bind(trackId, trackTitle, era, nowIso)
    .run();

  let wasNewlyStarred = false;

  if (eventType === "star") {
    const insRes = await env.DB.prepare(
      `INSERT OR IGNORE INTO music_map_track_stars (track_id, session_hash, track_title, era, starred_at)
       VALUES (?, ?, ?, ?, ?)`
    )
      .bind(trackId, sessionHash, trackTitle, era, nowIso)
      .run();
    wasNewlyStarred = Boolean(insRes && insRes.meta && Number(insRes.meta.changes) > 0);

    await env.DB.prepare(
      `UPDATE music_map_track_totals
       SET active_stars = (SELECT COUNT(*) FROM music_map_track_stars WHERE track_id = ?),
           total_star_events = total_star_events + ?,
           last_starred_at = ?,
           updated_at = ?
       WHERE track_id = ?`
    )
      .bind(trackId, wasNewlyStarred ? 1 : 0, nowIso, nowIso, trackId)
      .run();
  } else if (eventType === "unstar") {
    await env.DB.prepare(
      `DELETE FROM music_map_track_stars WHERE track_id = ? AND session_hash = ?`
    )
      .bind(trackId, sessionHash)
      .run();

    await env.DB.prepare(
      `UPDATE music_map_track_totals
       SET active_stars = (SELECT COUNT(*) FROM music_map_track_stars WHERE track_id = ?),
           updated_at = ?
       WHERE track_id = ?`
    )
      .bind(trackId, nowIso, trackId)
      .run();
  } else if (eventType === "download") {
    const isFlac = format === "flac" ? 1 : 0;
    const isMp3 = format === "mp3" || format === "mp3_320" ? 1 : 0;
    await env.DB.prepare(
      `UPDATE music_map_track_totals
       SET total_downloads = total_downloads + 1,
           mp3_downloads = mp3_downloads + ?,
           flac_downloads = flac_downloads + ?,
           last_downloaded_at = ?,
           updated_at = ?
       WHERE track_id = ?`
    )
      .bind(isMp3, isFlac, nowIso, nowIso, trackId)
      .run();
  } else if (eventType === "request") {
    await env.DB.prepare(
      `INSERT INTO music_map_requests
         (track_id, track_title, era, requester_email, note, session_hash, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(trackId, trackTitle, era, requesterEmail, rawNote, sessionHash, country, nowIso)
      .run();

    await env.DB.prepare(
      `UPDATE music_map_track_totals
       SET total_requests = total_requests + 1,
           updated_at = ?
       WHERE track_id = ?`
    )
      .bind(nowIso, trackId)
      .run();
  }

  await env.DB.prepare(
    `INSERT INTO music_map_events
       (track_id, track_title, era, event_type, format, source, session_hash, ip_hash, country, referrer, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      trackId,
      trackTitle,
      era,
      eventType,
      format,
      source,
      sessionHash,
      ipHash,
      country,
      clientReferrer,
      publicEventNote,
      nowIso
    )
    .run();

  const totals = (await env.DB.prepare(
    `SELECT active_stars, total_star_events, total_downloads, mp3_downloads, flac_downloads, total_requests
     FROM music_map_track_totals
     WHERE track_id = ?`
  )
    .bind(trackId)
    .first()) || {
    active_stars: 0,
    total_star_events: 0,
    total_downloads: 0,
    mp3_downloads: 0,
    flac_downloads: 0,
    total_requests: 0,
  };

  const eventRecord = {
    track_id: trackId,
    track_title: trackTitle,
    era,
    event_type: eventType,
    format,
    source,
    session_hash: sessionHash,
    ip_hash: ipHash,
    country,
    requester_email: requesterEmail,
    note: rawNote,
    created_at: nowIso,
  };

  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      maybeSendNotification(eventRecord, totals, wasNewlyStarred, env).catch(() => {})
    );
  } else {
    await maybeSendNotification(eventRecord, totals, wasNewlyStarred, env).catch(() => {});
  }

  return jsonResponse(
    {
      ok: true,
      track_id: trackId,
      event_type: eventType,
      active_stars: Number(totals.active_stars || 0),
      total_downloads: Number(totals.total_downloads || 0),
      mp3_downloads: Number(totals.mp3_downloads || 0),
      flac_downloads: Number(totals.flac_downloads || 0),
      total_requests: Number(totals.total_requests || 0),
    },
    200,
    corsHeaders
  );
}

function rangeToSinceIso(rangeKey) {
  const nowMs = Date.now();
  switch (rangeKey) {
    case "today":
      return new Date(nowMs - 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    case "7d":
      return new Date(nowMs - 7 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    case "30d":
      return new Date(nowMs - 30 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    case "90d":
      return new Date(nowMs - 90 * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    default:
      return "1970-01-01T00:00:00Z";
  }
}

async function handleGetHotlist(url, env, corsHeaders) {
  const rangeKey = (url.searchParams.get("range") || "all").toLowerCase();
  const rawLimit = parseInt(url.searchParams.get("limit") || "25", 10);
  const limit = Math.max(1, Math.min(50, Number.isFinite(rawLimit) ? rawLimit : 25));
  const sinceIso = rangeToSinceIso(rangeKey);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const [aggTotals, windowAgg, uniqueRow, topRows, recentRows] = await Promise.all([
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(active_stars), 0) AS active_stars,
         COALESCE(SUM(total_star_events), 0) AS total_star_events,
         COALESCE(SUM(total_downloads), 0) AS total_downloads,
         COALESCE(SUM(mp3_downloads), 0) AS mp3_downloads,
         COALESCE(SUM(flac_downloads), 0) AS flac_downloads,
         COALESCE(SUM(total_requests), 0) AS total_requests
       FROM music_map_track_totals`
    ).first(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM music_map_track_stars WHERE starred_at >= ?) AS window_stars,
         COALESCE(SUM(CASE WHEN event_type = 'download' THEN 1 ELSE 0 END), 0) AS window_downloads,
         COALESCE(SUM(CASE WHEN event_type = 'request' THEN 1 ELSE 0 END), 0) AS window_requests
       FROM music_map_events
       WHERE created_at >= ?`
    )
      .bind(sinceIso, sinceIso)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_hash) AS unique_visitors FROM music_map_events`
    ).first(),
    env.DB.prepare(
      `SELECT
         t.track_id,
         t.track_title,
         t.era,
         t.active_stars,
         t.total_downloads,
         t.mp3_downloads,
         t.flac_downloads,
         t.total_requests,
         t.last_starred_at,
         t.last_downloaded_at,
         t.updated_at,
         COALESCE((SELECT COUNT(*) FROM music_map_track_stars s WHERE s.track_id = t.track_id AND s.starred_at >= ?), 0) AS window_stars,
         COALESCE((SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = t.track_id AND e.event_type = 'download' AND e.created_at >= ?), 0) AS window_downloads
       FROM music_map_track_totals t
       WHERE (t.active_stars > 0 OR t.total_downloads > 0 OR t.total_requests > 0)
       ORDER BY (t.active_stars * 2 + t.total_downloads + t.total_requests) DESC,
                t.active_stars DESC,
                t.total_downloads DESC,
                t.updated_at DESC
       LIMIT ?`
    )
      .bind(sinceIso, sinceIso, limit)
      .all(),
    env.DB.prepare(
      `SELECT id, event_type, track_id, track_title, era, format, source, country, created_at
       FROM music_map_events
       WHERE event_type IN ('star', 'download', 'request')
       ORDER BY id DESC
       LIMIT 30`
    ).all(),
  ]);

  const topTracks = ((topRows && topRows.results) || []).map((r) => ({
    track_id: r.track_id,
    track_title: r.track_title,
    era: r.era || "",
    active_stars: Number(r.active_stars || 0),
    total_downloads: Number(r.total_downloads || 0),
    mp3_downloads: Number(r.mp3_downloads || 0),
    flac_downloads: Number(r.flac_downloads || 0),
    total_requests: Number(r.total_requests || 0),
    window_stars: Number(r.window_stars || 0),
    window_downloads: Number(r.window_downloads || 0),
    last_starred_at: r.last_starred_at || null,
    last_downloaded_at: r.last_downloaded_at || null,
    updated_at: r.updated_at || null,
    url: buildDeepLink(env.MUSIC_MAP_BASE_URL, r.track_id),
  }));

  const recentEvents = ((recentRows && recentRows.results) || []).map((e) => ({
    id: Number(e.id),
    event_type: e.event_type,
    track_id: e.track_id,
    track_title: e.track_title,
    era: e.era || "",
    format: e.format || "",
    format_label: e.event_type === "download" ? formatHumanLabel(e.format) : "",
    source: e.source || "",
    country: e.country || "",
    created_at: e.created_at,
    url: buildDeepLink(env.MUSIC_MAP_BASE_URL, e.track_id),
  }));

  return jsonResponse(
    {
      ok: true,
      generated_at: generatedAt,
      range: rangeKey,
      summary: {
        active_stars: Number((aggTotals && aggTotals.active_stars) || 0),
        total_star_events: Number((aggTotals && aggTotals.total_star_events) || 0),
        total_downloads: Number((aggTotals && aggTotals.total_downloads) || 0),
        mp3_downloads: Number((aggTotals && aggTotals.mp3_downloads) || 0),
        flac_downloads: Number((aggTotals && aggTotals.flac_downloads) || 0),
        total_requests: Number((aggTotals && aggTotals.total_requests) || 0),
        unique_visitors: Number((uniqueRow && uniqueRow.unique_visitors) || 0),
        window_stars: Number((windowAgg && windowAgg.window_stars) || 0),
        window_downloads: Number((windowAgg && windowAgg.window_downloads) || 0),
        window_requests: Number((windowAgg && windowAgg.window_requests) || 0),
      },
      top_tracks: topTracks,
      recent_events: recentEvents,
    },
    200,
    corsHeaders
  );
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";
    const corsHeaders = buildCorsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      if (origin && !isOriginAllowed(origin, env)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (origin && !isOriginAllowed(origin, env)) {
      return jsonResponse({ ok: false, error: "Forbidden origin" }, 403, corsHeaders);
    }

    if (url.pathname === "/api/health" || url.pathname === "/") {
      return jsonResponse({ ok: true, service: "music-map-events" }, 200, corsHeaders);
    }

    if (url.pathname === "/api/dev/outbox") {
      if (env.DEV_OUTBOX_ENABLED !== "1") {
        return jsonResponse({ ok: false, error: "Not found" }, 404, corsHeaders);
      }
      if (request.method === "DELETE") {
        devOutbox.length = 0;
        return jsonResponse({ ok: true, cleared: true }, 200, corsHeaders);
      }
      return jsonResponse({ ok: true, count: devOutbox.length, items: devOutbox }, 200, corsHeaders);
    }

    try {
      await ensureSchema(env.DB);
    } catch (err) {
      return jsonResponse(
        { ok: false, error: "Database initialization error", detail: String(err && err.message ? err.message : err) },
        500,
        corsHeaders
      );
    }

    if (url.pathname === "/api/events" && request.method === "POST") {
      return handlePostEvent(request, env, ctx, corsHeaders);
    }

    if (url.pathname === "/api/hotlist" && request.method === "GET") {
      return handleGetHotlist(url, env, corsHeaders);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404, corsHeaders);
  },
};
