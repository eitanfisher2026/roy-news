const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Parser = require('rss-parser');

admin.initializeApp();
const db = admin.database();

// ─── Access control ───────────────────────────────────────────────────────────
const OWNER_EMAIL = 'eitanfisher100@gmail.com';

function sanitizeEmailKey(email) {
  return email.trim().toLowerCase().replace(/\./g, ',');
}

// Looks up a user's uid from their email via the usersByEmail index — null
// if they've never signed in (the index is written client-side on login).
async function resolveUidByEmail(email) {
  const snap = await db.ref(`usersByEmail/${sanitizeEmailKey(String(email || ''))}`).once('value');
  return snap.val() || null;
}

async function getRole(email) {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (normalized === OWNER_EMAIL) return 'admin';
  const snap = await db.ref(`authorizedUsers/${sanitizeEmailKey(normalized)}`).once('value');
  const rec = snap.val();
  return rec ? rec.role : null;
}

async function requireAuthorized(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
  const role = await getRole(request.auth.token.email);
  if (!role) {
    throw new HttpsError('permission-denied',
      'Your account is not authorized to use Roy News.\n\nHow to fix: ask the administrator to add your email in Settings → Manage Users.'
    );
  }
  return role;
}

function requireAdmin(role) {
  if (role !== 'admin') throw new HttpsError('permission-denied', 'Administrator access required.');
}

// ─── Cost tracking (per user, per month, per AI provider) ─────────────────────
// Shared by live onCall requests and the background scheduled-report job —
// both attribute cost to a uid, they just get it from different places
// (request.auth vs. a schedule's stored creator).
async function persistCost(uid, email, ai, costUsd) {
  if (costUsd <= 0 || !uid) return;
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  await Promise.all([
    db.ref(`userCosts/${uid}/email`).set(email || null),
    db.ref(`userCosts/${uid}/costs/${month}/${ai.type}`).set(admin.database.ServerValue.increment(costUsd)),
  ]).catch(() => {}); // never fail the caller over a cost-logging hiccup
}

async function recordCost(request, ai, inputTokens, outputTokens, isTranslation = false) {
  const costUsd = calcCostUsd(ai, inputTokens, outputTokens, isTranslation);
  if (request.auth) await persistCost(request.auth.uid, request.auth.token.email, ai, costUsd);
  return costUsd;
}

const rssParser = new Parser({
  timeout: 12000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RoyNewsBot/1.0; +https://roy-news.web.app)' },
  customFields: { item: ['description', 'content:encoded'] }
});

// ─── AI pricing ($ per million tokens) ───────────────────────────────────────
const PRICING = {
  anthropic: {
    'claude-sonnet-4-6':          { in: 3, out: 15 },
    'claude-haiku-4-5-20251001':  { in: 1, out: 5 },
  },
  gemini: {
    'gemini-2.0-flash-lite':     { in: 0.075, out: 0.30 },
    'gemini-2.0-flash':          { in: 0.10, out: 0.40 },
    'gemini-2.5-flash-lite':     { in: 0.10, out: 0.40 },
    'gemini-2.5-flash':          { in: 0.30, out: 2.50 },
    'gemini-2.5-pro':            { in: 1.25, out: 10.00 },
    'gemini-3.1-flash-lite':     { in: 0.25, out: 1.50 },
    'gemini-3.5-flash':          { in: 1.50, out: 9.00 },
    'gemini-3.1-pro-preview':    { in: 2.00, out: 12.00 },
    'gemini-omni-flash-preview': { in: 1.50, out: 9.00 },
    'gemini-3-flash-preview':    { in: 0.30, out: 2.50 },
  },
  openai: {
    'gpt-4o-mini':   { in: 0.15, out: 0.60 },
    'gpt-4o':        { in: 2.50, out: 10.00 },
    'gpt-4.1':       { in: 2.00, out: 8.00 },
    'gpt-4.1-mini':  { in: 0.40, out: 1.60 },
    'gpt-5.4-nano':  { in: 0.20, out: 1.25 },
    'gpt-5.4-mini':  { in: 0.75, out: 4.50 },
    'gpt-5.4':       { in: 2.50, out: 15.00 },
    'gpt-5.4-pro':   { in: 30.00, out: 180.00 },
    'gpt-5.5':       { in: 5.00, out: 30.00 },
    'gpt-5.5-pro':   { in: 30.00, out: 180.00 },
    'gpt-5.6-luna':  { in: 1.00, out: 6.00 },
    'gpt-5.6-terra': { in: 2.50, out: 15.00 },
    'gpt-5.6-sol':   { in: 5.00, out: 30.00 },
    'gpt-5.3-codex': { in: 1.75, out: 14.00 },
    'chat-latest':   { in: 5.00, out: 30.00 },
  }
};

// ─── AI abstraction ───────────────────────────────────────────────────────────
function makeAI(data, forTranslation = false) {
  const { provider, geminiApiKey, geminiModel, openaiApiKey, openaiModel, anthropicApiKey, anthropicModel } = data || {};

  if (provider === 'gemini' && geminiApiKey) {
    const DEPRECATED = { 'gemini-2.0-flash': 'gemini-2.5-flash', 'gemini-2.0-flash-lite': 'gemini-2.5-flash' };
    const rawModel = forTranslation ? 'gemini-2.5-flash' : (geminiModel || 'gemini-2.5-flash');
    const model = DEPRECATED[rawModel] || rawModel;
    return { type: 'gemini', client: new GoogleGenerativeAI(geminiApiKey), model };
  }
  if (provider === 'openai' && openaiApiKey) {
    const model = forTranslation ? 'gpt-4o-mini' : (openaiModel || 'gpt-4o-mini');
    return { type: 'openai', client: new OpenAI({ apiKey: openaiApiKey }), model };
  }
  if (provider === 'anthropic' && anthropicApiKey) {
    const model = forTranslation ? 'claude-haiku-4-5-20251001' : (anthropicModel || 'claude-sonnet-4-6');
    return { type: 'anthropic', client: new Anthropic({ apiKey: anthropicApiKey }), model };
  }
  throw new HttpsError('failed-precondition',
    'No AI provider configured.\n\nHow to fix: open Settings → AI Provider and add your Gemini, OpenAI, or Anthropic API key.'
  );
}

async function callAI(ai, prompt, maxTokens) {
  try {
    if (ai.type === 'gemini') {
      const gemModel = ai.client.getGenerativeModel({ model: ai.model });
      const result = await gemModel.generateContent(prompt);
      const text = result.response.text();
      const meta = result.response.usageMetadata;
      return { text, usage: { input_tokens: meta?.promptTokenCount || 0, output_tokens: meta?.candidatesTokenCount || 0 } };
    }
    if (ai.type === 'openai') {
      const completion = await ai.client.chat.completions.create({
        model: ai.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }]
      });
      return {
        text: completion.choices[0].message.content,
        usage: { input_tokens: completion.usage?.prompt_tokens || 0, output_tokens: completion.usage?.completion_tokens || 0 }
      };
    }
    // Anthropic
    const resp = await ai.client.messages.create({
      model: ai.model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    });
    return { text: resp.content[0].text, usage: resp.usage };
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    const msg = (e.message || '').toLowerCase();
    const status = e.status || e.statusCode || 0;
    const name = ai.type === 'gemini' ? 'Gemini' : ai.type === 'openai' ? 'OpenAI' : 'Anthropic';
    if (status === 401 || msg.includes('api key') || msg.includes('api_key_invalid') || msg.includes('invalid x-api-key') || msg.includes('incorrect api key') || msg.includes('authentication_error') || msg.includes('invalid_api_key')) {
      throw new HttpsError('permission-denied',
        `Your ${name} API key is invalid or expired.\n\nHow to fix: open Settings → AI Provider, clear the current key, and paste a valid one from your ${name} account.`
      );
    }
    if (msg.includes('insufficient_quota') || msg.includes('exceeded your current quota') || msg.includes('billing') || e.code === 'insufficient_quota') {
      throw new HttpsError('resource-exhausted',
        `Your ${name} account has no usable quota — this usually means no payment method is on file, or a free-trial credit ran out.\n\nHow to fix: go to your ${name} account's billing page and add a payment method, then try again.`
      );
    }
    if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('rate_limit_exceeded')) {
      throw new HttpsError('resource-exhausted',
        `${name} rate limit reached — you've sent too many requests too quickly.\n\nHow to fix: wait 30–60 seconds and try again. If this keeps happening, consider switching to a different AI provider in Settings.`
      );
    }
    if (status === 403 || msg.includes('permission denied') || msg.includes('access denied')) {
      throw new HttpsError('permission-denied',
        `Your ${name} API key does not have permission for this model (${ai.model}).\n\nHow to fix: check that your ${name} account has access to this model, or choose a different model in Settings → AI Provider.`
      );
    }
    throw new HttpsError('internal', `${name} error: ${e.message}`);
  }
}

