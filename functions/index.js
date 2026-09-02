const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Parser = require('rss-parser');
const nodemailer = require('nodemailer');
const { defineSecret } = require('firebase-functions/params');

const gmailAppPassword = defineSecret('GMAIL_APP_PASSWORD');

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
      'Your account is not authorized to use Airtime.\n\nHow to fix: ask the administrator to add your email in Settings → Manage Users.'
    );
  }
  return role;
}

function requireAdmin(role) {
  if (role !== 'admin') throw new HttpsError('permission-denied', 'Administrator access required.');
}

// ─── Per-schedule access (owner / write / read) ───────────────────────────────
// Schedules are personal by default (owned by whoever created them) with
// optional sharing to specific other authorized users, same shape as Buli's
// list sharing: "read" can view the schedule and its reports; "write" can
// also edit, pause/resume, and delete it; only the owner can manage who it's
// shared with.
function scheduleAccessLevel(schedule, uid) {
  if (schedule.createdBy === uid) return 'owner';
  const shared = schedule.sharedWith && schedule.sharedWith[uid];
  return shared ? shared.level : null;
}
function requireScheduleAccess(schedule, uid, minLevel) {
  const level = scheduleAccessLevel(schedule, uid);
  if (!level) throw new HttpsError('permission-denied', 'You do not have access to this schedule.');
  if (minLevel === 'write' && level === 'read') throw new HttpsError('permission-denied', 'You have read-only access to this schedule.');
  if (minLevel === 'owner' && level !== 'owner') throw new HttpsError('permission-denied', 'Only the schedule owner can do this.');
  return level;
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
    // Google retires Gemini model names over time — this redirects any
    // stored/default name that's stopped working to a currently-live one,
    // so a stale setting doesn't start silently failing every call it
    // makes. Confirmed 2026-08-23 (via a direct test call, not just
    // trusting the deprecation notice): gemini-2.5-flash — this map's own
    // prior redirect target — and gemini-2.5-flash-lite are BOTH now dead
    // too (404 "no longer available to new users"); gemini-3.1-flash-lite
    // and gemini-3-flash-preview are confirmed live.
    const DEPRECATED = {
      'gemini-2.0-flash': 'gemini-3-flash-preview',
      'gemini-2.0-flash-lite': 'gemini-3.1-flash-lite',
      'gemini-2.5-flash': 'gemini-3-flash-preview',
      'gemini-2.5-flash-lite': 'gemini-3.1-flash-lite',
    };
    const rawModel = forTranslation ? 'gemini-3.1-flash-lite' : (geminiModel || 'gemini-3-flash-preview');
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

Analyze how {{country}}'s media covered the following topics between {{startDate}} and {{endDate}}. For any topic where real archived coverage is provided below, treat it as verified ground truth — anchor your analysis on it and do not contradict it — and combine it with your general knowledge of the country's media landscape for context, for outlets not represented in that archived data, and for the cross-source synthesis. For any topic without archived coverage provided, draw on your training knowledge of each outlet's editorial patterns and typical coverage during this period, exactly as you would otherwise.

Topics: {{topicList}}
{{personaLine}}
{{groundingSection}}
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
      // This text is shown to readers directly now (scheduled reports display
      // it raw, no AI rewrite), so a mid-sentence cutoff is more visible than
      // it used to be when this only fed keyword matching/AI input. 3000
      // covers almost every real feed's description length in practice —
      // simpler than sentence-boundary-aware trimming for a case that rarely
      // triggers either way.
      text: (item.contentSnippet || item.description || '').slice(0, 3000).trim(),
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

// ─── Source list integrity ─────────────────────────────────────────────────
// A country's source list (countries/{countryKey}/setup/sources) is one
// shared array across every user, and across point-in-time/period/scheduled
// reports — same reasoning as the shared topic registry. Unlike topics
// though, it was never fragmented across storage locations; the duplicate
// entries that show up in practice come from write-time races and from
// callers that add without checking the live list first (see addSources'
// old read-then-set and SourceManager's handleAddFound, which had no dedup
// check at all).
function normalizeSourceName(name) {
  return String(name || '').trim().toLowerCase();
}

// Merges entries that share a name (case-insensitive) — keeps whichever one
// actually has a working feed, since that's the copy worth keeping when the
// same outlet ended up added twice (a stale "Find by name" re-add, two users
// adding around the same time, etc.). Fields the "winner" is missing (lean,
// notes, feedStats) are backfilled from the other copy rather than lost.
function dedupeSourcesList(sources) {
  const byKey = new Map();
  let mergedCount = 0;
  for (const s of (sources || [])) {
    const name = normalizeSourceName(s.name);
    const key = name || `__noname_${s.id || byKey.size}`;
    if (!byKey.has(key)) { byKey.set(key, s); continue; }
    mergedCount++;
    const existing = byKey.get(key);
    const keepNew = !existing.rssUrl && s.rssUrl;
    const primary = keepNew ? s : existing;
    const secondary = keepNew ? existing : s;
    byKey.set(key, { ...secondary, ...primary, feedStats: primary.feedStats || secondary.feedStats || null });
  }
  return { deduped: [...byKey.values()], mergedCount };
}

// Same idea as checkTopicInUse — warn before removing something a schedule
// still depends on, rather than after silently shrinking its source list.
exports.checkSourceInUse = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey, sourceId } = request.data || {};
    if (!countryKey || !sourceId) throw new HttpsError('invalid-argument', 'countryKey and sourceId required');
    const snap = await db.ref('schedules').once('value');
    const schedules = Object.values(snap.val() || {});
    const usedBy = schedules
      .filter(s => s.countryKey === countryKey && (s.sourceIds || []).includes(sourceId))
      .map(s => ({ reportTitle: s.reportTitle, topics: s.topics, createdByEmail: s.createdByEmail }));
    return { inUse: usedBy.length > 0, usedBy };
  }
);

// One-click cleanup for duplicates already sitting in a country's source
// list (from before write-time dedup existed, or a race that slipped
// through anyway) — same merge logic addSources now applies automatically,
// just triggerable on demand from the Source Manager.
exports.dedupeCountrySources = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey } = request.data || {};
    if (!countryKey) throw new HttpsError('invalid-argument', 'countryKey required');
    const snap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
    const { deduped, mergedCount } = dedupeSourcesList(snap.val() || []);
    if (mergedCount > 0) await db.ref(`countries/${countryKey}/setup/sources`).set(deduped);
    return { sources: deduped, mergedCount };
  }
);

// ─── Raw article archive cleanup ──────────────────────────────────────────────
// articleArchive/{countryKey}/{sourceId}/{day} exists purely to feed each
// source's *next* daily report generation (generateDailyReportRun reads it,
// then either prunes or — for a shared source — currently leaves it in place
// indefinitely, see the comment there). Nothing else in the app ever reads
// this data again: point-in-time reports re-fetch live RSS, and period
// summaries work from the AI's own knowledge plus existing reports, neither
// touches this archive. So once a day-node is a few days old, it's pure
// dead weight regardless of whether it was ever "relevant" to any schedule
// or shared between schedules — safe to delete outright, uniformly, with no
// per-country or per-schedule distinction needed.
const ARCHIVE_CLEANUP_DEFAULTS = { enabled: true, retentionDays: 3 };
function clampRetentionDays(v) {
  return Math.min(Math.max(parseInt(v) || ARCHIVE_CLEANUP_DEFAULTS.retentionDays, 1), 30);
}

async function sweepArticleArchive(retentionDays) {
  const cutoff = addDaysUTC(isoDateUTC(new Date()), -retentionDays);
  const snap = await db.ref('articleArchive').once('value');
  const tree = snap.val() || {};
  let beforeBytes = 0, afterBytes = 0, deletedDayNodes = 0, keptDayNodes = 0;
  const deletions = {};
  for (const [countryKey, sources] of Object.entries(tree)) {
    for (const [sourceId, days] of Object.entries(sources || {})) {
      for (const [day, articles] of Object.entries(days || {})) {
        const size = Buffer.byteLength(JSON.stringify(articles));
        beforeBytes += size;
        if (day < cutoff) {
          deletions[`articleArchive/${countryKey}/${sourceId}/${day}`] = null;
          deletedDayNodes++;
        } else {
          afterBytes += size;
          keptDayNodes++;
        }
      }
    }
  }
  if (Object.keys(deletions).length > 0) await db.ref().update(deletions);
  return {
    ranAt: new Date().toISOString(), retentionDays, cutoff,
    beforeBytes, afterBytes, reclaimedBytes: beforeBytes - afterBytes,
    deletedDayNodes, keptDayNodes
  };
}

// Fixed daily maintenance slot — not user-configurable (there's no reason to
// tie it to any particular report's schedule), just needs to be predictable
// enough to show "next run" in the UI.
const ARCHIVE_CLEANUP_CRON_UTC_HOUR = 3;

exports.getArchiveCleanupSettings = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const snap = await db.ref('config/archiveCleanup').once('value');
    const stored = snap.val() || {};
    const now = new Date();
    const nextRunAt = new Date(now);
    nextRunAt.setUTCHours(ARCHIVE_CLEANUP_CRON_UTC_HOUR, 0, 0, 0);
    if (nextRunAt <= now) nextRunAt.setUTCDate(nextRunAt.getUTCDate() + 1);
    return {
      enabled: stored.enabled !== undefined ? stored.enabled : ARCHIVE_CLEANUP_DEFAULTS.enabled,
      retentionDays: stored.retentionDays !== undefined ? stored.retentionDays : ARCHIVE_CLEANUP_DEFAULTS.retentionDays,
      lastRun: stored.lastRun || null,
      nextRunAt: nextRunAt.toISOString(),
      cronUtcHour: ARCHIVE_CLEANUP_CRON_UTC_HOUR
    };
  }
);

exports.updateArchiveCleanupSettings = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const { enabled, retentionDays } = request.data || {};
    const patch = {};
    if (enabled !== undefined) patch.enabled = !!enabled;
    if (retentionDays !== undefined) patch.retentionDays = clampRetentionDays(retentionDays);
    if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'no valid fields to update');
    await db.ref('config/archiveCleanup').update(patch);
    return { ok: true };
  }
);

// Manual trigger — runs the exact same sweep as the scheduled job, regardless
// of the enabled toggle (an explicit click should always work), and records
// the result to the same lastRun field so "when did this last run" is
// accurate no matter which path triggered it.
exports.runArchiveCleanupNow = onCall(
  { timeoutSeconds: 300, memory: '256MiB', region: 'us-central1' },
  async (request) => {
    requireAdmin(await requireAuthorized(request));
    const settingsSnap = await db.ref('config/archiveCleanup').once('value');
    const retentionDays = clampRetentionDays((settingsSnap.val() || {}).retentionDays);
    const result = await sweepArticleArchive(retentionDays);
    await db.ref('config/archiveCleanup/lastRun').set(result);
    return result;
  }
);

exports.pruneArticleArchive = onSchedule(
  { schedule: `0 ${ARCHIVE_CLEANUP_CRON_UTC_HOUR} * * *`, region: 'us-central1', memory: '256MiB', timeoutSeconds: 300, timeZone: 'Etc/UTC' },
  async () => {
    const snap = await db.ref('config/archiveCleanup').once('value');
    const settings = snap.val() || {};
    const enabled = settings.enabled !== undefined ? settings.enabled : ARCHIVE_CLEANUP_DEFAULTS.enabled;
    if (!enabled) return;
    const retentionDays = clampRetentionDays(settings.retentionDays);
    const result = await sweepArticleArchive(retentionDays);
    await db.ref('config/archiveCleanup/lastRun').set(result);
  }
);

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
    // Ask for more than requested — a meaningful share of the AI's guessed
    // RSS URLs won't actually resolve when live-probed below, and asking
    // for exactly numSources meant any validation loss directly shrank the
    // final count with no way to compensate (same reasoning as addSources'
    // smaller +3 buffer, just larger since this prompt's loss rate runs
    // higher in practice — observed requesting 7 yielding as few as 3).
    const requestCount = Math.min(numSources * 2, 20);

    const ai = makeAI(request.data);
    const customPrompts = await getCustomPrompts();
    const prompt = fillPrompt(customPrompts.setup || DEFAULT_PROMPTS.setup, { country, numSources: requestCount });

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
    const beforeRssFilter = sources.length;
    if (filterNoRSS) sources = sources.filter(s => s.rssUrl);
    const rssFilteredCount = filterNoRSS ? beforeRssFilter - sources.length : 0;
    sources = sources.slice(0, numSources);

    const countryKey = countryToKey(country);
    const setupDate = new Date().toISOString();
    await Promise.all([
      db.ref(`countries/${countryKey}/setup`).set({ country, countryKey, sources, setupDate, model: aiLabel(ai) }),
      db.ref(`country-meta/${countryKey}`).set({ country, countryKey, setupDate }),
    ]);

    return { countryKey, sources, rssFilteredCount, requestedCount: numSources };
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
        // Transaction, not read-then-set: the earlier existingNames check
        // above was against a client-supplied snapshot (stale under a
        // concurrent add from another user, or just a page that hadn't
        // refreshed) — this re-checks against whatever's actually live at
        // write time, and folds in a general dedupe pass as a side effect.
        await db.ref(`countries/${countryKey}/setup/sources`).transaction(current => {
          const existingList = Array.isArray(current) ? current : [];
          const existingKeys = new Set(existingList.map(s => normalizeSourceName(s.name)));
          const toAdd = sources.filter(s => !existingKeys.has(normalizeSourceName(s.name)));
          return dedupeSourcesList([...existingList, ...toAdd]).deduped;
        });
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
// Shared per-source topic analysis, used by the scheduled report generator,
// so the "only pay for what's relevant" and keyword-override logic exists in
// exactly one place.
// ─────────────────────────────────────────────────────────────────────────────
// In-memory cache, backed by the DB below so it survives cold starts —
// translations never change, so once a topic/language pair has been
// translated it's reused forever across every schedule and run that needs it.
const topicTranslationCache = {};
function cacheSlug(str) {
  const basis = str.trim().toLowerCase();
  let hash = 5381;
  for (let i = 0; i < basis.length; i++) hash = ((hash * 33) ^ basis.charCodeAt(i)) >>> 0;
  return 'k' + hash.toString(36);
}

