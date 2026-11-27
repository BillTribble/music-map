/**
 * Cloudflare Worker + D1 Backend for Bill Tribble Music Map
 * - Logs Star, Unstar, Track Download (MP3 / FLAC / Audio), Qualified Play (manual vs autoplay + listened_sec),
 *   and Track Request events in D1
 * - Sends instant email notifications strictly on Track Star, Track Download, & Track Request (NEVER on Plays)
 *   with per-session & per-IP anti-spam deduplication
 * - Serves cached weighted Popularity Score (/api/popular) and aggregate Hot List (/api/hotlist)
 */

const VALID_EVENT_TYPES = new Set(["star", "unstar", "download", "request", "play", "play_end"]);
const VALID_PLAY_SOURCES = new Set(["manual", "autoplay"]);
const VALID_RANGES = new Set(["today", "7d", "30d", "90d", "all"]);
const TRACK_ID_RE = /^[a-zA-Z0-9_.:-]{1,120}$/;
const SESSION_HASH_RE = /^[a-f0-9]{12,64}$/i;
const VISITOR_SEED_RE = /^[a-zA-Z0-9_.:-]{16,128}$/;
const PLAY_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STAR_EMAIL_COOLDOWN_SEC = 12 * 3600;     // 12h per (session_hash, track_id) prevents ★/☆ toggle spam
const DOWNLOAD_EMAIL_COOLDOWN_SEC = 10 * 60;   // 10m per (session_hash, track_id, format) prevents double-click dupes
const REQUEST_EMAIL_COOLDOWN_SEC = 300;        // 5m per (session_hash, track_id, requester_email) prevents accidental double-submit
const IP_EMAIL_HOURLY_CAP = 15;                // Max 15 notification emails/hr per hashed IP
const IP_EVENTS_PER_MIN_CAP = 90;              // Max 90 event writes/min per hashed IP
const POPULAR_CACHE_TTL_MS = 15 * 1000;        // 15s edge/isolate cache for /api/popular (cleared on write)

let schemaInitialized = false;
const devOutbox = [];
const popularCache = new Map();

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

function fnv1aHex(str, seedInit) {
  let h = seedInit >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function fallbackHash24(input) {
  return (
    fnv1aHex(input, 0x811c9dc5) +
    fnv1aHex("a:" + input, 0x9e3779b9) +
    fnv1aHex("b:" + input, 0x85ebca6b)
  ).slice(0, 24);
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
        event_type TEXT NOT NULL CHECK (event_type IN ('star', 'unstar', 'download', 'request', 'play')),
        format TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        play_id TEXT NOT NULL DEFAULT '',
        listened_sec REAL NOT NULL DEFAULT 0,
        session_hash TEXT NOT NULL,
        is_owner INTEGER NOT NULL DEFAULT 0,
        ip_hash TEXT NOT NULL DEFAULT '',
        country TEXT NOT NULL DEFAULT '',
        referrer TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_owner_sessions (
        session_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_track_stars (
        track_id TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        track_title TEXT NOT NULL,
        era TEXT NOT NULL DEFAULT '',
        is_owner INTEGER NOT NULL DEFAULT 0,
        starred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        PRIMARY KEY (track_id, session_hash)
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_stars_track ON music_map_track_stars(track_id)`),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS music_map_track_listeners (
        track_id TEXT NOT NULL,
        session_hash TEXT NOT NULL,
        first_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_played_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        play_count INTEGER NOT NULL DEFAULT 1,
        is_owner INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (track_id, session_hash)
      )
    `),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_listeners_track ON music_map_track_listeners(track_id)`),
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
        total_plays INTEGER NOT NULL DEFAULT 0,
        manual_plays INTEGER NOT NULL DEFAULT 0,
        autoplay_plays INTEGER NOT NULL DEFAULT 0,
        unique_listeners INTEGER NOT NULL DEFAULT 0,
        total_listen_sec REAL NOT NULL DEFAULT 0,
        last_starred_at TEXT,
        last_downloaded_at TEXT,
        last_played_at TEXT,
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

  // Self-heal any legacy v1/v3 tables missing 'play' CHECK, play rollups, or 'is_owner' partitioning
  const ddlRows = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('music_map_events', 'music_map_track_totals', 'music_map_track_stars', 'music_map_track_listeners')`
    )
    .all();
  const ddlByName = new Map(((ddlRows && ddlRows.results) || []).map((r) => [r.name, String(r.sql || "")]));

  const eventsDdl = ddlByName.get("music_map_events") || "";
  if (eventsDdl && (!eventsDdl.includes("'play'") || !eventsDdl.includes("listened_sec") || !eventsDdl.includes("play_id"))) {
    await db.batch([
      db.prepare(`DROP TABLE IF EXISTS music_map_events_v2`),
      db.prepare(`
        CREATE TABLE music_map_events_v2 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          track_id TEXT NOT NULL,
          track_title TEXT NOT NULL,
          era TEXT NOT NULL DEFAULT '',
          event_type TEXT NOT NULL CHECK (event_type IN ('star', 'unstar', 'download', 'request', 'play')),
          format TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT '',
          play_id TEXT NOT NULL DEFAULT '',
          listened_sec REAL NOT NULL DEFAULT 0,
          session_hash TEXT NOT NULL,
          ip_hash TEXT NOT NULL DEFAULT '',
          country TEXT NOT NULL DEFAULT '',
          referrer TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `),
      db.prepare(`
        INSERT INTO music_map_events_v2 (
          id, track_id, track_title, era, event_type, format, source,
          session_hash, ip_hash, country, referrer, note, created_at
        )
        SELECT
          id, track_id, track_title, era, event_type, format, source,
          session_hash, ip_hash, country, referrer, note, created_at
        FROM music_map_events
      `),
      db.prepare(`DROP TABLE music_map_events`),
      db.prepare(`ALTER TABLE music_map_events_v2 RENAME TO music_map_events`),
    ]);
  }

  const totalsDdl = ddlByName.get("music_map_track_totals") || "";
  if (totalsDdl && !totalsDdl.includes("total_plays")) {
    const alterStmts = [
      ["total_plays", "ALTER TABLE music_map_track_totals ADD COLUMN total_plays INTEGER NOT NULL DEFAULT 0"],
      ["manual_plays", "ALTER TABLE music_map_track_totals ADD COLUMN manual_plays INTEGER NOT NULL DEFAULT 0"],
      ["autoplay_plays", "ALTER TABLE music_map_track_totals ADD COLUMN autoplay_plays INTEGER NOT NULL DEFAULT 0"],
      ["unique_listeners", "ALTER TABLE music_map_track_totals ADD COLUMN unique_listeners INTEGER NOT NULL DEFAULT 0"],
      ["total_listen_sec", "ALTER TABLE music_map_track_totals ADD COLUMN total_listen_sec REAL NOT NULL DEFAULT 0"],
      ["last_played_at", "ALTER TABLE music_map_track_totals ADD COLUMN last_played_at TEXT"],
    ]
      .filter(([col]) => !totalsDdl.includes(col))
      .map(([, sql]) => db.prepare(sql));
    if (alterStmts.length) {
      await db.batch(alterStmts);
    }
  }

  const ownerColAlters = [];
  const postMigrateDdlRows = await db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('music_map_events', 'music_map_track_stars', 'music_map_track_listeners')`
    )
    .all();
  const postDdlByName = new Map(
    ((postMigrateDdlRows && postMigrateDdlRows.results) || []).map((r) => [r.name, String(r.sql || "")])
  );
  for (const tbl of ["music_map_events", "music_map_track_stars", "music_map_track_listeners"]) {
    const sqlText = postDdlByName.get(tbl) || "";
    if (sqlText && !sqlText.includes("is_owner")) {
      ownerColAlters.push(db.prepare(`ALTER TABLE ${tbl} ADD COLUMN is_owner INTEGER NOT NULL DEFAULT 0`));
    }
  }
  if (ownerColAlters.length) {
    await db.batch(ownerColAlters);
  }

  await db.batch([
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_created ON music_map_events(created_at DESC, id DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_track ON music_map_events(track_id, event_type)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_ip_window ON music_map_events(ip_hash, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_play_lookup ON music_map_events(track_id, session_hash, play_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_session ON music_map_events(session_hash)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_events_owner_created ON music_map_events(is_owner, created_at DESC, id DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_stars_track_owner ON music_map_track_stars(track_id, is_owner)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_mm_listeners_track_owner ON music_map_track_listeners(track_id, is_owner)`),
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

  return {
    subject,
    headline,
    text,
    html,
    deepLink,
    statsUrl,
    replyTo,
    replyMailtoHref,
    meta: {
      event_type: ev.event_type,
      track_id: ev.track_id,
      track_title: ev.track_title,
      era: eraDisplay,
      format_label: ev.event_type === "download" ? fmtLabel : "",
      source: ev.source || "",
      requester_email: replyTo,
      note: noteDisplay,
      country: countryDisplay,
      created_at: ev.created_at,
      active_stars: Number(totals.active_stars || 0),
      total_downloads: Number(totals.total_downloads || 0),
      total_requests: Math.max(reqCount, ev.event_type === "request" ? 1 : 0),
    },
  };
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

  if (!deliveredAll && env.GITHUB_DISPATCH_TOKEN) {
    const ghRepo = stripCrLf(
      env.GITHUB_DISPATCH_REPO || "BillTribble/music-map-notifications",
      140
    );
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(ghRepo)) {
      const apiBase = stripCrLf(
        env.GITHUB_API_BASE_URL || "https://api.github.com",
        200
      ).replace(/\/+$/, "");
      try {
        const ghResp = await fetch(`${apiBase}/repos/${ghRepo}/dispatches`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${String(env.GITHUB_DISPATCH_TOKEN).trim()}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "music-map-events-worker/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({
            event_type: "music_map_alert",
            client_payload: {
              alert: {
                subject: mail.subject,
                headline: mail.headline || mail.subject,
                deep_link: mail.deepLink,
                stats_url: mail.statsUrl || "https://billtribble.github.io/stats/",
                reply_to: mail.replyTo || "",
                reply_mailto: mail.replyMailtoHref || "",
                ...(mail.meta || {}),
              },
            },
          }),
        });
        if (ghResp.status === 204 || ghResp.ok) {
          statuses.push("github_dispatch:sent:1");
          deliveredAll = true;
        } else {
          statuses.push(`github_dispatch:err:${ghResp.status}`);
        }
      } catch (err) {
        statuses.push(
          `github_dispatch:err:${String(err && err.message ? err.message : err).slice(0, 50)}`
        );
      }
    } else {
      statuses.push("github_dispatch:err:bad_repo");
    }
  }

  if (env.DEV_OUTBOX_ENABLED === "1" && env.SIMULATE_NO_TRANSPORT !== "1") {
    statuses.push(`dev_outbox:captured:${recipients.length}`);
  }

  return statuses.length ? statuses.join(",") : "no_transport_configured";
}