function calcCostUsd(ai, inputTokens, outputTokens, isTranslation = false) {
  if (ai.type === 'gemini') {
    const model = isTranslation ? 'gemini-2.5-flash' : ai.model;
    const p = PRICING.gemini[model] || PRICING.gemini['gemini-2.5-flash'];
    return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  }
  if (ai.type === 'openai') {
    const model = isTranslation ? 'gpt-4o-mini' : ai.model;
    const p = PRICING.openai[model] || PRICING.openai['gpt-4o-mini'];
    return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
  }
  const model = isTranslation ? 'claude-haiku-4-5-20251001' : ai.model;
  const p = PRICING.anthropic[model] || PRICING.anthropic['claude-sonnet-4-6'];
  return (inputTokens * p.in + outputTokens * p.out) / 1_000_000;
}

function aiLabel(ai) {
  if (ai.type === 'gemini') return `gemini/${ai.model}`;
  if (ai.type === 'openai') return `openai/${ai.model}`;
  return ai.model;
}

// ─── Prompt templates (editable via Firebase config/prompts) ─────────────────
const DEFAULT_PROMPTS = {
  setup: `You are a media research expert. Research the news media landscape of "{{country}}".

Return ONLY a valid JSON array — no explanation, no markdown, just the raw JSON array starting with [.

Each element must have exactly these fields:
{
  "id": "unique-kebab-case-id",
  "name": "Publication name in English",
  "nameOriginal": "Name in the country's primary language",
  "type": "newspaper" or "tv" or "online" or "radio" or "news_agency" or "podcast",
  "lean": "government" or "pro-government" or "opposition" or "independent" or "pro-faction",
  "leanDescription": "One sentence in English describing the political position and ownership",
  "rssUrl": "Full RSS/Atom feed URL (string) or null if unknown",
  "websiteUrl": "Main website URL",
  "languages": ["Arabic"],
  "notes": "One sentence of important context: reach, influence, history"
}

Rules:
- Include exactly {{numSources}} sources spanning the full political spectrum
- Quality bar: only include outlets that are real, currently operating, and have a significant audience — a national newspaper/broadcaster, or the leading/most-cited outlet in their region or category. Do not include obscure blogs, low-circulation fringe sites, or defunct outlets just to fill a slot.
- In "notes", state the outlet's approximate reach or standing in plain terms (e.g. "one of the country's 2-3 largest daily newspapers", "state broadcaster, primary TV news source", "leading English-language outlet for expats/foreign readers") — the person reading this may not know the country's media landscape and needs to judge legitimacy from this line alone
- Prioritize sources that have RSS feeds
- Be honest: if a country has no real opposition press, note that and include exile/diaspora sources — but still prefer the most established one available (largest readership/longest track record), not an obscure blog
- For the lean field, use exactly one of the 5 values listed above
- Do not include sources you are not reasonably confident exist

Country: {{country}}`,

  analysis: `You are analyzing news coverage from "{{sourceName}}" ({{sourceLean}} outlet in {{country}}).
Context: {{leanDescription}}

Date: {{date}}
Topics of interest: {{topicList}}

Articles fetched from RSS on {{date}}:
{{articlesText}}

Keyword matches (pre-identified — article contains the topic word in its title or body):
{{topicMatchesText}}

RULES — follow exactly:
1. covered: use the pre-identified keyword matches above. If a topic has matched articles listed, covered: true. If listed as "none", covered: false. Do not apply your own judgment — the keyword check is authoritative.
2. If covered: false, set summary: "No articles about this topic were published in this outlet on {{date}}.", narrative: null, quotes: [], tone: "neutral".
3. For covered topics, write summary/narrative/quotes using ONLY the matched articles. Do NOT use background knowledge or information not in the articles.
4. Quotes must be copied verbatim from the articles — do not paraphrase or invent.
5. keyStories: up to 3 article titles from the matched articles across all topics. If none, return [].

Respond in {{lang}} ONLY. Return ONLY valid JSON (no markdown, no explanation):
{
  "topicAnalyses": [
    {
      "topic": "topic name",
      "covered": true or false,
      "summary": "{{summaryLen}} based strictly on matched articles, or the not-covered message",
      "tone": "positive" or "negative" or "neutral" or "alarmed" or "dismissive",
      "narrative": "Key framing from the matched articles only, or null if not covered",
      "quotes": ["Verbatim quote from matched article"]
    }
  ],
  "overallTone": "one word",
  "keyStories": ["article title 1", "article title 2"]
}`,

  period: `You are a media analyst with deep knowledge of {{country}}'s press landscape.

Analyze how {{country}}'s media covered the following topics between {{startDate}} and {{endDate}}, drawing on your training knowledge of each outlet's editorial patterns and typical coverage during this period.

Topics: {{topicList}}
{{personaLine}}
Organize your analysis by political lean (government-aligned, opposition, independent), then by topic within each group. Focus on divergent narratives and what each camp emphasized, downplayed, or framed differently.
Write approximately {{reportLen}} for each topic entry inside a group.

Return ONLY valid JSON (no markdown, no explanation):
{
  "country": "{{country}}",
  "period": "{{startDate}} to {{endDate}}",
  "leanGroups": [
    {
      "lean": "government",
      "label": "Government / Pro-Government Media",
      "outlets": ["outlet1", "outlet2"],
      "overallNarrative": "One sentence on the dominant framing across this camp",
      "topics": [
        {
          "topic": "topic name",
          "summary": "{{reportLen}} — how this political camp covered this topic during the period",
          "keyNarratives": ["narrative 1", "narrative 2"],
          "tone": "positive" or "negative" or "neutral" or "alarmed" or "dismissive"
        }
      ]
    }
  ],
  "synthesis": {
    "consensus": "What all camps agreed on",
    "faultLines": "The sharpest divergence in coverage",
    "blindSpots": "Topics underreported across all outlets",
    "evolution": "How coverage shifted during the period (if notable)"
  }
}

Include groups for government (or pro-government), opposition, and independent. If a group does not meaningfully exist in {{country}}'s media landscape, omit it and note it in synthesis.blindSpots.`,

  // Deliberately NOT the setup prompt above: that one is built to name a
  // country's obvious major outlets, which is exactly what's already in the
  // user's list by the time they're using "Add More". Reusing it just makes
  // the AI re-derive the same famous handful and then get excluded down to
  // nothing. {{locationClause}}/{{mediaTypeClause}}/{{orientationClause}}/
  // {{languageClause}} are pre-built sentence fragments (empty string if not
  // applicable) — see addSources() for how they're assembled.
  addSources: `You are a media research expert helping expand an existing news-source list for "{{country}}".

The user already has these outlets — do NOT suggest any of them again, and do not suggest rebrands/close variants of them:
{{existingNames}}

Find {{requestCount}} additional, genuinely different outlets not in that list.{{locationClause}}{{mediaTypeClause}}{{orientationClause}}{{languageClause}} Go beyond the handful of most obvious major national outlets — consider regional/local papers and broadcasters, other national outlets not yet listed, niche or specialty outlets, wire services/news agencies, and outlets with a different political lean than what's already represented.

Return ONLY a valid JSON array — no explanation, no markdown, just the raw JSON array starting with [.

Each element must have exactly these fields:
{
  "id": "unique-kebab-case-id",
  "name": "Publication name in English",
  "nameOriginal": "Name in the country's primary language",
  "type": "newspaper" or "tv" or "online" or "radio" or "news_agency" or "podcast",
  "lean": "government" or "pro-government" or "opposition" or "independent" or "pro-faction",
  "leanDescription": "One sentence in English describing the political position and ownership",
  "rssUrl": "Full RSS/Atom feed URL (string) or null if unknown",
  "websiteUrl": "Main website URL",
  "languages": ["Arabic"],
  "notes": "One sentence of important context: reach, influence, history"
}

Rules:
- Include exactly {{requestCount}} sources, ALL different from the excluded list above
- Quality bar — same as any first-pass list: only real, currently operating outlets with a significant audience (national reach, or the leading outlet in their region/category/niche). Going beyond the obvious major outlets does NOT mean lowering the bar — do not include obscure blogs, low-circulation fringe sites, or defunct outlets just to hit the count.
- In "notes", state the outlet's approximate reach or standing in plain terms — the reader may not know this country's media landscape and needs to judge legitimacy from this line alone
- Prioritize sources that have RSS feeds
- For the lean field, use exactly one of the 5 values listed above
- Do not include sources you are not reasonably confident exist

Country: {{country}}`
};