// Translates a topic keyword into a source's own language so non-English
// outlets can actually be matched — checking only the English word against
// Thai/Khmer/etc. article text silently misses every real mention, which is
// exactly what was happening: high-volume non-English sources were coming
// back "not covered" not because they had no coverage, but because the
// check never had a chance of matching their language.
async function getTranslatedTopic(topic, language, ai, uid, email) {
  const cacheKey = cacheSlug(language) + '/' + cacheSlug(topic);
  if (topicTranslationCache[cacheKey] !== undefined) return topicTranslationCache[cacheKey];
  const dbPath = `topicTranslations/${cacheKey}`;
  try {
    const snap = await db.ref(dbPath).once('value');
    if (snap.exists()) { topicTranslationCache[cacheKey] = snap.val(); return snap.val(); }
  } catch {}
  let translated = null;
  try {
    const prompt = `Translate the word or short phrase "${topic}" into ${language}. Reply with ONLY the single most natural, commonly used translation a native speaker would recognize in a news article — no explanation, no English, no quotation marks, nothing else.`;
    const { text, usage } = await callAI(ai, prompt, 40);
    translated = text.trim();
    if (usage) await persistCost(uid, email, ai, calcCostUsd(ai, usage.input_tokens || 0, usage.output_tokens || 0));
    if (translated) await db.ref(dbPath).set(translated).catch(() => {});
  } catch {}
  topicTranslationCache[cacheKey] = translated;
  return translated;
}

async function computeTopicKeywordMatches(articles, topics, source, ai, uid, email) {
  const languages = (source?.languages || []).filter(l => l && l.toLowerCase() !== 'english');
  const topicVariants = {};
  for (const topic of topics) {
    const variants = [topic.toLowerCase()];
    for (const lang of languages) {
      const translated = await getTranslatedTopic(topic, lang, ai, uid, email);
      if (translated) variants.push(translated.toLowerCase());
    }
    topicVariants[topic] = variants;
  }

  const topicKeywordMatches = {};
  for (const topic of topics) {
    const variants = topicVariants[topic];
    topicKeywordMatches[topic] = articles.reduce((acc, a, i) => {
      const haystack = (a.title + ' ' + (a.text || '')).toLowerCase();
      if (variants.some(v => haystack.includes(v))) acc.push(i + 1);
      return acc;
    }, []);
  }
  return topicKeywordMatches;
}

function relevantIndicesFromMatches(topicKeywordMatches) {
  return [...new Set(Object.values(topicKeywordMatches).flat())].sort((a, b) => a - b);
}

function splitTopicsByMode(topics, contextTopics) {
  const contextSet = new Set((contextTopics || []).map(t => t.toLowerCase()));
  return {
    exactTopics: topics.filter(t => !contextSet.has(t.toLowerCase())),
    actualContextTopics: topics.filter(t => contextSet.has(t.toLowerCase()))
  };
}

// ─── Raw (no-AI-summary) scheduled reports ────────────────────────────────────
// Article and Hebrew-email translation both go through the AI provider
// already paid for (translateBatch, forced to its cheapest model — see
// makeAI's forTranslation flag) rather than a free/unofficial endpoint.
// That free endpoint used to be the translator here, but it rate-limits
// under bursty load with no warning, which is exactly what let Thai/Khmer
// article text leak untranslated into English-only reports on 2026-08-23.

// A source's own RSS text needs no translation call at all if it only
// publishes in English — zero cost, zero latency for the common case.
function sourceIsEnglishOnly(source) {
  const langs = source?.languages || [];
  return langs.length === 0 || langs.every(l => (l || '').toLowerCase() === 'english');
}

// Assembles one day's sources: each source lists every article that matched
// ANY of the schedule's topics (deduped/sorted by relevantIndicesFromMatches),
// with no per-topic grouping — topics are shown once, informationally, in the
// report header instead, since the schedule's whole topic list applies to the
// report as a whole, not to any one article. Sources are ordered alphabetically.
function buildDaySourceGroups(perSourceMatchData) {
  return perSourceMatchData
    .map(({ source, topicKeywordMatches, translatedArticles }) => {
      const relevantIndices = relevantIndicesFromMatches(topicKeywordMatches);
      return {
        sourceId: source.id, sourceName: source.name, sourceLean: source.lean,
        articles: relevantIndices.map(i => translatedArticles[i - 1])
      };
    })
    .sort((a, b) => a.sourceName.localeCompare(b.sourceName));
}

// Shared by the in-app viewer's Share/Copy and the emailed report body, so
// the two never drift apart.
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function formatDayLabel(dayStr) {
  const d = new Date(dayStr + 'T00:00:00Z');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${dd}.${mm}`;
}
function formatLongDateLabel(dayStr) {
  const d = new Date(dayStr + 'T00:00:00Z');
  return `${WEEKDAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
// dd/Mon, e.g. "08/Aug" — used in the email subject, kept short deliberately
// so it doesn't eat into the inbox-list space the report title needs.
function formatShortDate(dayStr) {
  const d = new Date(dayStr + 'T00:00:00Z');
  return `${String(d.getUTCDate()).padStart(2, '0')}/${MONTH_NAMES[d.getUTCMonth()].slice(0, 3)}`;
}
// Daily: one short date. Weekly: dd/Mon-dd/Mon range across the period.
function formatEmailDateRange(run) {
  if (run.runType === 'weekly' && run.periodStart && run.periodEnd) {
    return `${formatShortDate(run.periodStart)}-${formatShortDate(run.periodEnd)}`;
  }
  return formatShortDate(run.periodEnd || run.dateLabel);
}
function titleCase(str) {
  return String(str || '').replace(/\b\w/g, c => c.toUpperCase());
}

// Plain-text fallback for clients that don't render HTML. A daily report is
// one day, so the date only needs to appear once, in the header — Day: lines
// only earn their place when a report actually spans more than one day.
// Topics are informative only — listed once up top, not used to group
// articles — so the body groups directly by source, alphabetically.
// Weekly shows the summary only, never the underlying day-by-day articles —
// those still get collected internally (the summary is extracted from them),
// just never surfaced on their own for a weekly report.
function buildRawReportText(schedule, run) {
  const days = run.runType === 'weekly' ? [] : (run.days || []);
  const isMultiDay = days.length > 1;
  const topics = run.topics || schedule.topics || [];
  let text = `${titleCase(schedule.country)}\n`;
  if (topics.length > 0) text += `Topics: ${topics.join(', ')}\n`;
  if (run.summary) text += `\nSummary\n${run.summary.replace(/\*\*(.+?)\*\*/g, '$1')}\n`;
  else if (run.runType === 'weekly') text += `\nNo coverage this period.\n`;
  text += '\n';
  for (const d of days) {
    if (isMultiDay) text += `Day: ${formatDayLabel(d.day)}\n`;
    for (const s of d.sources || []) {
      text += `  Source: ${s.sourceName}\n`;
      for (const a of s.articles) {
        text += `   ${a.title}\n   ${a.text}\n`;
        if (a.translationFailed) text += `   ⚠ Could not translate this article right now — shown in its original language.\n`;
        if (a.link) text += `   ${a.link}\n`;
      }
    }
  }
  text += '\nQuestions or feedback on this report? Just reply to this email.\n';
  return text;
}

function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML counterpart of buildRawReportText — same content, same structure, just
// styled: headline and snippet carry the visual weight, Day/Source shrink to
// small muted labels, and a rule only appears between days (never between
// sources, and never at all for a single-day report). Topics are informative
// only — one line in the header — so the body groups directly by source,
// alphabetically, instead of by topic.
// rtl only affects the translated content paragraphs (summary, article
// title/text) — the English chrome (labels, source names, date header)
// Plain HTML collapses whitespace, so a sectionedSummary-mode summary
// (blank-line-separated blocks, each optionally starting with **Heading**)
// needs to be split into real paragraphs rather than dumped into one <p> —
// harmless no-op for a normal flowing-paragraph summary, which is just one
// block with no heading match.
function renderSummaryBlocks(summary, sans, contentDir, contentAlign) {
  return summary.split(/\n{2,}/).map(b => b.trim()).filter(Boolean).map(block => {
    const headingMatch = block.match(/^\*\*(.+?)\*\*\s*\n?([\s\S]*)$/);
    if (!headingMatch) {
      return `<p${contentDir} style="font-size:14.5px;color:#43474d;line-height:1.6;margin:0 0 14px;font-family:${sans};${contentAlign}">${escapeHtml(block)}</p>`;
    }
    const [, heading, rest] = headingMatch;
    const restHtml = rest.trim()
      ? `<p${contentDir} style="font-size:14.5px;color:#43474d;line-height:1.6;margin:0 0 14px;font-family:${sans};${contentAlign}">${escapeHtml(rest.trim())}</p>`
      : '';
    return `<p${contentDir} style="font-size:13.5px;font-weight:700;color:#1c1e21;margin:0 0 4px;font-family:${sans};${contentAlign}">${escapeHtml(heading.trim())}</p>${restHtml}`;
  }).join('');
}

function buildReportHtml(schedule, run, rtl = false) {
  const contentDir = rtl ? ' dir="rtl"' : '';
  const contentAlign = rtl ? 'text-align:right;' : '';
  const isWeekly = run.runType === 'weekly';
  const days = isWeekly ? [] : (run.days || []);
  const kind = isWeekly ? 'Weekly' : 'Daily';
  const isMultiDay = days.length > 1;
  const dateHeader = isWeekly && run.periodStart && run.periodEnd
    ? `${formatLongDateLabel(run.periodStart)} – ${formatLongDateLabel(run.periodEnd)}`
    : isMultiDay
      ? `${formatLongDateLabel(days[0].day)} – ${formatLongDateLabel(days[days.length - 1].day)}`
      : (days[0] ? formatLongDateLabel(days[0].day) : (run.periodEnd ? formatLongDateLabel(run.periodEnd) : ''));
  const topics = run.topics || schedule.topics || [];

  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

  // Weekly shows only the summary (no trailing rule when there's no article
  // listing to separate it from) — daily keeps both, unchanged.
  const summaryHtml = run.summary
    ? `
          <p style="font-size:11px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#3e5c76;margin:0 0 10px;font-family:${sans};">Summary</p>
          <div style="margin:0 0 ${days.length > 0 ? '8px' : '0'};">${renderSummaryBlocks(run.summary, sans, contentDir, contentAlign)}</div>
          ${days.length > 0 ? '<hr style="border:none;border-top:1px solid #e7e5e0;margin:0 0 22px;">' : ''}`
    : (isWeekly ? `<p style="font-size:14.5px;color:#90949c;font-family:${sans};">No coverage this period.</p>` : '');

  let body = '';
  days.forEach((d, di) => {
    if (isMultiDay) {
      body += `<hr style="border:none;border-top:1px solid #e7e5e0;margin:${di === 0 ? '0 0 22px' : '28px 0 22px'};">`;
      body += `<p style="font-size:11px;font-weight:600;letter-spacing:0.09em;text-transform:uppercase;color:#3e5c76;margin:0 0 18px;font-family:${sans};">${escapeHtml(formatDayLabel(d.day))}</p>`;
    }
    (d.sources || []).forEach((s, si) => {
      body += `<div style="margin-top:${(di === 0 && si === 0) ? '0' : '26px'};">`;
      body += `<p style="font-size:11px;font-weight:600;letter-spacing:0.07em;text-transform:uppercase;color:#90949c;margin:0 0 8px;font-family:${sans};">${escapeHtml(s.sourceName)}</p>`;
      (s.articles || []).forEach((a, ai) => {
        const titleHtml = a.link
          ? `<a href="${escapeHtml(a.link)}" style="color:#3e5c76;text-decoration:none;">${escapeHtml(a.title)} ↗</a>`
          : escapeHtml(a.title);
        body += `<div style="margin-top:${ai === 0 ? '0' : '14px'};">`;
        body += `<p${contentDir} style="font-size:15.5px;font-weight:600;color:#1c1e21;margin:0 0 4px;line-height:1.35;font-family:${sans};${contentAlign}">${titleHtml}</p>`;
        if (a.translationFailed) {
          body += `<p style="font-size:12px;color:#b45309;margin:0 0 4px;font-family:${sans};">⚠ Could not translate this article right now — shown in its original language.</p>`;
        }
        body += `<p${contentDir} style="font-size:14.5px;color:#43474d;line-height:1.6;margin:0;font-family:${sans};${contentAlign}">${escapeHtml(a.text)}</p>`;
        body += `</div>`;
      });
      body += `</div>`;
    });
  });

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#eef0f3;">
    <div style="max-width:640px;margin:0 auto;padding:32px 16px;">
      <div style="background:#ffffff;border-radius:3px;box-shadow:0 1px 2px rgba(20,22,26,0.06),0 8px 24px rgba(20,22,26,0.07);">
        <div style="padding:30px 28px 36px;font-family:${sans};">
          <p style="font-family:Georgia,'Times New Roman',serif;font-size:13px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:#90949c;margin:0 0 16px;">Airtime</p>
          <p style="font-size:19px;font-weight:600;margin:0 0 3px;letter-spacing:-0.005em;color:#1c1e21;">${escapeHtml(titleCase(schedule.country))} — ${kind} Report</p>
          <p style="font-size:13px;color:#90949c;margin:0 0 3px;">${escapeHtml(dateHeader)}</p>
          ${topics.length > 0 ? `<p style="font-size:13px;color:#90949c;margin:0 0 20px;">Topics: ${escapeHtml(topics.join(', '))}</p>` : ''}
          <hr style="border:none;border-top:1px solid #e7e5e0;margin:0 0 22px;">
          ${summaryHtml}
          ${body}
          <hr style="border:none;border-top:1px solid #e7e5e0;margin:28px 0 14px;">
          <p style="font-size:12px;color:#90949c;margin:0;font-family:${sans};">Questions or feedback on this report? Just reply to this email.</p>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

// Handles both the new days-shaped runs and legacy results-shaped runs, so
// old reports keep their correct unread/badge counts without needing a
// one-time data migration.
function computeRunRelevantTotal(run) {
  if (Array.isArray(run.days)) {
    let total = 0;
    for (const d of run.days) for (const s of d.sources || []) total += (s.articles || []).length;
    return total;
  }
  return Object.values(run.results || {}).reduce((sum, s) => sum + (s.relevantCount || 0), 0);
}
function computeRunSourceCount(run) {
  if (Array.isArray(run.days)) {
    const ids = new Set();
    for (const d of run.days) for (const s of d.sources || []) ids.add(s.sourceId);
    return ids.size;
  }
  return run.results ? Object.keys(run.results).length : 0;
}

// A schedule has no user-set name (that field exists in the data model but
// was never wired up in the UI, so it's always undefined in practice) — two
// schedules for the same country only really differ by their topic list. The
// old subject line had nothing but country + date, so e.g. a country's
// "Israel/Middle East" schedule and its "Internal Politics" schedule
// produced byte-identical subjects on the same day. Gmail (and most mail
// clients) threads messages with identical subjects into one conversation,
// which is what made "send all 4 now" look like only 2 arrived — all 4 sent
// fine, they just paired up into 2 threads.
// Kept short (~20 chars) specifically so it can't get truncated in an inbox
// list view, per request — just enough to tell schedules apart at a glance.
function scheduleShortTopicLabel(schedule) {
  const topics = schedule.topics || [];
  if (topics.length === 0) return '';
  let label = topics[0];
  if (label.length > 20) label = label.slice(0, 20).trim() + '…';
  if (topics.length > 1) label += ` +${topics.length - 1}`;
  return label;
}

// Produces a Hebrew copy of a run for the outgoing email only — the stored
// run (reportRuns, in-app history) always stays in English. Only the
// substantive content is translated (summary, article title/text); links
// and structural labels are untouched. Since the whole recipient list gets
// one shared email (a single sendMail call below), this only ever runs
// once per report regardless of how many recipients are on it. Everything
// goes through one batched AI call (billed on the same provider already
// paid for, translateAi forcing its cheapest model) rather than one
// free-endpoint call per field.
async function translateRunToHebrew(run, translateAi, uid, email) {
  const batch = [];
  if (run.summary) batch.push(run.summary);
  for (const d of (run.days || [])) {
    for (const s of (d.sources || [])) {
      for (const a of (s.articles || [])) {
        batch.push(a.title, a.text);
      }
    }
  }
  if (batch.length === 0) return { ...run };

  const { translations, usage } = await translateBatch(translateAi, batch, 'Hebrew');
  if (usage) await persistCost(uid, email, translateAi, calcCostUsd(translateAi, usage.input_tokens || 0, usage.output_tokens || 0));

  let cursor = 0;
  const translatedRun = { ...run };
  if (run.summary) translatedRun.summary = translations[cursor++];
  translatedRun.days = (run.days || []).map(d => ({
    ...d,
    sources: (d.sources || []).map(s => ({
      ...s,
      articles: (s.articles || []).map(a => ({ ...a, title: translations[cursor++], text: translations[cursor++] }))
    }))
  }));
  return translatedRun;
}

// Each recipient picks English or Hebrew individually — some want the
// original, some want it translated, on the same send. Accepts legacy
// plain-string recipients too (pre-dates the per-recipient language field),
// which default to English, same as before this existed.
function normalizeRecipients(emailRecipients) {
  return (emailRecipients || [])
    .map(r => typeof r === 'string' ? { email: r, hebrew: false } : r)
    .filter(r => r && r.email);
}

async function sendReportEmail(schedule, run) {
  const recipients = normalizeRecipients(schedule.emailRecipients);
  if (recipients.length === 0) return;
  const enRecipients = recipients.filter(r => !r.hebrew).map(r => r.email);
  const heRecipients = recipients.filter(r => r.hebrew).map(r => r.email);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: OWNER_EMAIL, pass: gmailAppPassword.value() }
  });
  // reportTitle is the user-set identity for this schedule's emails now —
  // falls back to the old topic-based label (or just the country) for any
  // schedule that hasn't set one, so subjects still stay distinct enough to
  // avoid the Gmail-threading collision this used to guard against.
  const titlePart = (schedule.reportTitle || '').trim() || scheduleShortTopicLabel(schedule) || titleCase(schedule.country);
  // Leading U+200E (left-to-right mark) — invisible, but stops Gmail's
  // Hebrew-locale UI from bidi-reordering the "dd/Mon" date prefix when it
  // renders the opened-message subject line (mobile/list views already
  // rendered it fine; only that one RTL-paragraph area needed the hint).
  const subject = `‎${formatEmailDateRange(run)} ${titlePart}`;

  // Two separate sends (when both language groups exist) rather than one
  // email with mixed content — different recipients need genuinely
  // different bodies. Hebrew is only ever translated once here, reused for
  // every Hebrew recipient, regardless of how many are on the list. Each
  // send fails independently so one language's delivery issue never blocks
  // the other's — same "never fail the report run itself" guarantee as
  // before, just per-branch now instead of wrapping the whole function.
  if (enRecipients.length > 0) {
    try {
      await transporter.sendMail({
        from: `Airtime <${OWNER_EMAIL}>`, to: enRecipients.join(', '), subject,
        text: buildRawReportText(schedule, run),
        html: buildReportHtml(schedule, run)
      });
    } catch (e) {
      console.error('sendReportEmail (English) failed', e.message);
    }
  }
  if (heRecipients.length > 0) {
    try {
      const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
      const translateAi = makeAI(aiSettingsSnap.val() || {}, true);
      const hebrewRun = await translateRunToHebrew(run, translateAi, schedule.createdBy, schedule.createdByEmail);
      await transporter.sendMail({
        from: `Airtime <${OWNER_EMAIL}>`, to: heRecipients.join(', '), subject,
        text: buildRawReportText(schedule, hebrewRun),
        html: buildReportHtml(schedule, hebrewRun, true)
      });
    } catch (e) {
      console.error('sendReportEmail (Hebrew) failed', e.message);
    }
  }
}