function isSuccessfulDelivery(deliveryStatus) {
  return /(^|,)(resend:sent:|resend:partial:|smtps:sent:|cf_email:sent:|web3forms:sent:|github_dispatch:sent:|dev_outbox:captured:)/.test(
    String(deliveryStatus || "")
  );
}

async function maybeSendNotification(ev, totals, wasNewlyStarred, env) {
  // Strictly NEVER send email notifications on play, play_end, or unstar events
  if (ev.event_type === "unstar" || ev.event_type === "play" || ev.event_type === "play_end") return;
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

  const isPlayFamily = eventType === "play" || eventType === "play_end";
  const publicEventNote = eventType === "request" ? "" : rawNote.slice(0, 360);
  let playSource = "";
  let playId = "";
  let listenedSec = 0;

  if (isPlayFamily) {
    const rawSourceLower = source.toLowerCase();
    if (rawSourceLower && !VALID_PLAY_SOURCES.has(rawSourceLower)) {
      return jsonResponse({ ok: false, error: "Invalid play source" }, 400, corsHeaders);
    }
    playSource = rawSourceLower === "autoplay" ? "autoplay" : "manual";
    const rawPlayId = stripCrLf(body.play_id, 64);
    if (rawPlayId && PLAY_ID_RE.test(rawPlayId)) {
      playId = rawPlayId;
    }
    const rawListen = Number(body.listened_sec);
    listenedSec = Number.isFinite(rawListen)
      ? Math.round(Math.max(0, Math.min(3600, rawListen)) * 100) / 100
      : 0;
  }

  const format = isPlayFamily ? "" : normalizeFormat(body.format, eventType);

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

  const enrolledOwnerRow = await env.DB.prepare(
    `SELECT 1 AS ok FROM music_map_owner_sessions WHERE session_hash = ? LIMIT 1`
  )
    .bind(sessionHash)
    .first();
  const isOwnerRow = Boolean(body.is_owner) || Boolean(enrolledOwnerRow) ? 1 : 0;

  // Handle play completion delta (or idempotent same-play_id update) without double-counting plays
  if (isPlayFamily) {
    let existingPlay = null;
    if (playId) {
      existingPlay = await env.DB.prepare(
        `SELECT id, listened_sec, is_owner FROM music_map_events
         WHERE track_id = ? AND session_hash = ? AND play_id = ? AND event_type = 'play'
         ORDER BY id DESC LIMIT 1`
      )
        .bind(trackId, sessionHash, playId)
        .first();
    }

    if (existingPlay) {
      const prevSec = Number(existingPlay.listened_sec || 0);
      const nextSec = Math.max(prevSec, listenedSec);
      const deltaSec = Math.round(Math.max(0, nextSec - prevSec) * 100) / 100;
      const effectiveOwner = Number(existingPlay.is_owner || 0) === 1 || isOwnerRow === 1 ? 1 : 0;
      if (deltaSec > 0) {
        const deltaStmts = [
          env.DB.prepare(`UPDATE music_map_events SET listened_sec = ?, is_owner = ? WHERE id = ?`).bind(
            nextSec,
            effectiveOwner,
            existingPlay.id
          ),
          env.DB.prepare(
            `UPDATE music_map_track_listeners
             SET last_played_at = ?, is_owner = MAX(is_owner, ?)
             WHERE track_id = ? AND session_hash = ?`
          ).bind(nowIso, effectiveOwner, trackId, sessionHash),
        ];
        if (effectiveOwner === 0) {
          deltaStmts.push(
            env.DB.prepare(
              `UPDATE music_map_track_totals
               SET total_listen_sec = ROUND(total_listen_sec + ?, 2),
                   updated_at = ?
               WHERE track_id = ?`
            ).bind(deltaSec, nowIso, trackId)
          );
        }
        await env.DB.batch(deltaStmts);
        popularCache.clear();
      }
      const curTotals = (await env.DB.prepare(
        `SELECT active_stars, total_downloads, mp3_downloads, flac_downloads, total_requests,
                total_plays, manual_plays, autoplay_plays, unique_listeners, total_listen_sec
         FROM music_map_track_totals WHERE track_id = ?`
      )
        .bind(trackId)
        .first()) || {};
      return jsonResponse(
        {
          ok: true,
          track_id: trackId,
          event_type: eventType,
          is_owner: Boolean(effectiveOwner),
          play_updated: true,
          listened_sec: nextSec,
          active_stars: Number(curTotals.active_stars || 0),
          total_downloads: Number(curTotals.total_downloads || 0),
          total_plays: Number(curTotals.total_plays || 0),
          manual_plays: Number(curTotals.manual_plays || 0),
          autoplay_plays: Number(curTotals.autoplay_plays || 0),
          unique_listeners: Number(curTotals.unique_listeners || 0),
          total_listen_sec: Number(curTotals.total_listen_sec || 0),
        },
        200,
        corsHeaders
      );
    }

    if (eventType === "play_end") {
      return jsonResponse(
        {
          ok: true,
          track_id: trackId,
          event_type: "play_end",
          is_owner: Boolean(isOwnerRow),
          play_updated: false,
        },
        200,
        corsHeaders
      );
    }
  }

  // Ensure visitor track totals row exists strictly for visitor activity (is_owner = 0)
  if (isOwnerRow === 0) {
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
  }

  let wasNewlyStarred = false;

  if (eventType === "star") {
    const insRes = await env.DB.prepare(
      `INSERT OR IGNORE INTO music_map_track_stars (track_id, session_hash, track_title, era, is_owner, starred_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(trackId, sessionHash, trackTitle, era, isOwnerRow, nowIso)
      .run();
    wasNewlyStarred = Boolean(insRes && insRes.meta && Number(insRes.meta.changes) > 0);
    if (!wasNewlyStarred && isOwnerRow === 1) {
      await env.DB.prepare(
        `UPDATE music_map_track_stars SET is_owner = 1 WHERE track_id = ? AND session_hash = ?`
      )
        .bind(trackId, sessionHash)
        .run();
    }

    if (isOwnerRow === 0) {
      await env.DB.prepare(
        `UPDATE music_map_track_totals
         SET active_stars = (SELECT COUNT(*) FROM music_map_track_stars WHERE track_id = ? AND is_owner = 0),
             total_star_events = total_star_events + ?,
             last_starred_at = ?,
             updated_at = ?
         WHERE track_id = ?`
      )
        .bind(trackId, wasNewlyStarred ? 1 : 0, nowIso, nowIso, trackId)
        .run();
    }
  } else if (eventType === "unstar") {
    await env.DB.prepare(
      `DELETE FROM music_map_track_stars WHERE track_id = ? AND session_hash = ?`
    )
      .bind(trackId, sessionHash)
      .run();

    if (isOwnerRow === 0) {
      await env.DB.prepare(
        `UPDATE music_map_track_totals
         SET active_stars = (SELECT COUNT(*) FROM music_map_track_stars WHERE track_id = ? AND is_owner = 0),
             updated_at = ?
         WHERE track_id = ?`
      )
        .bind(trackId, nowIso, trackId)
        .run();
    }
  } else if (eventType === "download") {
    if (isOwnerRow === 0) {
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
    }
  } else if (eventType === "request") {
    await env.DB.prepare(
      `INSERT INTO music_map_requests
         (track_id, track_title, era, requester_email, note, session_hash, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(trackId, trackTitle, era, requesterEmail, rawNote, sessionHash, country, nowIso)
      .run();

    if (isOwnerRow === 0) {
      await env.DB.prepare(
        `UPDATE music_map_track_totals
         SET total_requests = total_requests + 1,
             updated_at = ?
         WHERE track_id = ?`
      )
        .bind(nowIso, trackId)
        .run();
    }
  } else if (eventType === "play") {
    const isManual = playSource === "manual" ? 1 : 0;
    const isAutoplay = playSource === "autoplay" ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO music_map_track_listeners (track_id, session_hash, first_played_at, last_played_at, play_count, is_owner)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT(track_id, session_hash) DO UPDATE SET
         last_played_at = excluded.last_played_at,
         play_count = music_map_track_listeners.play_count + 1,
         is_owner = MAX(music_map_track_listeners.is_owner, excluded.is_owner)`
    )
      .bind(trackId, sessionHash, nowIso, nowIso, isOwnerRow)
      .run();

    if (isOwnerRow === 0) {
      await env.DB.prepare(
        `UPDATE music_map_track_totals
         SET total_plays = total_plays + 1,
             manual_plays = manual_plays + ?,
             autoplay_plays = autoplay_plays + ?,
             unique_listeners = (SELECT COUNT(*) FROM music_map_track_listeners WHERE track_id = ? AND is_owner = 0),
             total_listen_sec = ROUND(total_listen_sec + ?, 2),
             last_played_at = ?,
             updated_at = ?
         WHERE track_id = ?`
      )
        .bind(isManual, isAutoplay, trackId, listenedSec, nowIso, nowIso, trackId)
        .run();
    }
  }

  await env.DB.prepare(
    `INSERT INTO music_map_events
       (track_id, track_title, era, event_type, format, source, play_id, listened_sec, session_hash, is_owner, ip_hash, country, referrer, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      trackId,
      trackTitle,
      era,
      eventType,
      format,
      eventType === "play" ? playSource : source,
      playId,
      listenedSec,
      sessionHash,
      isOwnerRow,
      ipHash,
      country,
      clientReferrer,
      publicEventNote,
      nowIso
    )
    .run();

  popularCache.clear();

  const totals = (await env.DB.prepare(
    `SELECT active_stars, total_star_events, total_downloads, mp3_downloads, flac_downloads, total_requests,
            total_plays, manual_plays, autoplay_plays, unique_listeners, total_listen_sec
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
    total_plays: 0,
    manual_plays: 0,
    autoplay_plays: 0,
    unique_listeners: 0,
    total_listen_sec: 0,
  };

  // Strictly NEVER trigger email notifications on play / unstar events.
  // Passive owner-session browsing (star / download with is_owner = 1) suppresses self-alerts,
  // while explicit Track Requests (eventType === "request") ALWAYS notify so owner tests & all requests deliver.
  const shouldNotify =
    eventType === "request" ||
    (isOwnerRow === 0 && (eventType === "star" || eventType === "download"));
  if (shouldNotify) {
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
  }

  return jsonResponse(
    {
      ok: true,
      track_id: trackId,
      event_type: eventType,
      is_owner: Boolean(isOwnerRow),
      active_stars: Number(totals.active_stars || 0),
      total_downloads: Number(totals.total_downloads || 0),
      mp3_downloads: Number(totals.mp3_downloads || 0),
      flac_downloads: Number(totals.flac_downloads || 0),
      total_requests: Number(totals.total_requests || 0),
      total_plays: Number(totals.total_plays || 0),
      manual_plays: Number(totals.manual_plays || 0),
      autoplay_plays: Number(totals.autoplay_plays || 0),
      unique_listeners: Number(totals.unique_listeners || 0),
      total_listen_sec: Number(totals.total_listen_sec || 0),
    },
    200,
    corsHeaders
  );
}

function normalizeRangeKey(raw) {
  const r = String(raw || "all").toLowerCase();
  return VALID_RANGES.has(r) ? r : "all";
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

function computePopularityScore({
  stars = 0,
  downloads = 0,
  uniqueListeners = 0,
  manualPlays = 0,
  autoplayPlays = 0,
}) {
  const raw =
    Number(stars || 0) * 5 +
    Number(downloads || 0) * 4 +
    Number(uniqueListeners || 0) * 2 +
    Number(manualPlays || 0) * 1.5 +
    Number(autoplayPlays || 0) * 0.5;
  return Math.round(raw * 100) / 100;
}

function normalizeAudience(raw) {
  return String(raw || "visitors").toLowerCase() === "owner" ? "owner" : "visitors";
}

const OWNER_TOTALS_CTE_BODY = `
  owner_ev_all AS (
    SELECT
      track_id,
      MAX(track_title) AS track_title,
      MAX(CASE WHEN era != '' THEN era ELSE NULL END) AS era,
      SUM(CASE WHEN event_type = 'star' THEN 1 ELSE 0 END) AS total_star_events,
      SUM(CASE WHEN event_type = 'download' THEN 1 ELSE 0 END) AS total_downloads,
      SUM(CASE WHEN event_type = 'download' AND format IN ('mp3', 'mp3_320') THEN 1 ELSE 0 END) AS mp3_downloads,
      SUM(CASE WHEN event_type = 'download' AND format = 'flac' THEN 1 ELSE 0 END) AS flac_downloads,
      SUM(CASE WHEN event_type = 'request' THEN 1 ELSE 0 END) AS total_requests,
      SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END) AS total_plays,
      SUM(CASE WHEN event_type = 'play' AND source != 'autoplay' THEN 1 ELSE 0 END) AS manual_plays,
      SUM(CASE WHEN event_type = 'play' AND source = 'autoplay' THEN 1 ELSE 0 END) AS autoplay_plays,
      COUNT(DISTINCT CASE WHEN event_type = 'play' THEN session_hash END) AS unique_listeners,
      ROUND(COALESCE(SUM(CASE WHEN event_type = 'play' THEN listened_sec ELSE 0 END), 0), 2) AS total_listen_sec,
      MAX(CASE WHEN event_type = 'star' THEN created_at END) AS last_starred_at,
      MAX(CASE WHEN event_type = 'download' THEN created_at END) AS last_downloaded_at,
      MAX(CASE WHEN event_type = 'play' THEN created_at END) AS last_played_at,
      MAX(created_at) AS updated_at
    FROM music_map_events
    WHERE is_owner = 1
    GROUP BY track_id
  ),
  owner_stars_all AS (
    SELECT
      track_id,
      MAX(track_title) AS star_title,
      MAX(CASE WHEN era != '' THEN era ELSE NULL END) AS star_era,
      COUNT(*) AS active_stars,
      MAX(starred_at) AS latest_star_at
    FROM music_map_track_stars
    WHERE is_owner = 1
    GROUP BY track_id
  ),
  owner_track_ids AS (
    SELECT track_id FROM owner_ev_all
    UNION
    SELECT track_id FROM owner_stars_all
  ),
  owner_totals AS (
    SELECT
      ids.track_id,
      COALESCE(e.track_title, s.star_title, ids.track_id) AS track_title,
      COALESCE(e.era, s.star_era, '') AS era,
      COALESCE(s.active_stars, 0) AS active_stars,
      COALESCE(e.total_star_events, 0) AS total_star_events,
      COALESCE(e.total_downloads, 0) AS total_downloads,
      COALESCE(e.mp3_downloads, 0) AS mp3_downloads,
      COALESCE(e.flac_downloads, 0) AS flac_downloads,
      COALESCE(e.total_requests, 0) AS total_requests,
      COALESCE(e.total_plays, 0) AS total_plays,
      COALESCE(e.manual_plays, 0) AS manual_plays,
      COALESCE(e.autoplay_plays, 0) AS autoplay_plays,
      COALESCE(e.unique_listeners, 0) AS unique_listeners,
      COALESCE(e.total_listen_sec, 0) AS total_listen_sec,
      COALESCE(e.last_starred_at, s.latest_star_at) AS last_starred_at,
      e.last_downloaded_at,
      e.last_played_at,
      COALESCE(e.updated_at, s.latest_star_at) AS updated_at
    FROM owner_track_ids ids
    LEFT JOIN owner_ev_all e ON e.track_id = ids.track_id
    LEFT JOIN owner_stars_all s ON s.track_id = ids.track_id
  )
`;

async function handleGetPopular(request, url, env, corsHeaders) {
  const audience = normalizeAudience(url.searchParams.get("audience"));
  const isOwnerVal = audience === "owner" ? 1 : 0;
  const rangeKey = normalizeRangeKey(url.searchParams.get("range"));
  const rawLimit = parseInt(url.searchParams.get("limit") || "200", 10);
  const limit = Math.max(1, Math.min(600, Number.isFinite(rawLimit) ? rawLimit : 200));
  const bypassCache =
    url.searchParams.get("fresh") === "1" ||
    /(no-cache|no-store)/i.test(request.headers.get("cache-control") || "");

  const cacheKey = `${audience}:${rangeKey}:${limit}`;
  const nowMs = Date.now();
  if (!bypassCache && popularCache.has(cacheKey)) {
    const hit = popularCache.get(cacheKey);
    if (nowMs - hit.cachedAtMs < POPULAR_CACHE_TTL_MS) {
      return jsonResponse(hit.payload, 200, corsHeaders, {
        "Cache-Control": "public, max-age=15, stale-while-revalidate=45",
      });
    }
    popularCache.delete(cacheKey);
  }

  const generatedAt = new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, "Z");
  let tracks = [];
  let summary = {
    active_tracks: 0,
    plays: 0,
    manual_plays: 0,
    autoplay_plays: 0,
    unique_listeners: 0,
    listened_sec: 0,
    stars: 0,
    downloads: 0,
  };

  const totalsSourceSql = audience === "owner" ? "owner_totals" : "music_map_track_totals";
  const allTimePrefixCte = audience === "owner" ? `WITH ${OWNER_TOTALS_CTE_BODY}` : "";

  if (rangeKey === "all") {
    const [rowsRes, uniqueRow] = await Promise.all([
      env.DB.prepare(
        `${allTimePrefixCte}
         SELECT
           track_id,
           track_title,
           era,
           active_stars,
           total_downloads,
           mp3_downloads,
           flac_downloads,
           total_requests,
           total_plays,
           manual_plays,
           autoplay_plays,
           unique_listeners,
           total_listen_sec,
           last_starred_at,
           last_downloaded_at,
           last_played_at,
           updated_at
         FROM ${totalsSourceSql}
         WHERE (active_stars > 0 OR total_downloads > 0 OR total_plays > 0)
         ORDER BY (active_stars * 5.0 + total_downloads * 4.0 + unique_listeners * 2.0 + manual_plays * 1.5 + autoplay_plays * 0.5) DESC,
                  total_plays DESC,
                  active_stars DESC,
                  total_downloads DESC,
                  updated_at DESC
         LIMIT ?`
      )
        .bind(limit)
        .all(),
      env.DB.prepare(
        `SELECT COUNT(DISTINCT session_hash) AS unique_listeners
         FROM music_map_track_listeners
         WHERE is_owner = ?`
      )
        .bind(isOwnerVal)
        .first(),
    ]);

    const rawRows = (rowsRes && rowsRes.results) || [];
    tracks = rawRows.map((r, idx) => {
      const stars = Number(r.active_stars || 0);
      const downloads = Number(r.total_downloads || 0);
      const uniqueListeners = Number(r.unique_listeners || 0);
      const manualPlays = Number(r.manual_plays || 0);
      const autoplayPlays = Number(r.autoplay_plays || 0);
      const plays = Number(r.total_plays || 0);
      const listenedSec = Math.round(Number(r.total_listen_sec || 0) * 100) / 100;
      const score = computePopularityScore({
        stars,
        downloads,
        uniqueListeners,
        manualPlays,
        autoplayPlays,
      });
      summary.plays += plays;
      summary.manual_plays += manualPlays;
      summary.autoplay_plays += autoplayPlays;
      summary.listened_sec += listenedSec;
      summary.stars += stars;
      summary.downloads += downloads;
      return {
        rank: idx + 1,
        track_id: r.track_id,
        track_title: r.track_title,
        era: r.era || "",
        popularity_score: score,
        all_time_popularity_score: score,
        plays,
        manual_plays: manualPlays,
        autoplay_plays: autoplayPlays,
        unique_listeners: uniqueListeners,
        listened_sec: listenedSec,
        stars,
        downloads,
        mp3_downloads: Number(r.mp3_downloads || 0),
        flac_downloads: Number(r.flac_downloads || 0),
        active_stars: stars,
        total_downloads: downloads,
        total_plays: plays,
        total_listen_sec: listenedSec,
        last_starred_at: r.last_starred_at || null,
        last_downloaded_at: r.last_downloaded_at || null,
        last_played_at: r.last_played_at || null,
        updated_at: r.updated_at || null,
        url: buildDeepLink(env.MUSIC_MAP_BASE_URL, r.track_id),
      };
    });
    summary.active_tracks = tracks.length;
    summary.listened_sec = Math.round(summary.listened_sec * 100) / 100;
    summary.unique_listeners = Number((uniqueRow && uniqueRow.unique_listeners) || 0);
  } else {
    const sinceIso = rangeToSinceIso(rangeKey);
    const windowCtePrefix = audience === "owner" ? `WITH ${OWNER_TOTALS_CTE_BODY},` : "WITH";
    const [rowsRes, uniqueWinRow] = await Promise.all([
      env.DB.prepare(
        `${windowCtePrefix}
         win_events AS (
           SELECT
             track_id,
             SUM(CASE WHEN event_type = 'download' THEN 1 ELSE 0 END) AS win_downloads,
             SUM(CASE WHEN event_type = 'download' AND format IN ('mp3', 'mp3_320') THEN 1 ELSE 0 END) AS win_mp3_downloads,
             SUM(CASE WHEN event_type = 'download' AND format = 'flac' THEN 1 ELSE 0 END) AS win_flac_downloads,
             SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END) AS win_plays,
             SUM(CASE WHEN event_type = 'play' AND source != 'autoplay' THEN 1 ELSE 0 END) AS win_manual_plays,
             SUM(CASE WHEN event_type = 'play' AND source = 'autoplay' THEN 1 ELSE 0 END) AS win_autoplay_plays,
             COUNT(DISTINCT CASE WHEN event_type = 'play' THEN session_hash END) AS win_unique_listeners,
             ROUND(COALESCE(SUM(CASE WHEN event_type = 'play' THEN listened_sec ELSE 0 END), 0), 2) AS win_listen_sec
           FROM music_map_events
           WHERE is_owner = ? AND created_at >= ?
           GROUP BY track_id
         ),
         win_stars AS (
           SELECT track_id, COUNT(*) AS win_stars
           FROM music_map_track_stars
           WHERE is_owner = ? AND starred_at >= ?
           GROUP BY track_id
         )
         SELECT
           t.track_id,
           t.track_title,
           t.era,
           t.active_stars,
           t.total_downloads,
           t.mp3_downloads,
           t.flac_downloads,
           t.total_plays,
           t.manual_plays AS all_manual_plays,
           t.autoplay_plays AS all_autoplay_plays,
           t.unique_listeners AS all_unique_listeners,
           t.total_listen_sec,
           t.last_starred_at,
           t.last_downloaded_at,
           t.last_played_at,
           t.updated_at,
           COALESCE(ws.win_stars, 0) AS win_stars,
           COALESCE(we.win_downloads, 0) AS win_downloads,
           COALESCE(we.win_mp3_downloads, 0) AS win_mp3_downloads,
           COALESCE(we.win_flac_downloads, 0) AS win_flac_downloads,
           COALESCE(we.win_plays, 0) AS win_plays,
           COALESCE(we.win_manual_plays, 0) AS win_manual_plays,
           COALESCE(we.win_autoplay_plays, 0) AS win_autoplay_plays,
           COALESCE(we.win_unique_listeners, 0) AS win_unique_listeners,
           COALESCE(we.win_listen_sec, 0) AS win_listen_sec
         FROM ${totalsSourceSql} t
         LEFT JOIN win_events we ON we.track_id = t.track_id
         LEFT JOIN win_stars ws ON ws.track_id = t.track_id
         WHERE (COALESCE(ws.win_stars, 0) > 0 OR COALESCE(we.win_downloads, 0) > 0 OR COALESCE(we.win_plays, 0) > 0)
         ORDER BY (COALESCE(ws.win_stars, 0) * 5.0 + COALESCE(we.win_downloads, 0) * 4.0 + COALESCE(we.win_unique_listeners, 0) * 2.0 + COALESCE(we.win_manual_plays, 0) * 1.5 + COALESCE(we.win_autoplay_plays, 0) * 0.5) DESC,
                  COALESCE(we.win_plays, 0) DESC,
                  COALESCE(ws.win_stars, 0) DESC,
                  COALESCE(we.win_downloads, 0) DESC,
                  t.updated_at DESC
         LIMIT ?`
      )
        .bind(isOwnerVal, sinceIso, isOwnerVal, sinceIso, limit)
        .all(),
      env.DB.prepare(
        `SELECT COUNT(DISTINCT session_hash) AS unique_listeners
         FROM music_map_events
         WHERE is_owner = ? AND event_type = 'play' AND created_at >= ?`
      )
        .bind(isOwnerVal, sinceIso)
        .first(),
    ]);

    const rawRows = (rowsRes && rowsRes.results) || [];
    tracks = rawRows.map((r, idx) => {
      const stars = Number(r.win_stars || 0);
      const downloads = Number(r.win_downloads || 0);
      const uniqueListeners = Number(r.win_unique_listeners || 0);
      const manualPlays = Number(r.win_manual_plays || 0);
      const autoplayPlays = Number(r.win_autoplay_plays || 0);
      const plays = Number(r.win_plays || 0);
      const listenedSec = Math.round(Number(r.win_listen_sec || 0) * 100) / 100;
      const score = computePopularityScore({
        stars,
        downloads,
        uniqueListeners,
        manualPlays,
        autoplayPlays,
      });
      const allScore = computePopularityScore({
        stars: Number(r.active_stars || 0),
        downloads: Number(r.total_downloads || 0),
        uniqueListeners: Number(r.all_unique_listeners || 0),
        manualPlays: Number(r.all_manual_plays || 0),
        autoplayPlays: Number(r.all_autoplay_plays || 0),
      });
      summary.plays += plays;
      summary.manual_plays += manualPlays;
      summary.autoplay_plays += autoplayPlays;
      summary.listened_sec += listenedSec;
      summary.stars += stars;
      summary.downloads += downloads;
      return {
        rank: idx + 1,
        track_id: r.track_id,
        track_title: r.track_title,
        era: r.era || "",
        popularity_score: score,
        all_time_popularity_score: allScore,
        plays,
        manual_plays: manualPlays,
        autoplay_plays: autoplayPlays,
        unique_listeners: uniqueListeners,
        listened_sec: listenedSec,
        stars,
        downloads,
        mp3_downloads: Number(r.win_mp3_downloads || 0),
        flac_downloads: Number(r.win_flac_downloads || 0),
        active_stars: Number(r.active_stars || 0),
        total_downloads: Number(r.total_downloads || 0),
        total_plays: Number(r.total_plays || 0),
        total_listen_sec: Math.round(Number(r.total_listen_sec || 0) * 100) / 100,
        last_starred_at: r.last_starred_at || null,
        last_downloaded_at: r.last_downloaded_at || null,
        last_played_at: r.last_played_at || null,
        updated_at: r.updated_at || null,
        url: buildDeepLink(env.MUSIC_MAP_BASE_URL, r.track_id),
      };
    });
    summary.active_tracks = tracks.length;
    summary.listened_sec = Math.round(summary.listened_sec * 100) / 100;
    summary.unique_listeners = Number((uniqueWinRow && uniqueWinRow.unique_listeners) || 0);
  }

  const payload = {
    ok: true,
    generated_at: generatedAt,
    audience,
    range: rangeKey,
    formula: "active_stars*5 + total_downloads*4 + unique_listeners*2 + manual_plays*1.5 + autoplay_plays*0.5",
    summary,
    tracks,
  };

  if (popularCache.size >= 32) {
    const oldestKey = popularCache.keys().next().value;
    if (oldestKey !== undefined) popularCache.delete(oldestKey);
  }
  popularCache.set(cacheKey, { cachedAtMs: nowMs, payload });

  return jsonResponse(payload, 200, corsHeaders, {
    "Cache-Control": bypassCache || audience === "owner" ? "no-store" : "public, max-age=15, stale-while-revalidate=45",
  });
}

async function handleGetHotlist(url, env, corsHeaders) {
  const audience = normalizeAudience(url.searchParams.get("audience"));
  const isOwnerVal = audience === "owner" ? 1 : 0;
  const rangeKey = normalizeRangeKey(url.searchParams.get("range"));
  const rawLimit = parseInt(url.searchParams.get("limit") || "40", 10);
  const limit = Math.max(1, Math.min(100, Number.isFinite(rawLimit) ? rawLimit : 40));
  const sinceIso = rangeToSinceIso(rangeKey);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const totalsSourceSql = audience === "owner" ? "owner_totals" : "music_map_track_totals";
  const aggCtePrefix = audience === "owner" ? `WITH ${OWNER_TOTALS_CTE_BODY}` : "";
  const topCtePrefix = audience === "owner" ? `WITH ${OWNER_TOTALS_CTE_BODY},` : "WITH";

  const [aggTotals, windowAgg, uniqueRow, uniqueListenersRow, topRows, recentRows] = await Promise.all([
    env.DB.prepare(
      `${aggCtePrefix}
       SELECT
         COALESCE(SUM(active_stars), 0) AS active_stars,
         COALESCE(SUM(total_star_events), 0) AS total_star_events,
         COALESCE(SUM(total_downloads), 0) AS total_downloads,
         COALESCE(SUM(mp3_downloads), 0) AS mp3_downloads,
         COALESCE(SUM(flac_downloads), 0) AS flac_downloads,
         COALESCE(SUM(total_requests), 0) AS total_requests,
         COALESCE(SUM(total_plays), 0) AS total_plays,
         COALESCE(SUM(manual_plays), 0) AS manual_plays,
         COALESCE(SUM(autoplay_plays), 0) AS autoplay_plays,
         ROUND(COALESCE(SUM(total_listen_sec), 0), 2) AS total_listen_sec
       FROM ${totalsSourceSql}`
    ).first(),
    env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM music_map_track_stars WHERE is_owner = ? AND starred_at >= ?) AS window_stars,
         COALESCE(SUM(CASE WHEN event_type = 'download' THEN 1 ELSE 0 END), 0) AS window_downloads,
         COALESCE(SUM(CASE WHEN event_type = 'download' AND format IN ('mp3', 'mp3_320') THEN 1 ELSE 0 END), 0) AS window_mp3_downloads,
         COALESCE(SUM(CASE WHEN event_type = 'download' AND format = 'flac' THEN 1 ELSE 0 END), 0) AS window_flac_downloads,
         COALESCE(SUM(CASE WHEN event_type = 'request' THEN 1 ELSE 0 END), 0) AS window_requests,
         COALESCE(SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END), 0) AS window_plays,
         COALESCE(SUM(CASE WHEN event_type = 'play' AND source != 'autoplay' THEN 1 ELSE 0 END), 0) AS window_manual_plays,
         COALESCE(SUM(CASE WHEN event_type = 'play' AND source = 'autoplay' THEN 1 ELSE 0 END), 0) AS window_autoplay_plays,
         COUNT(DISTINCT CASE WHEN event_type = 'play' THEN session_hash END) AS window_unique_listeners,
         ROUND(COALESCE(SUM(CASE WHEN event_type = 'play' THEN listened_sec ELSE 0 END), 0), 2) AS window_listen_sec
       FROM music_map_events
       WHERE is_owner = ? AND created_at >= ?`
    )
      .bind(isOwnerVal, sinceIso, isOwnerVal, sinceIso)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_hash) AS unique_visitors
       FROM music_map_events
       WHERE is_owner = ?`
    )
      .bind(isOwnerVal)
      .first(),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT session_hash) AS unique_listeners
       FROM music_map_track_listeners
       WHERE is_owner = ?`
    )
      .bind(isOwnerVal)
      .first(),
    env.DB.prepare(
      `${topCtePrefix}
       win_events AS (
         SELECT
           track_id,
           SUM(CASE WHEN event_type = 'download' THEN 1 ELSE 0 END) AS window_downloads,
           SUM(CASE WHEN event_type = 'play' THEN 1 ELSE 0 END) AS window_plays,
           SUM(CASE WHEN event_type = 'play' AND source != 'autoplay' THEN 1 ELSE 0 END) AS window_manual_plays,
           SUM(CASE WHEN event_type = 'play' AND source = 'autoplay' THEN 1 ELSE 0 END) AS window_autoplay_plays,
           COUNT(DISTINCT CASE WHEN event_type = 'play' THEN session_hash END) AS window_unique_listeners,
           ROUND(COALESCE(SUM(CASE WHEN event_type = 'play' THEN listened_sec ELSE 0 END), 0), 2) AS window_listen_sec
         FROM music_map_events
         WHERE is_owner = ? AND created_at >= ?
         GROUP BY track_id
       ),
       win_stars AS (
         SELECT track_id, COUNT(*) AS window_stars
         FROM music_map_track_stars
         WHERE is_owner = ? AND starred_at >= ?
         GROUP BY track_id
       )
       SELECT
         t.track_id,
         t.track_title,
         t.era,
         t.active_stars,
         t.total_downloads,
         t.mp3_downloads,
         t.flac_downloads,
         t.total_requests,
         t.total_plays,
         t.manual_plays,
         t.autoplay_plays,
         t.unique_listeners,
         t.total_listen_sec,
         t.last_starred_at,
         t.last_downloaded_at,
         t.last_played_at,
         t.updated_at,
         COALESCE(ws.window_stars, 0) AS window_stars,
         COALESCE(we.window_downloads, 0) AS window_downloads,
         COALESCE(we.window_plays, 0) AS window_plays,
         COALESCE(we.window_manual_plays, 0) AS window_manual_plays,
         COALESCE(we.window_autoplay_plays, 0) AS window_autoplay_plays,
         COALESCE(we.window_unique_listeners, 0) AS window_unique_listeners,
         COALESCE(we.window_listen_sec, 0) AS window_listen_sec
       FROM ${totalsSourceSql} t
       LEFT JOIN win_events we ON we.track_id = t.track_id
       LEFT JOIN win_stars ws ON ws.track_id = t.track_id
       WHERE (t.active_stars > 0 OR t.total_downloads > 0 OR t.total_requests > 0 OR t.total_plays > 0)
       ORDER BY (t.active_stars * 5.0 + t.total_downloads * 4.0 + t.unique_listeners * 2.0 + t.manual_plays * 1.5 + t.autoplay_plays * 0.5 + t.total_requests * 2.0) DESC,
                t.active_stars DESC,
                t.total_downloads DESC,
                t.total_plays DESC,
                t.updated_at DESC
       LIMIT ?`
    )
      .bind(isOwnerVal, sinceIso, isOwnerVal, sinceIso, limit)
      .all(),
    env.DB.prepare(
      `SELECT id, event_type, track_id, track_title, era, format, source, listened_sec, country, created_at
       FROM music_map_events
       WHERE is_owner = ? AND event_type IN ('star', 'download', 'request', 'play')
       ORDER BY id DESC
       LIMIT 40`
    )
      .bind(isOwnerVal)
      .all(),
  ]);

  const topTracks = ((topRows && topRows.results) || []).map((r) => {
    const activeStars = Number(r.active_stars || 0);
    const totalDownloads = Number(r.total_downloads || 0);
    const totalPlays = Number(r.total_plays || 0);
    const manualPlays = Number(r.manual_plays || 0);
    const autoplayPlays = Number(r.autoplay_plays || 0);
    const uniqueListeners = Number(r.unique_listeners || 0);
    const totalListenSec = Math.round(Number(r.total_listen_sec || 0) * 100) / 100;
    const winStars = Number(r.window_stars || 0);
    const winDownloads = Number(r.window_downloads || 0);
    const winPlays = Number(r.window_plays || 0);
    const winManualPlays = Number(r.window_manual_plays || 0);
    const winAutoplayPlays = Number(r.window_autoplay_plays || 0);
    const winUniqueListeners = Number(r.window_unique_listeners || 0);
    const winListenSec = Math.round(Number(r.window_listen_sec || 0) * 100) / 100;

    return {
      track_id: r.track_id,
      track_title: r.track_title,
      era: r.era || "",
      popularity_score: computePopularityScore({
        stars: activeStars,
        downloads: totalDownloads,
        uniqueListeners,
        manualPlays,
        autoplayPlays,
      }),
      window_popularity_score: computePopularityScore({
        stars: winStars,
        downloads: winDownloads,
        uniqueListeners: winUniqueListeners,
        manualPlays: winManualPlays,
        autoplayPlays: winAutoplayPlays,
      }),
      active_stars: activeStars,
      total_downloads: totalDownloads,
      mp3_downloads: Number(r.mp3_downloads || 0),
      flac_downloads: Number(r.flac_downloads || 0),
      total_requests: Number(r.total_requests || 0),
      total_plays: totalPlays,
      manual_plays: manualPlays,
      autoplay_plays: autoplayPlays,
      unique_listeners: uniqueListeners,
      total_listen_sec: totalListenSec,
      window_stars: winStars,
      window_downloads: winDownloads,
      window_plays: winPlays,
      window_manual_plays: winManualPlays,
      window_autoplay_plays: winAutoplayPlays,
      window_unique_listeners: winUniqueListeners,
      window_listen_sec: winListenSec,
      last_starred_at: r.last_starred_at || null,
      last_downloaded_at: r.last_downloaded_at || null,
      last_played_at: r.last_played_at || null,
      updated_at: r.updated_at || null,
      url: buildDeepLink(env.MUSIC_MAP_BASE_URL, r.track_id),
    };
  });

  const recentEvents = ((recentRows && recentRows.results) || []).map((e) => ({
    id: Number(e.id),
    event_type: e.event_type,
    track_id: e.track_id,
    track_title: e.track_title,
    era: e.era || "",
    format: e.format || "",
    format_label: e.event_type === "download" ? formatHumanLabel(e.format) : "",
    source: e.source || "",
    listened_sec: Math.round(Number(e.listened_sec || 0) * 100) / 100,
    country: e.country || "",
    created_at: e.created_at,
    url: buildDeepLink(env.MUSIC_MAP_BASE_URL, e.track_id),
  }));

  return jsonResponse(
    {
      ok: true,
      generated_at: generatedAt,
      audience,
      range: rangeKey,
      summary: {
        active_stars: Number((aggTotals && aggTotals.active_stars) || 0),
        total_star_events: Number((aggTotals && aggTotals.total_star_events) || 0),
        total_downloads: Number((aggTotals && aggTotals.total_downloads) || 0),
        mp3_downloads: Number((aggTotals && aggTotals.mp3_downloads) || 0),
        flac_downloads: Number((aggTotals && aggTotals.flac_downloads) || 0),
        total_requests: Number((aggTotals && aggTotals.total_requests) || 0),
        total_plays: Number((aggTotals && aggTotals.total_plays) || 0),
        manual_plays: Number((aggTotals && aggTotals.manual_plays) || 0),
        autoplay_plays: Number((aggTotals && aggTotals.autoplay_plays) || 0),
        total_listen_sec: Math.round(Number((aggTotals && aggTotals.total_listen_sec) || 0) * 100) / 100,
        unique_visitors: Number((uniqueRow && uniqueRow.unique_visitors) || 0),
        unique_listeners: Number((uniqueListenersRow && uniqueListenersRow.unique_listeners) || 0),
        window_stars: Number((windowAgg && windowAgg.window_stars) || 0),
        window_downloads: Number((windowAgg && windowAgg.window_downloads) || 0),
        window_mp3_downloads: Number((windowAgg && windowAgg.window_mp3_downloads) || 0),
        window_flac_downloads: Number((windowAgg && windowAgg.window_flac_downloads) || 0),
        window_requests: Number((windowAgg && windowAgg.window_requests) || 0),
        window_plays: Number((windowAgg && windowAgg.window_plays) || 0),
        window_manual_plays: Number((windowAgg && windowAgg.window_manual_plays) || 0),
        window_autoplay_plays: Number((windowAgg && windowAgg.window_autoplay_plays) || 0),
        window_unique_listeners: Number((windowAgg && windowAgg.window_unique_listeners) || 0),
        window_listen_sec: Math.round(Number((windowAgg && windowAgg.window_listen_sec) || 0) * 100) / 100,
      },
      top_tracks: topTracks,
      recent_events: recentEvents,
    },
    200,
    corsHeaders
  );
}