function fillPrompt(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] !== undefined ? String(vars[key]) : `{{${key}}}`
  );
}

async function getCustomPrompts() {
  try {
    const snap = await db.ref('config/prompts').once('value');
    return snap.val() || {};
  } catch { return {}; }
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function countryToKey(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

function extractJson(text, startChar) {
  const idx = text.indexOf(startChar);
  if (idx === -1) throw new Error('No JSON found in response');
  const end = startChar === '[' ? text.lastIndexOf(']') : text.lastIndexOf('}');
  return JSON.parse(text.slice(idx, end + 1));
}

async function fetchRss(url, limit = 25) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  let xml;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RoyNewsBot/1.0; +https://roy-news.web.app)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    xml = await res.text();
  } finally {
    clearTimeout(timer);
  }
  const feed = await rssParser.parseString(xml);
  const seen = new Set();
  return feed.items
    .map(item => ({
      title: (item.title || '').trim(),
      text: (item.contentSnippet || item.description || '').slice(0, 600).trim(),
      link: item.link || '',
      date: item.pubDate || ''
    }))
    .filter(a => {
      if (!a.title) return false;
      const key = a.title.toLowerCase().slice(0, 80);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

// Fetches a candidate RSS/Atom feed once and reports back both whether it's
// usable and what it actually looks like day-to-day: how many items it
// currently holds (its "queue depth") and the time span those items cover
// (oldest to newest pubDate). A feed with 10 items spanning 4 hours behaves
// very differently at query time than one with 10 items spanning 3 days —
// this is what actually determines whether a source's own feed can be relied
// on for a given lookback window, independent of the app's articleLimit.
async function probeRssFeed(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RoyNewsBot/1.0; +https://roy-news.web.app)' }
    });
    if (!res.ok) return { valid: false };
    const xml = await res.text();
    const feed = await rssParser.parseString(xml);
    const itemCount = feed.items.length;
    const dates = feed.items
      .map(i => new Date(i.pubDate))
      .filter(d => !isNaN(d))
      .sort((a, b) => b - a);
    const spanHours = dates.length >= 2 ? Math.round((dates[0] - dates[dates.length - 1]) / 3600000) : null;
    return { valid: true, feedStats: { itemCount, spanHours, checkedAt: new Date().toISOString() } };
  } catch { return { valid: false }; }
  finally { clearTimeout(timer); }
}