// callAI throws an HttpsError with a specific `code` for anything that looks
// like a billing/quota/API-key problem (see callAI's catch block) — that's
// the narrow set worth waking someone up for, as opposed to a one-off
// network blip or an AI response that failed to parse.
function isAiBillingOrKeyError(e) {
  return !!e && (e.code === 'resource-exhausted' || e.code === 'permission-denied');
}

// One email per user per day, no matter how many of their schedules hit the
// same underlying problem — this is the failure mode that silently produced
// a run of empty reports before classifyContextTopicsByFullBody was fixed
// to stop swallowing it, so it's worth alerting on directly rather than
// only relying on someone noticing an empty report days later.
const AI_ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

async function maybeSendAiFailureAlert(schedule, error) {
  if (!isAiBillingOrKeyError(error)) return;
  const uid = schedule.createdBy;
  const to = schedule.createdByEmail;
  if (!uid || !to) return;
  try {
    const alertRef = db.ref(`users/${uid}/lastAiErrorAlertAt`);
    const last = (await alertRef.once('value')).val();
    if (last && (Date.now() - new Date(last).getTime()) < AI_ALERT_THROTTLE_MS) return;
    await alertRef.set(new Date().toISOString());

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: OWNER_EMAIL, pass: gmailAppPassword.value() }
    });
    const reportName = (schedule.reportTitle || '').trim() || titleCase(schedule.country);
    await transporter.sendMail({
      from: `Airtime <${OWNER_EMAIL}>`,
      to,
      subject: '⚠ Airtime — AI provider error, reports may be empty',
      text: `Your "${reportName}" report just failed to generate because of an AI provider error:\n\n${error.message}\n\nThis usually means the AI account under Settings → AI Provider is out of credits, hit a quota limit, or has an invalid/expired API key — until it's fixed, affected reports will keep coming back empty instead of failing loudly.\n\nOpen Airtime → Settings → AI Provider to check your key and billing.\n\n(You'll only get one of these emails per day even if several of your reports are affected.)`
    });
  } catch (e2) {
    console.error('maybeSendAiFailureAlert failed', e2.message);
  }
}

// ─── Context topics ────────────────────────────────────────────────────────────
// A topic like "Israel" is a word — a literal keyword check works. A topic
// like "internal politics" is a theme — no substring check will ever match
// it, since the article is *about* that theme without necessarily containing
// those words. Topics flagged as "context" (vs. the default "exact") skip
// keyword matching and get judged instead by the AI, either from just the
// article titles (classifyContextTopicsByHeader) or the full article text
// (classifyContextTopicsByFullBody) — the scheduled-report pipeline always
// uses the latter (see the comment in generateScheduledReports for why).

// scope 'domestic' narrows a theme like "internal politics" or "economy" to
// events/actors inside the schedule's own country — without it, a broad
// theme matches that topic happening anywhere in the world, which is what
// the AI would otherwise default to since nothing in the theme name itself
// says "domestic only".
function domesticScopeLine(scope, country, { loose } = {}) {
  if (scope !== 'domestic' || !country) return '';
  const uncertainty = loose
    ? ` If it's unclear from the headline alone whether it's domestic or foreign, include it (this is just a first pass — the full read resolves unclear cases).`
    : '';
  return `\nScope: domestic only — count it only if the theme is genuinely about ${country} itself (its government, institutions, economy, or domestic actors), not international/global coverage of the theme that merely mentions ${country} in passing.${uncertainty}\n`;
}

// topicGuidance is an optional { [topicName]: compiledPrompt } map — the
// static, pre-compiled include/exclude instructions from that topic's
// registry entry (see buildCompiledTopicPrompt on the client, which is what
// actually produces this string; nothing here re-derives it from raw word
// lists on every run). Topics without guidance just render as a bare name,
// identical to today's behavior.
function buildThemesBlock(contextTopics, topicGuidance) {
  const hasGuidance = contextTopics.some(t => topicGuidance && topicGuidance[t]);
  if (!hasGuidance) return `Themes: ${contextTopics.join(', ')}`;
  return `Themes:\n` + contextTopics.map(t => {
    const g = topicGuidance && topicGuidance[t];
    return g ? `- ${t} — ${g}` : `- ${t}`;
  }).join('\n');
}

async function classifyContextTopicsByHeader(articles, contextTopics, ai, uid, email, scope, country, topicGuidance) {
  const empty = Object.fromEntries(contextTopics.map(t => [t, []]));
  if (articles.length === 0) return empty;

  const titlesList = articles.map((a, i) => `${i + 1}. ${a.title}`).join('\n');
  const scopeLine = domesticScopeLine(scope, country, { loose: true });
  const prompt = `Below is a numbered list of article headlines. For each theme listed, return the numbers of the headlines that are plausibly about that theme, judging only from the headline — err on the side of including a headline if it's plausibly related, since this is just a first pass.
${scopeLine}
Headlines:
${titlesList}

${buildThemesBlock(contextTopics, topicGuidance)}

Return ONLY valid JSON, no markdown, no explanation: { "theme name": [1, 4, 7], "other theme": [] }`;

  try {
    const { text, usage } = await callAI(ai, prompt, 500);
    if (usage) await persistCost(uid, email, ai, calcCostUsd(ai, usage.input_tokens || 0, usage.output_tokens || 0));
    const parsed = extractJson(text, '{') || {};
    const normalized = {};
    for (const [k, v] of Object.entries(parsed)) normalized[k.trim().toLowerCase()] = v;
    const result = {};
    for (const t of contextTopics) {
      const v = normalized[t.trim().toLowerCase()];
      result[t] = Array.isArray(v) ? v.filter(n => Number.isInteger(n) && n >= 1 && n <= articles.length) : [];
    }
    return result;
  } catch (e) {
    // A failed classification call should fail closed (no matches, no main
    // analysis call either), not fail open into a full-body-priced pass —
    // still logged now, though, so a real failure (billing, invalid key,
    // outage) leaves a trace instead of looking identical to a quiet day.
    console.error('classifyContextTopicsByHeader failed:', e.message);
    return empty;
  }
}

