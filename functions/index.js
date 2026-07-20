const { onCall, HttpsError } = require('firebase-functions/v2/https');
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
async function recordCost(request, ai, inputTokens, outputTokens, isTranslation = false) {
  const costUsd = calcCostUsd(ai, inputTokens, outputTokens, isTranslation);
  if (costUsd > 0 && request.auth) {
    const uid = request.auth.uid;
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    await Promise.all([
      db.ref(`userCosts/${uid}/email`).set(request.auth.token.email || null),
      db.ref(`userCosts/${uid}/costs/${month}/${ai.type}`).set(admin.database.ServerValue.increment(costUsd)),
    ]).catch(() => {}); // never fail the user-facing request over a cost-logging hiccup
  }
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
    'claude-haiku-4-5-20251001':  { in: 0.80, out: 4 },
  },
  gemini: {
    'gemini-2.5-flash':          { in: 0.30, out: 2.50 },
    'gemini-2.5-pro':            { in: 1.25, out: 10.00 },
    'gemini-3-flash-preview':    { in: 0.30, out: 2.50 },
  },
  openai: {
    'gpt-4o-mini':  { in: 0.15, out: 0.60 },
    'gpt-4o':       { in: 2.50, out: 10.00 },
    'gpt-4.1':      { in: 2.00, out: 8.00 },
    'gpt-4.1-mini': { in: 0.40, out: 1.60 },
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
    if (status === 429 || msg.includes('rate limit') || msg.includes('quota exceeded') || msg.includes('too many requests') || msg.includes('rate_limit_exceeded')) {
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
  "type": "newspaper" or "tv" or "online" or "radio" or "news_agency",
  "lean": "government" or "pro-government" or "opposition" or "independent" or "pro-faction",
  "leanDescription": "One sentence in English describing the political position and ownership",
  "rssUrl": "Full RSS/Atom feed URL (string) or null if unknown",
  "websiteUrl": "Main website URL",
  "languages": ["Arabic"],
  "notes": "One sentence of important context: reach, influence, history"
}

Rules:
- Include exactly {{numSources}} sources spanning the full political spectrum
- Prioritize sources that have RSS feeds
- Be honest: if a country has no real opposition press, note that and include exile/diaspora sources
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

Include groups for government (or pro-government), opposition, and independent. If a group does not meaningfully exist in {{country}}'s media landscape, omit it and note it in synthesis.blindSpots.`
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

async function validateRssUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RoyNewsBot/1.0; +https://roy-news.web.app)' }
    });
    if (!res.ok) return false;
    const xml = await res.text();
    await rssParser.parseString(xml);
    return true;
  } catch { return false; }
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
  const q = topicQueries.length > 0
    ? `site:${domain} (${topicQueries.join(' OR ')})`
    : `site:${domain}`;
  const qs = new URLSearchParams({ q, hl: p.hl, gl: p.gl, ceid: p.ceid });
  return `https://news.google.com/rss/search?${qs}`;
}