async function fetchRssWithRetry(url, limit = 25) {
  const backoff = [1500, 3500];
  let lastErr;
  for (let i = 0; i <= backoff.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, backoff[i - 1]));
    try { return await fetchRss(url, limit); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

const GOOGLE_NEWS_PARAMS = {
  'united-state': { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  'israel':       { hl: 'iw',    gl: 'IL', ceid: 'IL:iw' },
};
// Google typically returns up to ~100 items for a news search — pull that
// whole pool before filtering by exact date, not just articleLimit's worth.
const GOOGLE_NEWS_FETCH_POOL = 100;

function deriveGoogleNewsUrl(source, countryKey, topics = []) {
  let domain = source.domain || null;
  if (!domain) {
    const toDomain = u => {
      try { const h = new URL(u).hostname.split('.'); return h.length >= 2 ? h.slice(-2).join('.') : h.join('.'); }
      catch { return null; }
    };
    domain = (source.rssUrl && toDomain(source.rssUrl)) || (source.websiteUrl && toDomain(source.websiteUrl));
  }
  if (!domain) return null;
  const p = GOOGLE_NEWS_PARAMS[countryKey] || { hl: 'en-US', gl: 'US', ceid: 'US:en' };
  // Build query: & separates required terms (AND); multi-word parts quoted as phrases; topics OR'd
  // e.g. "Mundial & red card" → Mundial "red card"
  // e.g. ["Mundial & red card", "economy"] → site:domain (Mundial "red card" OR economy)
  const topicQueries = topics
    .map(t => t.split(/[&,]/).map(p => p.trim()).filter(p => p.length > 0)
      .map(p => p.includes(' ') ? `"${p}"` : p).join(' '))
    .filter(q => q.length > 0)
    .slice(0, 4);
  // NOTE: news.google.com/rss/search does NOT honor after:/before: date
  // operators (verified directly — results were identical with or without
  // them). There's no real date-range filter available on this endpoint, so
  // exact-date matching has to happen entirely by filtering the results below.
  const q = topicQueries.length > 0
    ? `site:${domain} (${topicQueries.join(' OR ')})`
    : `site:${domain}`;
  const qs = new URLSearchParams({ q, hl: p.hl, gl: p.gl, ceid: p.ceid });
  return `https://news.google.com/rss/search?${qs}`;
}

// Calendar day the *publisher* stamped on the article (their local
// timezone), not the UTC day. A straight `new Date(articleDate).toISOString()`
// normalizes to UTC first, which silently reclassifies any article published
// in the early local morning (e.g. 06:00 +0700 in Bangkok) as the *previous*
// UTC day — so every early-morning article from a non-UTC outlet was being
// filtered out as "not from the requested date" even though the outlet
// itself dated it today.
function publisherLocalDateStr(articleDate) {
  const d = new Date(articleDate);
  if (isNaN(d)) return null;
  const offsetMatch = articleDate.match(/([+-])(\d{2}):?(\d{2})\s*$/);
  const offsetMinutes = offsetMatch
    ? (offsetMatch[1] === '-' ? -1 : 1) * (parseInt(offsetMatch[2], 10) * 60 + parseInt(offsetMatch[3], 10))
    : 0;
  return new Date(d.getTime() + offsetMinutes * 60000).toISOString().slice(0, 10);
}

// Matches an RSS pubDate against the requested "YYYY-MM-DD" date plus up to
// `lookbackDays` earlier calendar days — a source's own feed or Google News'
// index frequently hasn't caught up with the exact requested day yet, so a
// same-day-only match misses real coverage that's a day or two old.
function matchesDateRange(articleDate, requestedDate, lookbackDays = 0) {
  if (!requestedDate || !articleDate) return false;
  const articleDay = publisherLocalDateStr(articleDate);
  if (!articleDay) return false;
  const diffDays = Math.round((Date.parse(requestedDate + 'T00:00:00Z') - Date.parse(articleDay + 'T00:00:00Z')) / 86400000);
  return diffDays >= 0 && diffDays <= lookbackDays;
}

// Human-readable label for the effective window being searched, used in
// user-facing "no coverage found" text so it accurately reflects what was
// actually checked (not just the single anchor date).
function dateRangeLabel(requestedDate, lookbackDays = 0) {
  if (!lookbackDays) return requestedDate;
  const start = new Date(Date.parse(requestedDate + 'T00:00:00Z') - lookbackDays * 86400000).toISOString().slice(0, 10);
  return `${start} to ${requestedDate}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 1: Setup Country
// ─────────────────────────────────────────────────────────────────────────────
exports.setupCountry = onCall(
  { timeoutSeconds: 120, memory: '512MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, numSources: rawNumSources, filterNoRSS } = request.data;
    if (!country || typeof country !== 'string') throw new HttpsError('invalid-argument', 'country required');
    const numSources = Math.min(Math.max(parseInt(rawNumSources) || 7, 1), 15);

    const ai = makeAI(request.data);
    const customPrompts = await getCustomPrompts();
    const prompt = fillPrompt(customPrompts.setup || DEFAULT_PROMPTS.setup, { country, numSources });

    const { text, usage } = await callAI(ai, prompt, 3000);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);

    let sources;
    try {
      sources = extractJson(text, '[');
    } catch (e) {
      throw new HttpsError('internal', 'Failed to parse sources from AI: ' + e.message);
    }

    // Validate RSS URLs in parallel — drop any that fail to load, and record
    // each working feed's item count / time span for display in the UI
    const probes = await Promise.all(
      sources.map(s => s.rssUrl ? probeRssFeed(s.rssUrl) : Promise.resolve({ valid: false }))
    );
    sources = sources.map((s, i) => probes[i].valid ? { ...s, feedStats: probes[i].feedStats } : { ...s, rssUrl: null });
    if (filterNoRSS) sources = sources.filter(s => s.rssUrl);

    const countryKey = countryToKey(country);
    const setupDate = new Date().toISOString();
    await Promise.all([
      db.ref(`countries/${countryKey}/setup`).set({ country, countryKey, sources, setupDate, model: aiLabel(ai) }),
      db.ref(`country-meta/${countryKey}`).set({ country, countryKey, setupDate }),
    ]);

    return { countryKey, sources };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT: Add More Sources (append to existing, exclude already-listed names)
// ─────────────────────────────────────────────────────────────────────────────
const ORIENTATION_LABELS = { government: 'government', 'pro-government': 'pro-government', opposition: 'opposition', independent: 'independent', 'pro-faction': 'pro-faction (aligned with a specific political party, movement, or armed faction — not the state itself, not neutral)' };
const MEDIA_TYPE_LABELS = { newspaper: 'newspaper', tv: 'TV', radio: 'radio', podcast: 'podcast' };

exports.addSources = onCall(
  { timeoutSeconds: 120, memory: '512MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, numSources: rawNum, filterNoRSS, existingNames, location, mediaType, orientation, language } = request.data;
    if (!country || typeof country !== 'string') throw new HttpsError('invalid-argument', 'country required');
    const numSources = Math.min(Math.max(parseInt(rawNum) || 5, 1), 10);
    // Ask for a few more than requested so losses to dedup/RSS validation
    // don't zero out the result — the client still only shows `numSources`.
    const requestCount = numSources + 3;
    const existing = existingNames?.length ? existingNames : [];
    const existingLower = existing.map(n => n.trim().toLowerCase());

    const locationClause = location?.trim()
      ? ` Focus specifically on outlets based in or covering ${location.trim()}, ${country} — not the country as a whole.`
      : '';
    const mediaTypeClause = MEDIA_TYPE_LABELS[mediaType]
      ? ` Only include ${MEDIA_TYPE_LABELS[mediaType]} outlets.`
      : '';
    const orientationClause = ORIENTATION_LABELS[orientation]
      ? ` Every outlet must be classified as "${orientation}" per the lean definitions below (${ORIENTATION_LABELS[orientation]}).`
      : '';
    const languageClause = language === 'native'
      ? ` Only include outlets that primarily publish in the country's own native/local language(s) — not English-language outlets aimed at foreigners or expats.`
      : ` Only include outlets that primarily publish in English.`;

    const ai = makeAI(request.data);
    const customPrompts = await getCustomPrompts();
    const prompt = fillPrompt(customPrompts.addSources || DEFAULT_PROMPTS.addSources, {
      country, requestCount,
      existingNames: existing.length ? existing.join(', ') : '(none yet)',
      locationClause, mediaTypeClause, orientationClause, languageClause,
    });

    const { text, usage } = await callAI(ai, prompt, 3000);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
    let sources;
    try { sources = extractJson(text, '['); }
    catch (e) { throw new HttpsError('internal', 'Failed to parse sources: ' + e.message); }

    const aiReturnedCount = sources.length;
    // Safety net: the AI doesn't always follow the exclusion instruction.
    sources = sources.filter(s => !existingLower.includes((s.name || '').trim().toLowerCase()));
    const duplicatesSkipped = aiReturnedCount - sources.length;

    const probes = await Promise.all(
      sources.map(s => s.rssUrl ? probeRssFeed(s.rssUrl) : Promise.resolve({ valid: false }))
    );
    sources = sources.map((s, i) => probes[i].valid ? { ...s, feedStats: probes[i].feedStats } : { ...s, rssUrl: null });
    const beforeRssFilter = sources.length;
    if (filterNoRSS) sources = sources.filter(s => s.rssUrl);
    const rssFilteredCount = filterNoRSS ? beforeRssFilter - sources.length : 0;
    sources = sources.slice(0, numSources);

    if (sources.length > 0 && countryKey) {
      try {
        const snap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
        const existingStored = snap.val() || [];
        await db.ref(`countries/${countryKey}/setup/sources`).set([...existingStored, ...sources]);
      } catch {}
    }

    return { sources, duplicatesSkipped, rssFilteredCount };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT: Find Source by Name
// ─────────────────────────────────────────────────────────────────────────────
exports.findSource = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, sourceName } = request.data;
    if (!country || !sourceName) throw new HttpsError('invalid-argument', 'country and sourceName required');

    const ai = makeAI(request.data);
    const prompt = `Find the news outlet "${sourceName}" in ${country}.
Return ONLY valid JSON (no markdown, no explanation):
{
  "id": "unique-kebab-case-id",
  "name": "Publication name in English",
  "nameOriginal": "Name in local language (or same as name if English)",
  "type": "newspaper" or "tv" or "online" or "radio" or "news_agency",
  "lean": "government" or "pro-government" or "opposition" or "independent" or "pro-faction",
  "leanDescription": "One sentence on political position and ownership",
  "rssUrl": "Full RSS feed URL or null if unknown",
  "websiteUrl": "Main website URL",
  "languages": ["English"],
  "notes": "One sentence on reach and influence"
}
If this outlet does not exist in ${country} or you are not confident it exists, return: null`;

    const { text, usage } = await callAI(ai, prompt, 600);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
    let source = null;
    try {
      if (!text.trim().toLowerCase().startsWith('null')) {
        const parsed = extractJson(text, '{');
        if (parsed && parsed.id) {
          if (parsed.rssUrl) {
            const probe = await probeRssFeed(parsed.rssUrl);
            if (!probe.valid) parsed.rssUrl = null;
            else parsed.feedStats = probe.feedStats;
          }
          source = parsed;
        }
      }
    } catch {}

    return { source };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared per-source topic analysis — used by both the live fetchNews call and
// the scheduled report generator, so the "only pay for what's relevant" and
// keyword-override logic exists in exactly one place.
// ─────────────────────────────────────────────────────────────────────────────
function computeTopicKeywordMatches(articles, topics) {
  const topicKeywordMatches = {};
  for (const topic of topics) {
    const kw = topic.toLowerCase();
    topicKeywordMatches[topic] = articles.reduce((acc, a, i) => {
      if ((a.title + ' ' + (a.text || '')).toLowerCase().includes(kw)) acc.push(i + 1);
      return acc;
    }, []);
  }
  return topicKeywordMatches;
}

function relevantIndicesFromMatches(topicKeywordMatches) {
  return [...new Set(Object.values(topicKeywordMatches).flat())].sort((a, b) => a - b);
}

function notCoveredAnalysis(topics, dateLabel) {
  return {
    topicAnalyses: topics.map(t => ({
      topic: t, covered: false,
      summary: `No articles about this topic were published in this outlet on ${dateLabel}.`,
      tone: 'neutral', narrative: null, quotes: []
    })),
    overallTone: 'neutral', keyStories: [], relevantArticleIndices: []
  };
}

// Given articles already fetched/date-filtered by the caller, matches them
// against topics and (only if something matched) calls the AI with just the
// relevant articles — not the full set — since unrelated same-day articles
// cost tokens without ever being quoted or summarized.
async function analyzeArticlesForTopics({ ai, source, articles, topics, country, dateLabel, summaryLen, customPrompts }) {
  if (articles.length === 0) {
    return { text: JSON.stringify(notCoveredAnalysis(topics, dateLabel)), usage: null, relevantIndices: [], topicKeywordMatches: {} };
  }

  const topicKeywordMatches = computeTopicKeywordMatches(articles, topics);
  const relevantIndices = relevantIndicesFromMatches(topicKeywordMatches);

  if (relevantIndices.length === 0) {
    return { text: JSON.stringify(notCoveredAnalysis(topics, dateLabel)), usage: null, relevantIndices, topicKeywordMatches };
  }

  const relevantArticles = relevantIndices.map(i => articles[i - 1]);
  const origToLocal = new Map(relevantIndices.map((origIdx, localIdx) => [origIdx, localIdx + 1]));
  const articlesText = relevantArticles.map((a, i) => `${i + 1}. ${a.title}\n${a.text}`).join('\n\n');
  const topicMatchesText = topics.map(t => {
    const idx = topicKeywordMatches[t].map(origIdx => origToLocal.get(origIdx));
    return `- ${t}: ${idx.length > 0 ? idx.map(i => `article ${i}`).join(', ') : 'none'}`;
  }).join('\n');

  const prompt = fillPrompt(customPrompts.analysis || DEFAULT_PROMPTS.analysis, {
    sourceName: source.name, sourceLean: source.lean, country,
    leanDescription: source.leanDescription, date: dateLabel, topicList: topics.join(', '),
    articlesText, topicMatchesText, lang: 'English', summaryLen
  });

  const { text, usage } = await callAI(ai, prompt, 3000);
  return { text, usage, relevantIndices, topicKeywordMatches };
}

// Applies the AI's parsed analysis + the server-side keyword override that
// makes covered/not-covered authoritative regardless of what the prompt says.
function finalizeAnalysis(rawText, relevantIndices, topicKeywordMatches, dateLabel) {
  let analysis = null;
  if (rawText) {
    try { analysis = extractJson(rawText, '{'); }
    catch { analysis = { error: 'parse_error', raw: rawText.slice(0, 500) }; }
  }
  if (analysis && relevantIndices !== undefined) {
    analysis.relevantArticleIndices = relevantIndices;
    if (Array.isArray(analysis.topicAnalyses) && topicKeywordMatches) {
      analysis.topicAnalyses = analysis.topicAnalyses.map(ta => {
        const key = Object.keys(topicKeywordMatches).find(t => t.toLowerCase() === (ta.topic || '').toLowerCase());
        if (!key) return ta;
        const hasMatch = topicKeywordMatches[key].length > 0;
        if (hasMatch && !ta.covered) return { ...ta, covered: true };
        if (!hasMatch && ta.covered) return { ...ta, covered: false, summary: `No articles about this topic were published in this outlet on ${dateLabel}.`, narrative: null, quotes: [], tone: 'neutral' };
        return ta;
      });
    }
  }
  return analysis;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2: Fetch News
// ─────────────────────────────────────────────────────────────────────────────
exports.fetchNews = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, selectedSources, topics, date, summaryWords, maxArticles, lookbackDays: rawLookbackDays } = request.data;
    const summaryLen = `~${Math.min(Math.max(summaryWords || 100, 30), 300)}-word summary`;
    const articleLimit = Math.min(Math.max(parseInt(maxArticles) || 25, 10), 50);
    const parsedLookbackDays = parseInt(rawLookbackDays);
    const lookbackDays = Math.min(Math.max(Number.isFinite(parsedLookbackDays) ? parsedLookbackDays : 1, 0), 14);
    if (!country || !selectedSources?.length) throw new HttpsError('invalid-argument', 'country and sources required');

    const ai = makeAI(request.data);
    const dateLabel = dateRangeLabel(date, lookbackDays);
    const allResults = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const customPrompts = await getCustomPrompts();

    // ── Per-source analysis — all sources run in parallel ───────────────────
    const sourceResults = await Promise.all(selectedSources.map(async (source) => {
      let articles = [];
      let rssError = null;
      let usedGoogleNews = false;

      // Step 1: try the source's own RSS feed, kept to articles within the
      // requested date window (the anchor date plus up to lookbackDays earlier)
      if (source.rssUrl) {
        try {
          const fetched = await fetchRssWithRetry(source.rssUrl, articleLimit);
          articles = fetched.filter(a => matchesDateRange(a.date, date, lookbackDays));
          if (fetched.length > 0 && articles.length === 0) rssError = `No articles from ${dateLabel} in this feed's recent window`;
        }
        catch (e) { rssError = e.message; }
      }

      // Step 2: own RSS had nothing in that window — try Google News.
      // Google's search endpoint has no real date-range filter (its after:/
      // before: operators are silently ignored there), so instead we pull a
      // much larger pool of its results and filter *those* down ourselves —
      // filtering after truncating to articleLimit would throw away date
      // matches that just weren't near the top of Google's relevance ranking.
      if (articles.length === 0) {
        const googleUrl = deriveGoogleNewsUrl(source, countryKey, topics);
        if (googleUrl) {
          try {
            const googleArticles = await fetchRssWithRetry(googleUrl, GOOGLE_NEWS_FETCH_POOL);
            const dated = googleArticles.filter(a => matchesDateRange(a.date, date, lookbackDays)).slice(0, articleLimit);
            if (dated.length > 0) { articles = dated; rssError = null; usedGoogleNews = true; }
          } catch {}
        }
      }

      if (articles.length === 0) {
        return { source, articles, rssError, usage: null, text: null, usedGoogleNews };
      }

      // Step 3: had date-matched articles but none matched any topic yet —
      // try Google News for this source+topic before giving up on it
      const preMatches = computeTopicKeywordMatches(articles, topics);
      if (relevantIndicesFromMatches(preMatches).length === 0 && !usedGoogleNews) {
        const googleUrl = deriveGoogleNewsUrl(source, countryKey, topics);
        if (googleUrl) {
          try {
            const googleArticles = await fetchRssWithRetry(googleUrl, GOOGLE_NEWS_FETCH_POOL);
            const dated = googleArticles.filter(a => matchesDateRange(a.date, date, lookbackDays)).slice(0, articleLimit);
            if (dated.length > 0) { articles = dated; rssError = null; usedGoogleNews = true; }
          } catch {}
        }
      }

      try {
        const { text, usage, relevantIndices, topicKeywordMatches } = await analyzeArticlesForTopics({
          ai, source, articles, topics, country, dateLabel, summaryLen, customPrompts
        });
        return { source, articles, rssError, usage, text, relevantIndices, topicKeywordMatches, usedGoogleNews };
      } catch (e) {
        return { source, articles: [], rssError, error: e.message, usedGoogleNews };
      }
    }));

    for (const r of sourceResults) {
      if (r.error) {
        allResults[r.source.id] = { source: r.source, articles: [], analysis: null, error: r.error };
      } else {
        totalInputTokens  += r.usage?.input_tokens  || 0;
        totalOutputTokens += r.usage?.output_tokens || 0;
        const analysis = finalizeAnalysis(r.text, r.relevantIndices, r.topicKeywordMatches, dateLabel);
        allResults[r.source.id] = { source: r.source, articles: r.articles, analysis, fetchedAt: new Date().toISOString(), rssError: r.rssError, usedGoogleNews: r.usedGoogleNews || false };
      }
    }

    const costUsd = await recordCost(request, ai, totalInputTokens, totalOutputTokens);
    const rssCount = sourceResults.filter(r => !r.error && r.articles?.length > 0 && !r.usedGoogleNews).length;
    const googleNewsCount = sourceResults.filter(r => !r.error && r.articles?.length > 0 && r.usedGoogleNews).length;
    return { results: allResults, date, usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd, provider: ai.type, model: ai.model, rssCount, googleNewsCount } };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 3: Translate Results
// ─────────────────────────────────────────────────────────────────────────────
async function translateBatch(ai, batch) {
  const prompt = `Translate each English text in this JSON array to Hebrew.
Return ONLY a valid JSON array with exactly ${batch.length} elements in the same order.
Each element must be a properly JSON-escaped string. Preserve empty strings as "".
Do not add markdown, code blocks, or any explanation. Start with [ and end with ].

${JSON.stringify(batch)}`;

  const { text, usage } = await callAI(ai, prompt, 8000);
  return { translations: extractJson(text, '['), usage };
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT: Fix Single Source URL
// ─────────────────────────────────────────────────────────────────────────────
exports.fixSourceUrl = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, sourceName } = request.data;
    if (!country || !sourceName) throw new HttpsError('invalid-argument', 'country and sourceName required');

    const ai = makeAI(request.data);
    const prompt = `Find the current working RSS or Atom feed URL for the news outlet "${sourceName}" in ${country}.
Return ONLY valid JSON: { "rssUrl": "https://..." }
The URL must be a real, publicly accessible RSS/Atom feed that exists right now.
If you are not confident a working URL exists, return: { "rssUrl": null }`;

    const { text, usage } = await callAI(ai, prompt, 200);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
    let rssUrl = null;
    let feedStats = null;
    try {
      const parsed = extractJson(text, '{');
      if (parsed.rssUrl) {
        const probe = await probeRssFeed(parsed.rssUrl);
        if (probe.valid) { rssUrl = parsed.rssUrl; feedStats = probe.feedStats; }
      }
    } catch {}

    // Always update Firebase — set new URL if found, null out old broken URL if not
    try {
      const snap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
      const sources = snap.val();
      if (Array.isArray(sources)) {
        const updated = sources.map(s => s.name === sourceName ? { ...s, rssUrl: rssUrl || null, feedStats: feedStats || null } : s);
        await db.ref(`countries/${countryKey}/setup/sources`).set(updated);
      }
    } catch {}

    return { rssUrl, feedStats };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT: Check Feed Stats (no AI call — just re-probes an existing rssUrl for
// its current item count / time span, e.g. for sources added before this
// feature existed, or to spot-check whether a feed's cadence has changed)
// ─────────────────────────────────────────────────────────────────────────────
exports.checkFeedStats = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey, sourceId, rssUrl } = request.data || {};
    if (!countryKey || !sourceId || !rssUrl) throw new HttpsError('invalid-argument', 'countryKey, sourceId, and rssUrl required');

    const probe = await probeRssFeed(rssUrl);
    // Only persist on a successful probe — a single timed-out check shouldn't
    // erase stats that were previously working fine.
    if (probe.valid) {
      try {
        const snap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
        const sources = snap.val();
        if (Array.isArray(sources)) {
          const updated = sources.map(s => s.id === sourceId ? { ...s, feedStats: probe.feedStats } : s);
          await db.ref(`countries/${countryKey}/setup/sources`).set(updated);
        }
      } catch {}
    }
    return { valid: probe.valid, feedStats: probe.valid ? probe.feedStats : null };
  }
);