// Same idea as classifyContextTopicsByHeader but reads each full article
// (title + text) instead of just the headline, and — unlike that header
// pass, which is deliberately a loose "first pass" refined by a later full
// read in the old AI-summary pipeline — this IS the final decision, since
// the raw-report pipeline has no follow-up analysis call to correct it.
// Used for 'fullBody' context mode there, where accuracy over speed/cost is
// the point.
async function classifyContextTopicsByFullBody(articles, contextTopics, ai, uid, email, scope, country, topicGuidance) {
  const empty = Object.fromEntries(contextTopics.map(t => [t, []]));
  if (articles.length === 0) return empty;

  const articlesList = articles.map((a, i) => `${i + 1}. ${a.title}\n${a.text}`).join('\n\n');
  const scopeLine = domesticScopeLine(scope, country);
  const prompt = `Below is a numbered list of full articles. For each theme listed, return the numbers of the articles that are genuinely about that theme, judging from the full article text — this is the final decision for what gets included in a report, so be precise rather than inclusive.
${scopeLine}
Articles:
${articlesList}

${buildThemesBlock(contextTopics, topicGuidance)}

Return ONLY valid JSON, no markdown, no explanation: { "theme name": [1, 4, 7], "other theme": [] }`;

  try {
    const { text, usage } = await callAI(ai, prompt, 500);
    if (usage) await persistCost(uid, email, ai, calcCostUsd(ai, usage.input_tokens || 0, usage.output_tokens || 0));
    const parsed = extractJson(text, '{') || {};
    const normalized = {};
    for (const [k, v] of Object.entries(parsed)) normalized[k.trim().toLowerCase()] = v;
    const result = {};
    for (const t of contextTopics) {
      const v = normalized[t.trim().toLowerCase()];
      result[t] = Array.isArray(v) ? v.filter(n => Number.isInteger(n) && n >= 1 && n <= articles.length) : [];
    }
    return result;
  } catch (e) {
    // Unlike classifyContextTopicsByHeader below, this IS the final decision
    // for the scheduled-report pipeline — there's no follow-up pass to "fail
    // open" into here, so swallowing the error used to just produce a
    // wrong, silent "nothing today" result with zero trace of what broke
    // (e.g. an AI billing/quota failure came back looking identical to a
    // genuinely quiet news day). Propagating lets the caller's existing
    // per-schedule error handling in generateScheduledReports do its job:
    // log it, mark the run as failed, and retry tomorrow instead of
    // silently emailing an empty report as if it were accurate.
    console.error('classifyContextTopicsByFullBody failed:', e.message);
    throw e;
  }
}

async function translateBatch(ai, batch, targetLangName) {
  const prompt = `Translate each text in this JSON array to ${targetLangName}. Text already in ${targetLangName} should be returned unchanged.
Return ONLY a valid JSON array with exactly ${batch.length} elements in the same order.
Each element must be a properly JSON-escaped string. Preserve empty strings as "".
Do not add markdown, code blocks, or any explanation. Start with [ and end with ].

${JSON.stringify(batch)}`;

  const { text, usage } = await callAI(ai, prompt, 8000);
  let translations = extractJson(text, '[');
  if (!Array.isArray(translations) || translations.length < batch.length) {
    throw new Error(`translateBatch: expected at least ${batch.length} translations, got ${Array.isArray(translations) ? translations.length : typeof translations}`);
  }
  // Confirmed 2026-09-01: gemini-3.1-flash-lite sometimes pads the response
  // with extra trailing empty-string elements past what was asked for — the
  // real translations are still correct and in order, so this only trims
  // the harmless padding rather than discarding an otherwise-good batch.
  if (translations.length > batch.length) translations = translations.slice(0, batch.length);
  return { translations, usage };
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

    // Always update Firebase — set new URL if found, null out old broken URL if
    // not. Transaction (not read-then-set) so a concurrent fix/add from
    // another user can't get silently overwritten.
    try {
      await db.ref(`countries/${countryKey}/setup/sources`).transaction(current => {
        if (!Array.isArray(current)) return current;
        return current.map(s => s.name === sourceName ? { ...s, rssUrl: rssUrl || null, feedStats: feedStats || null } : s);
      });
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
// Adds one manually-found source (from "Find by name" -> Add) — transaction
// against live data, not a full-array replace of whatever the client had
// loaded. A full-array replace is exactly what let an out-of-band fix (or a
// concurrent edit from another tab/user) get silently overwritten by a
// stale client a few minutes later: the client doesn't know what it doesn't
// know, so it can only safely say "add this one thing" or "remove that one
// id" — never "here's everything," since "everything" it has might already
// be stale by the time this call lands.
exports.addSourceEntry = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey, source } = request.data || {};
    if (!countryKey || !source?.id || !source?.name) throw new HttpsError('invalid-argument', 'countryKey and source required');
    let added = false;
    await db.ref(`countries/${countryKey}/setup/sources`).transaction(current => {
      const existingList = Array.isArray(current) ? current : [];
      const key = normalizeSourceName(source.name);
      if (existingList.some(s => normalizeSourceName(s.name) === key)) { added = false; return; }
      added = true;
      return dedupeSourcesList([source, ...existingList]).deduped;
    });
    return { added };
  }
);

