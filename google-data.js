// Reads Gmail (via IMAP + App Password) and Calendar (via its private ICS
// feed) — one file, no OAuth, no Google Cloud project, no verification.
// Which one it does is picked by ?source=gmail or ?source=calendar.
// All credentials stay server-side as Vercel env vars.

import { ImapFlow } from 'imapflow';

export default async function handler(req, res) {
  const source = req.query.source;
  if (source === 'gmail') return handleGmail(req, res);
  if (source === 'calendar') return handleCalendar(req, res);
  return res.status(400).json({ error: 'Use ?source=gmail or ?source=calendar' });
}

async function handleGmail(req, res) {
  const user = process.env.GMAIL_ADDRESS;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    return res.status(400).json({ error: 'GMAIL_ADDRESS / GMAIL_APP_PASSWORD are not set in Vercel Environment Variables.' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const messages = [];
    try {
      const status = await client.status('INBOX', { messages: true });
      const total = status.messages;
      if (total > 0) {
        const start = Math.max(1, total - 4);
        for await (const msg of client.fetch(`${start}:${total}`, { envelope: true })) {
          const from = msg.envelope.from && msg.envelope.from[0];
          messages.push({
            subject: msg.envelope.subject || '(no subject)',
            from: from ? (from.name || from.address) : '',
            date: msg.envelope.date
          });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    messages.reverse(); // most recent first
    res.status(200).json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function handleCalendar(req, res) {
  try {
    const icsUrl = process.env.GOOGLE_CALENDAR_ICS_URL;
    if (!icsUrl) {
      return res.status(400).json({ error: 'GOOGLE_CALENDAR_ICS_URL is not set in Vercel Environment Variables.' });
    }

    const icsRes = await fetch(icsUrl);
    if (!icsRes.ok) throw new Error('Calendar feed returned HTTP ' + icsRes.status);
    const text = await icsRes.text();

    const events = [];
    const blocks = text.split('BEGIN:VEVENT').slice(1);
    for (const block of blocks) {
      const body = block.split('END:VEVENT')[0];
      const summary = (body.match(/SUMMARY:(.*)/) || [])[1];
      const dtstartLine = (body.match(/DTSTART[^:\r\n]*:([^\r\n]*)/) || [])[1];
      if (!dtstartLine) continue;
      const start = parseICSDate(dtstartLine.trim());
      if (!start) continue;
      events.push({
        summary: (summary || '(untitled)').trim(),
        start: start.toISOString(),
        allDay: dtstartLine.trim().length === 8
      });
    }

    const now = new Date();
    const upcoming = events
      .filter(e => new Date(e.start) >= now)
      .sort((a, b) => new Date(a.start) - new Date(b.start))
      .slice(0, 5);

    res.status(200).json({ events: upcoming });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function parseICSDate(val) {
  if (/^\d{8}$/.test(val)) {
    const y = val.slice(0, 4), m = val.slice(4, 6), d = val.slice(6, 8);
    return new Date(`${y}-${m}-${d}T00:00:00Z`);
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : ''}`);
}