exports.translateResults = onCall(
  { timeoutSeconds: 120, memory: '256MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { texts } = request.data;
    if (!Array.isArray(texts) || texts.length === 0) throw new HttpsError('invalid-argument', 'texts array required');

    const ai = makeAI(request.data, true); // forTranslation=true → uses cheapest model per provider
    const BATCH_SIZE = 20;
    const allTranslations = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      try {
        const { translations, usage } = await translateBatch(ai, batch);
        allTranslations.push(...translations);
        totalInputTokens  += usage?.input_tokens  || 0;
        totalOutputTokens += usage?.output_tokens || 0;
      } catch (e) {
        throw new HttpsError('internal', `Translation batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${e.message}`);
      }
    }

    const costUsd = await recordCost(request, ai, totalInputTokens, totalOutputTokens, true);
    return { translations: allTranslations, usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens, costUsd, provider: ai.type, model: ai.model } };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 4: Period Summary
// ─────────────────────────────────────────────────────────────────────────────
exports.fetchPeriodSummary = onCall(
  { timeoutSeconds: 120, memory: '512MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, topics, startDate, endDate, periodReportWords: rawReportWords, persona } = request.data;
    if (!country || !topics?.length || !startDate || !endDate) {
      throw new HttpsError('invalid-argument', 'country, topics, startDate, endDate required');
    }
    const reportLen = `~${Math.min(Math.max(parseInt(rawReportWords) || 150, 50), 500)}-word summary`;
    const personaLine = persona
      ? `\nReader profile — apply actively and explicitly throughout:\n${persona}\n\nYou must: foreground ideological roots and cultural patterns behind each camp's framing; explicitly call out when an Israeli angle or perspective appears in coverage; tailor which fault lines, blind spots, and narrative shifts you emphasize to directly serve this reader's stated purpose.\n`
      : '';

    const ai = makeAI(request.data);
    const topicList = topics.join(', ');
    const customPrompts = await getCustomPrompts();
    const prompt = fillPrompt(customPrompts.period || DEFAULT_PROMPTS.period, {
      country, topicList, startDate, endDate, reportLen, personaLine
    });

    const { text, usage } = await callAI(ai, prompt, 4000);

    let result;
    try {
      result = extractJson(text, '{');
    } catch (e) {
      throw new HttpsError('internal', 'Failed to parse period summary from AI: ' + e.message);
    }

    const costUsd = await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
    return {
      result,
      usage: { inputTokens: usage?.input_tokens || 0, outputTokens: usage?.output_tokens || 0, costUsd, provider: ai.type, model: ai.model }
    };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Live model catalog — lets Settings show each provider's current model list
// (ours goes stale as providers ship new models) with a price hint per model.
// ─────────────────────────────────────────────────────────────────────────────
function cheapestModelId(models) {
  const priced = models.filter(m => m.price);
  if (priced.length === 0) return null;
  return priced.reduce((a, b) => (a.price.in + a.price.out) <= (b.price.in + b.price.out) ? a : b).id;
}

exports.listProviderModels = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { provider, apiKey } = request.data || {};
    if (!apiKey || typeof apiKey !== 'string') throw new HttpsError('invalid-argument', 'apiKey required');

    async function fetchJson(url, headers) {
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        throw new HttpsError('unavailable', `Could not reach the provider: ${e.message}`);
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new HttpsError('permission-denied', 'That API key was rejected. Double-check it and try again.');
        }
        throw new HttpsError('failed-precondition', `Could not list models (HTTP ${res.status}).`);
      }
      return res.json();
    }

    if (provider === 'openai') {
      const json = await fetchJson('https://api.openai.com/v1/models', { Authorization: `Bearer ${apiKey}` });
      const EXCLUDE = /embedding|whisper|tts|dall-e|davinci|babbage|moderation|realtime|audio|transcribe|image|search|omni-moderation/i;
      const models = (json.data || [])
        .filter(m => /^(gpt-|o[1-9]|chatgpt|chat-)/i.test(m.id) && !EXCLUDE.test(m.id))
        .map(m => ({ id: m.id, price: PRICING.openai[m.id] || null }))
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, cheapestId: cheapestModelId(models) };
    }
    if (provider === 'anthropic') {
      const json = await fetchJson('https://api.anthropic.com/v1/models', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
      const models = (json.data || [])
        .map(m => ({ id: m.id, label: m.display_name || null, price: PRICING.anthropic[m.id] || null }))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
      return { models, cheapestId: cheapestModelId(models) };
    }
    if (provider === 'gemini') {
      const json = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {});
      const models = (json.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && !/embedding|aqa|imagen|veo/i.test(m.name))
        .map(m => {
          const id = m.name.replace(/^models\//, '');
          return { id, label: m.displayName || null, price: PRICING.gemini[id] || null };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      return { models, cheapestId: cheapestModelId(models) };
    }
    throw new HttpsError('invalid-argument', 'Unknown provider');
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Access control — who's allowed to use the app, and the admin panel behind it
// ─────────────────────────────────────────────────────────────────────────────
exports.getMyRole = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login required');
    const role = await getRole(request.auth.token.email);
    // Mirror the authorization result into a uid-keyed index so database rules
    // (which can't call getRole themselves) can gate reads without exposing
    // authorizedUsers/userCosts to clients.
    await db.ref(`authorizedUids/${request.auth.uid}`).set(role ? true : null).catch(() => {});
    return { role };
  }
);

// costs shape per user: { "YYYY-MM": { gemini: 1.23, openai: 0.45, anthropic: 0 } }
exports.getCosts = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    const role = await requireAuthorized(request);
    const { scope } = request.data || {};
    if (scope === 'all') {
      requireAdmin(role);
      const snap = await db.ref('userCosts').once('value');
      const val = snap.val() || {};
      const users = Object.entries(val).map(([uid, u]) => ({ uid, email: u.email || null, costs: u.costs || {} }));
      return { users };
    }
    const snap = await db.ref(`userCosts/${request.auth.uid}/costs`).once('value');
    return { costs: snap.val() || {} };
  }
);