// Removes one source by id — same transaction reasoning as addSourceEntry
// above, just for the remove direction.
exports.removeSourceEntry = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { countryKey, sourceId } = request.data || {};
    if (!countryKey || !sourceId) throw new HttpsError('invalid-argument', 'countryKey and sourceId required');
    await db.ref(`countries/${countryKey}/setup/sources`).transaction(current => {
      const existingList = Array.isArray(current) ? current : [];
      return existingList.filter(s => s.id !== sourceId);
    });
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
    if (!['setup', 'addSources'].includes(key) || typeof value !== 'string') {
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
    if (!['setup', 'addSources'].includes(key)) throw new HttpsError('invalid-argument', 'valid key required');
    await db.ref(`config/prompts/${key}`).remove();
    return { ok: true };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// Scheduled Reports — reliable daily/weekly topic digests
//
// A single point-in-time check of a source's RSS feed is unreliable for
// high-volume outlets: their feed only exposes a small rolling window of
// recent items, so a topic published earlier in the day can already have
// scrolled off by the time anyone checks. A schedule can't just re-run that
// same live check on a timer — it would inherit the exact same blind spot.
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

// Reduces needless polling for slow-moving feeds — a source with, say, one
// new item every 3 hours doesn't need re-checking every 15 minutes just
// because the scheduler ticks that often. Derived from the same
// itemCount/spanHours feed-stats already shown in the UI: the average gap
// between items, halved for safety margin, clamped to a sane range. A source
// with no feedStats yet (never checked, or too few items to measure a rate)
// defaults to the tightest interval, since there's no evidence yet that
// polling less often is safe for it.
const MIN_POLL_MINUTES = 15;
const MAX_POLL_MINUTES = 120;
function targetPollMinutes(source) {
  const stats = source.feedStats;
  if (!stats || !stats.spanHours || !stats.itemCount || stats.itemCount < 2) return MIN_POLL_MINUTES;
  const avgMinutesBetweenItems = (stats.spanHours * 60) / stats.itemCount;
  return Math.min(MAX_POLL_MINUTES, Math.max(MIN_POLL_MINUTES, Math.round(avgMinutesBetweenItems / 2)));
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

    const now = Date.now();
    for (const [countryKey, sourceIdSet] of Object.entries(sourceIdsByCountry)) {
      let sources = [];
      try { sources = (await db.ref(`countries/${countryKey}/setup/sources`).once('value')).val() || []; } catch { continue; }
      const bySourceId = Object.fromEntries(sources.map(s => [s.id, s]));

      let meta = {};
      try { meta = (await db.ref(`articleArchiveMeta/${countryKey}`).once('value')).val() || {}; } catch {}

      await Promise.all([...sourceIdSet].map(sourceId => {
        const source = bySourceId[sourceId];
        if (!source?.rssUrl) return Promise.resolve();
        const lastPolledAt = meta[sourceId]?.lastPolledAt || 0;
        const dueInMs = targetPollMinutes(source) * 60000 - (now - lastPolledAt);
        if (dueInMs > 0) return Promise.resolve(); // this source isn't due yet — cheaper feeds get skipped most ticks
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
// full day to archive. "Today" is deliberately excluded since it's still in
// progress.
function yesterdayUTC() {
  return addDaysUTC(isoDateUTC(new Date()), -1);
}

// Each returned article carries its own archive path (_archivePath) so the
// caller can delete specific entries later — the topic-matching pipeline only
// reads .title/.text, so this extra field rides along harmlessly.
async function readArchivedArticles(countryKey, sourceId, dayKeys) {
  const snaps = await Promise.all(dayKeys.map(day => db.ref(`articleArchive/${countryKey}/${sourceId}/${day}`).once('value')));
  const articles = [];
  dayKeys.forEach((day, i) => {
    const val = snaps[i].val();
    if (!val) return;
    for (const [key, a] of Object.entries(val)) {
      articles.push({ ...a, _archivePath: `articleArchive/${countryKey}/${sourceId}/${day}/${key}` });
    }
  });
  return articles;
}

// Reads each named topic's pre-compiled prompt fragment from the shared
// registry — a plain field lookup, not a rebuild from raw include/exclude
// words. Topics with no compiledPrompt yet (or missing from the registry
// entirely) are simply omitted, so classify behavior is unchanged for them.
async function loadTopicGuidance(topicNames) {
  if (!topicNames || topicNames.length === 0) return {};
  const snap = await db.ref('config/topicRegistry').once('value');
  const registry = snap.val() || {};
  const guidance = {};
  for (const name of topicNames) {
    const entry = registry[name];
    if (entry && entry.compiledPrompt) guidance[name] = entry.compiledPrompt;
  }
  return guidance;
}

// The one per-day pass: fetch that day's archived articles per source, match
// topics, translate what matched, group into day-topic-source sections.
// Always a single day now — daily generation is unconditional (every enabled
// schedule produces this every day, regardless of whether email is on for
// it), and weekly is built by aggregating 7 of these already-stored runs
// (see aggregateWeeklyFromDailyRuns) rather than re-running this over a week
// pooled together.
async function generateDailyReportRun(scheduleId, schedule, ai, translateAi, contextMode, now, sharedSourceKeys) {
  const periodEnd = yesterdayUTC();

  let sources = (await db.ref(`countries/${schedule.countryKey}/setup/sources`).once('value')).val() || [];
  sources = sources.filter(s => (schedule.sourceIds || []).includes(s.id));

  const topics = schedule.topics || [];
  const contextTopics = schedule.contextTopics || [];
  const { exactTopics, actualContextTopics } = splitTopicsByMode(topics, contextTopics);

  // One read for the whole run (not per source/day) — topicGuidance is just
  // each context topic's already-compiled prompt fragment, so this is a
  // cheap lookup, not a rebuild of anything from raw include/exclude words.
  const topicGuidance = await loadTopicGuidance(actualContextTopics);

  // Collected but not applied until the whole run is durably recorded by the
  // caller — if anything here throws, nothing here ever executes, so a
  // retried run still sees the full, unpruned archive to work from.
  const pendingDeletions = {};
  const perSourceMatchData = [];

  await Promise.all(sources.map(async (source) => {
    const articles = await readArchivedArticles(schedule.countryKey, source.id, [periodEnd]);
    if (articles.length === 0) return;

    const exactMatches = exactTopics.length > 0
      ? await computeTopicKeywordMatches(articles, exactTopics, source, ai, schedule.createdBy, schedule.createdByEmail)
      : {};
    let contextMatches = {};
    if (actualContextTopics.length > 0) {
      contextMatches = contextMode === 'fullBody'
        ? await classifyContextTopicsByFullBody(articles, actualContextTopics, ai, schedule.createdBy, schedule.createdByEmail, schedule.searchScope, schedule.country, topicGuidance)
        : await classifyContextTopicsByHeader(articles, actualContextTopics, ai, schedule.createdBy, schedule.createdByEmail, schedule.searchScope, schedule.country, topicGuidance);
    }
    const topicKeywordMatches = { ...exactMatches, ...contextMatches };
    const relevantIndices = relevantIndicesFromMatches(topicKeywordMatches);

    // Keep only the articles that mattered to this report; drop the rest
    // from the archive — UNLESS another enabled schedule for this same
    // country also uses this source. Two schedules with different topics
    // share the exact same archive node (country/source/day): if one prunes
    // down to "just my relevant articles" first, the other schedule would
    // then only have those leftovers to match against, and could mislabel
    // them under its own unrelated topics. Only safe to prune when this
    // schedule is the sole consumer of the source.
    const relevantSet = new Set(relevantIndices);
    const isSharedSource = sharedSourceKeys.has(`${schedule.countryKey}:${source.id}`);
    if (!isSharedSource) {
      articles.forEach((a, i) => { if (!relevantSet.has(i + 1)) pendingDeletions[a._archivePath] = null; });
    }
    if (relevantIndices.length === 0) return;

    // Only the matched articles get translated — same "only pay for what's
    // relevant" principle the old AI-summary path applied to its analysis
    // call, just applied to translation now instead. One batched AI call
    // per source (title+text for every relevant article together) rather
    // than one free-endpoint call per field — cheaper in requests, immune
    // to that endpoint's rate-limiting, and billed on the AI provider
    // already paid for (translateAi forces its cheapest model regardless
    // of what's picked for classification).
    const isEnglish = sourceIsEnglishOnly(source);
    const translatedArticles = articles.map(a => ({ title: a.title, text: a.text, link: a.link }));
    const toTranslate = isEnglish ? [] : relevantIndices;
    if (toTranslate.length > 0) {
      const batch = toTranslate.flatMap(i => [articles[i - 1].title, articles[i - 1].text]);
      try {
        const { translations, usage } = await translateBatch(translateAi, batch, 'English');
        if (usage) await persistCost(schedule.createdBy, schedule.createdByEmail, translateAi, calcCostUsd(translateAi, usage.input_tokens || 0, usage.output_tokens || 0));
        toTranslate.forEach((i, idx) => {
          translatedArticles[i - 1] = { title: translations[idx * 2], text: translations[idx * 2 + 1], link: articles[i - 1].link };
        });
      } catch (e) {
        // A report with an untranslated article, clearly flagged, beats an
        // article silently dropped (or worse, a whole report that looks
        // empty) — the original text (already seeded above) is left as-is,
        // translationFailed just drives the "couldn't translate" note the
        // email/report renderers show next to it.
        console.error(`translateBatch failed for source ${source.id}, showing ${toTranslate.length} article(s) untranslated:`, e.message);
        toTranslate.forEach(i => { translatedArticles[i - 1] = { ...translatedArticles[i - 1], translationFailed: true }; });
      }
    }

    perSourceMatchData.push({ source, topicKeywordMatches, translatedArticles });
  }));

  const sourceGroups = buildDaySourceGroups(perSourceMatchData);
  const days = sourceGroups.length > 0 ? [{ day: periodEnd, sources: sourceGroups }] : [];

  const run = {
    scheduleId, generatedAt: now.toISOString(), periodStart: periodEnd, periodEnd, dateLabel: periodEnd,
    days, topics, runType: 'daily', costUsd: 0, inputTokens: 0, outputTokens: 0, provider: ai.type, model: ai.model, status: 'ok'
  };
  return { run, pendingDeletions, periodEnd };
}

// Per-schedule, off by default — most reports read fine as one flowing
// paragraph, and forcing a topic breakdown on a quiet day just produces
// awkward stub sections. Rule 4 (skip empty topics entirely) only matters
// once sectioning is on — a flowing paragraph already just omits whatever
// nothing was collected on, nothing to instruct there.
function summaryStructureRules(sectioned) {
  return sectioned
    ? `3. Organize the summary into clearly separated sections, one per distinct topic or storyline actually covered. Start each section with a short heading on its own line, wrapped in ** (e.g. **Heading**), followed by a plain-prose paragraph — no other markdown, no bullet points.
4. Skip entirely any topic that had no real coverage — do not create a section, placeholder, or "nothing to report" line for it.`
    : `3. Plain prose only — no markdown, no headers, no bullet points.`;
}

// Strictly extractive weekly digest: the one AI call in the weekly path,
// deliberately told to use ONLY the week's own collected article text — same
// "no outside knowledge, no invented detail" rule the per-article analysis
// prompt already follows elsewhere in this file, just applied across the
// whole week's coverage instead of one outlet's one day.
async function generateWeeklySummary(schedule, days, ai) {
  const lines = [];
  for (const d of days) {
    for (const s of (d.sources || [])) {
      for (const a of (s.articles || [])) {
        lines.push(`[${s.sourceName}, ${d.day}] ${a.title} — ${a.text}`);
      }
    }
  }
  if (lines.length === 0) return null;

  const wordCount = clampWeeklySummaryWords(schedule.weeklySummaryWords);
  const prompt = `You are compiling a factual weekly news digest for ${titleCase(schedule.country)}, covering these topics: ${(schedule.topics || []).join(', ')}.

Below is every article's headline and text collected this week, across all sources.

RULES — follow exactly:
1. Use ONLY the information explicitly stated in the articles below — no outside knowledge, no historical background, no speculation, and no analysis, interpretation, or evaluation of your own. Every sentence must restate something the article text directly says, not a conclusion you have drawn from it. Do not use analytical or interpretive phrasing (e.g. "this suggests," "in an apparent attempt to," "reflecting broader tensions," "this comes amid") — state only what was explicitly reported, nothing more. If an article itself is an opinion piece, an allegation, or a claim by one side, report only that the claim was made and what it says — do not treat it as established fact, and do not add your own framing around it.
2. Attribute each distinct claim or story to the specific outlet that reported it, by name (e.g. "Sabah reported that...", "Hürriyet said...", "In an opinion column, Sözcü argued that..."). Every sentence should make clear which outlet is the source of that information, so a reader can tell attributed reporting apart from opinion or an official statement. If several outlets covered the same story, attribute it to one representative outlet rather than listing all of them.
${summaryStructureRules(!!schedule.sectionedSummary)}
Write approximately ${wordCount} words in total.

Articles:
${lines.join('\n')}

Weekly summary:`;

  const maxTokens = Math.min(4000, Math.round(wordCount * 2.2) + 300);
  const { text, usage } = await callAI(ai, prompt, maxTokens);
  return { text: (text || '').trim(), usage };
}

// On-demand only — a daily run never gets a summary automatically, unlike
// weekly (see aggregateWeeklyFromDailyRuns below, unchanged). Deliberately a
// separate function from generateWeeklySummary rather than a shared/
// parameterized one, so touching this can never risk altering weekly's
// prompt or behavior. Same extractive rules: summary text only ever drawn
// from this run's own collected articles, nothing else.
async function generateDailySummary(schedule, run, ai) {
  const lines = [];
  for (const d of (run.days || [])) {
    for (const s of (d.sources || [])) {
      for (const a of (s.articles || [])) {
        lines.push(`[${s.sourceName}] ${a.title} — ${a.text}`);
      }
    }
  }
  if (lines.length === 0) return null;

  const wordCount = clampDailySummaryWords(schedule.dailySummaryWords);
  const prompt = `You are compiling a factual daily news digest for ${titleCase(schedule.country)} on ${run.dateLabel}, covering these topics: ${(schedule.topics || []).join(', ')}.

Below is every article's headline and text collected today, across all sources.

RULES — follow exactly:
1. Use ONLY the information explicitly stated in the articles below — no outside knowledge, no historical background, no speculation, and no analysis, interpretation, or evaluation of your own. Every sentence must restate something the article text directly says, not a conclusion you have drawn from it. Do not use analytical or interpretive phrasing (e.g. "this suggests," "in an apparent attempt to," "reflecting broader tensions," "this comes amid") — state only what was explicitly reported, nothing more. If an article itself is an opinion piece, an allegation, or a claim by one side, report only that the claim was made and what it says — do not treat it as established fact, and do not add your own framing around it.
2. Attribute each distinct claim or story to the specific outlet that reported it, by name (e.g. "Sabah reported that...", "Hürriyet said...", "In an opinion column, Sözcü argued that..."). Every sentence should make clear which outlet is the source of that information, so a reader can tell attributed reporting apart from opinion or an official statement. If several outlets covered the same story, attribute it to one representative outlet rather than listing all of them.
${summaryStructureRules(!!schedule.sectionedSummary)}
Write approximately ${wordCount} words in total.

Articles:
${lines.join('\n')}

Daily summary:`;

  const maxTokens = Math.min(2000, Math.round(wordCount * 2.2) + 300);
  const { text, usage } = await callAI(ai, prompt, maxTokens);
  return { text: (text || '').trim(), usage };
}

// Builds a weekly digest purely from already-generated daily reportRuns — no
// archive re-scan, no re-matching. This is what makes "weekly" cheap (it used
// to independently re-process 7 pooled days, which duplicated whatever the
// daily runs for those same days had already paid for) and what makes a
// retroactive weekly report possible from existing daily history (see
// sendReportEmailNow) without waiting for a real week. The one exception is
// the summary above, which does need its own AI call.
async function aggregateWeeklyFromDailyRuns(scheduleId, schedule, weeklyPeriodEnd, now, ai) {
  const weeklyPeriodStart = addDaysUTC(weeklyPeriodEnd, -6);
  const snap = await db.ref(`reportRuns/${scheduleId}`).once('value');
  const runs = Object.values(snap.val() || {});
  const dailyRuns = runs.filter(r =>
    (r.runType || 'daily') === 'daily' && r.status === 'ok' &&
    r.periodEnd >= weeklyPeriodStart && r.periodEnd <= weeklyPeriodEnd
  );
  const days = dailyRuns
    .flatMap(r => r.days || [])
    .sort((a, b) => a.day.localeCompare(b.day));

  let summary = null, costUsd = 0, inputTokens = 0, outputTokens = 0;
  try {
    const result = await generateWeeklySummary(schedule, days, ai);
    if (result) {
      summary = result.text;
      inputTokens = result.usage?.input_tokens || 0;
      outputTokens = result.usage?.output_tokens || 0;
      costUsd = calcCostUsd(ai, inputTokens, outputTokens);
      await persistCost(schedule.createdBy, schedule.createdByEmail, ai, costUsd);
    }
  } catch (e) {
    // A failed summary must never fail the whole weekly digest — the
    // per-source article listing is still useful on its own without it.
    console.error('generateWeeklySummary failed', e.message);
    await maybeSendAiFailureAlert(schedule, e);
  }

  return {
    scheduleId, generatedAt: now.toISOString(), periodStart: weeklyPeriodStart, periodEnd: weeklyPeriodEnd,
    dateLabel: `${weeklyPeriodStart} to ${weeklyPeriodEnd}`,
    days, topics: schedule.topics || [], summary,
    runType: 'weekly', costUsd, inputTokens, outputTokens, provider: ai.type, model: ai.model, status: 'ok'
  };
}

exports.generateScheduledReports = onSchedule(
  { schedule: 'every 60 minutes', region: 'us-central1', memory: '512MiB', timeoutSeconds: 540, timeZone: 'Etc/UTC', secrets: [gmailAppPassword] },
  async () => {
    const now = new Date();
    const schedulesSnap = await db.ref('schedules').once('value');
    const schedules = schedulesSnap.val() || {};
    // Always the precise, full-article classifier here (classifyContextTopicsByFullBody),
    // never the cheaper header-only pass (classifyContextTopicsByHeader) — that one is a
    // deliberately loose "first pass, err on inclusion" classification meant to be
    // corrected by a follow-up full-text read, which this raw scheduled pipeline has no
    // such follow-up step for. Using it here let unrelated articles (e.g. global wire
    // stories) through under narrow topics like "Internal Politics" as a FINAL decision,
    // not just a candidate filter. 'fullBody' costs more per run but is the only mode
    // that's actually correct for a pipeline with no correction step.
    const contextMode = 'fullBody';

    // A source shared by more than one enabled schedule for the same country
    // must never get pruned by just one of them — see the comment in
    // generateDailyReportRun for why.
    const sourceUsageCount = new Map();
    for (const s of Object.values(schedules)) {
      if (!s.enabled) continue;
      for (const sourceId of (s.sourceIds || [])) {
        const key = `${s.countryKey}:${sourceId}`;
        sourceUsageCount.set(key, (sourceUsageCount.get(key) || 0) + 1);
      }
    }
    const sharedSourceKeys = new Set([...sourceUsageCount.entries()].filter(([, count]) => count > 1).map(([key]) => key));

    for (const [scheduleId, schedule] of Object.entries(schedules)) {
      if (!schedule.enabled) continue;
      const periodEnd = yesterdayUTC();
      // Falls back to the shared hourUtc for schedules saved before daily and
      // weekly got independent times.
      const dailyHour = schedule.dailyHourUtc ?? schedule.hourUtc;

      // ── Daily generation — always, regardless of whether daily email is
      // on. This is the base layer: it's what lets a broken feed show up
      // in-app within a day instead of staying silent for a week. Runs at
      // its own hour (dailyHourUtc), independent from weekly's (hourUtc). ──
      if (now.getUTCHours() === dailyHour) {
        // Already produced today's daily report — guards against a double-fire
        // within the same due hour, not a real recurrence.
        const dailyAlreadyDone = schedule.lastRunStatus === 'ok' && schedule.lastPeriodEnd === periodEnd;
        // Atomically claim this exact day before doing any work. Cloud
        // Scheduler delivers "at least once," not "exactly once" — this
        // function can genuinely be invoked twice within the same due hour
        // a few seconds apart, and a plain read-then-write here let both
        // invocations see "not done yet" and both generate + email a
        // duplicate report (confirmed 2026-08-12: 3 of 4 daily schedules
        // sent twice, with lastRunAt identical to the millisecond). The
        // claim lives in its own field, separate from lastPeriodEnd/
        // lastRunStatus, so a genuine failure still leaves those unset and
        // gets retried by tomorrow's tick, exactly as before.
        let dailyClaimed = false;
        if (!dailyAlreadyDone) {
          await db.ref(`schedules/${scheduleId}/dailyClaimPeriod`).transaction(current => {
            if (current === periodEnd) return; // another invocation already claimed this day
            dailyClaimed = true;
            return periodEnd;
          });
        }
        if (!dailyAlreadyDone && dailyClaimed) {
          const runRef = db.ref(`reportRuns/${scheduleId}`).push();
          try {
            const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
            const ai = makeAI(aiSettingsSnap.val() || {});
            const translateAi = makeAI(aiSettingsSnap.val() || {}, true);
            const { run, pendingDeletions } = await generateDailyReportRun(scheduleId, schedule, ai, translateAi, contextMode, now, sharedSourceKeys);
            // Daily always gets a summary now, same as weekly already does —
            // a failed summary must never fail the report itself, the
            // per-source article listing is still useful without it.
            try {
              const result = await generateDailySummary(schedule, run, ai);
              if (result) {
                run.summary = result.text;
                const summaryCostUsd = calcCostUsd(ai, result.usage?.input_tokens || 0, result.usage?.output_tokens || 0);
                run.costUsd = (run.costUsd || 0) + summaryCostUsd;
                run.inputTokens = (run.inputTokens || 0) + (result.usage?.input_tokens || 0);
                run.outputTokens = (run.outputTokens || 0) + (result.usage?.output_tokens || 0);
                await persistCost(schedule.createdBy, schedule.createdByEmail, ai, summaryCostUsd);
              }
            } catch (e) {
              console.error('generateDailySummary failed', e.message);
              await maybeSendAiFailureAlert(schedule, e);
            }
            await runRef.set(run);
            await db.ref(`schedules/${scheduleId}`).update({ lastRunAt: now.toISOString(), lastRunStatus: 'ok', lastPeriodEnd: periodEnd });
            if (Object.keys(pendingDeletions).length > 0) {
              try { await db.ref().update(pendingDeletions); } catch {}
            }
            if (schedule.sendDailyEmail) {
              // A second, independent atomic claim, checked as late as
              // possible (right before the actual send) — belt-and-
              // suspenders on top of dailyClaimPeriod above. Confirmed
              // 2026-08-23: two full daily runs still got generated and
              // emailed for the same schedule/period ~2 minutes apart
              // despite that earlier claim, so the email itself — the
              // part a recipient actually notices twice — gets its own
              // gate rather than trusting the generation-time claim alone.
              let emailClaimed = false;
              await db.ref(`schedules/${scheduleId}/dailyEmailedPeriod`).transaction(current => {
                if (current === periodEnd) return;
                emailClaimed = true;
                return periodEnd;
              });
              if (emailClaimed) {
                await sendReportEmail(schedule, run);
                // Marks this run as having a durable copy outside the
                // database (the recipient's inbox) — sweepScheduleReportRuns
                // only deletes old daily runs once this is true.
                await runRef.update({ emailSent: true });
              }
            }
          } catch (e) {
            // Deliberately does NOT set lastPeriodEnd on failure, so the next
            // hourly tick retries this same period instead of silently
            // skipping it.
            await runRef.set({ scheduleId, generatedAt: now.toISOString(), periodStart: periodEnd, periodEnd, dateLabel: periodEnd, runType: 'daily', status: 'error', error: e.message });
            await db.ref(`schedules/${scheduleId}`).update({ lastRunAt: now.toISOString(), lastRunStatus: 'error' });
            await maybeSendAiFailureAlert(schedule, e);
          }
        }
      }

      // ── Weekly aggregation — only on the schedule's chosen weekday, at its
      // own hour (hourUtc), built from the 7 daily runs above rather than
      // re-scanning anything. ──
      if (now.getUTCHours() === schedule.hourUtc && schedule.weeklyDay && WEEKDAYS[now.getUTCDay()] === schedule.weeklyDay) {
        const weeklyAlreadyDone = schedule.lastWeeklyRunStatus === 'ok' && schedule.lastWeeklyPeriodEnd === periodEnd;
        // Same at-least-once double-fire risk as the daily block above —
        // claim atomically before doing any work.
        let weeklyClaimed = false;
        if (!weeklyAlreadyDone) {
          await db.ref(`schedules/${scheduleId}/weeklyClaimPeriod`).transaction(current => {
            if (current === periodEnd) return;
            weeklyClaimed = true;
            return periodEnd;
          });
        }
        if (!weeklyAlreadyDone && weeklyClaimed) {
          const weeklyRunRef = db.ref(`reportRuns/${scheduleId}`).push();
          try {
            const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
            const ai = makeAI(aiSettingsSnap.val() || {});
            const weeklyRun = await aggregateWeeklyFromDailyRuns(scheduleId, schedule, periodEnd, now, ai);
            await weeklyRunRef.set(weeklyRun);
            await db.ref(`schedules/${scheduleId}`).update({ lastWeeklyRunAt: now.toISOString(), lastWeeklyRunStatus: 'ok', lastWeeklyPeriodEnd: periodEnd });
            if (schedule.sendWeeklyEmail) {
              // Same belt-and-suspenders send-time claim as the daily block.
              let weeklyEmailClaimed = false;
              await db.ref(`schedules/${scheduleId}/weeklyEmailedPeriod`).transaction(current => {
                if (current === periodEnd) return;
                weeklyEmailClaimed = true;
                return periodEnd;
              });
              if (weeklyEmailClaimed) await sendReportEmail(schedule, weeklyRun);
            }
          } catch (e) {
            await weeklyRunRef.set({ scheduleId, generatedAt: now.toISOString(), periodStart: addDaysUTC(periodEnd, -6), periodEnd, dateLabel: periodEnd, runType: 'weekly', status: 'error', error: e.message });
            await db.ref(`schedules/${scheduleId}`).update({ lastWeeklyRunAt: now.toISOString(), lastWeeklyRunStatus: 'error' });
            await maybeSendAiFailureAlert(schedule, e);
          }
        }
      }
    }
  }
);

// ─── Schedule management (admin-only, mirrors other admin-gated writes) ──────
// Recipients are arbitrary email addresses, not tied to authorizedUids —
// anyone with a valid-looking address can be added, format-checked only.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Each recipient carries its own language now — some want the report in
// English, some in Hebrew, from the same send. Accepts either {email,
// hebrew} objects (current shape) or plain strings (schedules saved before
// this existed, which default to English/untranslated — same as before).
function sanitizeEmailList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const isObj = raw && typeof raw === 'object';
    const email = String(isObj ? raw.email : raw || '').trim().toLowerCase();
    if (!email || !EMAIL_RE.test(email) || seen.has(email)) continue;
    seen.add(email);
    out.push({ email, hebrew: isObj ? !!raw.hebrew : false });
  }
  return out;
}

function clampSummaryWords(v, fallback) {
  return Math.min(Math.max(parseInt(v) || fallback, 50), 1000);
}
function clampWeeklySummaryWords(v) { return clampSummaryWords(v, 400); }
function clampDailySummaryWords(v) { return clampSummaryWords(v, 200); }

exports.createSchedule = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, sourceIds, topics, weeklyDay, hourUtc, dailyHourUtc, sendDailyEmail, sendWeeklyEmail } = request.data || {};
    const contextTopics = Array.isArray(request.data?.contextTopics) ? request.data.contextTopics : [];
    const emailRecipients = sanitizeEmailList(request.data?.emailRecipients);
    if (!country || !countryKey || !sourceIds?.length || !topics?.length) {
      throw new HttpsError('invalid-argument', 'country, countryKey, sourceIds, and topics required');
    }
    if (weeklyDay && !WEEKDAYS.includes(weeklyDay)) throw new HttpsError('invalid-argument', 'weeklyDay must be a valid weekday or empty (weekly digest off)');
    const hour = Math.min(Math.max(parseInt(hourUtc) || 0, 0), 23);
    const parsedDailyHour = parseInt(dailyHourUtc);
    const dailyHour = Math.min(Math.max(Number.isFinite(parsedDailyHour) ? parsedDailyHour : hour, 0), 23);
    const weeklySummaryWords = clampWeeklySummaryWords(request.data?.weeklySummaryWords);
    const dailySummaryWords = clampDailySummaryWords(request.data?.dailySummaryWords);
    const searchScope = request.data?.searchScope === 'domestic' ? 'domestic' : 'global';
    const reportTitle = String(request.data?.reportTitle || '').trim().slice(0, 60);

    const ref = db.ref('schedules').push();
    const schedule = {
      id: ref.key, country, countryKey, sourceIds, topics, contextTopics, searchScope, reportTitle,
      weeklyDay, hourUtc: hour, dailyHourUtc: dailyHour, weeklySummaryWords, dailySummaryWords,
      sendDailyEmail: !!sendDailyEmail, sendWeeklyEmail: !!sendWeeklyEmail, emailRecipients,
      sectionedSummary: !!request.data?.sectionedSummary,
      enabled: true,
      createdBy: request.auth.uid, createdByEmail: request.auth.token.email || null,
      createdAt: new Date().toISOString(),
      lastRunAt: null, lastRunStatus: null, lastPeriodEnd: null,
      lastWeeklyRunAt: null, lastWeeklyRunStatus: null, lastWeeklyPeriodEnd: null,
      sharedWith: {}
    };
    await ref.set(schedule);
    return { schedule: { ...schedule, access: 'owner' } };
  }
);

exports.updateSchedule = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, ...updates } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
    if (updates.emailRecipients !== undefined) updates.emailRecipients = sanitizeEmailList(updates.emailRecipients);
    if (updates.weeklySummaryWords !== undefined) updates.weeklySummaryWords = clampWeeklySummaryWords(updates.weeklySummaryWords);
    if (updates.dailySummaryWords !== undefined) updates.dailySummaryWords = clampDailySummaryWords(updates.dailySummaryWords);
    if (updates.hourUtc !== undefined) updates.hourUtc = Math.min(Math.max(parseInt(updates.hourUtc) || 0, 0), 23);
    if (updates.dailyHourUtc !== undefined) updates.dailyHourUtc = Math.min(Math.max(parseInt(updates.dailyHourUtc) || 0, 0), 23);
    if (updates.reportTitle !== undefined) updates.reportTitle = String(updates.reportTitle || '').trim().slice(0, 60);
    if (updates.searchScope !== undefined) updates.searchScope = updates.searchScope === 'domestic' ? 'domestic' : 'global';
    if (updates.sectionedSummary !== undefined) updates.sectionedSummary = !!updates.sectionedSummary;
    const allowed = ['sourceIds', 'topics', 'contextTopics', 'weeklyDay', 'hourUtc', 'dailyHourUtc', 'weeklySummaryWords', 'dailySummaryWords', 'reportTitle', 'enabled', 'sendDailyEmail', 'sendWeeklyEmail', 'emailRecipients', 'searchScope', 'sectionedSummary'];
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
    await requireAuthorized(request);
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
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