function isStale(articles) {
  if (!articles.length) return false;
  const newest = articles.reduce((best, a) => {
    const t = a.date ? new Date(a.date).getTime() : 0;
    return t > best ? t : best;
  }, 0);
  if (!newest) return false; // no parseable dates — don't assume stale
  return newest < Date.now() - 3 * 24 * 60 * 60 * 1000;
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

    // Validate RSS URLs in parallel — drop any that fail to load
    const validations = await Promise.all(
      sources.map(s => s.rssUrl ? validateRssUrl(s.rssUrl) : Promise.resolve(false))
    );
    sources = sources.map((s, i) => validations[i] ? s : { ...s, rssUrl: null });
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
exports.addSources = onCall(
  { timeoutSeconds: 120, memory: '512MiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, numSources: rawNum, filterNoRSS, existingNames } = request.data;
    if (!country || typeof country !== 'string') throw new HttpsError('invalid-argument', 'country required');
    const numSources = Math.min(Math.max(parseInt(rawNum) || 5, 1), 10);

    const ai = makeAI(request.data);
    const customPrompts = await getCustomPrompts();
    const excludeClause = existingNames?.length
      ? `\n\nDo NOT include any of these already-listed sources: ${existingNames.join(', ')}`
      : '';
    const prompt = fillPrompt(customPrompts.setup || DEFAULT_PROMPTS.setup, { country, numSources }) + excludeClause;

    const { text, usage } = await callAI(ai, prompt, 3000);
    await recordCost(request, ai, usage?.input_tokens || 0, usage?.output_tokens || 0);
    let sources;
    try { sources = extractJson(text, '['); }
    catch (e) { throw new HttpsError('internal', 'Failed to parse sources: ' + e.message); }

    const validations = await Promise.all(
      sources.map(s => s.rssUrl ? validateRssUrl(s.rssUrl) : Promise.resolve(false))
    );
    sources = sources.map((s, i) => validations[i] ? s : { ...s, rssUrl: null });
    if (filterNoRSS) sources = sources.filter(s => s.rssUrl);

    if (sources.length > 0 && countryKey) {
      try {
        const snap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
        const existing = snap.val() || [];
        await db.ref(`countries/${countryKey}/setup/sources`).set([...existing, ...sources]);
      } catch {}
    }

    return { sources };
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
            const valid = await validateRssUrl(parsed.rssUrl);
            if (!valid) parsed.rssUrl = null;
          }
          source = parsed;
        }
      }
    } catch {}

    return { source };
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// AGENT 2: Fetch News
// ─────────────────────────────────────────────────────────────────────────────
exports.fetchNews = onCall(
  { timeoutSeconds: 300, memory: '1GiB', region: 'us-central1' },
  async (request) => {
    await requireAuthorized(request);
    const { country, countryKey, selectedSources, topics, date, summaryWords, maxArticles } = request.data;
    const summaryLen = `~${Math.min(Math.max(summaryWords || 100, 30), 300)}-word summary`;
    const articleLimit = Math.min(Math.max(parseInt(maxArticles) || 25, 10), 50);
    if (!country || !selectedSources?.length) throw new HttpsError('invalid-argument', 'country and sources required');

    const ai = makeAI(request.data);
    const lang = 'English';
    const topicList = topics.join(', ');
    const allResults = {};
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const customPrompts = await getCustomPrompts();

    // ── Per-source analysis — all sources run in parallel ───────────────────
    const sourceResults = await Promise.all(selectedSources.map(async (source) => {
      let articles = [];
      let rssError = null;
      let usedGoogleNews = false;

      // Step 1: try the source's own RSS feed
      if (source.rssUrl) {
        try { articles = await fetchRssWithRetry(source.rssUrl, articleLimit); }
        catch (e) { rssError = e.message; }
      }

      // Step 2: fall back to Google News if RSS failed or returned stale content
      if (articles.length === 0 || isStale(articles)) {
        const googleUrl = deriveGoogleNewsUrl(source, countryKey, topics);
        if (googleUrl) {
          const hadStale = articles.length > 0;
          try {
            const googleArticles = await fetchRssWithRetry(googleUrl, articleLimit);
            if (googleArticles.length > 0) { articles = googleArticles; rssError = null; usedGoogleNews = true; }
          } catch {}
          if (hadStale && isStale(articles)) { articles = []; rssError = rssError || 'Stale feed — no recent articles found'; }
        }
      }

      if (articles.length === 0) {
        return { source, articles, rssError, usage: null, text: null, usedGoogleNews };
      }

      // Keyword matching — determine which articles mention each topic
      const topicKeywordMatches = {};
      for (const topic of topics) {
        const kw = topic.toLowerCase();
        topicKeywordMatches[topic] = articles.reduce((acc, a, i) => {
          if ((a.title + ' ' + (a.text || '')).toLowerCase().includes(kw)) acc.push(i + 1);
          return acc;
        }, []);
      }
      let relevantIndices = [...new Set(Object.values(topicKeywordMatches).flat())].sort((a, b) => a - b);

      // Step 3: if RSS was fresh but had zero topic matches, try topic-targeted Google News
      if (relevantIndices.length === 0 && !usedGoogleNews) {
        const googleUrl = deriveGoogleNewsUrl(source, countryKey, topics);
        if (googleUrl) {
          try {
            const googleArticles = await fetchRssWithRetry(googleUrl, articleLimit);
            if (googleArticles.length > 0) {
              articles = googleArticles;
              rssError = null;
              usedGoogleNews = true;
              for (const topic of topics) {
                const kw = topic.toLowerCase();
                topicKeywordMatches[topic] = articles.reduce((acc, a, i) => {
                  if ((a.title + ' ' + (a.text || '')).toLowerCase().includes(kw)) acc.push(i + 1);
                  return acc;
                }, []);
              }
              relevantIndices = [...new Set(Object.values(topicKeywordMatches).flat())].sort((a, b) => a - b);
            }
          } catch {}
        }
      }

      // If no topic keyword found in any article, skip AI entirely
      if (relevantIndices.length === 0) {
        const precomputed = JSON.stringify({
          topicAnalyses: topics.map(t => ({
            topic: t, covered: false,
            summary: `No articles about this topic were published in this outlet on ${date}.`,
            tone: 'neutral', narrative: null, quotes: []
          })),
          overallTone: 'neutral',
          keyStories: [],
          relevantArticleIndices: []
        });
        return { source, articles, rssError, usage: null, text: precomputed, relevantIndices, topicKeywordMatches, usedGoogleNews };
      }

      const articlesText = articles.map((a, i) => `${i + 1}. ${a.title}\n${a.text}`).join('\n\n');
      const topicMatchesText = topics.map(t => {
        const idx = topicKeywordMatches[t];
        return `- ${t}: ${idx.length > 0 ? idx.map(i => `article ${i}`).join(', ') : 'none'}`;
      }).join('\n');

      const prompt = fillPrompt(customPrompts.analysis || DEFAULT_PROMPTS.analysis, {
        sourceName: source.name, sourceLean: source.lean, country,
        leanDescription: source.leanDescription, date, topicList,
        articlesText, topicMatchesText, lang, summaryLen
      });

      try {
        const { text, usage } = await callAI(ai, prompt, 3000);
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
        let analysis = null;
        if (r.text) {
          try { analysis = extractJson(r.text, '{'); }
          catch { analysis = { error: 'parse_error', raw: r.text.slice(0, 500) }; }
        }
        if (analysis && r.relevantIndices !== undefined) {
          analysis.relevantArticleIndices = r.relevantIndices;
          // Override covered/not-covered based on server-side keyword match — authoritative regardless of prompt
          if (Array.isArray(analysis.topicAnalyses) && r.topicKeywordMatches) {
            analysis.topicAnalyses = analysis.topicAnalyses.map(ta => {
              const key = Object.keys(r.topicKeywordMatches).find(t => t.toLowerCase() === (ta.topic || '').toLowerCase());
              if (!key) return ta;
              const hasMatch = r.topicKeywordMatches[key].length > 0;
              if (hasMatch && !ta.covered) return { ...ta, covered: true };
              if (!hasMatch && ta.covered) return { ...ta, covered: false, summary: `No articles about this topic were published in this outlet on ${date}.`, narrative: null, quotes: [], tone: 'neutral' };
              return ta;
            });
          }
        }
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
    try {
      const parsed = extractJson(text, '{');
      if (parsed.rssUrl) {
        const valid = await validateRssUrl(parsed.rssUrl);
        if (valid) rssUrl = parsed.rssUrl;
      }
    } catch {}

    // Always update Firebase — set new URL if found, null out old broken URL if not
    try {
      const snap = await db.ref(`countries/${countryKey}/setup/sources`).once('value');
      const sources = snap.val();
      if (Array.isArray(sources)) {
        const updated = sources.map(s => s.name === sourceName ? { ...s, rssUrl: rssUrl || null } : s);
        await db.ref(`countries/${countryKey}/setup/sources`).set(updated);
      }
    } catch {}

    return { rssUrl };
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

exports.listAuthorizedUsers = onCall(
  { timeoutSeconds: 30, memory: '128MiB', region: 'us-central1' },
  async (request) => {
    const role = await requireAuthorized(request);
    requireAdmin(role);
    const snap = await db.ref('authorizedUsers').once('value');
    const val = snap.val() || {};
    const users = Object.values(val).sort((a, b) => (a.email || '').localeCompare(b.email || ''));
    return { owner: OWNER_EMAIL, users };
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
    // Best-effort: revoke read access immediately for any uid we know maps to this
    // email (from prior usage), instead of waiting for their next getMyRole call.
    try {
      const snap = await db.ref('userCosts').once('value');
      const val = snap.val() || {};
      const uids = Object.entries(val).filter(([, u]) => (u.email || '').toLowerCase() === email).map(([uid]) => uid);
      await Promise.all(uids.map(uid => db.ref(`authorizedUids/${uid}`).remove()));
    } catch {}
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
    if (!['setup', 'analysis', 'period'].includes(key) || typeof value !== 'string') {
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
    if (!['setup', 'analysis', 'period'].includes(key)) throw new HttpsError('invalid-argument', 'valid key required');
    await db.ref(`config/prompts/${key}`).remove();
    return { ok: true };
  }
);