async function lastLoginForEmail(email) {
  const uid = await resolveUidByEmail(email);
  if (!uid) return null;
  const snap = await db.ref(`users/${uid}/lastLogin`).once('value');
  return snap.val() || null;
}

exports.listAuthorizedUsers = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const snap = await db.ref('authorizedUsers').once('value');
    const val = snap.val() || {};
    const users = await Promise.all(
      Object.values(val).map(async u => ({ ...u, lastLogin: await lastLoginForEmail(u.email) }))
    );
    users.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    const ownerLastLogin = await lastLoginForEmail(OWNER_EMAIL);
    return { owner: OWNER_EMAIL, ownerLastLogin, users };
  }
);

exports.addAuthorizedUser = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail, role: newRole } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'Invalid email address');
    if (email === OWNER_EMAIL) throw new HttpsError('invalid-argument', 'That email is already the owner');
    const finalRole = newRole === 'admin' ? 'admin' : 'user';
    await db.ref(`authorizedUsers/${sanitizeEmailKey(email)}`).set({
      email, role: finalRole, addedAt: new Date().toISOString(), addedBy: request.auth.token.email
    });
    return { ok: true };
  }
);

exports.removeAuthorizedUser = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const { email: rawEmail } = request.data || {};
    if (!rawEmail || typeof rawEmail !== 'string') throw new HttpsError('invalid-argument', 'email required');
    const email = rawEmail.trim().toLowerCase();
    await db.ref(`authorizedUsers/${sanitizeEmailKey(email)}`).remove();
    // Best-effort: revoke read access immediately for the uid we know maps to this
    // email (from prior logins), instead of waiting for their next getMyRole call.
    const uid = await resolveUidByEmail(email).catch(() => null);
    if (uid) await db.ref(`authorizedUids/${uid}`).remove().catch(() => {});
    return { ok: true };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared-data writes — routed through here (instead of direct client writes) so