// ─── Per-report cleanup (old daily report runs) ───────────────────────────────
// Unlike the raw article archive, a daily report's full contents (article
// listing + summary) exist nowhere else once it's old — UNLESS it was
// actually emailed, in which case that email is a durable copy sitting in
// the recipient's inbox. So a daily run is only ever deleted once it's both
// past the retention window AND confirmed emailed — never based on age
// alone. Weekly runs are never touched by this: they're the long-term
// artifact (summary-only already), and for a schedule that doesn't email
// its weekly digest, the stored run is the only copy that exists at all.
const REPORT_CLEANUP_DEFAULTS = { enabled: true, retentionDays: 10 };
const REPORT_CLEANUP_CRON_UTC_HOUR = 4; // offset from the archive job's 3am to spread load
function clampReportRetentionDays(v) {
  return Math.min(Math.max(parseInt(v) || REPORT_CLEANUP_DEFAULTS.retentionDays, 1), 90);
}

async function sweepScheduleReportRuns(scheduleId, schedule, retentionDays) {
  const cutoff = addDaysUTC(isoDateUTC(new Date()), -retentionDays);
  const snap = await db.ref(`reportRuns/${scheduleId}`).once('value');
  const runs = snap.val() || {};
  let beforeBytes = 0, afterBytes = 0, deletedCount = 0, keptCount = 0, keptUnemailedCount = 0;
  const deletions = {};
  for (const [runId, run] of Object.entries(runs)) {
    if ((run.runType || 'daily') !== 'daily') continue; // weekly runs are never swept
    const size = Buffer.byteLength(JSON.stringify(run));
    beforeBytes += size;
    if (run.periodEnd >= cutoff) { afterBytes += size; keptCount++; continue; }
    // Runs written before the emailSent flag existed have no such field —
    // for those (only), status:'ok' plus the schedule's current
    // sendDailyEmail is used as a one-time bridge: if the send had failed,
    // the original run would have been overwritten with an error status
    // instead of 'ok', so 'ok' already implies the send succeeded whenever
    // it was attempted. Every run generated from here on stamps emailSent
    // explicitly, so this bridge stops mattering as old runs age out.
    const emailConfirmed = run.emailSent === true ||
      (run.emailSent === undefined && run.status === 'ok' && schedule.sendDailyEmail === true);
    if (run.status === 'ok' && emailConfirmed) {
      deletions[`reportRuns/${scheduleId}/${runId}`] = null;
      deletedCount++;
    } else {
      afterBytes += size; keptCount++; keptUnemailedCount++;
    }
  }
  if (Object.keys(deletions).length > 0) await db.ref().update(deletions);
  return {
    ranAt: new Date().toISOString(), retentionDays, cutoff,
    beforeBytes, afterBytes, reclaimedBytes: beforeBytes - afterBytes,
    deletedCount, keptCount, keptUnemailedCount
  };
}

