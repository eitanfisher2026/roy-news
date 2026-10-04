// Weekly "what's coming up" highlights for a schedule's curated reference
// sites (sites with no RSS feed). No Firebase dependency on purpose — the
// same module is run locally against the real sites to verify extraction.

const FETCH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_PAGE_CHARS = 40000;
const MAX_EVENTS_PER_SITE = 10;
const MAX_EVENTS_PER_GROUP = 15;
// Below this a page is a script-rendered shell or a bot-challenge page, not content.
const MIN_READABLE_CHARS = 400;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function absoluteUrl(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
  } catch { return null; }
}

// Keeps each link's target next to its text ("Title [url]") so the model can
// return the event's own page rather than a guessed one.
function htmlToText(html, baseUrl) {
  let s = html
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => {
    const label = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const url = absoluteUrl(decodeEntities(href), baseUrl);
    if (!label) return ' ';
    return url ? ` ${label} [${url}] ` : ` ${label} `;
  });
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function fetchPageText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': FETCH_USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9,th;q=0.8' },
      redirect: 'follow', signal: controller.signal
    });
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}`, text: '' };
    const text = htmlToText(await resp.text(), resp.url || url);
    if (text.length < MIN_READABLE_CHARS) return { ok: false, reason: 'page has no readable content', text };
    return { ok: true, text: text.slice(0, MAX_PAGE_CHARS) };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : e.message, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

function endOfNextMonth(todayIso) {
  const d = new Date(`${todayIso}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).toISOString().slice(0, 10);
}

function buildPrompt(link, pageText, todayIso, interest) {
  const windowEnd = endOfNextMonth(todayIso);
  return `Below is the text of a web page from "${link.name}" (${link.eventsUrl || link.url}). Link targets appear in [square brackets] right after the link text.

Today is ${todayIso}. List the ${interest} events, exhibitions, screenings, performances, festivals or markets on this page that take place in or near Bangkok and are either running now or start between today and ${windowEnd}.

Rules:
- Use ONLY what is written on the page. Never invent or guess an event, a date or a venue.
- Skip anything that already ended before today, and anything with no date on the page unless the page clearly presents it as currently on.
- Skip sports events, races, trade fairs, business conferences, sales promotions, classes, courses, camps, volunteer activities and permanent attractions.
- "title": the event name in English (translate if it is in Thai).
- "dates": the dates as a short English phrase, e.g. "10–25 Oct 2026" or "Until 30 Nov 2026". Empty string if the page gives none.
- "startDate": YYYY-MM-DD of the first day if known, otherwise empty string.
- "venue": the venue name in English, or empty string if not stated.
- "url": the event's own link exactly as it appears in the brackets, or empty string if it has none.
- At most ${MAX_EVENTS_PER_SITE} events. If more qualify, prefer the ones starting soonest from today, then the ones that opened most recently.

Reply with ONLY a JSON array, no other text. Reply [] if nothing qualifies.

PAGE TEXT:
${pageText}`;
}

function parseEvents(raw, link) {
  const match = String(raw || '').match(/\[[\s\S]*\]/);
  if (!match) return [];
  let arr;
  try { arr = JSON.parse(match[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const pageUrl = link.eventsUrl || link.url;
  const clean = v => String(v || '').replace(/\s+/g, ' ').trim();
  return arr
    .filter(e => e && clean(e.title))
    .map(e => ({
      title: clean(e.title).slice(0, 200),
      dates: clean(e.dates).slice(0, 80),
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(clean(e.startDate)) ? clean(e.startDate) : '',
      venue: clean(e.venue).slice(0, 120),
      url: absoluteUrl(clean(e.url), pageUrl) || pageUrl,
      site: link.name
    }));
}

// callAI is injected (index.js's own) so billing and error handling stay in one place.
async function extractSiteEvents(callAI, ai, link, todayIso, interest) {
  const page = await fetchPageText(link.eventsUrl || link.url);
  if (!page.ok) return { readable: false, reason: page.reason, events: [], usage: null };
  const { text, usage } = await callAI(ai, buildPrompt(link, page.text, todayIso, interest), 3000);
  return { readable: true, events: parseEvents(text, link), usage };
}

// Upcoming events first (soonest first), then ones already running (most
// recently opened first), undated last — the point is to surface what is new.
// `seen` is shared across a schedule's groups so one event isn't listed twice.
function mergeGroupEvents(events, todayIso, seen = new Set()) {
  const unique = events.filter(e => {
    const key = e.title.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rank = e => !e.startDate ? 2 : (e.startDate >= todayIso ? 0 : 1);
  unique.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return a.startDate.localeCompare(b.startDate);
    if (ra === 1) return b.startDate.localeCompare(a.startDate);
    return 0;
  });
  if (unique.length <= MAX_EVENTS_PER_GROUP) return unique;
  // Over the limit: take turns between sites so one large listing site
  // can't crowd out the venues' own pages, then keep the date order.
  const bySite = new Map();
  for (const e of unique) {
    if (!bySite.has(e.site)) bySite.set(e.site, []);
    bySite.get(e.site).push(e);
  }
  const picked = new Set();
  while (picked.size < MAX_EVENTS_PER_GROUP) {
    let added = false;
    for (const queue of bySite.values()) {
      if (queue.length > 0 && picked.size < MAX_EVENTS_PER_GROUP) { picked.add(queue.shift()); added = true; }
    }
    if (!added) break;
  }
  return unique.filter(e => picked.has(e));
}

module.exports = { extractSiteEvents, mergeGroupEvents, fetchPageText, htmlToText, parseEvents, buildPrompt, MAX_EVENTS_PER_GROUP };