// every mutation to global data passes through the same authorization check.
// ─────────────────────────────────────────────────────────────────────────────
exports.updateSources = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey, sources } = request.data || {};
    if (!countryKey || !Array.isArray(sources)) throw new HttpsError('invalid-argument', 'countryKey and sources required');
    await db.ref(`countries/${countryKey}/setup/sources`).set(sources);
    return { ok: true };
  }
);

exports.deleteCountry = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey } = request.data || {};
    if (!countryKey) throw new HttpsError('invalid-argument', 'countryKey required');
    await Promise.all([
      db.ref(`countries/${countryKey}`).remove(),
      db.ref(`country-meta/${countryKey}`).remove(),
    ]);
    return { ok: true };
  }
);

exports.savePromptTemplate = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { key, value } = request.data || {};
    if (!['setup', 'analysis', 'period', 'addSources'].includes(key) || typeof value !== 'string') {
      throw new HttpsError('invalid-argument', 'valid key and value required');
    }
    await db.ref(`config/prompts/${key}`).set(value);
    return { ok: true };
  }
);

exports.resetPromptTemplate = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { key } = request.data || {};
    if (!['setup', 'analysis', 'period', 'addSources'].includes(key)) throw new HttpsError('invalid-argument', 'valid key required');
    await db.ref(`config/prompts/${key}`).remove();
    return { ok: true };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled Reports — reliable daily/weekly topic digests
//
// The live fetchNews path checks a source's RSS feed at one point in time,
// which is unreliable for high-volume outlets: their feed only exposes a
// small rolling window of recent items, so a topic published earlier in the
// day can already have scrolled off by the time anyone checks. A schedule
// can't just re-run that same live check on a timer — it would inherit the
// exact same blind spot.
//
// Instead: a frequent poller (pollArchivedSources) continuously archives
// each source's feed into our own permanent store, often enough that no
// article can rotate out of the feed's small window between polls. The
// report generator (generateScheduledReports) then reads a full day (or
// week) out of that archive — a complete record of what was actually
// published, not a lucky snapshot.
// ─────────────────────────────────────────────────────────────────────────────

// Stable per-article key for dedup — RTDB keys can't contain '.', '#', '$',
// '[', ']', '/', so this hashes the link (or title, if no link) rather than
// using either directly.
function articleKey(article) {
  const basis = (article.link || article.title || '').trim();
  let hash = 5381;
  for (let i = 0; i < basis.length; i++) hash = ((hash * 33) ^ basis.charCodeAt(i)) >>> 0;
  return 'a' + hash.toString(36);
}

async function archiveSourceArticles(countryKey, sourceId, rssUrl) {
  let articles;
  try { articles = await fetchRssWithRetry(rssUrl, 30); } catch { return; }

  // Lightweight per-source poll record (timestamp + count only, not article
  // content) — lets the UI show "last refreshed" / item count as a feed
  // health signal without scanning the full articleArchive tree.
  try { await db.ref(`articleArchiveMeta/${countryKey}/${sourceId}`).set({ lastPolledAt: Date.now(), articleCount: articles.length }); } catch {}

  if (articles.length === 0) return;

  // Group by the publisher's own calendar day so we only touch the archive
  // nodes that are actually relevant, instead of one read/write per article.
  const byDay = {};
  for (const a of articles) {
    const day = publisherLocalDateStr(a.date);
    if (!day) continue;
    (byDay[day] = byDay[day] || []).push(a);
  }

  for (const [day, dayArticles] of Object.entries(byDay)) {
    const ref = db.ref(`articleArchive/${countryKey}/${sourceId}/${day}`);
    let existing = {};
    try { existing = (await ref.once('value')).val() || {}; } catch { continue; }
    const updates = {};
    for (const a of dayArticles) {
      const key = articleKey(a);
      if (!existing[key]) {
        updates[key] = { title: a.title, text: a.text, link: a.link, date: a.date, archivedAt: new Date().toISOString() };
      }
    }
    if (Object.keys(updates).length > 0) {
      try { await ref.update(updates); } catch {}
    }
  }
}

exports.pollArchivedSources = onSchedule(
  { schedule: 'every 15 minutes', region: 'us-central1', memory: '256MiB', timeoutSeconds: 300, timeZone: 'Etc/UTC' },
  async () => {
    const schedulesSnap = await db.ref('schedules').once('value');
    const schedules = Object.values(schedulesSnap.val() || {}).filter(s => s.enabled);
    if (schedules.length === 0) return;

    const sourceIdsByCountry = {};
    for (const s of schedules) {
      const set = sourceIdsByCountry[s.countryKey] || (sourceIdsByCountry[s.countryKey] = new Set());
      (s.sourceIds || []).forEach(id => set.add(id));
    }

    for (const [countryKey, sourceIdSet] of Object.entries(sourceIdsByCountry)) {
      let sources = [];
      try { sources = (await db.ref(`countries/${countryKey}/setup/sources`).once('value')).val() || []; } catch { continue; }
      const bySourceId = Object.fromEntries(sources.map(s => [s.id, s]));
      await Promise.all([...sourceIdSet].map(sourceId => {
        const source = bySourceId[sourceId];
        if (!source?.rssUrl) return Promise.resolve();
        return archiveSourceArticles(countryKey, sourceId, source.rssUrl);
      }));
    }
  }
);

// ─── Date-window helpers for the scheduled report period ─────────────────────
function isoDateUTC(d) { return d.toISOString().slice(0, 10); }
function addDaysUTC(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return isoDateUTC(d);
}
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Always ends yesterday (UTC) — the last calendar day the poller has had a
// full day to archive. "Today" is deliberately excluded, same reasoning as
// the point-in-time date warning: it's still in progress.
function reportPeriodFor(frequency) {
  const periodEnd = addDaysUTC(isoDateUTC(new Date()), -1);
  const periodStart = frequency === 'weekly' ? addDaysUTC(periodEnd, -6) : periodEnd;
  const dayKeys = [];
  for (let d = periodStart; ; d = addDaysUTC(d, 1)) {
    dayKeys.push(d);
    if (d === periodEnd) break;
  }
  return { periodStart, periodEnd, dayKeys };
}

async function readArchivedArticles(countryKey, sourceId, dayKeys) {
  const snaps = await Promise.all(dayKeys.map(day => db.ref(`articleArchive/${countryKey}/${sourceId}/${day}`).once('value')));
  const articles = [];
  for (const snap of snaps) {
    const val = snap.val();
    if (val) articles.push(...Object.values(val));
  }
  return articles;
}