async function recomputeVisitorTrackTotals(db, trackIds) {
  if (!trackIds || trackIds.length === 0) return;
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const stmts = [];
  for (const trackId of trackIds) {
    stmts.push(
      db.prepare(
        `UPDATE music_map_track_totals
         SET active_stars = (SELECT COUNT(*) FROM music_map_track_stars s WHERE s.track_id = music_map_track_totals.track_id AND s.is_owner = 0),
             total_star_events = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'star'),
             total_downloads = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'download'),
             mp3_downloads = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'download' AND e.format IN ('mp3', 'mp3_320')),
             flac_downloads = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'download' AND e.format = 'flac'),
             total_requests = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'request'),
             total_plays = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'play'),
             manual_plays = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'play' AND e.source != 'autoplay'),
             autoplay_plays = (SELECT COUNT(*) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'play' AND e.source = 'autoplay'),
             unique_listeners = (SELECT COUNT(*) FROM music_map_track_listeners l WHERE l.track_id = music_map_track_totals.track_id AND l.is_owner = 0),
             total_listen_sec = (SELECT ROUND(COALESCE(SUM(e.listened_sec), 0), 2) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'play'),
             last_starred_at = (SELECT MAX(e.created_at) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'star'),
             last_downloaded_at = (SELECT MAX(e.created_at) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'download'),
             last_played_at = (SELECT MAX(e.created_at) FROM music_map_events e WHERE e.track_id = music_map_track_totals.track_id AND e.is_owner = 0 AND e.event_type = 'play'),
             updated_at = ?
         WHERE track_id = ?`
      ).bind(nowIso, trackId)
    );
    stmts.push(
      db.prepare(
        `DELETE FROM music_map_track_totals
         WHERE track_id = ?
           AND active_stars = 0
           AND total_star_events = 0
           AND total_downloads = 0
           AND total_requests = 0
           AND total_plays = 0`
      ).bind(trackId)
    );
  }
  await db.batch(stmts);
}