exports.getReportCleanupSettings = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
    const now = new Date();
    const nextRunAt = new Date(now);
    nextRunAt.setUTCHours(REPORT_CLEANUP_CRON_UTC_HOUR, 0, 0, 0);
    if (nextRunAt <= now) nextRunAt.setUTCDate(nextRunAt.getUTCDate() + 1);
    return {
      enabled: schedule.cleanupEnabled !== undefined ? schedule.cleanupEnabled : REPORT_CLEANUP_DEFAULTS.enabled,
      retentionDays: schedule.cleanupRetentionDays !== undefined ? schedule.cleanupRetentionDays : REPORT_CLEANUP_DEFAULTS.retentionDays,
      lastRun: schedule.cleanupLastRun || null,
      nextRunAt: nextRunAt.toISOString(),
      cronUtcHour: REPORT_CLEANUP_CRON_UTC_HOUR
    };
  }
);

exports.updateReportCleanupSettings = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, enabled, retentionDays } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
    const patch = {};
    if (enabled !== undefined) patch.cleanupEnabled = !!enabled;
    if (retentionDays !== undefined) patch.cleanupRetentionDays = clampReportRetentionDays(retentionDays);
    if (Object.keys(patch).length === 0) throw new HttpsError('invalid-argument', 'no valid fields to update');
    await db.ref(`schedules/${scheduleId}`).update(patch);
    return { ok: true };
  }
);

exports.runReportCleanupNow = onCall(
  { timeoutSeconds: 60, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
    const retentionDays = clampReportRetentionDays(schedule.cleanupRetentionDays);
    const result = await sweepScheduleReportRuns(scheduleId, schedule, retentionDays);
    await db.ref(`schedules/${scheduleId}/cleanupLastRun`).set(result);
    return result;
  }
);

exports.pruneReportRuns = onSchedule(
  { schedule: `0 ${REPORT_CLEANUP_CRON_UTC_HOUR} * * *`, region: 'us-central1', memory: '256MiB', timeoutSeconds: 300, timeZone: 'Etc/UTC' },
  async () => {
    const snap = await db.ref('schedules').once('value');
    const schedules = snap.val() || {};
    for (const [scheduleId, schedule] of Object.entries(schedules)) {
      const enabled = schedule.cleanupEnabled !== undefined ? schedule.cleanupEnabled : REPORT_CLEANUP_DEFAULTS.enabled;
      if (!enabled) continue;
      const retentionDays = clampReportRetentionDays(schedule.cleanupRetentionDays);
      try {
        const result = await sweepScheduleReportRuns(scheduleId, schedule, retentionDays);
        await db.ref(`schedules/${scheduleId}/cleanupLastRun`).set(result);
      } catch (e) {
        console.error(`pruneReportRuns failed for ${scheduleId}`, e.message);
      }
    }
  }
);

// Manual "re-run today's daily report right now" — unlike sendReportEmailNow
// (which only resends whatever's already stored), this actually re-runs
// classification and translation against the same archived articles, using
// whatever topic definitions/wording are live *right now*. Exists because
// editing a topic's include/exclude words and clicking "Update Prompts" has
// no effect on a day already generated — the next chance to see it working
// would otherwise be tomorrow's automatic run. Replaces today's existing
// daily run in place (same reportRuns entry) rather than adding a second
// entry for the same day, so report history doesn't show a duplicate date.
exports.regenerateDailyReportNow = onCall(
  { timeoutSeconds: 300, memory: '512MiB', region: 'us-central1', secrets: [gmailAppPassword] },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');

    const now = new Date();
    const periodEnd = yesterdayUTC();
    const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
    const ai = makeAI(aiSettingsSnap.val() || {});
    const translateAi = makeAI(aiSettingsSnap.val() || {}, true);

    // Same shared-source protection as the automatic pipeline — a source
    // used by more than one enabled schedule must not get pruned here.
    const allSchedulesSnap = await db.ref('schedules').once('value');
    const allSchedules = allSchedulesSnap.val() || {};
    const sourceUsageCount = new Map();
    for (const s of Object.values(allSchedules)) {
      if (!s.enabled) continue;
      for (const sourceId of (s.sourceIds || [])) {
        const key = `${s.countryKey}:${sourceId}`;
        sourceUsageCount.set(key, (sourceUsageCount.get(key) || 0) + 1);
      }
    }
    const sharedSourceKeys = new Set([...sourceUsageCount.entries()].filter(([, count]) => count > 1).map(([key]) => key));

    const runsSnap = await db.ref(`reportRuns/${scheduleId}`).once('value');
    const existingMatch = Object.entries(runsSnap.val() || {}).find(([, r]) => (r.runType || 'daily') === 'daily' && r.periodEnd === periodEnd);
    const runRef = existingMatch ? db.ref(`reportRuns/${scheduleId}/${existingMatch[0]}`) : db.ref(`reportRuns/${scheduleId}`).push();

    try {
      const { run, pendingDeletions } = await generateDailyReportRun(scheduleId, schedule, ai, translateAi, 'fullBody', now, sharedSourceKeys);
      try {
        const result = await generateDailySummary(schedule, run, ai);
        if (result) {
          run.summary = result.text;
          const summaryCostUsd = calcCostUsd(ai, result.usage?.input_tokens || 0, result.usage?.output_tokens || 0);
          run.costUsd = (run.costUsd || 0) + summaryCostUsd;
          run.inputTokens = (run.inputTokens || 0) + (result.usage?.input_tokens || 0);
          run.outputTokens = (run.outputTokens || 0) + (result.usage?.output_tokens || 0);
          await persistCost(schedule.createdBy, schedule.createdByEmail, ai, summaryCostUsd);
        }
      } catch (e) {
        console.error('generateDailySummary failed (manual regenerate)', e.message);
        await maybeSendAiFailureAlert(schedule, e);
      }
      await runRef.set(run);
      await db.ref(`schedules/${scheduleId}`).update({ lastRunAt: now.toISOString(), lastRunStatus: 'ok', lastPeriodEnd: periodEnd });
      if (Object.keys(pendingDeletions).length > 0) {
        try { await db.ref().update(pendingDeletions); } catch {}
      }
      let emailed = false;
      if (schedule.sendDailyEmail) {
        await sendReportEmail(schedule, run);
        await runRef.update({ emailSent: true });
        emailed = true;
      }
      return { ok: true, days: (run.days || []).length, hasSummary: !!run.summary, emailed };
    } catch (e) {
      await runRef.set({ scheduleId, generatedAt: now.toISOString(), periodStart: periodEnd, periodEnd, dateLabel: periodEnd, runType: 'daily', status: 'error', error: e.message });
      await maybeSendAiFailureAlert(schedule, e);
      throw new HttpsError('internal', e.message);
    }
  }
);

// Manual test/trigger — sends the most recent report of the given type right
// now, ignoring the schedule's own sendDailyEmail/sendWeeklyEmail toggles
// (those gate the automatic hourly firing, not an explicit manual action).
// For 'weekly' specifically, if no weekly run exists yet, builds one on the
// spot from whatever daily history already exists — this is what makes it
// possible to test the weekly digest against Thailand/Cambodia's existing
// daily reports without waiting for a real week to pass.
exports.sendReportEmailNow = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: 'us-central1', secrets: [gmailAppPassword] },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, type } = request.data || {};
    if (!scheduleId || !['daily', 'weekly'].includes(type)) {
      throw new HttpsError('invalid-argument', 'scheduleId and type ("daily" or "weekly") required');
    }
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
    if (!schedule.emailRecipients?.length) {
      throw new HttpsError('failed-precondition', 'No email recipients configured for this schedule yet.');
    }

    const runsSnap = await db.ref(`reportRuns/${scheduleId}`).once('value');
    const runEntries = Object.entries(runsSnap.val() || {});
    const match = runEntries
      .filter(([, r]) => (r.runType || 'daily') === type && r.status === 'ok')
      .sort((a, b) => (b[1].periodEnd || '').localeCompare(a[1].periodEnd || ''))[0];
    let runId = match ? match[0] : null;
    let run = match ? match[1] : null;

    if (!run && type === 'weekly') {
      const periodEnd = yesterdayUTC();
      const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
      const ai = makeAI(aiSettingsSnap.val() || {});
      const built = await aggregateWeeklyFromDailyRuns(scheduleId, schedule, periodEnd, new Date(), ai);
      if (built.days.length === 0) {
        throw new HttpsError('failed-precondition', 'No daily report history yet to build a weekly digest from.');
      }
      const pushRef = await db.ref(`reportRuns/${scheduleId}`).push(built);
      runId = pushRef.key;
      run = built;
    }

    if (!run) throw new HttpsError('failed-precondition', `No ${type} report exists yet for this schedule.`);

    // Daily and weekly reports always carry a summary now (generated
    // automatically when the report itself is built) — this just backfills
    // the rare case of an older report from before that existed, so Send
    // Now never sends without one.
    if (!run.summary && runId) {
      const aiSettingsSnap = await db.ref(`users/${schedule.createdBy}/ai`).once('value');
      const ai = makeAI(aiSettingsSnap.val() || {});
      const result = await generateDailySummary(schedule, run, ai);
      if (result) {
        if (result.usage) await persistCost(schedule.createdBy, schedule.createdByEmail, ai, calcCostUsd(ai, result.usage.input_tokens || 0, result.usage.output_tokens || 0));
        await db.ref(`reportRuns/${scheduleId}/${runId}`).update({ summary: result.text });
        run = { ...run, summary: result.text };
      }
    }

    await sendReportEmail(schedule, run);
    return { ok: true, dateLabel: run.dateLabel };
  }
);

// Topics are a shared, global list now — deleting one from the picker could
// silently break someone else's schedule that still names it. Checks every
// schedule regardless of ownership (not just the caller's own), since the
// point is to warn about impact on OTHER people's reports too.
exports.checkTopicInUse = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { topic } = request.data || {};
    if (!topic) throw new HttpsError('invalid-argument', 'topic required');
    const snap = await db.ref('schedules').once('value');
    const schedules = Object.values(snap.val() || {});
    const usedBy = schedules
      .filter(s => (s.topics || []).some(t => t.toLowerCase() === topic.toLowerCase()))
      .map(s => ({ country: s.country, createdByEmail: s.createdByEmail }));
    return { inUse: usedBy.length > 0, usedBy };
  }
);

// Same idea as checkTopicInUse but for every topic at once — one scan of
// `schedules` instead of one call per topic, so the Topics settings list can
// show a usage badge on every row without a round trip per row.
exports.getAllTopicUsage = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const snap = await db.ref('schedules').once('value');
    const schedules = Object.values(snap.val() || {});
    const usage = {};
    for (const s of schedules) {
      for (const t of (s.topics || [])) {
        const key = t.toLowerCase();
        (usage[key] = usage[key] || []).push({ country: s.country, createdByEmail: s.createdByEmail });
      }
    }
    return { usage };
  }
);

// Mirrors DEFAULT_TOPICS in public/app.js — kept as a separate copy here
// (rather than passed in from the client) so migration doesn't depend on
// trusting client input for what "default" means.
const REGISTRY_DEFAULT_TOPICS = ['Gaza', 'Iran & Nuclear', 'Hezbollah', 'Israel', 'USA', 'Economy', 'Internal Politics', 'Security & Terrorism', 'Refugees', 'Normalization'];

// Topic names, and their include/exclude words, are case-insensitive — "Economy"
// and "economy" are the same topic. Merges case-variant duplicate topics (keeping
// whichever casing is isDefault, or was seen first) and case-variant duplicate
// words within one topic's include/exclude lists, unioning their fields. A no-op
// (no write) once the registry is already clean, so this is cheap to run on
// every load rather than needing a separate one-off cleanup step.
function dedupeWordsCaseInsensitive(words) {
  const seen = new Set();
  const out = [];
  for (const w of (words || [])) {
    const key = w.toLowerCase();
    if (!seen.has(key)) { seen.add(key); out.push(w); }
  }
  return out;
}

function normalizeTopicRegistry(registry) {
  let changed = false;
  const byLower = {};
  for (const [name, rawEntry] of Object.entries(registry)) {
    const entry = { ...rawEntry };
    const dedupedInclude = dedupeWordsCaseInsensitive(entry.include);
    const dedupedExclude = dedupeWordsCaseInsensitive(entry.exclude);
    if (entry.include && dedupedInclude.length !== entry.include.length) { entry.include = dedupedInclude; changed = true; }
    if (entry.exclude && dedupedExclude.length !== entry.exclude.length) { entry.exclude = dedupedExclude; changed = true; }

    const key = name.toLowerCase();
    if (!byLower[key]) {
      byLower[key] = { name, entry };
      continue;
    }
    changed = true;
    const existing = byLower[key];
    const keepExisting = existing.entry.isDefault || !entry.isDefault;
    const primary = keepExisting ? existing.entry : entry;
    const secondary = keepExisting ? entry : existing.entry;
    byLower[key] = {
      name: keepExisting ? existing.name : name,
      entry: {
        mode: primary.mode === 'classify' || secondary.mode === 'classify' ? 'classify' : 'exact',
        isDefault: !!(primary.isDefault || secondary.isDefault),
        include: dedupeWordsCaseInsensitive([...(primary.include || []), ...(secondary.include || [])]),
        exclude: dedupeWordsCaseInsensitive([...(primary.exclude || []), ...(secondary.exclude || [])]),
        ...((primary.compiledPrompt || secondary.compiledPrompt) ? {
          compiledPrompt: primary.compiledPrompt || secondary.compiledPrompt,
          compiledAt: primary.compiledAt || secondary.compiledAt
        } : {}),
        ...((primary.wordsUpdatedAt || secondary.wordsUpdatedAt) ? {
          wordsUpdatedAt: [primary.wordsUpdatedAt, secondary.wordsUpdatedAt].filter(Boolean).sort().pop()
        } : {})
      }
    };
  }
  const normalized = {};
  for (const { name, entry } of Object.values(byLower)) normalized[name] = entry;
  return { normalized, changed };
}

