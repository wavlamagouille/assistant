// Reads Gmail (via IMAP + App Password) and Calendar (via its private ICS
// feed) — one file, no OAuth, no Google Cloud project, no verification.
// Which one it does is picked by ?source=gmail or ?source=calendar.
// All credentials stay server-side as Vercel env vars.

import { ImapFlow } from 'imapflow';
import { rrulestr } from 'rrule';
import { simpleParser } from 'mailparser';

export default async function handler(req, res) {
  const source = req.query.source;
  if (source === 'gmail') return handleGmail(req, res);
  if (source === 'calendar') return handleCalendar(req, res);
  return res.status(400).json({ error: 'Use ?source=gmail or ?source=calendar' });
}

// account=1 (default) uses GMAIL_ADDRESS/GMAIL_APP_PASSWORD.
// account=2 uses GMAIL_ADDRESS_2/GMAIL_APP_PASSWORD_2, for a second inbox.
async function handleGmail(req, res) {
  if (req.query.action === 'read') return handleGmailRead(req, res);

  const account = req.query.account === '2' ? '2' : '1';
  const suffix = account === '2' ? '_2' : '';
  const user = process.env['GMAIL_ADDRESS' + suffix];
  const pass = process.env['GMAIL_APP_PASSWORD' + suffix];
  if (!user || !pass) {
    const label = account === '2' ? 'GMAIL_ADDRESS_2 / GMAIL_APP_PASSWORD_2' : 'GMAIL_ADDRESS / GMAIL_APP_PASSWORD';
    return res.status(400).json({ error: `${label} are not set in Vercel Environment Variables.` });
  }

  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

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
    let total = 0;
    try {
      const status = await client.status('INBOX', { messages: true });
      total = status.messages;
      if (total > 0) {
        // offset=0 is the most recent; walk backwards from the top of the mailbox.
        const end = Math.max(1, total - offset);
        const start = Math.max(1, end - limit + 1);
        if (end >= start) {
          for await (const msg of client.fetch(`${start}:${end}`, { envelope: true, uid: true })) {
            const from = msg.envelope.from && msg.envelope.from[0];
            messages.push({
              uid: msg.uid,
              subject: msg.envelope.subject || '(no subject)',
              from: from ? (from.name || from.address) : '',
              date: msg.envelope.date
            });
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    messages.reverse(); // most recent first
    res.status(200).json({ messages, total, offset, limit, hasMore: offset + limit < total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function handleGmailRead(req, res) {
  const account = req.query.account === '2' ? '2' : '1';
  const suffix = account === '2' ? '_2' : '';
  const user = process.env['GMAIL_ADDRESS' + suffix];
  const pass = process.env['GMAIL_APP_PASSWORD' + suffix];
  if (!user || !pass) {
    const label = account === '2' ? 'GMAIL_ADDRESS_2 / GMAIL_APP_PASSWORD_2' : 'GMAIL_ADDRESS / GMAIL_APP_PASSWORD';
    return res.status(400).json({ error: `${label} are not set in Vercel Environment Variables.` });
  }
  const uid = parseInt(req.query.uid, 10);
  if (!uid) return res.status(400).json({ error: 'Missing or invalid uid parameter.' });

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
    let raw = null;
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (msg && msg.source) raw = msg.source;
    } finally {
      lock.release();
    }
    await client.logout();

    if (!raw) return res.status(404).json({ error: 'Message not found.' });

    const parsed = await simpleParser(raw);
    res.status(200).json({
      subject: parsed.subject || '(no subject)',
      from: parsed.from ? parsed.from.text : '',
      to: parsed.to ? parsed.to.text : '',
      date: parsed.date,
      text: parsed.text || '',
      html: parsed.html || null
    });
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

    // Unfold ICS line-folding (continuation lines start with a space/tab)
    // before splitting into VEVENT blocks, or wrapped RRULE/EXDATE lines
    // get silently truncated.
    const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');

    const now = new Date();
    const windowStart = new Date(now.getTime() - 24 * 3600 * 1000); // include "today" fully
    const windowEnd = new Date(now.getTime() + 90 * 24 * 3600 * 1000); // 90 days out, plenty for a calendar view

    const occurrences = [];
    const blocks = unfolded.split('BEGIN:VEVENT').slice(1);

    for (const block of blocks) {
      const body = block.split('END:VEVENT')[0];
      const summary = (body.match(/SUMMARY:(.*)/) || [])[1];
      const descMatch = body.match(/DESCRIPTION:(.*)/);
      const description = descMatch
        ? descMatch[1].replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim()
        : '';
      const dtstartMatch = body.match(/DTSTART([^:\r\n]*):([^\r\n]*)/);
      if (!dtstartMatch) continue;
      const dtstartParams = dtstartMatch[1] || '';
      const dtstartRaw = dtstartMatch[2].trim();
      const allDay = /^\d{8}$/.test(dtstartRaw);
      const start = parseICSDate(dtstartRaw, dtstartParams);
      if (!start) continue;

      const rruleMatch = body.match(/RRULE:([^\r\n]*)/);
      const exdateMatches = [...body.matchAll(/EXDATE[^:\r\n]*:([^\r\n]*)/g)];
      const exdates = new Set(
        exdateMatches.flatMap(m => m[1].split(',').map(v => v.trim()))
      );

      if (!rruleMatch) {
        if (start >= windowStart && start <= windowEnd) {
          occurrences.push({ summary: (summary || '(untitled)').trim(), start: start.toISOString(), allDay, description });
        }
        continue;
      }

      // Recurring event - expand actual occurrences in the window using
      // rrule.js rather than only ever reporting the first DTSTART, which
      // was the bug causing recurring events to show missing/wrong dates.
      try {
        const rule = rrulestr('DTSTART:' + toRRuleDate(start) + '\nRRULE:' + rruleMatch[1].trim());
        const dates = rule.between(windowStart, windowEnd, true);
        for (const d of dates) {
          const key = toRRuleDate(d);
          if (exdates.has(key)) continue;
          occurrences.push({ summary: (summary || '(untitled)').trim(), start: d.toISOString(), allDay, description });
        }
      } catch (err) {
        // Malformed RRULE - fall back to just the first occurrence rather
        // than dropping the event entirely.
        if (start >= windowStart && start <= windowEnd) {
          occurrences.push({ summary: (summary || '(untitled)').trim(), start: start.toISOString(), allDay, description });
        }
      }
    }

    occurrences.sort((a, b) => new Date(a.start) - new Date(b.start));
    const upcoming = occurrences.filter(e => new Date(e.start) >= now);

    res.status(200).json({
      events: occurrences,          // full window, for the calendar grid
      upcoming: upcoming.slice(0, 3) // next 3, for the quick list
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

function toRRuleDate(d){
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

// Simplified EU DST offset (last Sunday of March to last Sunday of October =
// CEST/+2, else CET/+1) - covers TZID-qualified local times without needing
// a full IANA timezone database, since this calendar is Zurich-based.
function euOffsetHours(date){
  const year = date.getUTCFullYear();
  const dstStart = lastSundayUTC(year, 2); // March
  const dstEnd = lastSundayUTC(year, 9);   // October
  return (date >= dstStart && date < dstEnd) ? 2 : 1;
}
function lastSundayUTC(year, monthIndex){
  const d = new Date(Date.UTC(year, monthIndex + 1, 0, 1, 0, 0)); // last day of month, 1am UTC
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d;
}

function parseICSDate(val, params) {
  if (/^\d{8}$/.test(val)) {
    const y = val.slice(0, 4), m = val.slice(4, 6), d = val.slice(6, 8);
    return new Date(`${y}-${m}-${d}T00:00:00Z`);
  }
  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (z) return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
  if (params && /TZID/i.test(params)) {
    // Naive local time with a timezone - apply the EU offset for that date.
    const naiveUTC = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
    const offset = euOffsetHours(naiveUTC);
    return new Date(naiveUTC.getTime() - offset * 3600 * 1000);
  }
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);
}