async function parseSessionIdPayload(request, corsHeaders) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 4096) {
    return { errorResp: jsonResponse({ ok: false, error: "Payload too large" }, 413, corsHeaders) };
  }
  let body;
  try {
    const rawText = await request.text();
    if (rawText.length > 4096) {
      return { errorResp: jsonResponse({ ok: false, error: "Payload too large" }, 413, corsHeaders) };
    }
    body = JSON.parse(rawText);
  } catch (_) {
    return { errorResp: jsonResponse({ ok: false, error: "Invalid JSON body" }, 400, corsHeaders) };
  }

  const rawSessionId = stripCrLf((body && (body.session_id || body.visitor_seed)) || "", 128);
  if (!rawSessionId || !VISITOR_SEED_RE.test(rawSessionId)) {
    return { errorResp: jsonResponse({ ok: false, error: "Valid session_id is required" }, 400, corsHeaders) };
  }

  const domainInput = `btmm-session-v1:${rawSessionId}`;
  const primaryHash = (await sha256Hex(domainInput, 24)).toLowerCase();
  const fallbackHash = fallbackHash24(domainInput).toLowerCase();
  return { body, rawSessionId, primaryHash, fallbackHash };
}

async function findAffectedSessionTracks(db, primaryHash, fallbackHash) {
  const affectedRes = await db
    .prepare(
      `SELECT DISTINCT track_id FROM (
         SELECT track_id FROM music_map_events WHERE session_hash IN (?, ?)
         UNION
         SELECT track_id FROM music_map_track_stars WHERE session_hash IN (?, ?)
         UNION
         SELECT track_id FROM music_map_track_listeners WHERE session_hash IN (?, ?)
       )`
    )
    .bind(primaryHash, fallbackHash, primaryHash, fallbackHash, primaryHash, fallbackHash)
    .all();

  return ((affectedRes && affectedRes.results) || [])
    .map((r) => String((r && r.track_id) || "").trim())
    .filter(Boolean);
}