// One-time migration from the old per-flow topic storage (config/topics,
// used only by the point-in-time picker, and each schedule's own free-typed
// topics/contextTopics arrays) into one shared registry keyed by topic name.
// Needs a privileged full scan of `schedules` (blocked by DB rules for plain
// clients — see checkTopicInUse above for the same reasoning) to pick up any
// topic name a schedule uses that was never added to config/topics.
exports.getTopicRegistry = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const snap = await db.ref('config/topicRegistry').once('value');
    let registry = snap.val();

    if (!registry || Object.keys(registry).length === 0) {
      const [legacySnap, schedulesSnap] = await Promise.all([
        db.ref('config/topics').once('value'),
        db.ref('schedules').once('value')
      ]);
      const legacy = legacySnap.val() || {};
      const removedDefaults = new Set(legacy.removedDefaults || []);
      const legacyContext = new Set((legacy.context || []).map(t => t.toLowerCase()));
      const schedules = Object.values(schedulesSnap.val() || {});

      registry = {};
      const ensureTopic = (name, mode, isDefault) => {
        if (!name) return;
        if (!registry[name]) registry[name] = { mode, isDefault };
        else if (mode === 'classify' && registry[name].mode !== 'classify') registry[name].mode = 'classify';
      };
      REGISTRY_DEFAULT_TOPICS.filter(t => !removedDefaults.has(t))
        .forEach(t => ensureTopic(t, legacyContext.has(t.toLowerCase()) ? 'classify' : 'exact', true));
      (legacy.custom || [])
        .forEach(t => ensureTopic(t, legacyContext.has(t.toLowerCase()) ? 'classify' : 'exact', false));
      for (const s of schedules) {
        const schedContext = new Set((s.contextTopics || []).map(t => t.toLowerCase()));
        for (const t of (s.topics || [])) {
          ensureTopic(t, schedContext.has(t.toLowerCase()) ? 'classify' : 'exact', false);
        }
      }
    }

    const { normalized, changed } = normalizeTopicRegistry(registry);
    if (changed) await db.ref('config/topicRegistry').set(normalized);
    return { topics: normalized };
  }
);

// Cheap, user-triggered, one-shot AI call — never automatic — suggesting
// candidate include words for a classify-mode topic, which the user picks
// from via a checklist rather than having them merged in automatically.
// Include-only: exclude words work best when they come from a specific
// false-positive the user actually saw in a report, not a generic guess, so
// there's no AI suggestion for those — manual entry only. Deliberately
// country/politician-agnostic (the registry is global, shared across every
// country) so the suggestion stays useful regardless of which schedule ends
// up using it.
exports.suggestTopicWords = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { topic } = request.data || {};
    if (!topic) throw new HttpsError('invalid-argument', 'topic required');
    const ai = makeAI(request.data);
    const prompt = `You're helping define what counts as the news theme "${topic}" for a classifier that reads one article at a time and must decide whether it genuinely belongs to this theme — this will be used across many different countries, so stay structural and generic, not tied to any specific country, politician, or current event.

Suggest 6-10 short words/phrases: concrete signals that indicate an article genuinely belongs to this theme.

Return ONLY valid JSON, no markdown, no explanation: { "include": ["...", ...] }`;

    const { text, usage } = await callAI(ai, prompt, 250);
    if (usage) await persistCost(request.auth.uid, request.auth.token.email, ai, calcCostUsd(ai, usage.input_tokens || 0, usage.output_tokens || 0));
    const parsed = extractJson(text, '{') || {};
    return {
      include: Array.isArray(parsed.include) ? parsed.include.filter(w => typeof w === 'string') : []
    };
  }
);

exports.listSchedules = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const uid = request.auth.uid;
    const snap = await db.ref('schedules').once('value');
    const all = Object.values(snap.val() || {});
    // Personal by default — only schedules you own or that were shared with
    // you, not the whole app's list of every schedule anyone has created.
    const mine = all
      .map(s => ({ ...s, access: scheduleAccessLevel(s, uid) }))
      .filter(s => s.access);

    // hasUnread per schedule — a run this user hasn't opened yet that
    // actually matched something. An empty ("not covered") run isn't worth
    // flagging — there's nothing there to read.
    await Promise.all(mine.map(async (s) => {
      const [runsSnap, readSnap] = await Promise.all([
        db.ref(`reportRuns/${s.id}`).once('value'),
        db.ref(`users/${uid}/readReports/${s.id}`).once('value')
      ]);
      const runs = runsSnap.val() || {};
      const readMap = readSnap.val() || {};
      s.hasUnread = Object.entries(runs).some(([runId, r]) => {
        if (r.status !== 'ok' || readMap[runId]) return false;
        return computeRunRelevantTotal(r) > 0;
      });
    }));

    mine.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return { schedules: mine };
  }
);

exports.shareSchedule = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, email: rawEmail, level } = request.data || {};
    if (!scheduleId || !rawEmail) throw new HttpsError('invalid-argument', 'scheduleId and email required');
    if (level !== null && !['read', 'write'].includes(level)) {
      throw new HttpsError('invalid-argument', 'level must be "read", "write", or null to remove access');
    }
    const snap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = snap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'owner');

    const email = rawEmail.trim().toLowerCase();
    if (email === (schedule.createdByEmail || '').toLowerCase()) {
      throw new HttpsError('invalid-argument', 'That email is already the owner');
    }
    const role = await getRole(email);
    if (!role) {
      throw new HttpsError('failed-precondition',
        `${email} isn't authorized to use Airtime yet.\n\nHow to fix: add them in Settings → Manage Users first, then share again.`
      );
    }
    const targetUid = await resolveUidByEmail(email);
    if (!targetUid) {
      throw new HttpsError('failed-precondition',
        `${email} hasn't signed in to Airtime yet.\n\nHow to fix: ask them to log in once, then share again.`
      );
    }
    if (level === null) {
      await db.ref(`schedules/${scheduleId}/sharedWith/${targetUid}`).remove();
    } else {
      await db.ref(`schedules/${scheduleId}/sharedWith/${targetUid}`).set({ email, level });
    }
    return { ok: true };
  }
);

exports.listReportRuns = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId } = request.data || {};
    if (!scheduleId) throw new HttpsError('invalid-argument', 'scheduleId required');
    const scheduleSnap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = scheduleSnap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'read');
    const [snap, readSnap] = await Promise.all([
      db.ref(`reportRuns/${scheduleId}`).once('value'),
      db.ref(`users/${request.auth.uid}/readReports/${scheduleId}`).once('value')
    ]);
    const val = snap.val() || {};
    const readMap = readSnap.val() || {};
    // Metadata only — not the full per-source analysis payload, so browsing
    // history for a schedule with many runs stays lightweight.
    const runs = Object.entries(val).map(([runId, r]) => {
      return {
        runId, generatedAt: r.generatedAt, periodStart: r.periodStart, periodEnd: r.periodEnd,
        dateLabel: r.dateLabel, costUsd: r.costUsd || 0, status: r.status, error: r.error || null,
        runType: r.runType || 'daily',
        sourceCount: computeRunSourceCount(r),
        // Total matched articles across all sources — lets the list mark which
        // runs actually found something without fetching the full analysis.
        relevantTotal: computeRunRelevantTotal(r),
        // Per-user read state — read reports/{scheduleId}/{runId} is written
        // directly by the client (users/{uid} is already self-writable).
        read: !!readMap[runId]
      };
    });
    runs.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''));
    return { runs };
  }
);

exports.getReportRun = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, runId } = request.data || {};
    if (!scheduleId || !runId) throw new HttpsError('invalid-argument', 'scheduleId and runId required');
    const scheduleSnap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = scheduleSnap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'read');
    const snap = await db.ref(`reportRuns/${scheduleId}/${runId}`).once('value');
    const run = snap.val();
    if (!run) throw new HttpsError('not-found', 'Report run not found');
    return { run };
  }
);

// On-demand summary for one daily report run — never runs automatically.
// Caches the result on the run itself (same field weekly always populates at
// generation time), so re-opening or re-sending the same report never pays
// for a second AI call.
exports.summarizeReportRun = onCall(
  { timeoutSeconds: 60, memory: '256MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, runId } = request.data || {};
    if (!scheduleId || !runId) throw new HttpsError('invalid-argument', 'scheduleId and runId required');
    const scheduleSnap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = scheduleSnap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');

    const runRef = db.ref(`reportRuns/${scheduleId}/${runId}`);
    const runSnap = await runRef.once('value');
    const run = runSnap.val();
    if (!run) throw new HttpsError('not-found', 'Report run not found');
    if (run.summary) return { summary: run.summary };

    const ai = makeAI(request.data);
    const result = await generateDailySummary(schedule, run, ai);
    if (!result) return { summary: null };
    if (result.usage) await persistCost(request.auth.uid, request.auth.token.email, ai, calcCostUsd(ai, result.usage.input_tokens || 0, result.usage.output_tokens || 0));
    await runRef.update({ summary: result.text });
    return { summary: result.text };
  }
);

exports.deleteReportRun = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { scheduleId, runId } = request.data || {};
    if (!scheduleId || !runId) throw new HttpsError('invalid-argument', 'scheduleId and runId required');
    const scheduleSnap = await db.ref(`schedules/${scheduleId}`).once('value');
    const schedule = scheduleSnap.val();
    if (!schedule) throw new HttpsError('not-found', 'Schedule not found');
    requireScheduleAccess(schedule, request.auth.uid, 'write');
    await db.ref(`reportRuns/${scheduleId}/${runId}`).remove();
    return { ok: true };
  }
);

// Rough per-run / per-month cost projection shown before a schedule is
// turned on, based on typical article/token volume — not a specific run's
// real usage. Actual per-run cost is recorded once the schedule starts
// executing (see reportRuns / listReportRuns).
exports.estimateScheduleCost = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { sourceIds, topics, contextTopics, countryKey } = request.data || {};
    if (!sourceIds?.length || !topics?.length) throw new HttpsError('invalid-argument', 'sourceIds and topics required');

    const ai = makeAI(request.data);
    const contextSet = new Set((contextTopics || []).map(t => t.toLowerCase()));
    const hasContext = topics.some(t => contextSet.has(t.toLowerCase()));
    // Matches generateScheduledReports, which always runs 'fullBody' now —
    // see the comment there for why 'header' mode isn't a valid option for
    // this pipeline, so the estimate here shouldn't offer it as one either.
    const contextMode = hasContext ? 'fullBody' : null;

    // Exact-topic matching is a substring check plus a one-time,
    // permanently-cached per-topic-per-language translation, so it's
    // ~free. Context-topic classification and article translation (below,
    // for non-English sources) are the ongoing AI costs, both once per
    // day. The weekly digest adds no marginal cost of its own — it's built
    // by aggregating already-generated daily runs, not by re-matching
    // anything (its own summary is a once-a-week cost, small enough next to
    // the daily one below to not be worth modeling separately here).
    const assumedArticlesPerDay = 10;
    let perRunInputTokens = 0, perRunOutputTokens = 0;
    if (hasContext) {
      // 'fullBody' reads each full article (title + text) to classify —
      // pricier but a real judgment; 'header' reads only the headlines.
      perRunInputTokens += (contextMode === 'fullBody'
        ? Math.round(assumedArticlesPerDay * 120 * 1.3)
        : 150) * sourceIds.length;
      perRunOutputTokens += 60 * sourceIds.length;
    }

    // Daily summary is unconditional now (generated automatically every
    // day, not on-demand) — a real recurring cost regardless of topic mode,
    // so it belongs in this estimate too.
    const dailySummaryWords = clampDailySummaryWords(request.data?.dailySummaryWords);
    perRunInputTokens += Math.round(assumedArticlesPerDay * sourceIds.length * 120 * 1.3);
    perRunOutputTokens += Math.round(dailySummaryWords * 1.3);

    // Translating non-English sources' matched articles is now a real AI
    // cost (billed on the cheapest model regardless of the classification
    // model chosen — see makeAI's forTranslation flag) rather than free, so
    // it belongs in the estimate. Same per-article token basis as the
    // summary estimate above, only applied to non-English sources.
    let translateUsd = 0;
    if (countryKey) {
      try {
        const sourcesSnap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
        const selected = (sourcesSnap.val() || []).filter(s => sourceIds.includes(s.id));
        const nonEnglishCount = selected.filter(s => !sourceIsEnglishOnly(s)).length;
        if (nonEnglishCount > 0) {
          const translateAi = makeAI(request.data, true);
          const perArticleTokens = Math.round(120 * 1.3);
          const translateTokens = assumedArticlesPerDay * nonEnglishCount * perArticleTokens;
          translateUsd = calcCostUsd(translateAi, translateTokens, translateTokens);
        }
      } catch {}
    }

    const perRunUsd = calcCostUsd(ai, perRunInputTokens, perRunOutputTokens) + translateUsd;

    return {
      perRunUsd, monthlyUsd: perRunUsd * 30,
      provider: ai.type, model: ai.model, basis: 'heuristic', contextMode
    };
  }
);