function scheduleIsDue(schedule, now) {
  if (now.getUTCHours() !== schedule.hourUtc) return false;
  if (schedule.frequency === 'weekly' && WEEKDAYS[now.getUTCDay()] !== schedule.startDay) return false;
  return true;
}

exports.generateScheduledReports = onSchedule(
  { schedule: 'every 60 minutes', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540, timeZone: 'Etc/UTC' },
  async () => {
    const now = new Date();
    const schedulesSnap = await db.ref('schedules').once('value');
    const schedules = schedulesSnap.val() || {};

    for (const [scheduleId, schedule] of Object.entries(schedules)) {
      if (!schedule.enabled || !scheduleIsDue(schedule, now)) continue;

      const { periodStart, periodEnd, dayKeys } = reportPeriodFor(schedule.frequency);
      // Already produced this exact period's report — guards against a
      // double-fire within the same due hour, not a real recurrence.
      if (schedule.lastRunStatus === 'ok' && schedule.lastPeriodEnd === periodEnd) continue;

      const runRef = db.ref(`reportRuns/${scheduleId}`).push();
      const dateLabel = periodStart === periodEnd ? periodEnd : `${periodStart} to ${periodEnd}`;

      try {
        const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
        const ai = makeAI(aiSettingsSnap.val() || {});
        const customPrompts = await getCustomPrompts();

        let sources = (await db.ref(`countries/${schedule.countryKey}/setup/sources`).once('value')).val() || [];
        sources = sources.filter(s => (schedule.sourceIds || []).includes(s.id));

        const summaryLen = `~${Math.min(Math.max(schedule.summaryWords || 100, 30), 300)}-word summary`;
        let totalInputTokens = 0, totalOutputTokens = 0;
        const results = {};

        await Promise.all(sources.map(async (source) => {
          const articles = await readArchivedArticles(schedule.countryKey, source.id, dayKeys);
          const { text, usage, relevantIndices, topicKeywordMatches } = await analyzeArticlesForTopics({
            ai, source, articles, topics: schedule.topics, country: schedule.country, dateLabel, summaryLen, customPrompts
          });
          totalInputTokens  += usage?.input_tokens  || 0;
          totalOutputTokens += usage?.output_tokens || 0;
          const analysis = finalizeAnalysis(text, relevantIndices, topicKeywordMatches, dateLabel);
          results[source.id] = { source, articleCount: articles.length, analysis };
        }));

        const costUsd = calcCostUsd(ai, totalInputTokens, totalOutputTokens);
        await persistCost(schedule.createdBy, schedule.createdByEmail, ai, costUsd);

        await runRef.set({
          scheduleId, generatedAt: now.toISOString(), periodStart, periodEnd, dateLabel,
          results, costUsd, inputTokens: totalInputTokens, outputTokens: totalOutputTokens,
          provider: ai.type, model: ai.model, status: 'ok'
        });
        await db.ref(`schedules/${scheduleId}`).update({ lastRunAt: now.toISOString(), lastRunStatus: 'ok', lastPeriodEnd: periodEnd });
      } catch (e) {
        // Deliberately does NOT set lastPeriodEnd on failure, so the next
        // hourly tick retries this same period instead of silently skipping it.
        await runRef.set({ scheduleId, generatedAt: now.toISOString(), periodStart, periodEnd, dateLabel, status: 'error', error: e.message });
        await db.ref(`schedules/${scheduleId}`).update({ lastRunAt: now.toISOString(), lastRunStatus: 'error' });
      }
    }
  }
);

// ─── Schedule management (admin-only, mirrors other admin-gated writes) ──────
exports.createSchedule = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { country, countryKey, sourceIds, topics, frequency, startDay, hourUtc, summaryWords, maxArticles } = request.data || {};
    if (!country || !countryKey || !sourceIds?.length || !topics?.length) {
      throw new HttpsError('invalid-argument', 'country, countryKey, sourceIds, and topics required');
    }
    if (!['daily', 'weekly'].includes(frequency)) throw new HttpsError('invalid-argument', 'frequency must be daily or weekly');
    if (frequency === 'weekly' && !WEEKDAYS.includes(startDay)) throw new HttpsError('invalid-argument', 'valid startDay required for weekly frequency');
    const hour = Math.min(Math.max(parseInt(hourUtc) || 0, 0), 23);

    const ref = db.ref('schedules').push();
    const schedule = {
      id: ref.key, country, countryKey, sourceIds, topics, frequency,
      startDay: frequency === 'weekly' ? startDay : null,
      hourUtc: hour,
      summaryWords: summaryWords || 100, maxArticles: maxArticles || 25,
      enabled: true,
      createdBy: request.auth.uid, createdByEmail: request.auth.token.email || null,
      createdAt: new Date().toISOString(),
      lastRunAt: null, lastRunStatus: null, lastPeriodEnd: null
    };
    await ref.set(schedule);
    return { schedule };
  }
);

exports.updateSchedule = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { scheduleId, ...updates } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const allowed = ['sourceIds', 'topics', 'frequency', 'startDay', 'hourUtc', 'summaryWords', 'maxArticles', 'enabled'];
    const patch = {};
    for (const k of allowed) if (updates[k] !== undefined) patch[k] = updates[k];
    if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'no valid fields to update');
    await db.ref(`schedules/${scheduleId}`).update(patch);
    return { ok: true };
  }
);

exports.deleteSchedule = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    // Only clears this schedule's own config + report history — the shared
    // article archive for its sources stays, since other schedules may
    // still be reading from it.
    await Promise.all([
      db.ref(`schedules/${scheduleId}`).remove(),
      db.ref(`reportRuns/${scheduleId}`).remove(),
    ]);
    return { ok: true };
  }
);

exports.listSchedules = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const snap = await db.ref('schedules').once('value');
    const schedules = Object.values(snap.val() || {});
    schedules.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return { schedules };
  }
);

exports.listReportRuns = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`reportRuns/${scheduleId}`).once('value');
    const val = snap.val() || {};
    // Metadata only — not the full per-source analysis payload, so browsing
    // history for a schedule with many runs stays lightweight.
    const runs = Object.entries(val).map(([runId, r]) => ({
      runId, generatedAt: r.generatedAt, periodStart: r.periodStart, periodEnd: r.periodEnd,
      dateLabel: r.dateLabel, costUsd: r.costUsd || 0, status: r.status, error: r.error || null,
      sourceCount: r.results ? Object.keys(r.results).length : 0
    }));
    runs.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    return { runs };
  }
);

exports.getReportRun = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { scheduleId, runId } = request.data || {};
    if (!scheduleId || !runId) throw new HttpsError('invalid-argument', 'scheduleId and runId required');
    const snap = await db.ref(`reportRuns/${scheduleId}/${runId}`).once('value');
    const run = snap.val();
    if (!run) throw new HttpsError('not-found', 'Report run not found');
    return { run };
  }
);

// Rough per-run / per-month cost projection shown before a schedule is
// turned on, based on typical article/token volume — not a specific run's
// real usage. Actual per-run cost is recorded once the schedule starts
// executing (see reportRuns / listReportRuns).
exports.estimateScheduleCost = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { sourceIds, topics, summaryWords, frequency } = request.data || {};
    if (!sourceIds?.length || !topics?.length) throw new HttpsError('invalid-argument', 'sourceIds and topics required');

    const ai = makeAI(request.data);
    const words = Math.min(Math.max(summaryWords || 100, 30), 300);

    // Heuristic: assume ~3 relevant articles matched per source at ~120
    // words each, plus fixed prompt scaffolding, for input; output scales
    // with topics selected and requested summary length.
    const inputTokensPerSource = 300 + Math.round((3 * 120) * 1.3);
    const outputTokensPerSource = Math.round(topics.length * (words * 1.3 + 60));
    const perRunInputTokens = inputTokensPerSource * sourceIds.length;
    const perRunOutputTokens = outputTokensPerSource * sourceIds.length;
    const perRunUsd = calcCostUsd(ai, perRunInputTokens, perRunOutputTokens);
    const runsPerMonth = frequency === 'weekly' ? 4.35 : 30;

    return {
      perRunUsd, monthlyUsd: perRunUsd * runsPerMonth,
      provider: ai.type, model: ai.model, basis: 'heuristic'
    };
  }
);