async function handleEnrollOwnerSession(request, env, corsHeaders) {
  const parsed = await parseSessionIdPayload(request, corsHeaders);
  if (parsed.errorResp) return parsed.errorResp;
  const { body, primaryHash, fallbackHash } = parsed;
  const targetIsOwner = body && body.is_owner === false ? 0 : 1;
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  let migratedEvents = 0;
  let affectedTrackIds = [];

  if (targetIsOwner === 1) {
    affectedTrackIds = await findAffectedSessionTracks(env.DB, primaryHash, fallbackHash);
    const batchRes = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO music_map_owner_sessions (session_hash, created_at) VALUES (?, ?)`
      ).bind(primaryHash, nowIso),
      env.DB.prepare(
        `INSERT OR IGNORE INTO music_map_owner_sessions (session_hash, created_at) VALUES (?, ?)`
      ).bind(fallbackHash, nowIso),
      env.DB.prepare(
        `UPDATE music_map_events SET is_owner = 1 WHERE session_hash IN (?, ?) AND is_owner = 0`
      ).bind(primaryHash, fallbackHash),
      env.DB.prepare(
        `UPDATE music_map_track_stars SET is_owner = 1 WHERE session_hash IN (?, ?) AND is_owner = 0`
      ).bind(primaryHash, fallbackHash),
      env.DB.prepare(
        `UPDATE music_map_track_listeners SET is_owner = 1 WHERE session_hash IN (?, ?) AND is_owner = 0`
      ).bind(primaryHash, fallbackHash),
    ]);
    migratedEvents = Number((batchRes[2] && batchRes[2].meta && batchRes[2].meta.changes) || 0);
    await recomputeVisitorTrackTotals(env.DB, affectedTrackIds);
  } else {
    await env.DB.prepare(`DELETE FROM music_map_owner_sessions WHERE session_hash IN (?, ?)`).bind(
      primaryHash,
      fallbackHash
    ).run();
  }

  popularCache.clear();

  return jsonResponse(
    {
      ok: true,
      is_owner: Boolean(targetIsOwner),
      migrated_events: migratedEvents,
      affected_tracks: affectedTrackIds.length,
    },
    200,
    corsHeaders
  );
}

async function handlePurgeOwnSession(request, env, corsHeaders) {
  const parsed = await parseSessionIdPayload(request, corsHeaders);
  if (parsed.errorResp) return parsed.errorResp;
  const { body, primaryHash, fallbackHash } = parsed;

  const affectedTrackIds = await findAffectedSessionTracks(env.DB, primaryHash, fallbackHash);

  const stmts = [
    env.DB.prepare(`DELETE FROM music_map_track_stars WHERE session_hash IN (?, ?)`).bind(
      primaryHash,
      fallbackHash
    ),
    env.DB.prepare(`DELETE FROM music_map_track_listeners WHERE session_hash IN (?, ?)`).bind(
      primaryHash,
      fallbackHash
    ),
    env.DB.prepare(
      `DELETE FROM music_map_events
       WHERE session_hash IN (?, ?) AND event_type IN ('play', 'star', 'unstar', 'download')`
    ).bind(primaryHash, fallbackHash),
    env.DB.prepare(
      `DELETE FROM music_map_email_dedup
       WHERE dedup_key LIKE ? OR dedup_key LIKE ? OR dedup_key LIKE ? OR dedup_key LIKE ?`
    ).bind(
      `star:${primaryHash}:%`,
      `download:${primaryHash}:%`,
      `star:${fallbackHash}:%`,
      `download:${fallbackHash}:%`
    ),
  ];

  if (body && body.unenroll === true) {
    stmts.push(
      env.DB.prepare(`DELETE FROM music_map_owner_sessions WHERE session_hash IN (?, ?)`).bind(
        primaryHash,
        fallbackHash
      )
    );
  }

  const delBatch = await env.DB.batch(stmts);
  const deletedStars = Number((delBatch[0] && delBatch[0].meta && delBatch[0].meta.changes) || 0);
  const deletedListeners = Number((delBatch[1] && delBatch[1].meta && delBatch[1].meta.changes) || 0);
  const deletedEvents = Number((delBatch[2] && delBatch[2].meta && delBatch[2].meta.changes) || 0);

  await recomputeVisitorTrackTotals(env.DB, affectedTrackIds);
  popularCache.clear();

  return jsonResponse(
    {
      ok: true,
      purged: deletedEvents + deletedStars + deletedListeners > 0,
      deleted_events: deletedEvents,
      deleted_stars: deletedStars,
      deleted_listeners: deletedListeners,
      affected_tracks: affectedTrackIds.length,
    },
    200,
    corsHeaders
  );
}

const AUDIO_ROUTE_RE = /^\/api\/audio\/([a-zA-Z0-9._-]{1,80})\/([a-zA-Z0-9._%+-]{1,220}\.(?:mp3|m4a|ogg|wav|flac))$/i;

function isAudioOriginAllowed(origin, env) {
  if (!origin) return true;
  if (isOriginAllowed(origin, env)) return true;
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin);
}

function audioMimeFromAsset(assetName) {
  const low = String(assetName || "").toLowerCase();
  if (low.endsWith(".mp3")) return "audio/mpeg";
  if (low.endsWith(".m4a")) return "audio/mp4";
  if (low.endsWith(".ogg")) return "audio/ogg";
  if (low.endsWith(".wav")) return "audio/wav";
  if (low.endsWith(".flac")) return "audio/flac";
  return "application/octet-stream";
}

function buildAudioCorsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function handleAudioRangeStream(request, url, origin, env) {
  if (!isAudioOriginAllowed(origin, env)) {
    return new Response(null, { status: 403 });
  }
  const cors = buildAudioCorsHeaders(origin);
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: cors });
  }
  const m = AUDIO_ROUTE_RE.exec(url.pathname);
  if (!m) {
    return new Response("Not Found", { status: 404, headers: cors });
  }
  const tag = m[1];
  const rawAsset = m[2];
  let decodedAsset = rawAsset;
  try {
    decodedAsset = decodeURIComponent(rawAsset);
  } catch (_) {
    return new Response("Bad Request", { status: 400, headers: cors });
  }
  if (
    tag.includes("..") ||
    decodedAsset.includes("..") ||
    decodedAsset.includes("/") ||
    decodedAsset.includes("\\")
  ) {
    return new Response("Bad Request", { status: 400, headers: cors });
  }

  const ghUrl = `https://github.com/BillTribble/music-map/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(decodedAsset)}`;
  const upHeaders = { "User-Agent": "music-map-audio-stream/1.0" };
  const rangeHdr = request.headers.get("range");
  const ifRangeHdr = request.headers.get("if-range");
  if (rangeHdr) upHeaders.Range = rangeHdr;
  if (ifRangeHdr) upHeaders["If-Range"] = ifRangeHdr;

  const upstream = await fetch(ghUrl, {
    method: request.method,
    headers: upHeaders,
    redirect: "follow",
    cf: { cacheTtl: 86400, cacheEverything: true },
  });

  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304 && upstream.status !== 416) {
    return new Response("Upstream Audio Unavailable", { status: upstream.status || 502, headers: cors });
  }

  const outHeaders = new Headers(cors);
  outHeaders.set("Content-Type", audioMimeFromAsset(decodedAsset));
  outHeaders.set("Accept-Ranges", upstream.headers.get("accept-ranges") || "bytes");
  outHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
  for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) outHeaders.set(h, v);
  }

  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "";

    if (url.pathname.startsWith("/api/audio/")) {
      return handleAudioRangeStream(request, url, origin, env);
    }

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

    if (url.pathname === "/api/enroll-owner-session" && request.method === "POST") {
      return handleEnrollOwnerSession(request, env, corsHeaders);
    }

    if (url.pathname === "/api/purge-own-session" && request.method === "POST") {
      return handlePurgeOwnSession(request, env, corsHeaders);
    }

    if (url.pathname === "/api/popular" && request.method === "GET") {
      return handleGetPopular(request, url, env, corsHeaders);
    }

    if (url.pathname === "/api/hotlist" && request.method === "GET") {
      return handleGetHotlist(url, env, corsHeaders);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404, corsHeaders);
  },
};
