// ─── Version ──────────────────────────────────────────────────────────────────
const VERSION = 'v3.10';

// ─── Firebase config ──────────────────────────────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCNzJ78R7ubQCkG3tB494pFU9Z6Ml7T22A",
  authDomain: "roy-news-23ab4.firebaseapp.com",
  databaseURL: "https://roy-news-23ab4-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "roy-news-23ab4",
  storageBucket: "roy-news-23ab4.firebasestorage.app",
  messagingSenderId: "544241806642",
  appId: "1:544241806642:web:c168412c4ac1035f81fb2b"
};

firebase.initializeApp(FIREBASE_CONFIG);
const auth = firebase.auth();
const db = firebase.database();
const fns = firebase.functions();

// ─── React hooks ──────────────────────────────────────────────────────────────
const { useState, useEffect, useRef } = React;

// ─── AI settings (Firebase per user, localStorage fallback for migration) ─────
const DEPRECATED_GEMINI = { 'gemini-2.0-flash': 'gemini-2.5-flash', 'gemini-2.0-flash-lite': 'gemini-2.5-flash' };

function normalizeAI(saved) {
  if (!saved?.provider) return null;
  if (DEPRECATED_GEMINI[saved.geminiModel]) saved.geminiModel = DEPRECATED_GEMINI[saved.geminiModel];
  return saved;
}

async function getAISettings(uid) {
  if (!uid) return { provider: null };
  try {
    const snap = await db.ref(`users/${uid}/ai`).once('value');
    const result = normalizeAI(snap.val());
    if (result) return result;
  } catch {}
  // Fall back to localStorage for users who haven't migrated yet
  try {
    const result = normalizeAI(JSON.parse(localStorage.getItem(`roy-news-ai-${uid}`)));
    if (result) return result;
  } catch {}
  return { provider: null };
}

function getUserPrefs(uid) {
  if (!uid) return {};
  try { return JSON.parse(localStorage.getItem(`roy-news-prefs-${uid}`)) || {}; } catch { return {}; }
}
function saveUserPrefs(uid, updates) {
  if (!uid) return;
  const existing = getUserPrefs(uid);
  localStorage.setItem(`roy-news-prefs-${uid}`, JSON.stringify({ ...existing, ...updates }));
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function countryToKey(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}
function getLeanCss(lean) {
  const m = { government: 'lean-government', 'pro-government': 'lean-pro-government', opposition: 'lean-opposition', independent: 'lean-independent', 'pro-faction': 'lean-pro-faction', various: 'lean-israel' };
  return m[lean] || 'lean-independent';
}
function getLeanColor(lean) {
  const m = { government: '#ef4444', 'pro-government': '#f97316', opposition: '#3b82f6', independent: '#64748b', 'pro-faction': '#a855f7', various: '#06b6d4' };
  return m[lean] || '#64748b';
}
function getToneClass(tone) {
  const m = { positive: 'tone-positive', negative: 'tone-negative', neutral: 'tone-neutral', alarmed: 'tone-alarmed', dismissive: 'tone-dismissive' };
  return m[(tone || '').toLowerCase()] || 'tone-neutral';
}
function getToneLabel(tone) {
  const m = { positive: 'Positive', negative: 'Negative', neutral: 'Neutral', alarmed: 'Alarmed', dismissive: 'Dismissive' };
  return m[(tone || '').toLowerCase()] || tone || 'Neutral';
}
// Ranks a source by how strongly its coverage matched the requested topics —
// not just whether it matched at all, but how many topics it covered and how
// much material backed that up — so the most relevant sources surface first
// instead of whatever order they happened to be fetched/stored in. Used by
// both the point-in-time results view and the scheduled-report viewer.
function topicMatchScore(analysis, relevantCount) {
  const coveredCount = (analysis?.topicAnalyses || []).filter(ta => ta.covered).length;
  return { coveredCount, relevantCount: relevantCount ?? (analysis?.relevantArticleIndices?.length || 0) };
}
function compareByMatchScore(a, b) {
  if (b.coveredCount !== a.coveredCount) return b.coveredCount - a.coveredCount;
  return b.relevantCount - a.relevantCount;
}
function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}
function formatLastLogin(ts) {
  if (!ts) return 'Never logged in';
  return 'Last logged in: ' + new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
// dd/mm/yyyy for a single "YYYY-MM-DD" string, or the same applied to both
// sides of a "YYYY-MM-DD to YYYY-MM-DD" range label.
function formatDMY(isoDate) {
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}
function formatDateLabelDMY(dateLabel) {
  if (!dateLabel) return dateLabel;
  if (dateLabel.includes(' to ')) {
    const [a, b] = dateLabel.split(' to ');
    return `${formatDMY(a)} to ${formatDMY(b)}`;
  }
  return formatDMY(dateLabel);
}
function formatDMYTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// A feed's item count alone doesn't say much — pairing it with the time
// span those items cover shows whether "10 items" means "the last 3 hours"
// (scrolls fast, small window) or "the last 3 days" (much more headroom).
function formatFeedStats(stats) {
  if (!stats || typeof stats.itemCount !== 'number') return null;
  const countLabel = `${stats.itemCount} item${stats.itemCount !== 1 ? 's' : ''}`;
  if (stats.spanHours == null) return countLabel;
  const spanLabel = stats.spanHours < 48 ? `~${stats.spanHours}h` : `~${Math.round(stats.spanHours / 24)}d`;
  return `${countLabel} · spans ${spanLabel}`;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TOPICS = ['Gaza', 'Iran & Nuclear', 'Hezbollah', 'Israel', 'USA', 'Economy', 'Internal Politics', 'Security & Terrorism', 'Refugees', 'Normalization'];

// Kept in sync with functions/index.js's DEFAULT_PROMPTS by hand — this copy
// only backs the Settings prompt-editor UI (initial text + "reset" display),
// the server's copy is what actually runs.
const DEFAULT_PROMPTS = {
  setup:
`You are a media research expert. Research the news media landscape of "{{country}}".

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

  addSources:
`You are a media research expert helping expand an existing news-source list for "{{country}}".

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

Country: {{country}}`,

  analysis:
`You are analyzing news coverage from "{{sourceName}}" ({{sourceLean}} outlet in {{country}}).
Context: {{leanDescription}}

Date: {{date}}
Topics of interest: {{topicList}}

Articles fetched from RSS on {{date}}:
{{articlesText}}

STRICT RULES — follow exactly:
1. covered: true ONLY if at least one article has this topic as its PRIMARY subject. An article that merely mentions a topic in passing does NOT qualify.
2. If no article primarily covers a topic: covered: false, summary: "No articles about this topic were published in this outlet on {{date}}.", narrative: null, quotes: [], tone: "neutral".
3. Do NOT add background knowledge, historical context, or information not directly stated in the fetched articles above. Every sentence must be supported by the article text.
4. Quotes must be copied verbatim from the articles — do not paraphrase or invent.
5. keyStories: up to 3 headlines from the fetched articles that are relevant to the selected topics ({{topicList}}). If fewer than 3 are relevant, list only those. If none are relevant, return [].
6. relevantArticleIndices: 1-based indices of all articles that are primarily relevant to any of the selected topics. If none, return [].

Respond in {{lang}} ONLY. Return ONLY valid JSON (no markdown, no explanation):
{
  "topicAnalyses": [
    {
      "topic": "topic name",
      "covered": true or false,
      "summary": "{{summaryLen}} based strictly on fetched articles, or the not-covered message",
      "tone": "positive" or "negative" or "neutral" or "alarmed" or "dismissive",
      "narrative": "Key framing from the articles only, or null if not covered",
      "quotes": ["Verbatim quote from article"]
    }
  ],
  "overallTone": "one word",
  "keyStories": ["relevant headline 1", "relevant headline 2"],
  "relevantArticleIndices": [1, 5]
}`,

  period:
`You are a media analyst with deep knowledge of {{country}}'s press landscape.

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

const COUNTRY_ALIASES = {
  usa: 'United States', 'u.s.a': 'United States', 'u.s': 'United States', us: 'United States',
  uk: 'United Kingdom', 'u.k': 'United Kingdom', gb: 'United Kingdom', 'great britain': 'United Kingdom',
  uae: 'United Arab Emirates', emirates: 'United Arab Emirates',
  ksa: 'Saudi Arabia', 'saudi': 'Saudi Arabia',
  drc: 'Democratic Republic of Congo',
  nz: 'New Zealand',
  rsa: 'South Africa',
  aus: 'Australia',
  ger: 'Germany', deu: 'Germany',
  fra: 'France',
  tur: 'Turkey',
  pak: 'Pakistan',
  afg: 'Afghanistan',
};

const LEAN_LABELS = { government: 'Government', 'pro-government': 'Pro-Government', opposition: 'Opposition', independent: 'Independent', 'pro-faction': 'Pro-Faction', various: 'Various' };
const TYPE_LABELS  = { newspaper: 'Newspaper', tv: 'TV', online: 'Online', radio: 'Radio', news_agency: 'Agency', podcast: 'Podcast' };

// ─── Shared styles ────────────────────────────────────────────────────────────
const BTN = (bg, extra = {}) => ({ background: bg, color: 'white', border: 'none', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 14, ...extra });
const SMALL_BTN = { background: '#1a2d42', color: '#cbd5e1', border: '1px solid #5b7ba8', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 600 };
const BACK_BTN = { background: '#1a2d42', color: '#cbd5e1', border: '1px solid #5b7ba8', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontWeight: 600, fontSize: 13 };
// Colors chosen for readability on a dark background — border/borderLight/faint
// were previously too low-contrast (verified against WCAG contrast ratios) and
// read as "dimmed" or invisible, especially at the small font sizes used for
// secondary text and button outlines throughout the app.
const C = { bg: '#0d1b2a', panel: '#132236', card: '#1a2d42', border: '#3d5a82', borderLight: '#5b7ba8', text: '#e2e8f0', muted: '#94a3b8', faint: '#a8b8cc' };

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function Spinner({ size = 20 }) {
  return <div className="spin" style={{ width: size, height: size, border: '2px solid #1e3a5f', borderTopColor: '#3b82f6', borderRadius: '50%', display: 'inline-block' }} />;
}

// ─── Generic confirm dialog ────────────────────────────────────────────────────
// Replaces window.confirm everywhere in the app — a native browser confirm()
// can't be styled, looks jarring against the rest of the UI, and is easy to
// click through on muscle memory. This is the one dialog every delete/remove
// action in the app should route through.
function ConfirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Delete', cancelLabel = 'Cancel', danger = true, onConfirm, onCancel }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onCancel}>
      <div className="panel" style={{ maxWidth: 360, width: '100%', padding: 20 }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 18, lineHeight: 1.5 }}>{message}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={{ ...SMALL_BTN, flex: 1 }}>{cancelLabel}</button>
          <button onClick={onConfirm} style={{ ...BTN(danger ? '#b91c1c' : '#2563eb'), flex: 1, fontSize: 13, padding: '9px 14px' }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Local per-component confirm-dialog state, so any component can do
// `const [confirm, confirmDialog] = useConfirm();` then
// `confirm({ message: '...', onConfirm: () => doTheThing() })` instead of
// window.confirm(...), and render {confirmDialog} once near its root.
function useConfirm() {
  const [state, setState] = useState(null);
  function confirm(opts) { setState(opts); }
  function close() { setState(null); }
  const dialog = state
    ? <ConfirmDialog {...state} onConfirm={() => { state.onConfirm(); close(); }} onCancel={close} />
    : null;
  return [confirm, dialog];
}

// ─── Progress Bar ─────────────────────────────────────────────────────────────
function ProgressBar({ durationSec, steps = [] }) {
  const [pct, setPct] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const iv = setInterval(() => {
      const elapsed = (Date.now() - startRef.current) / 1000;
      setPct(Math.min(92, (elapsed / durationSec) * 100));
      if (steps.length > 1) {
        setStepIdx(Math.min(steps.length - 1, Math.floor((elapsed / durationSec) * steps.length)));
      }
    }, 400);
    return () => clearInterval(iv);
  }, [durationSec, steps.length]);

  const label = steps[stepIdx] || 'Processing…';

  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ color: C.muted, fontSize: 13 }} className="pulse">{label}</span>
        <span style={{ color: C.faint, fontSize: 12, fontWeight: 600 }}>{Math.round(pct)}%</span>
      </div>
      <div className="progress-bar-track">
        <div className="progress-bar-fill" style={{ width: pct + '%' }} />
      </div>
    </div>
  );
}

// ─── Cancelable Loader ────────────────────────────────────────────────────────
function CancelableLoader({ title, durationSec, steps, onCancel }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 24, padding: 24 }}>
      <Spinner size={40} />
      <div style={{ fontWeight: 700, fontSize: 18, color: C.text }}>{title}</div>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <ProgressBar durationSec={durationSec} steps={steps} />
      </div>
      <button
        onClick={onCancel}
        style={{ ...BTN('#2a0a0a'), border: '1px solid #7f1d1d', color: '#f87171', marginTop: 8, fontSize: 13 }}
      >
        ✕ Stop & Cancel
      </button>
      <div style={{ color: C.faint, fontSize: 12 }}>
        The AI agent is working — cancelling will return you to the previous screen.
      </div>
    </div>
  );
}

// ─── Error Panel ──────────────────────────────────────────────────────────────
function ErrorPanel({ errors, onDismiss }) {
  if (!errors.length) return null;
  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 999, maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {errors.map(err => {
        const isKeyError = err.message.includes('API key') || err.message.includes('How to fix');
        const [firstLine, ...rest] = err.message.split('\n\n');
        return (
          <div key={err.id} className="error-panel slide-in" style={ isKeyError ? { borderColor: '#92400e', background: '#1c1200' } : {} }>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
              <div>
                <span style={{ color: isKeyError ? '#fbbf24' : '#f87171', fontWeight: 700, fontSize: 13 }}>{isKeyError ? '🔑 API Key Problem' : '⚠ Error'}</span>
                <span style={{ color: C.faint, fontSize: 11, marginLeft: 8 }}>{err.operation} · {new Date(err.timestamp).toLocaleTimeString()}</span>
              </div>
              <button onClick={() => onDismiss(err.id)} style={{ background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 0 0 8px' }}>✕</button>
            </div>
            <div style={{ color: isKeyError ? '#fcd34d' : '#fca5a5', fontSize: 13, fontWeight: 600, marginBottom: rest.length ? 8 : 10 }}>{firstLine}</div>
            {rest.map((para, i) => (
              <div key={i} style={{ color: '#d1d5db', fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>{para}</div>
            ))}
            <button onClick={() => navigator.clipboard?.writeText(err.message)} style={{ ...SMALL_BTN, fontSize: 11 }}>📋 Copy</button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Lean / Type badges ───────────────────────────────────────────────────────
function LeanBadge({ lean }) {
  const label = LEAN_LABELS[lean] || lean;
  const color = getLeanColor(lean);
  return (
    <span style={{ background: color + '22', color, border: '1px solid ' + color + '44', borderRadius: 4, padding: '1px 7px', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}
function TypeBadge({ type }) {
  return (
    <span style={{ background: '#1a2d42', color: C.muted, borderRadius: 4, padding: '1px 7px', fontSize: 11, whiteSpace: 'nowrap' }}>
      {TYPE_LABELS[type] || type}
    </span>
  );
}

// Small "about this source" toggle — same leanDescription/notes info the
// Select Sources screen already shows, made reusable so anywhere a source
// appears (results, period analysis, scheduled reports) can offer it too.
// Renders nothing if there's no lean description/notes to show. Place inside
// a flex row that has flexWrap: 'wrap' — the expanded panel uses
// flexBasis: '100%' to drop onto its own line within that same row.
function SourceInfoToggle({ source }) {
  const [open, setOpen] = useState(false);
  if (!source?.leanDescription && !source?.notes) return null;
  return (
    <>
      <button onClick={e => { e.stopPropagation(); setOpen(o => !o); }} title="About this source"
        style={{ background: 'none', border: 'none', color: open ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 14, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}>ℹ️</button>
      {open && (
        <div style={{ flexBasis: '100%', marginTop: 6 }} onClick={e => e.stopPropagation()}>
          {source.leanDescription && <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.55 }}>{source.leanDescription}</div>}
          {source.notes && <div style={{ color: C.faint, fontSize: 11, marginTop: 4 }}>{source.notes}</div>}
        </div>
      )}
    </>
  );
}

// ─── Login Screen ─────────────────────────────────────────────────────────────
function LoginScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleGoogleSignIn() {
    setLoading(true);
    setError('');
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      await auth.signInWithPopup(provider);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, background: C.bg }}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{ fontSize: 52, marginBottom: 10 }}>📰</div>
        <h1 style={{ fontSize: 30, fontWeight: 800, margin: '0 0 8px', color: C.text }}>Roy News</h1>
        <div style={{ color: C.muted, fontSize: 14, maxWidth: 320 }}>
          Explore how any country's media covers the world — multiple sources, compared and summarized by AI
        </div>
        <div style={{ color: C.faint, fontSize: 11, marginTop: 6 }}>{VERSION}</div>
      </div>

      <div className="panel" style={{ padding: 28, maxWidth: 340, width: '100%', textAlign: 'center' }}>
        <div style={{ color: C.muted, fontSize: 13, marginBottom: 20 }}>
          Sign in to save your analyses and access them from any device
        </div>
        <button
          onClick={handleGoogleSignIn}
          disabled={loading}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, width: '100%', padding: '11px 16px', background: 'white', color: '#1f1f1f', border: 'none', borderRadius: 8, cursor: loading ? 'default' : 'pointer', fontWeight: 600, fontSize: 14, opacity: loading ? 0.7 : 1 }}
        >
          {loading ? <Spinner size={18} /> : (
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#4285F4" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
              <path fill="#34A853" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
              <path fill="#FBBC05" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238A11.91 11.91 0 0 1 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
              <path fill="#EA4335" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
            </svg>
          )}
          {loading ? 'Signing in…' : 'Continue with Google'}
        </button>
        {error && <div style={{ marginTop: 14, color: '#f87171', fontSize: 12 }}>{error}</div>}
      </div>
    </div>
  );
}

// ─── Access Restricted Screen ──────────────────────────────────────────────────
function AccessRestrictedScreen({ user, onSignOut }) {
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: 24, background: C.bg, textAlign: 'center' }}>
      <div style={{ fontSize: 52, marginBottom: 10 }}>🔒</div>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: '0 0 8px', color: C.text }}>Access Restricted</h1>
      <div style={{ color: C.muted, fontSize: 14, maxWidth: 340, marginBottom: 4 }}>
        {user.email} isn't authorized to use Roy News yet.
      </div>
      <div style={{ color: C.faint, fontSize: 13, maxWidth: 340, marginBottom: 24, lineHeight: 1.6 }}>
        Ask the administrator to add your email in Settings → Manage Users.
      </div>
      <button onClick={onSignOut} style={{ ...BTN('#7f1d1d'), padding: '9px 20px' }}>Sign Out</button>
    </div>
  );
}

// ─── Setup Config Panel (shared between CountryStep new + refresh) ────────────
function SetupConfigPanel({ numSources, onChange, filterNoRSS, onFilterChange, onStart, onCancel, startLabel = '⚡ Start AI Setup' }) {
  return (
    <div style={{ padding: 14, background: '#0a1526', border: '1px solid #1e4a6e', borderRadius: 9, marginTop: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14 }}>AI Setup Configuration</div>

      <div style={{ fontSize: 12, color: C.faint, marginBottom: 8, fontWeight: 600 }}>Number of sources</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={() => onChange(numSources - 1)} style={{ width: 38, height: 38, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>−</button>
        <input type="number" min="1" max="15" value={numSources} inputMode="numeric" pattern="[0-9]*"
          onChange={e => onChange(parseInt(e.target.value) || 7)}
          style={{ width: 64, textAlign: 'center', fontSize: 22, fontWeight: 700, padding: '8px 4px', background: C.bg, border: '1px solid ' + C.borderLight, borderRadius: 8, color: C.text, outline: 'none' }} />
        <button onClick={() => onChange(numSources + 1)} style={{ width: 38, height: 38, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 22, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>+</button>
        <span style={{ fontSize: 13, color: C.muted }}>sources</span>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '10px 12px', background: filterNoRSS ? '#0a1e30' : C.card, borderRadius: 8, border: '1px solid ' + (filterNoRSS ? '#1e4a6e' : C.border), marginBottom: 16 }}>
        <input type="checkbox" checked={filterNoRSS} onChange={e => onFilterChange(e.target.checked)} style={{ accentColor: '#3b82f6', width: 15, height: 15, flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Hide sources without RSS</div>
          <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>Without RSS, AI uses training knowledge instead of live articles</div>
        </div>
      </label>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onStart} style={BTN('#2563eb')}>{startLabel}</button>
        <button onClick={onCancel} style={{ ...BTN('#1e3a5f'), background: C.card }}>Cancel</button>
      </div>
    </div>
  );
}

// ─── Shared Source Manager ────────────────────────────────────────────────────
// The only place source lists are managed — Settings → Country Management
// intentionally does not embed this; it only lists/removes whole countries.
function SourceManager({ country, user, sources, onSourcesChange, selectable = false, selected, onSelectionChange }) {
  const uid = user?.uid;
  const [confirm, confirmDialog] = useConfirm();

  const [expanded, setExpanded] = useState(new Set());
  function toggleExpand(id) {
    setExpanded(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  const [activePanel, setActivePanel] = useState(null); // 'addmore' | 'refresh'

  // Find by name
  const [findQuery, setFindQuery] = useState('');
  const [findResult, setFindResult] = useState(null);
  const [finding, setFinding] = useState(false);

  // Add more
  const [addNum, setAddNum] = useState(5);
  const [addFilterNoRSS, setAddFilterNoRSS] = useState(true);
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState('');
  // City/location narrows the search but isn't persisted — a city typed for
  // one country is meaningless as a default for the next one.
  const [addLocation, setAddLocation] = useState('');
  // Media type / orientation / language persist across sessions and countries.
  const [addMediaType, setAddMediaType] = useState(() => {
    try { return localStorage.getItem('roy-news-add-mediatype') || 'newspaper'; } catch { return 'newspaper'; }
  });
  const [addOrientation, setAddOrientation] = useState(() => {
    try { return localStorage.getItem('roy-news-add-orientation') || 'independent'; } catch { return 'independent'; }
  });
  const [addLanguage, setAddLanguage] = useState(() => {
    try { return localStorage.getItem('roy-news-add-language') || 'english'; } catch { return 'english'; }
  });
  function changeAddMediaType(v) { setAddMediaType(v); try { localStorage.setItem('roy-news-add-mediatype', v); } catch {} }
  function changeAddOrientation(v) { setAddOrientation(v); try { localStorage.setItem('roy-news-add-orientation', v); } catch {} }
  function changeAddLanguage(v) { setAddLanguage(v); try { localStorage.setItem('roy-news-add-language', v); } catch {} }

  // Refresh all
  const [refreshNum, setRefreshNum] = useState(() => {
    const p = user ? getUserPrefs(user.uid) : {};
    return sources.length || p.numSources || 7;
  });
  const [refreshFilterNoRSS, setRefreshFilterNoRSS] = useState(() => {
    const p = user ? getUserPrefs(user.uid) : {};
    return p.filterNoRSS ?? true;
  });
  const [refreshing, setRefreshing] = useState(false);

  // Fix URL
  const [fixingSourceId, setFixingSourceId] = useState(null);

  // Feed stats (item count / time span) — checked without an AI call
  const [checkingStatsId, setCheckingStatsId] = useState(null);
  const [checkingAllStats, setCheckingAllStats] = useState(false);

  // Sources added in the most recent add/find action — shown at the top of
  // the list with a temporary dashed marker until the next add or reload.
  const [newlyAddedIds, setNewlyAddedIds] = useState(new Set());

  // List sort order (display-only — doesn't change the stored source order).
  // Persisted so it survives this session and the next one, not just per-country.
  const [sortBy, setSortBy] = useState(() => {
    try { return localStorage.getItem('roy-news-source-sort') || 'default'; } catch { return 'default'; }
  });
  function changeSortBy(v) {
    setSortBy(v);
    try { localStorage.setItem('roy-news-source-sort', v); } catch {}
  }
  const LEAN_ORDER = ['government', 'pro-government', 'opposition', 'independent', 'pro-faction', 'various'];
  function sortSources(list) {
    if (sortBy === 'name') return [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sortBy === 'lean') {
      return [...list].sort((a, b) => {
        const d = LEAN_ORDER.indexOf(a.lean) - LEAN_ORDER.indexOf(b.lean);
        return d !== 0 ? d : a.name.localeCompare(b.name);
      });
    }
    return list;
  }

  // Hide/show selected-only toggle (persisted, selectable mode only)
  const [showOnlySelected, setShowOnlySelected] = useState(() => {
    try { return localStorage.getItem('roy-news-show-only-selected') === 'true'; } catch { return false; }
  });
  function toggleShowOnlySelected() {
    const next = !showOnlySelected;
    setShowOnlySelected(next);
    try { localStorage.setItem('roy-news-show-only-selected', String(next)); } catch {}
  }

  const rssHealth = (() => {
    try { return JSON.parse(localStorage.getItem(`roy-news-rss-health-${uid}-${country.key}`)) || {}; }
    catch { return {}; }
  })();

  const isBusy = refreshing || adding || finding || !!fixingSourceId || !!checkingStatsId || checkingAllStats;

  async function handleFind() {
    const q = findQuery.trim();
    if (!q || finding) return;
    setFinding(true);
    setFindResult(null);
    try {
      const fn = fns.httpsCallable('findSource', { timeout: 60000 });
      const result = await fn({ country: country.name, countryKey: country.key, sourceName: q, ...await getAISettings(uid) });
      setFindResult({ source: result.data.source || null });
    } catch (e) {
      setFindResult({ source: null, error: e.message });
    }
    setFinding(false);
  }

  function handleAddFound() {
    const src = findResult?.source;
    if (!src) return;
    const newSources = [src, ...sources];
    onSourcesChange(newSources);
    setNewlyAddedIds(new Set([src.id]));
    if (selectable && onSelectionChange) onSelectionChange(new Set([...(selected || []), src.id]));
    fns.httpsCallable('updateSources')({ countryKey: country.key, sources: newSources }).catch(() => {});
    setFindResult(null);
    setFindQuery('');
  }

  async function handleAddMore() {
    setAdding(true);
    setAddMsg('');
    try {
      const fn = fns.httpsCallable('addSources', { timeout: 120000 });
      const result = await fn({
        country: country.name, countryKey: country.key,
        numSources: addNum, filterNoRSS: addFilterNoRSS,
        existingNames: sources.map(s => s.name),
        location: addLocation, mediaType: addMediaType, orientation: addOrientation, language: addLanguage,
        ...await getAISettings(uid)
      });
      const newSrcs = result.data.sources || [];
      if (newSrcs.length > 0) {
        const merged = [...newSrcs, ...sources];
        onSourcesChange(merged);
        setNewlyAddedIds(new Set(newSrcs.map(s => s.id)));
        if (selectable && onSelectionChange) {
          onSelectionChange(new Set([...(selected || []), ...newSrcs.map(s => s.id)]));
        }
        setAddMsg(`✓ Added ${newSrcs.length} source${newSrcs.length !== 1 ? 's' : ''} · ${newSrcs.filter(s => s.rssUrl).length} with RSS`);
      } else if (result.data.rssFilteredCount > 0) {
        setAddMsg(`Found ${result.data.rssFilteredCount} new outlet${result.data.rssFilteredCount !== 1 ? 's' : ''}, but none had a working RSS feed — try again, or uncheck "Only sources with RSS".`);
      } else if (result.data.duplicatesSkipped > 0) {
        setAddMsg('The AI kept suggesting outlets you already have. Try again — it usually finds different ones on a second pass.');
      } else {
        setAddMsg('No new sources found — try again, or try a smaller "how many to add" number.');
      }
      setActivePanel(null);
    } catch (e) {
      setAddMsg('⚠ ' + e.message);
    }
    setAdding(false);
  }

  async function handleRefreshAll() {
    setRefreshing(true);
    try {
      const fn = fns.httpsCallable('setupCountry', { timeout: 120000 });
      const result = await fn({ country: country.name, numSources: refreshNum, filterNoRSS: refreshFilterNoRSS, ...await getAISettings(uid) });
      const newSrcs = result.data.sources || [];
      onSourcesChange(newSrcs);
      if (selectable && onSelectionChange) {
        onSelectionChange(new Set(newSrcs.filter(s => s.rssUrl).map(s => s.id)));
      }
      setActivePanel(null);
    } catch (e) {
      alert('Refresh failed: ' + e.message);
    }
    setRefreshing(false);
  }

  async function handleFixSource(src) {
    setFixingSourceId(src.id);
    try {
      const fn = fns.httpsCallable('fixSourceUrl', { timeout: 60000 });
      const result = await fn({ country: country.name, countryKey: country.key, sourceName: src.name, ...await getAISettings(uid) });
      const newUrl = result.data.rssUrl || null;
      onSourcesChange(sources.map(s => s.id === src.id ? { ...s, rssUrl: newUrl, feedStats: newUrl ? result.data.feedStats : null } : s));
      if (!newUrl) alert(`Could not find a working RSS feed for ${src.name}. The feed link has been cleared.`);
    } catch (e) {
      alert('Fix failed: ' + e.message);
    }
    setFixingSourceId(null);
  }

  // No AI call — just re-fetches an already-known rssUrl to report its
  // current item count / time span. Used for sources added before this
  // feature existed, or to spot-check whether a feed's cadence has changed.
  async function handleCheckStats(src) {
    if (!src.rssUrl) return;
    setCheckingStatsId(src.id);
    try {
      const fn = fns.httpsCallable('checkFeedStats', { timeout: 30000 });
      const result = await fn({ countryKey: country.key, sourceId: src.id, rssUrl: src.rssUrl });
      if (result.data.valid) {
        onSourcesChange(sources.map(s => s.id === src.id ? { ...s, feedStats: result.data.feedStats } : s));
      } else {
        alert(`Could not reach ${src.name}'s feed just now — try again, or use ⚙ Fix if this keeps happening.`);
      }
    } catch (e) {
      alert('Stats check failed: ' + e.message);
    }
    setCheckingStatsId(null);
  }

  async function handleCheckAllStats() {
    const withFeed = sources.filter(s => s.rssUrl);
    if (withFeed.length === 0) return;
    setCheckingAllStats(true);
    try {
      const fn = fns.httpsCallable('checkFeedStats', { timeout: 30000 });
      const results = await Promise.all(withFeed.map(s =>
        fn({ countryKey: country.key, sourceId: s.id, rssUrl: s.rssUrl }).then(r => ({ id: s.id, ...r.data })).catch(() => ({ id: s.id, valid: false }))
      ));
      const byId = Object.fromEntries(results.map(r => [r.id, r]));
      onSourcesChange(sources.map(s => byId[s.id]?.valid ? { ...s, feedStats: byId[s.id].feedStats } : s));
      const failedCount = results.filter(r => !r.valid).length;
      if (failedCount > 0) alert(`${failedCount} of ${withFeed.length} feeds couldn't be reached just now — their stats were left unchanged.`);
    } catch (e) {
      alert('Refresh stats failed: ' + e.message);
    }
    setCheckingAllStats(false);
  }

  function handleRemoveSource(id) {
    confirm({
      message: 'Remove this source permanently?',
      onConfirm: () => {
        const newSources = sources.filter(s => s.id !== id);
        onSourcesChange(newSources);
        if (selectable && onSelectionChange) {
          const n = new Set(selected); n.delete(id); onSelectionChange(n);
        }
        fns.httpsCallable('updateSources')({ countryKey: country.key, sources: newSources }).catch(() => {});
      }
    });
  }

  return (
    <div>
      {/* Action bar: search + Add More + Refresh All */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 6, flex: 1, minWidth: 180 }}>
          <input className="input-field" placeholder="Find a source by name…"
            value={findQuery}
            onChange={e => { setFindQuery(e.target.value); if (findResult) setFindResult(null); }}
            onKeyDown={e => e.key === 'Enter' && !isBusy && handleFind()}
            style={{ flex: 1, fontSize: 13, padding: '6px 12px' }} />
          <button onClick={handleFind} disabled={!findQuery.trim() || isBusy}
            style={{ ...SMALL_BTN, opacity: (!findQuery.trim() || isBusy) ? 0.5 : 1, flexShrink: 0 }}>
            {finding ? <Spinner size={12} /> : '🔍'}
          </button>
        </div>
        <button onClick={() => { setActivePanel(p => p === 'addmore' ? null : 'addmore'); setAddMsg(''); setAddLocation(''); }} disabled={isBusy}
          style={{ ...SMALL_BTN, padding: '9px 18px', fontSize: 14, fontWeight: 700, borderWidth: 2, borderColor: activePanel === 'addmore' ? '#3b82f6' : '#5b7ba8', color: activePanel === 'addmore' ? '#60a5fa' : C.text }}>
          + Add More
        </button>
        <button onClick={() => setActivePanel(p => p === 'refresh' ? null : 'refresh')} disabled={isBusy}
          style={{ ...SMALL_BTN, padding: '9px 18px', fontSize: 14, fontWeight: 700, borderWidth: 2, borderColor: activePanel === 'refresh' ? '#3b82f6' : '#5b7ba8', color: activePanel === 'refresh' ? '#60a5fa' : C.text }}>
          ↻ Refresh All
        </button>
      </div>

      {/* Find result */}
      {findResult && (
        <div style={{ marginBottom: 12, padding: '12px 14px', background: '#0f1e35', borderRadius: 9, border: '1px solid ' + (findResult.source ? '#14532d' : findResult.error ? '#7f1d1d' : C.border) }}>
          {findResult.error
            ? <div style={{ color: '#f87171', fontSize: 13 }}>⚠ {findResult.error}</div>
            : findResult.source
              ? <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{findResult.source.name}</span>
                      {findResult.source.nameOriginal && findResult.source.nameOriginal !== findResult.source.name && <span style={{ color: C.faint, fontSize: 12 }}>{findResult.source.nameOriginal}</span>}
                      <LeanBadge lean={findResult.source.lean} />
                      <TypeBadge type={findResult.source.type} />
                      {findResult.source.rssUrl ? <span style={{ fontSize: 11, color: '#4ade80' }}>✓ RSS verified</span> : <span style={{ fontSize: 11, color: '#fb923c' }}>○ No RSS</span>}
                    </div>
                    {findResult.source.leanDescription && <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.5 }}>{findResult.source.leanDescription}</div>}
                  </div>
                  <button onClick={handleAddFound} style={{ ...BTN('#14532d'), fontSize: 13, flexShrink: 0 }}>+ Add</button>
                </div>
              : <div style={{ color: C.muted, fontSize: 13 }}>No outlet found matching "{findQuery}". Try a different spelling or name.</div>
          }
        </div>
      )}

      {/* Add more panel */}
      {activePanel === 'addmore' && !adding && (
        <div style={{ marginBottom: 12, padding: 14, background: '#0a1526', border: '1px solid #1e4a6e', borderRadius: 9 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 12 }}>Add More Sources</div>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, fontWeight: 600 }}>How many to add</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <button onClick={() => setAddNum(n => Math.max(1, n - 1))} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>−</button>
            <input type="number" min="1" max="10" value={addNum} inputMode="numeric"
              onChange={e => setAddNum(Math.min(10, Math.max(1, parseInt(e.target.value) || 5)))}
              style={{ width: 52, textAlign: 'center', fontSize: 18, fontWeight: 700, padding: '5px 4px', background: C.bg, border: '1px solid ' + C.borderLight, borderRadius: 8, color: C.text, outline: 'none' }} />
            <button onClick={() => setAddNum(n => Math.min(10, n + 1))} style={{ width: 32, height: 32, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 18, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>+</button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 10px', background: addFilterNoRSS ? '#0a1e30' : C.card, borderRadius: 7, border: '1px solid ' + (addFilterNoRSS ? '#1e4a6e' : C.border), marginBottom: 12 }}>
            <input type="checkbox" checked={addFilterNoRSS} onChange={e => setAddFilterNoRSS(e.target.checked)} style={{ accentColor: '#3b82f6', width: 14, height: 14 }} />
            <span style={{ fontSize: 13, color: C.text }}>Only sources with RSS</span>
          </label>

          <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, fontWeight: 600 }}>City (optional — leave blank for the whole country)</div>
          <input type="text" value={addLocation} onChange={e => setAddLocation(e.target.value)}
            placeholder="e.g. Chicago" className="input-field" style={{ fontSize: 13, marginBottom: 12 }} />

          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px' }}>
              <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, fontWeight: 600 }}>Media type</div>
              <select value={addMediaType} onChange={e => changeAddMediaType(e.target.value)} className="input-field" style={{ fontSize: 13 }}>
                <option value="newspaper">Newspaper</option>
                <option value="tv">TV</option>
                <option value="radio">Radio</option>
                <option value="podcast">Podcast</option>
                <option value="other">Other / no preference</option>
              </select>
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, fontWeight: 600 }}>Orientation</div>
              <select value={addOrientation} onChange={e => changeAddOrientation(e.target.value)} className="input-field" style={{ fontSize: 13 }}>
                <option value="government">Government</option>
                <option value="pro-government">Pro-Government</option>
                <option value="opposition">Opposition</option>
                <option value="independent">Independent</option>
                <option value="pro-faction">Pro-Faction</option>
              </select>
            </div>
            <div style={{ flex: '1 1 140px' }}>
              <div style={{ fontSize: 12, color: C.faint, marginBottom: 6, fontWeight: 600 }}>Language</div>
              <select value={addLanguage} onChange={e => changeAddLanguage(e.target.value)} className="input-field" style={{ fontSize: 13 }}>
                <option value="english">English</option>
                <option value="native">Native language</option>
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleAddMore} style={BTN('#2563eb')}>OK</button>
            <button onClick={() => setActivePanel(null)} style={{ ...BTN('#1e3a5f'), background: C.card }}>Cancel</button>
          </div>
        </div>
      )}
      {adding && (
        <div style={{ padding: '12px 14px', background: '#0a1526', border: '1px solid #1e4a6e', borderRadius: 9, marginBottom: 10 }}>
          <ProgressBar durationSec={5 + addNum * 3} steps={['Searching for new outlets…', 'Verifying RSS feeds…', 'Finalizing…']} />
        </div>
      )}
      {addMsg && (
        <div style={{ marginBottom: 10, padding: '8px 12px', borderRadius: 7, fontSize: 12, color: addMsg.startsWith('✓') ? '#4ade80' : '#fb923c', background: addMsg.startsWith('✓') ? '#052e16' : '#2a1505', border: '1px solid ' + (addMsg.startsWith('✓') ? '#14532d' : '#7c3d00') }}>
          {addMsg}
        </div>
      )}

      {/* Refresh all panel */}
      {activePanel === 'refresh' && !refreshing && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ padding: '8px 12px', background: '#1c0a00', border: '1px solid #7c3d00', borderRadius: 7, marginBottom: 10, fontSize: 12, color: '#fb923c' }}>
            ⚠ This replaces the entire source list with a freshly generated one.
          </div>
          <SetupConfigPanel
            numSources={refreshNum} onChange={v => { const c = Math.min(Math.max(v, 1), 15); setRefreshNum(c); if (uid) saveUserPrefs(uid, { numSources: c }); }}
            filterNoRSS={refreshFilterNoRSS} onFilterChange={v => { setRefreshFilterNoRSS(v); if (uid) saveUserPrefs(uid, { filterNoRSS: v }); }}
            onStart={handleRefreshAll} onCancel={() => setActivePanel(null)}
            startLabel="↻ Regenerate All Sources" />
        </div>
      )}
      {refreshing && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: C.muted, fontSize: 13, padding: '8px 0', marginBottom: 10 }}>
          <Spinner size={14} /> Regenerating sources for {country.name}… (30–60 seconds)
        </div>
      )}

      {/* Select All / Clear All / Show toggle — selectable mode */}
      {selectable && sources.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => onSelectionChange(new Set(sources.map(s => s.id)))} style={SMALL_BTN}>Select All</button>
          <button onClick={() => onSelectionChange(new Set())} style={SMALL_BTN}>Clear All</button>
          <span style={{ color: C.faint, fontSize: 12, alignSelf: 'center', marginLeft: 4 }}>{(selected?.size || 0)} selected</span>
          <button onClick={toggleShowOnlySelected}
            style={{ ...SMALL_BTN, marginLeft: 'auto', borderColor: showOnlySelected ? '#3b82f6' : C.border, color: showOnlySelected ? '#60a5fa' : C.faint }}>
            {showOnlySelected ? '● Selected only' : '○ Show all'}
          </button>
        </div>
      )}

      {/* Sort control + bulk feed-stats refresh */}
      {sources.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          {sources.length > 1 && (
            <>
              <span style={{ color: C.faint, fontSize: 12 }}>Sort by</span>
              <select value={sortBy} onChange={e => changeSortBy(e.target.value)} className="input-field" style={{ fontSize: 12, padding: '4px 10px', width: 'auto' }}>
                <option value="default">Default</option>
                <option value="name">Name</option>
                <option value="lean">Orientation</option>
              </select>
            </>
          )}
          <button onClick={handleCheckAllStats} disabled={isBusy || checkingAllStats || sources.filter(s => s.rssUrl).length === 0}
            style={{ ...SMALL_BTN, marginLeft: 'auto' }}>
            {checkingAllStats ? <><Spinner size={10} />&nbsp;Checking feeds…</> : '🔄 Refresh Feed Stats'}
          </button>
        </div>
      )}

      {/* Source list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sortSources(selectable && showOnlySelected ? sources.filter(s => selected?.has(s.id)) : sources).map(src => {
          const active = !selectable || (selected?.has(src.id) ?? false);
          const health = rssHealth[src.id];
          const isNew = newlyAddedIds.has(src.id);
          return (
            <div key={src.id} className={selectable ? `check-item ${getLeanCss(src.lean)}` : getLeanCss(src.lean)}
              onClick={selectable ? () => { const n = new Set(selected); n.has(src.id) ? n.delete(src.id) : n.add(src.id); onSelectionChange(n); } : undefined}
              style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: active ? C.card : '#0f1e35', border: '1px solid ' + (active ? C.borderLight : C.border), borderRadius: 8, cursor: selectable ? 'pointer' : 'default', ...(isNew ? { outline: '2px dashed #3b82f6', outlineOffset: 2 } : {}) }}>
              {selectable && (
                <input type="checkbox" checked={active} readOnly
                  style={{ marginTop: 3, accentColor: getLeanColor(src.lean), flexShrink: 0, pointerEvents: 'none' }} />
              )}
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{src.name}</span>
                  {isNew && (
                    <span style={{ background: '#1e3a8a', color: '#93c5fd', border: '1px solid #3b82f6', borderRadius: 4, padding: '1px 7px', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>NEW</span>
                  )}
                  {src.nameOriginal && src.nameOriginal !== src.name && <span style={{ color: C.faint, fontSize: 12 }}>{src.nameOriginal}</span>}
                  <LeanBadge lean={src.lean} />
                  <TypeBadge type={src.type} />
                  {src.languages?.length > 0 && (
                    <span style={{ background: '#1a2d42', color: '#60a5fa', border: '1px solid #2a4060', borderRadius: 4, padding: '1px 7px', fontSize: 11, whiteSpace: 'nowrap' }}>
                      🌐 {src.languages.join(' / ')}
                    </span>
                  )}
                  {!src.rssUrl
                    ? <span style={{ fontSize: 11, color: '#f97316' }}>○ No RSS</span>
                    : health?.ok === true
                      ? <span style={{ fontSize: 11, color: '#4ade80' }}>✓ {health.date}</span>
                      : health?.ok === false
                        ? <span style={{ fontSize: 11, color: '#ef4444' }}>⚠ failed</span>
                        : <span style={{ fontSize: 11, color: C.faint }}>⬤ URL stored</span>
                  }
                  {src.rssUrl && formatFeedStats(src.feedStats) && (
                    <span style={{ fontSize: 11, color: C.faint, whiteSpace: 'nowrap' }} title="Items currently in this feed, and the time span they cover">
                      · {formatFeedStats(src.feedStats)}
                    </span>
                  )}
                  <button onClick={e => { e.stopPropagation(); toggleExpand(src.id); }}
                    style={{ background: 'none', border: 'none', color: expanded.has(src.id) ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 16, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}>ℹ️</button>
                </div>
                {expanded.has(src.id) && (
                  <div style={{ marginTop: 6 }} onClick={e => e.stopPropagation()}>
                    <div style={{ color: C.muted, fontSize: 12, lineHeight: 1.55 }}>{src.leanDescription}</div>
                    {src.notes && <div style={{ color: C.faint, fontSize: 11, marginTop: 4 }}>{src.notes}</div>}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, flexShrink: 0, alignItems: 'flex-start', marginLeft: 'auto', justifyContent: 'flex-end', maxWidth: 160 }} onClick={e => e.stopPropagation()}>
                {src.rssUrl && (
                  <button onClick={() => handleCheckStats(src)} disabled={isBusy || checkingStatsId === src.id}
                    title="Re-check this feed's item count and time span" style={{ ...SMALL_BTN, fontSize: 11 }}>
                    {checkingStatsId === src.id ? <><Spinner size={10} />&nbsp;Checking…</> : '🔄 Stats'}
                  </button>
                )}
                <button onClick={() => handleFixSource(src)} disabled={isBusy}
                  style={{ ...SMALL_BTN, fontSize: 11 }}>
                  {fixingSourceId === src.id ? <><Spinner size={10} />&nbsp;Fixing…</> : '⚙ Fix'}
                </button>
                <button onClick={() => handleRemoveSource(src.id)} disabled={isBusy}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 20, padding: '0 4px', lineHeight: 1, opacity: 0.7 }}>×</button>
              </div>
            </div>
          );
        })}
      </div>
      {confirmDialog}
    </div>
  );
}

// ─── Step 1: Country Selection ────────────────────────────────────────────────
function CountryStep({ onCountryConfirmed, onError, user, onOpenSchedule, hasUnreadSchedules }) {
  const metaCacheKey = user ? `roy-news-countrymeta-${user.uid}` : null;
  const [input, setInput] = useState('');
  const [history, setHistory] = useState(() => {
    if (!metaCacheKey) return [];
    try { const c = JSON.parse(localStorage.getItem(metaCacheKey)); if (Array.isArray(c) && c.length > 0) return c; } catch {}
    return [];
  });
  const [lookup, setLookup] = useState(null);
  const [checking, setChecking] = useState(false);
  const [pendingSetup, setPendingSetup] = useState(null);
  const [numSources, setNumSources] = useState(() => { const p = user ? getUserPrefs(user.uid) : {}; return p.numSources || 7; });
  const [filterNoRSS, setFilterNoRSS] = useState(() => { const p = user ? getUserPrefs(user.uid) : {}; return p.filterNoRSS ?? true; });
  const lastKeyStorageKey = user ? `roy-news-lastcountry-${user.uid}` : null;
  const [lastKey, setLastKey] = useState(() => lastKeyStorageKey ? (localStorage.getItem(lastKeyStorageKey) || null) : null);
  const cancelledRef = useRef(false);

  function handleNumSourcesChange(val) {
    const clamped = Math.min(Math.max(val, 1), 15);
    setNumSources(clamped);
    saveUserPrefs(user?.uid, { numSources: clamped });
  }
  function handleFilterChange(val) {
    setFilterNoRSS(val);
    saveUserPrefs(user?.uid, { filterNoRSS: val });
  }

  useEffect(() => {
    db.ref('country-meta').once('value').then(async snap => {
      if (cancelledRef.current) return;
      const meta = snap.val() || {};
      let list = Object.values(meta)
        .map(c => ({ name: c.country, key: c.countryKey, date: c.setupDate?.slice(0, 10) }))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      if (list.length === 0) {
        try {
          const countriesSnap = await db.ref('countries').once('value');
          if (cancelledRef.current) return;
          const countries = countriesSnap.val() || {};
          list = Object.values(countries)
            .filter(c => c.setup)
            .map(c => ({ name: c.setup.country, key: c.setup.countryKey, date: (c.setup.setupDate || '').slice(0, 10) }))
            .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        } catch {}
      }
      if (!cancelledRef.current) {
        setHistory(list);
        if (metaCacheKey && list.length > 0) localStorage.setItem(metaCacheKey, JSON.stringify(list));
      }
    });
    return () => { cancelledRef.current = true; };
  }, []);

  async function handleLookup(name) {
    const raw = (name || input).trim();
    if (!raw) return;

    // Normalize abbreviations
    const resolved = COUNTRY_ALIASES[raw.toLowerCase()] || raw;
    if (resolved !== raw) setInput(resolved);

    setChecking(true);
    setLookup(null);
    setPendingSetup(null);
    const key = countryToKey(resolved);

    try {
      const timeout = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('Lookup timed out — check your connection and try again')), 10000)
      );
      const snap = await Promise.race([
        db.ref(`countries/${key}/setup`).once('value'),
        timeout
      ]);
      if (!cancelledRef.current) {
        if (snap.val()) {
          if (lastKeyStorageKey) localStorage.setItem(lastKeyStorageKey, key);
          setLastKey(key);
          onCountryConfirmed({ name: resolved, key, setup: snap.val() });
        } else {
          setPendingSetup({ name: resolved, key });
          setLookup({ found: false, name: resolved, key });
        }
      }
    } catch (e) {
      if (!cancelledRef.current) {
        setLookup({ error: e.message, name: resolved });
      }
    } finally {
      if (!cancelledRef.current) setChecking(false);
    }
  }

  // "Latest usage" = when a report was last actually run for that country on
  // this device, falling back to its original setup date if never run.
  function usageDate(c) {
    const lastRun = user?.uid ? localStorage.getItem(`roy-news-lastrun-${user.uid}-${c.key}`) : null;
    return lastRun || c.date || '';
  }
  const sortedHistory = [...history].sort((a, b) => usageDate(b).localeCompare(usageDate(a)));

  function goToTopHistoryEntry() {
    const top = sortedHistory[0];
    if (top) { setInput(top.name); handleLookup(top.name); }
  }

  return (
    <div className="fade-in" style={{ maxWidth: 500, margin: '60px auto', padding: '0 20px' }}>
      <div style={{ textAlign: 'center', marginBottom: 24 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📰</div>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text }}>Roy News</h1>
        <div style={{ color: C.faint, fontSize: 12, marginTop: 4, cursor: 'pointer' }} onClick={() => window.location.reload()} title="Tap to refresh">{VERSION}</div>
      </div>

      {onOpenSchedule && (
        <button onClick={onOpenSchedule}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', padding: '12px', marginBottom: 16, background: C.card, border: '1px solid ' + C.border, borderRadius: 10, color: C.text, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          🗓️ Scheduled Reports
          {hasUnreadSchedules && <span title="Unread reports" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3b82f6' }} />}
        </button>
      )}

      <div className="panel" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: C.text }}>Select Country</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input-field"
            placeholder="Type a country name…"
            value={input}
            onChange={e => { setInput(e.target.value); setLookup(null); }}
            onKeyDown={e => { if (e.key === 'Enter') { input.trim() ? handleLookup() : goToTopHistoryEntry(); } }}
            style={{ flex: 1 }}
          />
          <button
            onClick={() => handleLookup()}
            disabled={!input.trim() || checking}
            style={{ ...BTN('#2563eb'), minWidth: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: (!input.trim() || checking) ? 0.5 : 1 }}
          >
            {checking ? <Spinner size={16} /> : '→'}
          </button>
        </div>

        {(lookup?.error || pendingSetup) && (
          <div style={{ marginTop: 16, padding: 16, background: C.card, borderRadius: 10, border: '1px solid ' + (lookup?.error ? '#7f1d1d' : C.borderLight) }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 10 }}>{lookup?.name || pendingSetup?.name}</div>
            {lookup?.error ? (
              <div>
                <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>⚠ {lookup.error}</div>
                <button onClick={() => handleLookup(lookup.name)} style={BTN('#7f1d1d')}>Try Again</button>
              </div>
            ) : pendingSetup ? (
              <>
                <div style={{ color: '#fb923c', fontSize: 13, marginBottom: 10 }}>⚡ New country — AI will research its media landscape (≈30–60 sec)</div>
                <SetupConfigPanel numSources={numSources} onChange={handleNumSourcesChange}
                  filterNoRSS={filterNoRSS} onFilterChange={handleFilterChange}
                  onStart={() => { const p = pendingSetup; setPendingSetup(null); onCountryConfirmed({ name: p.name, key: p.key, setup: null, needsSetup: true }); }}
                  onCancel={() => { setPendingSetup(null); setLookup(null); }} />
              </>
            ) : null}
          </div>
        )}

        {sortedHistory.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Recent Countries</div>
            <div style={{ maxHeight: 280, overflowY: 'auto', paddingRight: 2 }}>
              {sortedHistory.map(c => {
                const isLast = c.key === lastKey;
                const displayDate = usageDate(c);
                return (
                  <button key={c.key} onClick={() => { setInput(c.name); handleLookup(c.name); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', background: isLast ? '#0f2744' : C.card, border: '1px solid ' + (isLast ? '#2563eb' : C.border), borderRadius: 7, color: C.text, cursor: 'pointer', marginBottom: 4, fontSize: 14 }}>
                    {c.name} {isLast && <span style={{ color: '#60a5fa', fontSize: 11, fontWeight: 600 }}>★ last used</span>} {displayDate && <span style={{ color: C.faint, fontSize: 11 }}>· {displayDate}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Step 2: Sources ──────────────────────────────────────────────────────────
function SourcesStep({ country, user, onConfirmed, onBack }) {
  const storageKey = user ? `roy-news-sources-${user.uid}-${country.key}` : null;
  const [localSources, setLocalSources] = useState(country.setup?.sources || []);

  const [selected, setSelected] = useState(() => {
    const initSrcs = country.setup?.sources || [];
    if (storageKey) {
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey));
        if (Array.isArray(saved)) {
          const valid = new Set(initSrcs.map(s => s.id));
          const restored = new Set(saved.filter(id => valid.has(id)));
          if (restored.size > 0) return restored;
        }
      } catch {}
    }
    return new Set(initSrcs.filter(s => s.rssUrl).map(s => s.id));
  });

  function handleSelectionChange(newSel) {
    setSelected(newSel);
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify([...newSel]));
  }

  function handleSourcesChange(newSources) {
    setLocalSources(newSources);
    setSelected(prev => new Set([...prev].filter(id => newSources.some(s => s.id === id))));
  }

  return (
    <div className="fade-in" style={{ maxWidth: 640, margin: '40px auto', padding: '0 20px' }}>
      <div className="panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <button onClick={onBack} style={BACK_BTN}>← Back</button>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: '#4ade80' }}>{country.name}</div>
            <div style={{ fontSize: 11, color: C.faint }}>{localSources.length} sources · {localSources.filter(s => s.rssUrl).length} with RSS</div>
          </div>
        </div>

        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: C.text }}>Select Sources</h2>

        <SourceManager
          country={country}
          user={user}
          sources={localSources}
          onSourcesChange={handleSourcesChange}
          selectable={true}
          selected={selected}
          onSelectionChange={handleSelectionChange}
        />

        <button onClick={() => onConfirmed(localSources.filter(s => selected.has(s.id)))}
          disabled={selected.size === 0}
          style={{ ...BTN('#2563eb'), width: '100%', marginTop: 20, padding: '11px', fontSize: 15, opacity: selected.size === 0 ? 0.4 : 1 }}>
          Continue with {selected.size} source{selected.size !== 1 ? 's' : ''} →
        </button>
      </div>
    </div>
  );
}

// ─── Step 3: Topics + Config ──────────────────────────────────────────────────
function ConfigStep({ country, user, onGo, onBack }) {
  const uid = user?.uid;
  const topicsKey = uid ? `roy-news-topics-${uid}` : null;
  const [confirm, confirmDialog] = useConfirm();

  function loadLocal(field, fallback) {
    if (!topicsKey) return fallback;
    try {
      const saved = JSON.parse(localStorage.getItem(topicsKey));
      return saved?.[field] !== undefined ? saved[field] : fallback;
    } catch { return fallback; }
  }

  const [selectedTopics, setSelectedTopics] = useState(() => {
    const s = loadLocal('selected', null);
    return s?.length ? new Set(s) : new Set(['Gaza', 'Israel']);
  });
  // customTopics and removedDefaultTopics seed from localStorage, then get overwritten by Firebase
  const [customTopics, setCustomTopics]         = useState(() => loadLocal('custom', []));
  const [removedDefaultTopics, setRemovedDefaultTopics] = useState(() => new Set(loadLocal('removedDefaults', [])));
  // Topics tagged "Context" are judged thematically by AI instead of by
  // literal keyword — see Settings → Context Topic Analysis for how.
  const [contextTopics, setContextTopics]       = useState(() => new Set(loadLocal('context', [])));
  const [topicsLoaded, setTopicsLoaded]         = useState(false);
  const [summaryWords, setSummaryWords]         = useState(() => loadLocal('summaryWords', 100));
  const [maxArticles, setMaxArticles]           = useState(() => loadLocal('maxArticles', 25));
  const [mode, setMode]                         = useState(() => loadLocal('mode', 'pointintime'));
  const [periodType, setPeriodType]             = useState(() => loadLocal('periodType', 'days'));
  const [periodDays, setPeriodDays]             = useState(() => loadLocal('periodDays', 30));
  const [periodFrom, setPeriodFrom]             = useState(() => loadLocal('periodFrom', ''));
  const [periodTo, setPeriodTo]                 = useState(() => loadLocal('periodTo', todayStr()));
  const [periodReportWords, setPeriodReportWords] = useState(() => loadLocal('periodReportWords', 150));
  const [lookbackDays, setLookbackDays]         = useState(() => loadLocal('lookbackDays', 1));

  const [customInput, setCustomInput] = useState('');
  const [date, setDate]               = useState(todayStr());
  const [periodChecking, setPeriodChecking] = useState(false);
  const [showTopicHelp, setShowTopicHelp] = useState(false);
  const [showDateInfo, setShowDateInfo]   = useState(false);

  // Topic list (custom topics, hidden defaults, context tags) is shared by
  // everyone with access — one person adding "Anutin" means everyone sees it,
  // instead of each user rebuilding their own list from scratch. Which topics
  // are actually checked for this run stays per-user (see localStorage below).
  useEffect(() => {
    db.ref('config/topics').once('value').then(snap => {
      const data = snap.val();
      if (data) {
        setCustomTopics(data.custom || []);
        setRemovedDefaultTopics(new Set(data.removedDefaults || []));
        setContextTopics(new Set(data.context || []));
      }
      setTopicsLoaded(true);
    }).catch(() => setTopicsLoaded(true));
  }, []);

  // Sync topic list to Firebase whenever it changes (only after initial load)
  useEffect(() => {
    if (!topicsLoaded) return;
    db.ref('config/topics').set({ custom: customTopics, removedDefaults: [...removedDefaultTopics], context: [...contextTopics] });
  }, [customTopics, removedDefaultTopics, contextTopics, topicsLoaded, uid]);

  // Save session preferences to localStorage
  useEffect(() => {
    if (topicsKey) {
      localStorage.setItem(topicsKey, JSON.stringify({
        selected: [...selectedTopics], summaryWords, maxArticles, lookbackDays,
        mode, periodType, periodDays, periodFrom, periodTo, periodReportWords, context: [...contextTopics]
      }));
    }
  }, [selectedTopics, summaryWords, maxArticles, lookbackDays, mode, periodType, periodDays, periodFrom, periodTo, periodReportWords, contextTopics, topicsKey]);

  function toggleTopic(t) { setSelectedTopics(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; }); }
  function toggleContextMode(t) { setContextTopics(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; }); }
  function addCustom() { const t = customInput.trim(); if (!t || customTopics.includes(t)) return; setCustomTopics(p => [...p, t]); setSelectedTopics(p => new Set([...p, t])); setCustomInput(''); }
  async function removeTopic(t) {
    // Topics are shared globally now — someone else's scheduled report may
    // still depend on this exact topic name, so check before deleting out
    // from under it rather than after.
    try {
      const resp = await fns.httpsCallable('checkTopicInUse')({ topic: t });
      if (resp.data?.inUse) {
        const list = resp.data.usedBy.map(u => `${u.country} (${u.createdByEmail})`).join(', ');
        alert(`Can't remove "${t}" — it's still used by: ${list}. Remove it from ${resp.data.usedBy.length > 1 ? 'those schedules' : 'that schedule'} first.`);
        return;
      }
    } catch (e) {
      alert('Could not check if this topic is in use: ' + e.message);
      return;
    }
    confirm({
      message: `Remove topic "${t}"?`,
      onConfirm: () => {
        if (customTopics.includes(t)) {
          setCustomTopics(p => p.filter(x => x !== t));
        } else {
          setRemovedDefaultTopics(prev => new Set([...prev, t]));
        }
        setSelectedTopics(prev => { const n = new Set(prev); n.delete(t); return n; });
        setContextTopics(prev => { const n = new Set(prev); n.delete(t); return n; });
      }
    });
  }

  function computePeriodDates() {
    if (periodType === 'days') {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - periodDays);
      return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
    }
    return { startDate: periodFrom, endDate: periodTo };
  }

  const allTopics = [...DEFAULT_TOPICS.filter(t => !removedDefaultTopics.has(t)), ...customTopics];
  const isPeriod = mode === 'period';

  // Drops any selected topic that no longer exists in the current global
  // list (e.g. a topic that got renamed/recapitalized, like "iran" ->
  // "Iran" during an earlier cleanup) — otherwise a stale entry from
  // localStorage rides along on every future submission forever, invisible
  // since no chip renders for it once it no longer matches allTopics.
  useEffect(() => {
    if (!topicsLoaded) return;
    const validSet = new Set(allTopics);
    setSelectedTopics(prev => {
      const cleaned = new Set([...prev].filter(t => validSet.has(t)));
      return cleaned.size === prev.size ? prev : cleaned;
    });
  }, [topicsLoaded, customTopics, removedDefaultTopics]);

  function WordsStepper({ label, sublabel, value, onChange, min = 30, max = 500, step = 25, unit = 'words' }) {
    const [showInfo, setShowInfo] = useState(false);
    return (
      <div style={{ padding: '10px 14px', background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: showInfo ? 4 : 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{label}</span>
          {sublabel && (
            <button onClick={() => setShowInfo(s => !s)} title="What does this do?"
              style={{ background: 'none', border: 'none', color: showInfo ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>ℹ️</button>
          )}
        </div>
        {showInfo && sublabel && (
          <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.5 }}>{sublabel}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => onChange(Math.max(min, value - step))}
            style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>−</button>
          <input type="number" min={min} max={max} value={value} inputMode="numeric" pattern="[0-9]*"
            onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || value)))}
            style={{ width: 80, textAlign: 'center', fontSize: 22, fontWeight: 700, padding: '10px 6px', background: C.bg, border: '1px solid ' + C.borderLight, borderRadius: 10, color: C.text, outline: 'none' }} />
          <button onClick={() => onChange(Math.min(max, value + step))}
            style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>+</button>
          <span style={{ fontSize: 13, color: C.muted }}>{unit}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="fade-in" style={{ maxWidth: 560, margin: '40px auto', padding: '0 20px' }}>
      <div className="panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <button onClick={onBack} style={BACK_BTN}>← Back</button>
          <span style={{ color: C.faint, fontSize: 13 }}>{country.name}</span>
        </div>

        {/* Topic grid — alphabetical, with what's already selected pulled into
            its own section up top so it doesn't get lost among everyone's
            accumulated custom topics (the list is shared; selection isn't). */}
        {(() => {
          const renderChip = t => {
            const active = selectedTopics.has(t);
            const isContext = contextTopics.has(t);
            return (
              <button key={t} onClick={() => toggleTopic(t)} style={{ padding: '6px 13px', borderRadius: 20, fontSize: 13, cursor: 'pointer', background: active ? '#1d4ed8' : C.card, color: active ? 'white' : C.muted, border: '1px solid ' + (active ? '#3b82f6' : C.border), transition: 'all 0.15s', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {t}
                <span onClick={e => { e.stopPropagation(); toggleContextMode(t); }} title={isContext ? 'Context topic — click for Exact keyword match' : 'Exact keyword match — click for Context (theme) matching'}
                  style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, padding: '1px 6px', borderRadius: 8, background: isContext ? '#7c3aed' : 'rgba(255,255,255,0.12)', color: isContext ? 'white' : (active ? 'rgba(255,255,255,0.8)' : C.faint) }}>
                  {isContext ? '🧭 context' : 'exact'}
                </span>
                <span onClick={e => { e.stopPropagation(); removeTopic(t); }}
                  style={{ opacity: 0.6, fontSize: 15, lineHeight: 1, marginLeft: 2 }}>×</span>
              </button>
            );
          };
          const sortedAll = [...allTopics].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          const selectedList = sortedAll.filter(t => selectedTopics.has(t));
          const unselectedList = sortedAll.filter(t => !selectedTopics.has(t));
          return (
            <>
              {selectedList.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: '#60a5fa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                    Selected ({selectedList.length})
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{selectedList.map(renderChip)}</div>
                </div>
              )}
              {selectedList.length > 0 && (
                <div style={{ fontSize: 11, color: C.faint, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  All topics
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>{unselectedList.map(renderChip)}</div>
            </>
          );
        })()}
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 14 }}>Tap a topic's "exact"/"context" tag to switch how it's matched — exact looks for the literal word, context judges by theme (costs a bit more).</div>

        {/* Add custom topic */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <input className="input-field" placeholder="Add a custom topic…" value={customInput}
            onChange={e => setCustomInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addCustom()}
            spellCheck={true}
            style={{ flex: 1, fontSize: 13 }} />
          <button onClick={addCustom} disabled={!customInput.trim()} style={{ ...SMALL_BTN, opacity: !customInput.trim() ? 0.4 : 1 }}>+ Add</button>
        </div>

        {/* Topic naming guide */}
        <div style={{ marginBottom: 20 }}>
          <button onClick={() => setShowTopicHelp(s => !s)}
            style={{ background: 'none', border: 'none', color: showTopicHelp ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>ℹ️</span><span>How to name topics</span>
          </button>
          {showTopicHelp && (
            <div style={{ fontSize: 11, color: C.faint, marginTop: 8, lineHeight: 1.8, padding: '8px 12px', background: C.card, borderRadius: 7, border: '1px solid ' + C.border }}>
              <span style={{ color: '#60a5fa' }}>Economy</span> — single word, finds any article about economy<br/>
              <span style={{ color: '#60a5fa' }}>Red card</span> — phrase, finds articles containing "red card" together<br/>
              <span style={{ color: '#60a5fa' }}>Mundial &amp; red card</span> — both must appear in the article, not necessarily together
              {!isPeriod && <><br/><br/>In Point in Time mode, topics filter which articles the AI reads.</>}
            </div>
          )}
        </div>

        {/* Mode toggle */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderRadius: 9, overflow: 'hidden', border: '1px solid ' + C.border }}>
          {[['pointintime', '📅 Point in Time'], ['period', '📆 Period Analysis']].map(([m, label]) => (
            <button key={m} onClick={() => setMode(m)}
              style={{ flex: 1, padding: '10px 0', fontSize: 13, fontWeight: mode === m ? 700 : 400, cursor: 'pointer', border: 'none', background: mode === m ? '#1d4ed8' : C.card, color: mode === m ? 'white' : C.muted, transition: 'all 0.15s' }}>
              {label}
            </button>
          ))}
        </div>

        {/* Point-in-time mode */}
        {!isPeriod && (
          <>
            <WordsStepper
              label="Summary Length per Topic"
              sublabel="Words the AI writes per topic per source"
              value={summaryWords}
              onChange={setSummaryWords}
            />

            <WordsStepper
              label="Articles per Source"
              sublabel="More articles = better topic coverage, slightly slower"
              value={maxArticles}
              onChange={setMaxArticles}
              min={10}
              max={50}
              step={5}
            />

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, color: C.faint, marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Date</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="date" value={date} max={todayStr()} onChange={e => setDate(e.target.value)} className="input-field" style={{ width: 'auto', fontSize: 14 }} />
                {date === todayStr() && (
                  <>
                    <span style={{ color: C.faint, fontSize: 12 }}>Today</span>
                    <button onClick={() => setShowDateInfo(s => !s)} title="Why might today be incomplete?"
                      style={{ background: 'none', border: 'none', color: showDateInfo ? '#60a5fa' : '#fb923c', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}>⚠ ℹ️</button>
                  </>
                )}
              </div>
              {date === todayStr() && showDateInfo && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#fb923c', lineHeight: 1.4, maxWidth: 420 }}>
                  Today's coverage is often incomplete: each outlet's live feed only shows its most recent items, and Google's news index typically takes about a day to catch up.{lookbackDays > 0 ? ` "Days to look back" below is set to ${lookbackDays}, so this search also includes ${lookbackDays === 1 ? 'yesterday' : `the past ${lookbackDays} days`} to help fill in what today alone would miss.` : ' Set "Days to look back" below to 1 or more to also pick up yesterday\'s coverage.'}
                </div>
              )}
            </div>

            <WordsStepper
              label="Days to Look Back"
              sublabel="Also includes coverage from this many days before the date above — helps when today's news isn't indexed yet"
              value={lookbackDays}
              onChange={setLookbackDays}
              min={0}
              max={7}
              step={1}
              unit={lookbackDays === 1 ? 'day' : 'days'}
            />

            <button onClick={() => onGo({ mode: 'pointintime', topics: [...selectedTopics], contextTopics: [...selectedTopics].filter(t => contextTopics.has(t)), date, summaryWords, maxArticles, lookbackDays })}
              disabled={selectedTopics.size === 0}
              style={{ ...BTN('#2563eb'), width: '100%', padding: '12px', fontSize: 15, opacity: selectedTopics.size === 0 ? 0.4 : 1 }}>
              → Select Sources
            </button>
          </>
        )}

        {/* Period mode */}
        {isPeriod && (
          <>
            {/* Period type selector */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: C.faint, marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Period Type</div>
              <div style={{ display: 'flex', gap: 8 }}>
                {[['days', 'Last X days'], ['range', 'Date range']].map(([pt, label]) => (
                  <button key={pt} onClick={() => setPeriodType(pt)}
                    style={{ flex: 1, padding: '9px 0', fontSize: 13, fontWeight: periodType === pt ? 700 : 400, borderRadius: 8, cursor: 'pointer', border: '1px solid ' + (periodType === pt ? '#3b82f6' : C.border), background: periodType === pt ? '#1d4ed8' : C.card, color: periodType === pt ? 'white' : C.muted, transition: 'all 0.15s' }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Last X days stepper */}
            {periodType === 'days' && (
              <div style={{ padding: '10px 14px', background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 2 }}>Days Back from Today</div>
                <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>
                  Covers {new Date(Date.now() - periodDays * 86400000).toISOString().slice(0, 10)} → today
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <button onClick={() => setPeriodDays(d => Math.max(1, d - 1))}
                    style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>−</button>
                  <input type="number" min="1" max="365" value={periodDays} inputMode="numeric" pattern="[0-9]*"
                    onChange={e => setPeriodDays(Math.max(1, Math.min(365, parseInt(e.target.value) || 30)))}
                    style={{ width: 80, textAlign: 'center', fontSize: 22, fontWeight: 700, padding: '10px 6px', background: C.bg, border: '1px solid ' + C.borderLight, borderRadius: 10, color: C.text, outline: 'none' }} />
                  <button onClick={() => setPeriodDays(d => Math.min(365, d + 1))}
                    style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>+</button>
                  <span style={{ fontSize: 13, color: C.muted }}>days</span>
                </div>
              </div>
            )}

            {/* Date range pickers */}
            {periodType === 'range' && (
              <div style={{ padding: '10px 14px', background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 12 }}>Date Range</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>FROM</label>
                    <input type="date" value={periodFrom} max={periodTo || todayStr()}
                      onChange={e => setPeriodFrom(e.target.value)} className="input-field" style={{ width: 'auto', fontSize: 14 }} />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>TO</label>
                    <input type="date" value={periodTo} min={periodFrom} max={todayStr()}
                      onChange={e => setPeriodTo(e.target.value)} className="input-field" style={{ width: 'auto', fontSize: 14 }} />
                  </div>
                </div>
              </div>
            )}

            <WordsStepper
              label="Report Length per Topic"
              sublabel="Words the AI writes per topic per political camp"
              value={periodReportWords}
              onChange={setPeriodReportWords}
              min={50}
              max={500}
              step={25}
            />

            {(() => {
              const { startDate, endDate } = computePeriodDates();
              const disabled = selectedTopics.size === 0 || !startDate || !endDate || startDate > endDate || periodChecking;
              return (
                <button
                  onClick={async () => {
                    setPeriodChecking(true);
                    try {
                      // onGo resolves once the pre-flight grounding check is
                      // done and the confirm dialog is up (or, on failure,
                      // once the analysis itself has been kicked off) — this
                      // spinner only covers that initial network round-trip,
                      // which previously had no feedback at all.
                      await onGo({ mode: 'period', topics: [...selectedTopics], periodReportWords, ...computePeriodDates() });
                    } finally {
                      setPeriodChecking(false);
                    }
                  }}
                  disabled={disabled}
                  style={{ ...BTN('#7c3aed'), width: '100%', padding: '12px', fontSize: 15, opacity: disabled ? 0.4 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
                  {periodChecking ? <><Spinner size={14} /> Checking…</> : '📆 Analyze Period'}
                </button>
              );
            })()}
          </>
        )}
      </div>
      {confirmDialog}
    </div>
  );
}

// ─── Topic Card ───────────────────────────────────────────────────────────────
// Two topics that matched the exact same article(s) for a source would
// otherwise render as separate, near-identical cards (same quotes, same
// narrative) — merge them into one card under a combined heading. Topics
// with no match, or a different/partial match set, stay separate since
// they're not actually redundant. Falls back to no merging when
// matchedIndices is missing (older reports predating this field).
function groupTopicAnalyses(topicAnalyses) {
  const groups = [];
  const groupIndexBySignature = new Map();
  (topicAnalyses || []).forEach(ta => {
    const signature = ta.covered && Array.isArray(ta.matchedIndices) && ta.matchedIndices.length > 0
      ? ta.matchedIndices.join(',')
      : null;
    if (signature && groupIndexBySignature.has(signature)) {
      groups[groupIndexBySignature.get(signature)].topics.push(ta.topic);
      return;
    }
    groups.push({ topics: [ta.topic], analysis: ta });
    if (signature) groupIndexBySignature.set(signature, groups.length - 1);
  });
  return groups.map(g => ({ ...g.analysis, topic: g.topics.join(' + ') }));
}

function TopicCard({ analysis }) {
  const { topic, covered, summary, tone, narrative, quotes, comparedToArab } = analysis;
  const [open, setOpen] = useState(true);
  const toneClass = getToneClass(tone);
  const toneLabel = getToneLabel(tone);

  return (
    <div style={{ marginBottom: 10, background: '#0f1e35', borderRadius: 8, overflow: 'hidden', border: '1px solid ' + C.border }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'none', border: 'none', color: C.text, cursor: 'pointer', textAlign: 'left' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{topic}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {covered !== false && tone && (
            <span className={toneClass} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{toneLabel}</span>
          )}
          {covered === false && <span style={{ color: C.faint, fontSize: 12 }}>Not covered</span>}
          <span style={{ color: C.faint, fontSize: 11 }}>{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && covered !== false && (
        <div style={{ padding: '0 14px 14px', borderTop: '1px solid ' + C.border }}>
          {summary && <p style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, marginTop: 10, marginBottom: 0 }}>{summary}</p>}
          {narrative && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: '#0d1b2a', borderRadius: 6, fontSize: 12, color: C.muted, borderLeft: '3px solid ' + C.borderLight }}>
              {narrative}
            </div>
          )}
          {quotes?.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {quotes.map((q, i) => (
                <div key={i} style={{ fontSize: 12, color: C.faint, fontStyle: 'italic', padding: '5px 0', borderBottom: i < quotes.length - 1 ? '1px solid ' + C.border : 'none' }}>
                  "{q}"
                </div>
              ))}
            </div>
          )}
          {comparedToArab && (
            <div style={{ marginTop: 10, padding: '8px 12px', background: '#071825', borderRadius: 6, fontSize: 12, color: '#67e8f9', borderLeft: '3px solid #06b6d4' }}>
              <span style={{ fontWeight: 600 }}>vs. Arab coverage: </span>{comparedToArab}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Period helpers ───────────────────────────────────────────────────────────
function extractPeriodTexts(result) {
  const texts = [], paths = [];
  (result.leanGroups || []).forEach((g, gi) => {
    if (g.overallNarrative) { texts.push(g.overallNarrative); paths.push(['leanGroups', gi, 'overallNarrative']); }
    (g.topics || []).forEach((t, ti) => {
      if (t.summary) { texts.push(t.summary); paths.push(['leanGroups', gi, 'topics', ti, 'summary']); }
      (t.keyNarratives || []).forEach((n, ni) => { texts.push(n); paths.push(['leanGroups', gi, 'topics', ti, 'keyNarratives', ni]); });
    });
  });
  ['consensus', 'faultLines', 'blindSpots', 'evolution'].forEach(key => {
    if (result.synthesis?.[key]) { texts.push(result.synthesis[key]); paths.push(['synthesis', key]); }
  });
  return { texts, paths };
}
function applyPeriodTranslations(result, paths, translations) {
  const copy = JSON.parse(JSON.stringify(result));
  paths.forEach((path, i) => {
    let obj = copy;
    for (let j = 0; j < path.length - 1; j++) obj = obj[path[j]];
    obj[path[path.length - 1]] = translations[i] ?? obj[path[path.length - 1]];
  });
  return copy;
}
function buildPeriodShareText(country, startDate, endDate, result, followUps) {
  let text = `📰 Roy News — ${country.name} Period Analysis\n${formatDisplayDate(startDate)} → ${formatDisplayDate(endDate)}\n`;
  const s = result.synthesis;
  if (s) {
    text += '\n─── Synthesis ───\n';
    if (s.consensus)  text += `Consensus: ${s.consensus}\n`;
    if (s.faultLines) text += `Fault Lines: ${s.faultLines}\n`;
    if (s.blindSpots) text += `Blind Spots: ${s.blindSpots}\n`;
    if (s.evolution)  text += `Evolution: ${s.evolution}\n`;
  }
  (result.leanGroups || []).forEach(g => {
    text += `\n── ${g.label || g.lean} ──\n`;
    if (g.overallNarrative) text += `${g.overallNarrative}\n`;
    (g.topics || []).forEach(t => {
      text += `\n${t.topic}${t.tone ? ` [${t.tone}]` : ''}\n${(t.summary || '').slice(0, 220)}\n`;
    });
  });
  if (followUps?.length > 0) {
    text += '\n─── Follow-up Q&A ───\n';
    followUps.forEach(f => { text += `\nQ: ${f.question}\nA: ${f.answer}\n`; });
  }
  // No app link here — nothing about this analysis is stored anywhere the
  // link could resolve to, so it would just open an unrelated homepage. Many
  // share targets (WhatsApp, etc.) also render a trailing URL as a link-preview
  // card, visually burying the actual result text underneath it.
  text += `\n─────────────────\nGenerated by Roy News`;
  return text;
}

// ─── Period Result View ───────────────────────────────────────────────────────
function PeriodResultView({ country, result, startDate, endDate, topics, persona, user, usage, onNewSearch, onError }) {
  const [isHebrew, setIsHebrew]           = useState(false);
  const [hebrewResult, setHebrewResult]   = useState(null);
  const [translating, setTranslating]     = useState(false);
  const [translateProgress, setTranslateProgress] = useState(0);
  const [showTranslateInfo, setShowTranslateInfo] = useState(false);
  const [shareCopied, setShareCopied]     = useState(false);
  const [resultCopied, setResultCopied]   = useState(false);

  // Follow-up conversation — the one-shot analysis above is fixed, but the
  // user can ask about it instead of having to re-prompt from scratch.
  const [followUps, setFollowUps]       = useState([]); // [{ question, answer, costUsd }]
  const [followUpsHe, setFollowUpsHe]   = useState([]); // parallel Hebrew translations, filled in as needed
  const [followUpInput, setFollowUpInput] = useState('');
  const [asking, setAsking]             = useState(false);

  async function handleAskFollowUp() {
    const question = followUpInput.trim();
    if (!question || asking || !result) return;
    setAsking(true);
    try {
      const aiSettings = await getAISettings(user?.uid);
      const resp = await fns.httpsCallable('askPeriodFollowUp', { timeout: 65000 })({
        country: country.name, topics, startDate, endDate, persona,
        originalResult: result,
        history: followUps.map(f => ({ question: f.question, answer: f.answer })),
        question, ...aiSettings
      });
      setFollowUps(prev => [...prev, { question, answer: resp.data.answer, costUsd: resp.data.usage?.costUsd || 0 }]);
      setFollowUpInput('');
      // Asked while already viewing the Hebrew translation — keep it caught up
      // instead of leaving this one entry stuck in English until the user
      // happens to re-toggle Translate.
      if (isHebrew) {
        try {
          const [questionHe, answerHe] = await Promise.all([translateViaGoogle(question), translateViaGoogle(resp.data.answer)]);
          setFollowUpsHe(prev => [...prev, { question: questionHe, answer: answerHe }]);
        } catch {}
      }
    } catch (e) {
      onError?.('Follow-up question', e.message);
    }
    setAsking(false);
  }

  const displayResult = isHebrew && hebrewResult ? hebrewResult : result;
  const displayFollowUps = followUps.map((f, i) => (isHebrew && followUpsHe[i]) ? followUpsHe[i] : f);
  const { leanGroups = [], synthesis } = displayResult || {};

  const leanColors = { government: '#ef4444', 'pro-government': '#f97316', opposition: '#3b82f6', independent: '#64748b' };
  const leanBg    = { government: '#1a0a0a', 'pro-government': '#1a0f08', opposition: '#080f1a', independent: '#0f1217' };

  function LeanGroupCard({ group }) {
    const [open, setOpen] = useState(true);
    const color = leanColors[group.lean] || '#64748b';
    const bg    = leanBg[group.lean]    || '#0f1217';
    const registeredSources = country.setup?.sources || [];
    return (
      <div style={{ marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid ' + C.border }}>
        {/* A div, not a button — the per-outlet info toggle below is itself a
            button, and buttons can't nest inside buttons. */}
        <div onClick={() => setOpen(o => !o)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: bg, cursor: 'pointer', textAlign: 'left', borderBottom: open ? '1px solid ' + C.border : 'none' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: color }}>{group.label || group.lean}</div>
            {group.outlets?.length > 0 && (
              <div style={{ fontSize: 11, color: C.faint, marginTop: 2, display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                {group.outlets.map((name, oi) => {
                  const matched = registeredSources.find(s => s.name.toLowerCase() === name.toLowerCase());
                  return (
                    <span key={oi} style={{ display: 'inline-flex', alignItems: 'center' }}>
                      {oi > 0 && <span style={{ margin: '0 4px' }}>·</span>}
                      <span>{name}</span>
                      {matched && <SourceInfoToggle source={matched} />}
                    </span>
                  );
                })}
              </div>
            )}
          </div>
          <span style={{ color: C.faint, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
        </div>
        {open && (
          <div style={{ padding: '12px 16px', background: C.panel }}>
            {group.overallNarrative && (
              <div style={{ marginBottom: 14, padding: '8px 12px', background: bg, borderRadius: 7, fontSize: 13, color: C.muted, borderLeft: '3px solid ' + color, lineHeight: 1.6 }}>
                {group.overallNarrative}
              </div>
            )}
            {(group.topics || []).map((t, i) => {
              const toneClass = getToneClass(t.tone);
              const toneLabel = getToneLabel(t.tone);
              return (
                <div key={i} style={{ marginBottom: 10, background: '#0a1525', borderRadius: 8, overflow: 'hidden', border: '1px solid ' + C.border }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px' }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{t.topic}</span>
                    {t.tone && <span className={toneClass} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, fontWeight: 600 }}>{toneLabel}</span>}
                  </div>
                  <div style={{ padding: '0 12px 12px', borderTop: '1px solid ' + C.border }}>
                    {t.summary && <p style={{ color: '#cbd5e1', fontSize: 13, lineHeight: 1.7, marginTop: 10, marginBottom: 0 }}>{t.summary}</p>}
                    {t.keyNarratives?.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        {t.keyNarratives.map((n, ni) => (
                          <div key={ni} style={{ fontSize: 12, color: C.faint, padding: '4px 0', borderBottom: ni < t.keyNarratives.length - 1 ? '1px solid ' + C.border : 'none' }}>
                            › {n}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  async function handleTranslate() {
    if (isHebrew) { setIsHebrew(false); return; }
    // Re-check every time, not just once — new follow-up questions can be
    // asked after the first translation, and they need covering too.
    const needsResultTranslation = !hebrewResult;
    const untranslatedFollowUps = followUps.slice(followUpsHe.length);
    if (!needsResultTranslation && untranslatedFollowUps.length === 0) { setIsHebrew(true); return; }
    setTranslating(true);
    setTranslateProgress(0);
    try {
      if (needsResultTranslation) {
        const { texts, paths } = extractPeriodTexts(result);
        const CONCURRENCY = 6;
        const allTranslations = new Array(texts.length);
        for (let i = 0; i < texts.length; i += CONCURRENCY) {
          const batch = texts.slice(i, i + CONCURRENCY);
          const translated = await Promise.all(batch.map(t => translateViaGoogle(t)));
          translated.forEach((t, j) => { allTranslations[i + j] = t; });
          setTranslateProgress(Math.round(((i + batch.length) / texts.length) * 100 * (untranslatedFollowUps.length > 0 ? 0.7 : 1)));
        }
        setHebrewResult(applyPeriodTranslations(result, paths, allTranslations));
      }
      if (untranslatedFollowUps.length > 0) {
        const translated = await Promise.all(untranslatedFollowUps.map(async f => ({
          question: await translateViaGoogle(f.question),
          answer: await translateViaGoogle(f.answer)
        })));
        setFollowUpsHe(prev => [...prev, ...translated]);
        setTranslateProgress(100);
      }
      setIsHebrew(true);
    } catch (e) {
      onError?.('Translate to Hebrew', e.message);
    }
    setTranslating(false);
    setTranslateProgress(0);
  }

  async function handleCopyResult() {
    const text = buildPeriodShareText(country, startDate, endDate, displayResult, displayFollowUps);
    await navigator.clipboard?.writeText(text);
    setResultCopied(true);
    setTimeout(() => setResultCopied(false), 2500);
  }

  async function handleShareResult() {
    const text = buildPeriodShareText(country, startDate, endDate, displayResult, displayFollowUps);
    const title = `Roy News — ${country.name} · ${formatDisplayDate(startDate)} – ${formatDisplayDate(endDate)}`;
    if (navigator.share) {
      navigator.share({ title, text }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(text);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
    }
  }

  return (
    <div className="fade-in print-root" style={{ maxWidth: 760, margin: '0 auto', padding: '20px 16px' }}>

      {/* Print-only header */}
      <div className="print-header" style={{ display: 'none' }}>
        <div style={{ fontSize: 22, fontWeight: 800 }}>📰 Roy News — {country.name} Period Analysis</div>
        <div style={{ fontSize: 14, color: '#475569', marginTop: 4 }}>{formatDisplayDate(startDate)} → {formatDisplayDate(endDate)}</div>
      </div>

      {/* Action bar */}
      <div className="no-print" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <button onClick={onNewSearch} style={BACK_BTN}>← Back</button>
          <div>
            <h2 style={{ fontSize: 18, fontWeight: 800, margin: 0, color: C.text }}>{country.name} — Period Analysis</h2>
            <div style={{ fontSize: 13, color: C.faint, marginTop: 2 }}>{formatDisplayDate(startDate)} → {formatDisplayDate(endDate)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleTranslate} disabled={translating}
            style={{ ...SMALL_BTN, background: isHebrew ? '#1e3a5f' : C.card, borderColor: isHebrew ? '#3b82f6' : C.border, fontWeight: isHebrew ? 700 : 400, minWidth: 130 }}>
            {translating
              ? <><Spinner size={12} /> &nbsp;{translateProgress > 0 ? `${translateProgress}%` : 'Starting…'}</>
              : isHebrew ? '🇮🇱 עברית ON' : '🇮🇱 Translate to עב'}
          </button>
          <button onClick={() => setShowTranslateInfo(o => !o)}
            style={{ background: 'none', border: 'none', color: showTranslateInfo ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1 }}
            title="About translation">ℹ️</button>
          <button onClick={handleCopyResult} style={SMALL_BTN}>
            {resultCopied ? '✓ Copied!' : '📋 Copy'}
          </button>
          <button onClick={handleShareResult} style={SMALL_BTN}>
            {shareCopied ? '✓ Shared!' : '🔗 Share Result'}
          </button>
          <button onClick={() => window.print()} style={SMALL_BTN} title="Opens print dialog — select 'Save as PDF'">🖨️ Print/PDF</button>
        </div>
      </div>

      {showTranslateInfo && (
        <div className="no-print" style={{ padding: '10px 14px', background: '#0a1525', border: '1px solid #1e3a5f', borderRadius: 8, marginBottom: 10, fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
          Analysis is always generated in <strong style={{ color: C.text }}>English</strong> for best accuracy and lowest cost.<br/>
          Translation uses <strong style={{ color: C.text }}>Google Translate</strong> (free) and is cached — toggling is instant after the first time.<br/>
          <strong style={{ color: C.text }}>Share Result</strong> — on mobile opens your device's share sheet (WhatsApp, Gmail, etc.); on desktop copies the report to clipboard.
        </div>
      )}

      {/* Cost */}
      {usage && (
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', background: '#0a1a0a', border: '1px solid #14532d', borderRadius: 8, marginBottom: 12, fontSize: 12, flexWrap: 'wrap' }}>
          <span style={{ color: '#4ade80' }}>⚡</span>
          {usage.costUsd > 0 && (
            <span style={{ color: '#86efac' }}>AI cost <strong>${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(3)}</strong></span>
          )}
          {(usage.rssCount > 0 || usage.googleNewsCount > 0) && (
            <>
              {usage.costUsd > 0 && <span style={{ color: '#14532d' }}>·</span>}
              {usage.rssCount > 0 && <span style={{ color: C.faint, fontSize: 11 }}>RSS: <strong style={{ color: '#86efac' }}>{usage.rssCount}</strong></span>}
              {usage.rssCount > 0 && usage.googleNewsCount > 0 && <span style={{ color: '#14532d' }}>·</span>}
              {usage.googleNewsCount > 0 && <span style={{ color: C.faint, fontSize: 11 }}>Google News: <strong style={{ color: '#60a5fa' }}>{usage.googleNewsCount}</strong></span>}
            </>
          )}
          {usage.model && <><span style={{ color: '#14532d' }}>·</span><span style={{ color: C.faint, fontSize: 11 }}>{usage.model}</span></>}
        </div>
      )}

      {isHebrew && (
        <div className="no-print" style={{ padding: '8px 14px', background: '#0a1e35', border: '1px solid #1e3a5f', borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#60a5fa' }}>
          🇮🇱 Showing Hebrew translation — toggle off to return to English
        </div>
      )}

      {/* Synthesis — leads the report; the per-lean breakdown below is the
          supporting detail. */}
      {synthesis && (
        <div style={{ marginBottom: 20, padding: 18, background: '#0a1220', borderRadius: 10, border: '1px solid #1e3a5f' }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#60a5fa', marginBottom: 14 }}>Synthesis</div>
          {[
            ['Consensus', synthesis.consensus],
            ['Fault Lines', synthesis.faultLines],
            ['Blind Spots', synthesis.blindSpots],
            ['Evolution', synthesis.evolution],
          ].filter(([, v]) => v).map(([label, val]) => (
            <div key={label} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7 }}>{val}</div>
            </div>
          ))}
        </div>
      )}

      {/* Lean groups */}
      {leanGroups.length === 0
        ? <div style={{ color: C.muted, padding: 24, textAlign: 'center' }}>No data returned — try again.</div>
        : leanGroups.map((g, i) => <LeanGroupCard key={i} group={g} />)
      }

      {/* Follow-up conversation — the analysis above is fixed, but you can
          ask about it instead of writing a whole new prompt from scratch. */}
      {result && (
        <div className="no-print" style={{ marginTop: 20, padding: 18, background: C.card, borderRadius: 10, border: '1px solid ' + C.border }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>💬 Ask about this analysis</div>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 14 }}>Elaborate, clarify, or push back on anything above — each answer is grounded in the analysis, not a fresh lookup.</div>

          {displayFollowUps.map((f, i) => (
            <div key={i} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#60a5fa', marginBottom: 4 }}>{f.question}</div>
              <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{f.answer}</div>
            </div>
          ))}

          <div style={{ display: 'flex', gap: 8 }}>
            <input className="input-field" value={followUpInput} onChange={e => setFollowUpInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAskFollowUp(); } }}
              placeholder="e.g. Elaborate on the blind spot you mentioned…" disabled={asking}
              style={{ flex: 1, fontSize: 13 }} />
            <button onClick={handleAskFollowUp} disabled={!followUpInput.trim() || asking}
              style={{ ...BTN('#2563eb'), padding: '9px 16px', fontSize: 13, opacity: (!followUpInput.trim() || asking) ? 0.5 : 1 }}>
              {asking ? <Spinner size={14} /> : 'Ask'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Source Column ────────────────────────────────────────────────────────────
function SourceColumn({ sourceResult, requestedDate }) {
  if (!sourceResult || !sourceResult.source) return null;
  const { source, analysis, rssError, articles, error } = sourceResult;
  const topicAnalyses = analysis?.topicAnalyses || [];
  const [showArticles, setShowArticles] = useState(false);
  const isKnowledge = analysis?.basedOnTrainingKnowledge;

  // Freshness: compare article dates to the requested analysis date
  const articleDates = (articles || [])
    .filter(a => a.date)
    .map(a => new Date(a.date))
    .filter(d => !isNaN(d))
    .sort((a, b) => b - a);
  const latestArticle = articleDates[0] || null;
  const latestDateStr = latestArticle
    ? latestArticle.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;
  const hasLiveArticles = articleDates.length > 0;
  const latestIsoDate = latestArticle ? latestArticle.toISOString().slice(0, 10) : null;
  const isFromRequestedDate = requestedDate && latestIsoDate
    ? Math.abs(new Date(latestIsoDate) - new Date(requestedDate)) <= 2 * 24 * 60 * 60 * 1000
    : false;

  // For Israeli media: count articles per sub-source
  const israelSubSources = source.id === '_israel' ? (() => {
    const counts = { Ynet: 0, Haaretz: 0, 'Jerusalem Post': 0 };
    (articles || []).forEach(a => { if (counts[a.sourceName] !== undefined) counts[a.sourceName]++; });
    return counts;
  })() : null;

  return (
    <div className={`panel ${getLeanCss(source.lean)}`} style={{ padding: 18, flex: '1 1 260px', minWidth: 240 }}>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontWeight: 800, fontSize: 15, color: C.text }}>{source.name}</span>
          {source.nameOriginal && source.nameOriginal !== source.name && <span style={{ color: C.faint, fontSize: 12 }}>{source.nameOriginal}</span>}
          <SourceInfoToggle source={source} />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <LeanBadge lean={source.lean} />
          {source.type && <TypeBadge type={source.type} />}
          {source.languages?.length > 0 && (
            <span style={{ background: '#1a2d42', color: '#60a5fa', border: '1px solid #2a4060', borderRadius: 4, padding: '1px 7px', fontSize: 11 }}>
              🌐 {source.languages.join(' / ')}
            </span>
          )}
        </div>
        {israelSubSources && (
          <div style={{ marginTop: 8, padding: '8px 10px', background: '#071825', borderRadius: 7, border: '1px solid #0e2a40' }}>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Sources</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {Object.entries(israelSubSources).map(([name, count]) => (
                <span key={name} style={{ fontSize: 11, padding: '2px 8px', borderRadius: 10, background: count > 0 ? '#0a2018' : '#1a2d42', color: count > 0 ? '#4ade80' : C.faint, border: '1px solid ' + (count > 0 ? '#14532d' : C.border) }}>
                  {count > 0 ? `● ${name} (${count})` : `○ ${name}`}
                </span>
              ))}
            </div>
            {Object.values(israelSubSources).every(c => c === 0) && (
              <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>ℹ No live RSS — using AI training knowledge</div>
            )}
          </div>
        )}
        {analysis?.overallTone && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
            Overall: <span className={getToneClass(analysis.overallTone)} style={{ padding: '1px 7px', borderRadius: 10, fontWeight: 600 }}>{getToneLabel(analysis.overallTone)}</span>
          </div>
        )}
        {analysis?.overallAngle && !analysis?.overallTone && (
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8, fontStyle: 'italic' }}>{analysis.overallAngle}</div>
        )}
        {/* Freshness indicator */}
        {error && !analysis
          ? <div style={{ marginTop: 6, fontSize: 11, color: '#f87171' }}>⚠ Analysis failed: {error}</div>
          : rssError
            ? <div style={{ marginTop: 6, fontSize: 11, color: '#fb923c' }}>⚠ Could not load live articles — source skipped</div>
            : isKnowledge
              ? <div style={{ marginTop: 6, fontSize: 11, color: C.faint }}>ℹ No live articles fetched — summary based on AI training knowledge</div>
              : hasLiveArticles
                ? <div style={{ marginTop: 6, fontSize: 11, color: isFromRequestedDate ? '#4ade80' : '#fb923c', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span>{isFromRequestedDate ? '✓' : '⚠'}</span>
                    <span>
                      {articles.length} live article{articles.length !== 1 ? 's' : ''}
                      {latestDateStr && ` · Latest: ${latestDateStr}`}
                      {!isFromRequestedDate && ' — not from requested date'}
                    </span>
                  </div>
                : null
        }
      </div>

      {analysis?.keyStories?.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: C.faint, marginBottom: 6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Key Stories</div>
          {analysis.keyStories.map((s, i) => (
            <div key={i} style={{ fontSize: 12, color: '#cbd5e1', padding: '4px 0', borderBottom: '1px solid ' + C.border, lineHeight: 1.4 }}>{s}</div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 11, color: C.faint, marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Topic Analysis</div>
      {topicAnalyses.length === 0
        ? <div style={{ color: C.faint, fontSize: 13 }}>No results</div>
        : groupTopicAnalyses(topicAnalyses).map((ta, i) => <TopicCard key={i} analysis={ta} />)
      }

      {/* RSS feed info — always shown */}
      {(() => {
        const hasArticles = articles?.length > 0;
        const rssUrl = source.rssUrl;
        const friendlyRssError = rssError
          ? 'This source could not be reached. Go to Select Sources and use ⚙ Fix on this source.'
          : null;
        const relevantIndices = analysis?.relevantArticleIndices;
        const aiSpecifiedIndices = Array.isArray(relevantIndices);
        const displayArticles = aiSpecifiedIndices
          ? articles.filter((_, i) => relevantIndices.includes(i + 1))
          : articles;
        const isFiltered = aiSpecifiedIndices && displayArticles.length < articles.length;
        const toggleLabel = hasArticles
          ? aiSpecifiedIndices && displayArticles.length === 0
            ? `${articles.length} articles fetched — none relevant to selected topics`
            : isFiltered
              ? `${displayArticles.length} of ${articles.length} articles relevant to topics`
              : `${articles.length} article${articles.length !== 1 ? 's' : ''} fetched from RSS`
          : rssError ? 'Could not load articles for this date' : 'No news source configured';
        return (
          <div style={{ marginTop: 18, borderTop: '1px solid ' + C.border, paddingTop: 12 }}>
            <button onClick={() => setShowArticles(s => !s)}
              style={{ background: 'none', border: 'none', color: hasArticles ? C.faint : (rssError ? '#f97316' : C.faint), cursor: 'pointer', fontSize: 12, padding: 0, display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left' }}>
              <span>{showArticles ? '▾' : '▸'}</span>
              <span>{toggleLabel}</span>
            </button>
            {showArticles && (
              <div style={{ marginTop: 10 }}>
                {rssUrl && (
                  <div style={{ marginBottom: 8, padding: '6px 10px', background: C.bg, borderRadius: 6, border: '1px solid ' + C.border }}>
                    <div style={{ fontSize: 10, color: C.faint, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>RSS URL</div>
                    <a href={rssUrl} target="_blank" rel="noopener noreferrer"
                      style={{ color: '#60a5fa', fontSize: 11, wordBreak: 'break-all', textDecoration: 'none' }}>{rssUrl}</a>
                  </div>
                )}
                {friendlyRssError && (
                  <div style={{ marginBottom: 8, padding: '6px 10px', background: '#1c0e00', borderRadius: 6, border: '1px solid #7c2d12' }}>
                    <div style={{ fontSize: 11, color: '#fb923c' }}>⚠ {friendlyRssError}</div>
                  </div>
                )}
                {!rssUrl && !rssError && (
                  <div style={{ color: C.faint, fontSize: 12, fontStyle: 'italic', marginBottom: 8 }}>No news link available for this source. Go to Select Sources and use ⚙ Fix on this source.</div>
                )}
                {hasArticles && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {displayArticles.map((a, i) => (
                      <div key={i} style={{ padding: '7px 10px', background: C.bg, borderRadius: 6, border: '1px solid ' + C.border }}>
                        {a.link
                          ? <a href={a.link} target="_blank" rel="noopener noreferrer"
                              style={{ color: '#60a5fa', fontSize: 12, fontWeight: 600, lineHeight: 1.4, textDecoration: 'none', display: 'block' }}>{a.title}</a>
                          : <div style={{ color: C.text, fontSize: 12, fontWeight: 600, lineHeight: 1.4 }}>{a.title}</div>
                        }
                        {a.date && <div style={{ color: C.faint, fontSize: 11, marginTop: 3 }}>{new Date(a.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ─── Google Translate (client-side, free) ────────────────────────────────────
async function translateViaGoogle(text) {
  if (!text || !text.trim()) return text;
  try {
    // sl=auto (not a fixed 'en') — verbatim quotes can be in the source
    // outlet's own language (Thai, Khmer, ...), not just English, and forcing
    // sl=en makes Google assume those words are already English instead of
    // translating them.
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=he&dt=t&q=${encodeURIComponent(text)}`;
    const resp = await fetch(url);
    if (!resp.ok) return text;
    const data = await resp.json();
    if (!Array.isArray(data?.[0])) return text;
    return data[0].map(s => s?.[0] || '').join('');
  } catch {
    return text;
  }
}

async function translateTexts(texts) {
  const CONCURRENCY = 6;
  const results = new Array(texts.length);
  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const batch = texts.slice(i, i + CONCURRENCY);
    const translated = await Promise.all(batch.map(t => translateViaGoogle(t)));
    translated.forEach((t, j) => { results[i + j] = t; });
  }
  return results;
}

// ─── Extract / apply translations helpers ────────────────────────────────────
function extractTexts(results) {
  const texts = [], paths = [];
  Object.entries(results).forEach(([sid, sr]) => {
    if (!sr?.analysis) return;
    const { topicAnalyses = [], keyStories = [], overallAngle } = sr.analysis;
    topicAnalyses.forEach((ta, i) => {
      [['summary'], ['narrative'], ['comparedToArab']].forEach(([field]) => {
        if (ta[field]) { texts.push(ta[field]); paths.push([sid, 'analysis', 'topicAnalyses', i, field]); }
      });
      (ta.quotes || []).forEach((q, j) => { texts.push(q); paths.push([sid, 'analysis', 'topicAnalyses', i, 'quotes', j]); });
    });
    (keyStories || []).forEach((s, i) => { texts.push(s); paths.push([sid, 'analysis', 'keyStories', i]); });
    if (overallAngle) { texts.push(overallAngle); paths.push([sid, 'analysis', 'overallAngle']); }
  });
  return { texts, paths };
}
function applyTranslations(results, paths, translations) {
  const copy = JSON.parse(JSON.stringify(results));
  paths.forEach((path, i) => {
    let obj = copy;
    for (let j = 0; j < path.length - 1; j++) obj = obj[path[j]];
    obj[path[path.length - 1]] = translations[i] ?? obj[path[path.length - 1]];
  });
  return copy;
}

// ─── Share text builder ───────────────────────────────────────────────────────
function buildShareText(country, date, results, includeIsrael) {
  let text = `📰 Roy News — ${country.name}\n${formatDisplayDate(date)}\n`;
  const ids = [...Object.keys(results).filter(k => k !== '_israel'), ...(includeIsrael && results['_israel'] ? ['_israel'] : [])];
  ids.forEach(id => {
    const sr = results[id];
    if (!sr?.source || !sr.analysis) return;
    const keyStories = (sr.analysis.keyStories || []).slice(0, 3);
    const coveredTopics = (sr.analysis.topicAnalyses || []).filter(ta => ta.covered !== false).slice(0, 4);
    if (keyStories.length === 0 && coveredTopics.length === 0) return;
    text += `\n── ${sr.source.name} (${LEAN_LABELS[sr.source.lean] || sr.source.lean}) ──\n`;
    keyStories.forEach(s => { text += `• ${s}\n`; });
    coveredTopics.forEach(ta => {
      text += `\n${ta.topic} [${ta.tone || ''}]\n${(ta.summary || '').slice(0, 180)}\n`;
    });
  });
  text += `\n─────────────────\nGenerated by Roy News`;
  return text;
}

// ─── Results View ─────────────────────────────────────────────────────────────
function ResultsView({ country, results, date, includeIsrael, usage, user, onNewSearch, onError }) {
  const [isHebrew, setIsHebrew] = useState(false);
  const [hebrewResults, setHebrewResults] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [translateProgress, setTranslateProgress] = useState(0);
  const [showTranslateInfo, setShowTranslateInfo] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [resultCopied, setResultCopied] = useState(false);
  const sourceOrder = Object.keys(results).filter(k => k !== '_israel');
  const israelResult = results['_israel'];
  const displayResults = isHebrew && hebrewResults ? hebrewResults : results;
  const failedSourceIds = sourceOrder.filter(id => results[id]?.rssError && !results[id]?.analysis);
  const visibleSourceIds = sourceOrder.filter(id => !failedSourceIds.includes(id));
  // Sources with the strongest topic match lead — most covered topics first,
  // then most relevant articles as a tiebreaker (stable otherwise, so ties
  // keep their original order rather than reshuffling on every render).
  const sortedVisibleSourceIds = [...visibleSourceIds].sort((idA, idB) =>
    compareByMatchScore(topicMatchScore(displayResults[idA]?.analysis), topicMatchScore(displayResults[idB]?.analysis))
  );

  async function handleCopyResult() {
    const text = buildShareText(country, date, displayResults, includeIsrael);
    await navigator.clipboard?.writeText(text);
    setResultCopied(true);
    setTimeout(() => setResultCopied(false), 2500);
  }

  async function handleTranslate() {
    if (isHebrew) { setIsHebrew(false); return; }
    if (hebrewResults) { setIsHebrew(true); return; }
    setTranslating(true);
    setTranslateProgress(0);
    try {
      const { texts, paths } = extractTexts(results);
      const CONCURRENCY = 6;
      const allTranslations = new Array(texts.length);
      for (let i = 0; i < texts.length; i += CONCURRENCY) {
        const batch = texts.slice(i, i + CONCURRENCY);
        const translated = await Promise.all(batch.map(t => translateViaGoogle(t)));
        translated.forEach((t, j) => { allTranslations[i + j] = t; });
        setTranslateProgress(Math.round(((i + batch.length) / texts.length) * 100));
      }
      setHebrewResults(applyTranslations(results, paths, allTranslations));
      setIsHebrew(true);
    } catch (e) {
      onError('Translate to Hebrew', e.message);
    }
    setTranslating(false);
    setTranslateProgress(0);
  }

  async function handleShareResult() {
    const text = buildShareText(country, date, displayResults, includeIsrael);
    const title = `Roy News — ${country.name} · ${formatDisplayDate(date)}`;
    if (navigator.share) {
      navigator.share({ title, text }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(text);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
    }
  }

  return (
    <div className="fade-in print-root" style={{ padding: 20 }}>
      {/* Print-only header */}
      <div className="print-header" style={{ display: 'none' }}>
        <div style={{ fontSize: 22, fontWeight: 800 }}>📰 Roy News — {country.name}</div>
        <div style={{ fontSize: 14, color: '#475569', marginTop: 4 }}>{formatDisplayDate(date)}</div>
      </div>

      <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button onClick={onNewSearch} style={BACK_BTN}>← Back</button>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: C.text }}>Results for {country.name}</h2>
            <div style={{ color: C.faint, fontSize: 13, marginTop: 3 }}>{formatDisplayDate(date)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={handleTranslate} disabled={translating}
            style={{ ...SMALL_BTN, background: isHebrew ? '#1e3a5f' : C.card, borderColor: isHebrew ? '#3b82f6' : C.border, fontWeight: isHebrew ? 700 : 400, minWidth: 130 }}>
            {translating
              ? <><Spinner size={12} /> &nbsp;{translateProgress > 0 ? `${translateProgress}%` : 'Starting…'}</>
              : isHebrew ? '🇮🇱 עברית ON' : '🇮🇱 Translate to עב'}
          </button>
          <button onClick={() => setShowTranslateInfo(o => !o)}
            style={{ background: 'none', border: 'none', color: showTranslateInfo ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1 }}
            title="About translation">ℹ️</button>
          <button onClick={handleCopyResult} style={SMALL_BTN}>
            {resultCopied ? '✓ Copied!' : '📋 Copy'}
          </button>
          <button onClick={handleShareResult} style={SMALL_BTN}>
            {shareCopied ? '✓ Shared!' : '🔗 Share Result'}
          </button>
          <button onClick={() => window.print()} style={SMALL_BTN} title="Opens print dialog — select 'Save as PDF'">🖨️ Print/PDF</button>
        </div>
      </div>

      {showTranslateInfo && (
        <div className="no-print" style={{ padding: '10px 14px', background: '#0a1525', border: '1px solid #1e3a5f', borderRadius: 8, marginBottom: 10, fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
          Analysis is always generated in <strong style={{ color: C.text }}>English</strong> for best accuracy and lowest cost.<br/>
          Translation uses <strong style={{ color: C.text }}>Google Translate</strong> (free) and is cached — toggling is instant after the first time.<br/>
          <strong style={{ color: C.text }}>Share Result</strong> — on mobile opens your device's share sheet (WhatsApp, Gmail, etc.); on desktop copies the report to clipboard.
        </div>
      )}

      {usage && (
        <div className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', background: '#0a1a0a', border: '1px solid #14532d', borderRadius: 8, marginBottom: 12, fontSize: 12, flexWrap: 'wrap' }}>
          <span style={{ color: '#4ade80' }}>⚡</span>
          {usage.costUsd > 0 && (
            <span style={{ color: '#86efac' }}>AI cost <strong>${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(3)}</strong></span>
          )}
          {(usage.rssCount > 0 || usage.googleNewsCount > 0) && (
            <>
              {usage.costUsd > 0 && <span style={{ color: '#14532d' }}>·</span>}
              {usage.rssCount > 0 && <span style={{ color: C.faint, fontSize: 11 }}>RSS: <strong style={{ color: '#86efac' }}>{usage.rssCount}</strong></span>}
              {usage.rssCount > 0 && usage.googleNewsCount > 0 && <span style={{ color: '#14532d' }}>·</span>}
              {usage.googleNewsCount > 0 && <span style={{ color: C.faint, fontSize: 11 }}>Google News: <strong style={{ color: '#60a5fa' }}>{usage.googleNewsCount}</strong></span>}
            </>
          )}
          {usage.model && <><span style={{ color: '#14532d' }}>·</span><span style={{ color: C.faint, fontSize: 11 }}>{usage.model}</span></>}
        </div>
      )}

      {isHebrew && (
        <div className="no-print" style={{ padding: '8px 14px', background: '#0a1e35', border: '1px solid #1e3a5f', borderRadius: 8, marginBottom: 16, fontSize: 12, color: '#60a5fa' }}>
          🇮🇱 Showing Hebrew translation — toggle off to return to English
        </div>
      )}

      {failedSourceIds.length > 0 && (
        <div className="no-print" style={{ padding: '7px 14px', background: '#1a0e00', border: '1px solid #7c3d00', borderRadius: 8, marginBottom: 12, fontSize: 12, color: '#fb923c' }}>
          ℹ {failedSourceIds.map(id => results[id].source.name).join(', ')} could not be reached and were skipped. If this keeps happening, go to Select Sources and tap ↻ Refresh All to update the source list.
        </div>
      )}

      <div className="results-columns" style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {sortedVisibleSourceIds.map(id => <SourceColumn key={id} sourceResult={displayResults[id]} requestedDate={date} />)}
        {includeIsrael && israelResult && <SourceColumn key="_israel" sourceResult={displayResults['_israel']} requestedDate={date} />}
      </div>
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────
const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-lite',  label: 'Gemini 2.5 Flash-Lite — Cheapest' },
  { id: 'gemini-2.5-flash',       label: 'Gemini 2.5 Flash — Fast & affordable' },
  { id: 'gemini-2.5-pro',         label: 'Gemini 2.5 Pro — Most capable' },
  { id: 'gemini-3.1-flash-lite',  label: 'Gemini 3.1 Flash-Lite — Newest & cheap' },
];
const OPENAI_MODELS = [
  { id: 'gpt-4o-mini',  label: 'GPT-4o Mini — Fast & affordable' },
  { id: 'gpt-5.4-nano', label: 'GPT-5.4 Nano — Cheapest' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini — Fast & affordable' },
  { id: 'gpt-5.4',      label: 'GPT-5.4 — Most capable' },
];
const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6 — Balanced & capable' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 — Fast & affordable' },
];

function SettingsPage({ onBack, deferredInstall, user, onSignOut, isAdmin }) {
  const [confirm, confirmDialog] = useConfirm();
  const [persona, setPersona] = useState('');
  const [personaSaved, setPersonaSaved] = useState(false);

  useEffect(() => {
    if (!user?.uid) return;
    db.ref(`users/${user.uid}/persona`).once('value').then(snap => {
      const val = snap.val();
      if (val) { setPersona(val); return; }
      const lsVal = getUserPrefs(user.uid).persona;
      if (lsVal) setPersona(lsVal);
    }).catch(() => {});
  }, [user?.uid]);

  function savePersona(value) {
    if (user?.uid) db.ref(`users/${user.uid}/persona`).set(value || null);
    setPersonaSaved(true);
    setTimeout(() => setPersonaSaved(false), 2000);
  }

  const [aiProvider,   setAiProvider]   = useState('gemini');
  const [geminiKey,    setGeminiKey]    = useState('');
  const [geminiModel,  setGeminiModel]  = useState('gemini-2.5-flash');
  const [openaiKey,    setOpenaiKey]    = useState('');
  const [openaiModel,  setOpenaiModel]  = useState('gpt-4o-mini');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('claude-sonnet-4-6');
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [showOpenAIKey, setShowOpenAIKey] = useState(false);
  const [showAnthropicKey, setShowAnthropicKey] = useState(false);
  const [aiSaveMsg,    setAiSaveMsg]    = useState('');

  // Live model catalog per provider, fetched on demand — our hardcoded lists
  // above go stale as providers ship new models, so this asks the provider directly.
  const [liveModels, setLiveModels] = useState({});      // { [provider]: { models, cheapestId } }
  const [liveModelsLoading, setLiveModelsLoading] = useState(null); // provider currently loading, or null
  const [liveModelsErr, setLiveModelsErr] = useState({}); // { [provider]: message }

  async function refreshModels(provider, apiKey) {
    if (!apiKey?.trim() || liveModelsLoading) return;
    setLiveModelsLoading(provider);
    setLiveModelsErr(e => ({ ...e, [provider]: '' }));
    try {
      const result = await fns.httpsCallable('listProviderModels')({ provider, apiKey: apiKey.trim() });
      setLiveModels(m => ({ ...m, [provider]: result.data }));
    } catch (e) {
      setLiveModelsErr(e2 => ({ ...e2, [provider]: e.message }));
    }
    setLiveModelsLoading(null);
  }

  function modelLabel(m, cheapestId) {
    const price = m.price ? ` — $${m.price.in}/$${m.price.out} per M tokens` : '';
    const cheap = m.id === cheapestId ? ' · 💰 cheapest' : '';
    return `${m.label || m.id}${price}${cheap}`;
  }

  // Always include the currently-selected model, even if it fell out of the
  // provider's live/fallback list, so the <select> never silently blanks it.
  function modelOptions(models, currentId) {
    if (currentId && !models.some(m => m.id === currentId)) {
      return [{ id: currentId, label: currentId }, ...models];
    }
    return models;
  }

  // Load AI settings from Firebase on mount
  useEffect(() => {
    if (!user?.uid) return;
    db.ref(`users/${user.uid}/ai`).once('value').then(snap => {
      const d = snap.val();
      if (!d) {
        // Migrate from localStorage if present
        try {
          const ls = JSON.parse(localStorage.getItem(`roy-news-ai-${user.uid}`));
          if (ls?.provider) {
            setAiProvider(ls.provider === 'anthropic' || ls.provider === 'gemini' || ls.provider === 'openai' ? ls.provider : 'gemini');
            setGeminiKey(ls.geminiApiKey || '');
            setGeminiModel(ls.geminiModel || 'gemini-2.5-flash');
            setOpenaiKey(ls.openaiApiKey || '');
            setOpenaiModel(ls.openaiModel || 'gpt-4o-mini');
            setAnthropicKey(ls.anthropicApiKey || '');
            setAnthropicModel(ls.anthropicModel || 'claude-sonnet-4-6');
          }
        } catch {}
        return;
      }
      setAiProvider(d.provider === 'anthropic' || d.provider === 'gemini' || d.provider === 'openai' ? d.provider : 'gemini');
      setGeminiKey(d.geminiApiKey || '');
      setGeminiModel(d.geminiModel || 'gemini-2.5-flash');
      setOpenaiKey(d.openaiApiKey || '');
      setOpenaiModel(d.openaiModel || 'gpt-4o-mini');
      setAnthropicKey(d.anthropicApiKey || '');
      setAnthropicModel(d.anthropicModel || 'claude-sonnet-4-6');
    }).catch(() => {});
  }, [user?.uid]);

  const [countries, setCountries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installMsg, setInstallMsg] = useState('');

  const [contextModeOpen, setContextModeOpen] = useState(false);
  const [contextMode, setContextMode] = useState('header');
  const [contextModeLoading, setContextModeLoading] = useState(false);
  const [contextModeSaving, setContextModeSaving] = useState(false);

  async function loadContextMode() {
    setContextModeLoading(true);
    try {
      const snap = await db.ref('config/contextAnalysisMode').once('value');
      setContextMode(snap.val() === 'fullBody' ? 'fullBody' : 'header');
    } catch {}
    setContextModeLoading(false);
  }

  async function saveContextMode(mode) {
    if (!isAdmin || mode === contextMode) return;
    setContextModeSaving(true);
    try {
      await fns.httpsCallable('setContextAnalysisMode')({ mode });
      setContextMode(mode);
    } catch (e) {
      alert('Could not save: ' + e.message);
    }
    setContextModeSaving(false);
  }

  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [setupPrompt, setSetupPrompt] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [periodPrompt, setPeriodPrompt] = useState('');
  const [addSourcesPrompt, setAddSourcesPrompt] = useState('');
  const [promptSaving, setPromptSaving] = useState('');
  const [promptMsg, setPromptMsg] = useState('');

  const [usersOpen, setUsersOpen] = useState(false);
  const [usersLoading, setUsersLoading] = useState(false);
  const [authUsers, setAuthUsers] = useState([]);
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerLastLogin, setOwnerLastLogin] = useState(null);
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserRole, setNewUserRole] = useState('user');
  const [userBusy, setUserBusy] = useState(false);
  const [userMsg, setUserMsg] = useState('');

  async function loadAuthUsers() {
    setUsersLoading(true);
    try {
      const result = await fns.httpsCallable('listAuthorizedUsers')();
      setOwnerEmail(result.data.owner || '');
      setOwnerLastLogin(result.data.ownerLastLogin || null);
      setAuthUsers(result.data.users || []);
    } catch (e) {
      setUserMsg('⚠ Failed to load: ' + e.message);
    }
    setUsersLoading(false);
  }

  async function handleAddUser() {
    const email = newUserEmail.trim();
    if (!email || userBusy) return;
    setUserBusy(true);
    setUserMsg('');
    try {
      await fns.httpsCallable('addAuthorizedUser')({ email, role: newUserRole });
      setNewUserEmail('');
      setNewUserRole('user');
      setUserMsg('✓ Added');
      await loadAuthUsers();
      setTimeout(() => setUserMsg(''), 2500);
    } catch (e) {
      setUserMsg('⚠ ' + e.message);
    }
    setUserBusy(false);
  }

  function handleRemoveUser(email) {
    confirm({
      message: `Remove access for ${email}?`,
      onConfirm: async () => {
        setUserBusy(true);
        try {
          await fns.httpsCallable('removeAuthorizedUser')({ email });
          await loadAuthUsers();
        } catch (e) {
          setUserMsg('⚠ ' + e.message);
        }
        setUserBusy(false);
      }
    });
  }

  const [costsOpen, setCostsOpen] = useState(false);
  const [costsLoading, setCostsLoading] = useState(false);
  const [myCosts, setMyCosts] = useState(null);   // { 'YYYY-MM': { gemini: 1.2, openai: 0.4 } }
  const [allCosts, setAllCosts] = useState(null);  // [{ uid, email, costs }]
  const [costsMsg, setCostsMsg] = useState('');

  async function loadCosts() {
    setCostsLoading(true);
    setCostsMsg('');
    try {
      if (isAdmin) {
        const result = await fns.httpsCallable('getCosts')({ scope: 'all' });
        setAllCosts(result.data.users || []);
      } else {
        const result = await fns.httpsCallable('getCosts')();
        setMyCosts(result.data.costs || {});
      }
    } catch (e) {
      setCostsMsg('⚠ Failed to load: ' + e.message);
    }
    setCostsLoading(false);
  }

  function userTotal(costs) {
    return Object.values(costs || {}).reduce((sum, byProvider) => sum + Object.values(byProvider || {}).reduce((s, v) => s + v, 0), 0);
  }
  function formatUsd(n) {
    return '$' + (n || 0).toFixed(4);
  }

  async function loadPrompts() {
    setPromptsLoading(true);
    try {
      const snap = await db.ref('config/prompts').once('value');
      const val = snap.val() || {};
      setSetupPrompt(val.setup || DEFAULT_PROMPTS.setup);
      setAnalysisPrompt(val.analysis || DEFAULT_PROMPTS.analysis);
      setPeriodPrompt(val.period || DEFAULT_PROMPTS.period);
      setAddSourcesPrompt(val.addSources || DEFAULT_PROMPTS.addSources);
    } catch (e) {
      setSetupPrompt(DEFAULT_PROMPTS.setup);
      setAnalysisPrompt(DEFAULT_PROMPTS.analysis);
      setPeriodPrompt(DEFAULT_PROMPTS.period);
      setAddSourcesPrompt(DEFAULT_PROMPTS.addSources);
    }
    setPromptsLoading(false);
  }

  async function savePrompt(key, value) {
    setPromptSaving(key);
    try {
      await fns.httpsCallable('savePromptTemplate')({ key, value });
      setPromptMsg('✓ Saved — will take effect on the next run');
      setTimeout(() => setPromptMsg(''), 3500);
    } catch (e) {
      setPromptMsg('⚠ Save failed: ' + e.message);
    }
    setPromptSaving('');
  }

  async function resetPrompt(key) {
    try {
      await fns.httpsCallable('resetPromptTemplate')({ key });
      if (key === 'setup') setSetupPrompt(DEFAULT_PROMPTS.setup);
      else if (key === 'analysis') setAnalysisPrompt(DEFAULT_PROMPTS.analysis);
      else if (key === 'period') setPeriodPrompt(DEFAULT_PROMPTS.period);
      else if (key === 'addSources') setAddSourcesPrompt(DEFAULT_PROMPTS.addSources);
      setPromptMsg('✓ Reset to built-in default');
      setTimeout(() => setPromptMsg(''), 2500);
    } catch (e) {
      setPromptMsg('⚠ Reset failed: ' + e.message);
    }
  }

  async function saveAISettings() {
    if (!user?.uid) return;
    await db.ref(`users/${user.uid}/ai`).set({ provider: aiProvider, geminiApiKey: geminiKey, geminiModel, openaiApiKey: openaiKey, openaiModel, anthropicApiKey: anthropicKey, anthropicModel });
    setAiSaveMsg('✓ Saved');
    setTimeout(() => setAiSaveMsg(''), 2500);
  }

  useEffect(() => {
    db.ref('countries').once('value').then(snap => {
      const val = snap.val();
      const list = val ? Object.values(val).filter(c => c.setup).map(c => c.setup).sort((a, b) => (b.setupDate || '').localeCompare(a.setupDate || '')) : [];
      setCountries(list);
      setLoading(false);
    });
  }, []);

  async function handleInstall() {
    if (!deferredInstall.current) {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
      setInstallMsg(isIOS
        ? '📱 On iPhone: tap the Share button (□↑) in Safari → "Add to Home Screen"'
        : '📱 On Android: tap the 3-dot Chrome menu (⋮) → "Add to Home Screen" or "Install app"');
      return;
    }
    deferredInstall.current.prompt();
    const { outcome } = await deferredInstall.current.userChoice;
    setInstallMsg(outcome === 'accepted' ? '✓ App installed!' : 'Installation cancelled.');
    deferredInstall.current = null;
  }

  function removeCountry(key) {
    confirm({
      message: `Remove ${key}? This deletes its sources and configuration for everyone.`,
      onConfirm: async () => {
        await fns.httpsCallable('deleteCountry')({ countryKey: key });
        setCountries(p => p.filter(c => c.countryKey !== key));
      }
    });
  }

  return (
    <div style={{ maxWidth: 600, margin: '40px auto', padding: '0 20px' }}>
      <div className="panel" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <button onClick={onBack} style={BACK_BTN}>← Back</button>
          <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: C.text }}>Settings</h2>
          <span className="version-tag" style={{ marginLeft: 'auto' }}>{VERSION}</span>
        </div>

        {/* Account */}
        {user && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.5 }}>Account</div>
            <div style={{ padding: '12px 14px', background: C.card, borderRadius: 9, border: '1px solid ' + C.border, display: 'flex', alignItems: 'center', gap: 12 }}>
              {user.photoURL
                ? <img src={user.photoURL} alt="" style={{ width: 36, height: 36, borderRadius: '50%', flexShrink: 0 }} />
                : <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 16, flexShrink: 0 }}>{(user.displayName || user.email || '?')[0].toUpperCase()}</div>
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName || 'User'}</div>
                <div style={{ fontSize: 12, color: C.faint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</div>
              </div>
              <button onClick={onSignOut} style={{ ...SMALL_BTN, color: '#f87171', borderColor: '#7f1d1d', flexShrink: 0 }}>Sign Out</button>
            </div>
          </div>
        )}

        {/* Manage Users (admin only) */}
        {isAdmin && (
          <div style={{ marginBottom: 28 }}>
            <button
              onClick={() => { setUsersOpen(o => { if (!o) loadAuthUsers(); return !o; }); }}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 14px', background: usersOpen ? C.card : '#0f1e35', border: '1px solid ' + (usersOpen ? C.borderLight : C.border), borderRadius: 9, cursor: 'pointer', color: C.text }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 16 }}>👥</span>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>Manage Users</div>
                  <div style={{ fontSize: 11, color: C.faint, marginTop: 1 }}>Add or remove people who can use Roy News</div>
                </div>
              </div>
              <span style={{ color: C.faint, fontSize: 12 }}>{usersOpen ? '▲ Hide' : '▼ Show'}</span>
            </button>

            {usersOpen && (
              <div style={{ marginTop: 12 }}>
                {usersLoading ? (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>
                ) : (
                  <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
                    <div style={{ padding: '8px 10px', background: '#0f1e35', borderRadius: 7, marginBottom: 7 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ fontSize: 13, color: C.text }}>{ownerEmail}</div>
                        <span style={{ fontSize: 10, fontWeight: 700, color: '#4ade80', textTransform: 'uppercase', letterSpacing: 0.5 }}>Owner</span>
                      </div>
                      <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{formatLastLogin(ownerLastLogin)}</div>
                    </div>

                    {authUsers.length === 0 ? (
                      <div style={{ color: C.faint, fontSize: 12, padding: '4px 10px 12px' }}>No other authorized users yet</div>
                    ) : authUsers.map(u => (
                      <div key={u.email} style={{ padding: '8px 10px', borderRadius: 7, marginBottom: 5 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: u.role === 'admin' ? '#60a5fa' : C.faint, textTransform: 'uppercase', letterSpacing: 0.5 }}>{u.role}</span>
                            <button onClick={() => handleRemoveUser(u.email)} disabled={userBusy}
                              style={{ ...SMALL_BTN, color: '#f87171', borderColor: '#7f1d1d', padding: '3px 8px', opacity: userBusy ? 0.5 : 1 }}>Remove</button>
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{formatLastLogin(u.lastLogin)}</div>
                      </div>
                    ))}

                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <input type="email" value={newUserEmail} onChange={e => setNewUserEmail(e.target.value)}
                        placeholder="name@example.com" className="input-field" style={{ flex: 1, fontSize: 13 }}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddUser(); }} />
                      <select value={newUserRole} onChange={e => setNewUserRole(e.target.value)} className="input-field" style={{ fontSize: 13, width: 100 }}>
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                      <button onClick={handleAddUser} disabled={!newUserEmail.trim() || userBusy} style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px', opacity: (!newUserEmail.trim() || userBusy) ? 0.5 : 1 }}>
                        Add
                      </button>
                    </div>

                    {userMsg && (
                      <div style={{ fontSize: 12, color: userMsg.startsWith('✓') ? '#4ade80' : '#f87171', marginTop: 10 }}>{userMsg}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Usage & Costs */}
        <div style={{ marginBottom: 28 }}>
          <button
            onClick={() => { setCostsOpen(o => { if (!o) loadCosts(); return !o; }); }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 14px', background: costsOpen ? C.card : '#0f1e35', border: '1px solid ' + (costsOpen ? C.borderLight : C.border), borderRadius: 9, cursor: 'pointer', color: C.text }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>💰</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Usage & Costs</div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 1 }}>{isAdmin ? 'Your AI spend and everyone else\'s, by month and provider' : 'Your AI spend, by month and provider'}</div>
              </div>
            </div>
            <span style={{ color: C.faint, fontSize: 12 }}>{costsOpen ? '▲ Hide' : '▼ Show'}</span>
          </button>

          {costsOpen && (
            <div style={{ marginTop: 12 }}>
              {costsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>
              ) : isAdmin ? (
                (allCosts || []).length === 0 ? (
                  <div style={{ color: C.faint, fontSize: 12, padding: '4px 10px' }}>No usage recorded yet</div>
                ) : (
                  <>
                    {[...allCosts].sort((a, b) => userTotal(b.costs) - userTotal(a.costs)).map(u => (
                      <div key={u.uid} style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginBottom: 10 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.email || u.uid}{user?.uid === u.uid && <span style={{ color: C.faint, fontWeight: 400 }}> (you)</span>}
                          </div>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#4ade80', flexShrink: 0, marginLeft: 10 }}>{formatUsd(userTotal(u.costs))}</div>
                        </div>
                        {Object.entries(u.costs || {}).sort((a, b) => b[0].localeCompare(a[0])).map(([month, byProvider]) => (
                          <div key={month} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid ' + C.border, fontSize: 12 }}>
                            <div style={{ color: C.faint }}>{month}</div>
                            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                              {Object.entries(byProvider || {}).map(([provider, cost]) => (
                                <span key={provider} style={{ color: C.muted }}>{provider}: {formatUsd(cost)}</span>
                              ))}
                              <span style={{ color: C.text, fontWeight: 600 }}>{formatUsd(Object.values(byProvider || {}).reduce((s, v) => s + v, 0))}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                    <div style={{ fontSize: 12, color: C.faint, textAlign: 'right' }}>
                      Grand total: {formatUsd(allCosts.reduce((s, u) => s + userTotal(u.costs), 0))}
                    </div>
                  </>
                )
              ) : (
                !myCosts || Object.keys(myCosts).length === 0 ? (
                  <div style={{ color: C.faint, fontSize: 12, padding: '4px 10px' }}>No usage recorded yet</div>
                ) : (
                  <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
                    {Object.entries(myCosts).sort((a, b) => b[0].localeCompare(a[0])).map(([month, byProvider]) => (
                      <div key={month} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid ' + C.border, fontSize: 13 }}>
                        <div style={{ color: C.text }}>{month}</div>
                        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                          {Object.entries(byProvider || {}).map(([provider, cost]) => (
                            <span key={provider} style={{ color: C.faint, fontSize: 12 }}>{provider}: {formatUsd(cost)}</span>
                          ))}
                          <span style={{ color: '#4ade80', fontWeight: 600 }}>{formatUsd(Object.values(byProvider || {}).reduce((s, v) => s + v, 0))}</span>
                        </div>
                      </div>
                    ))}
                    <div style={{ fontSize: 12, color: C.faint, textAlign: 'right', marginTop: 8, paddingTop: 8, borderTop: '1px solid ' + C.border }}>
                      Total: {formatUsd(userTotal(myCosts))}
                    </div>
                  </div>
                )
              )}
              {costsMsg && (
                <div style={{ fontSize: 12, color: '#f87171', marginTop: 10 }}>{costsMsg}</div>
              )}
            </div>
          )}
        </div>

        {/* Your Profile */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Your Profile</div>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 12, lineHeight: 1.6 }}>
            Describes who you are and what you need from Period Analysis reports.<br/>
            The AI uses this to decide what to foreground — which fault lines matter, what blind spots are relevant, how to frame the synthesis.
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 10 }}>
            {[
              ['Curious / Intellectual', 'I follow geopolitics out of intellectual curiosity and want to understand the underlying narratives, ideological roots, and cultural patterns driving each camp\'s coverage.'],
              ['Policy & Diplomacy',     'I am a diplomat or policy professional who needs to understand what signals each camp is projecting, what is absent from coverage, and what coverage patterns reveal about political stability and government intent.'],
              ['Journalist',             'I am a journalist who needs citable framing, notable divergences between outlets, and clear signals of media bias or coordinated messaging.'],
              ['Researcher / Academic',  'I am a researcher studying media framing, political communication, or regional affairs and need systematic analysis of narrative patterns across the political spectrum.'],
            ].map(([label, text]) => (
              <button key={label} onClick={() => setPersona(text)}
                style={{ ...SMALL_BTN, background: persona === text ? '#1e3a5f' : C.card, borderColor: persona === text ? '#3b82f6' : C.border, color: persona === text ? '#93c5fd' : C.muted, fontSize: 12 }}>
                {label}
              </button>
            ))}
          </div>
          <textarea
            value={persona}
            onChange={e => setPersona(e.target.value)}
            placeholder="Describe yourself and what you want to get out of the analysis…"
            className="input-field"
            style={{ height: 90, resize: 'vertical', fontSize: 13, lineHeight: 1.6, marginBottom: 8 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button onClick={() => savePersona(persona)} style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px' }}>Save</button>
            {persona && <button onClick={() => { setPersona(''); savePersona(''); }} style={{ ...SMALL_BTN, color: C.faint }}>Clear</button>}
            {personaSaved && <span style={{ fontSize: 12, color: '#4ade80' }}>✓ Saved</span>}
          </div>
        </div>

        {/* AI Provider */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.5 }}>AI Provider</div>
          <div style={{ fontSize: 12, color: C.faint, marginBottom: 14, lineHeight: 1.6 }}>
            Roy News runs on your own API key — pick a provider and paste your key below.
          </div>

          {[
            { id: 'gemini',    name: 'Gemini (Google)',   desc: 'Google AI Studio · Your API key' },
            { id: 'openai',    name: 'ChatGPT (OpenAI)',  desc: 'OpenAI API · Your API key' },
            { id: 'anthropic', name: 'Claude (Anthropic)', desc: 'Anthropic API · Your API key' },
          ].map(p => (
            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: aiProvider === p.id ? C.card : '#0f1e35', border: '1px solid ' + (aiProvider === p.id ? '#3b82f6' : C.border), borderRadius: 8, cursor: 'pointer', marginBottom: 7 }}>
              <input type="radio" name="aiprovider" value={p.id} checked={aiProvider === p.id} onChange={() => setAiProvider(p.id)} style={{ accentColor: '#3b82f6', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: C.text }}>{p.name}</div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{p.desc}</div>
              </div>
              {aiProvider === p.id && <span style={{ color: '#4ade80', fontSize: 11, fontWeight: 700 }}>Active</span>}
            </label>
          ))}

          {aiProvider === 'gemini' && (
            <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginTop: 4, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: C.faint, fontWeight: 600 }}>Google AI Studio API Key</div>
                <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12, color: '#60a5fa', fontWeight: 600, textDecoration: 'none', padding: '4px 10px', background: '#0f2a4a', border: '1px solid #1e3a5f', borderRadius: 6, whiteSpace: 'nowrap' }}>
                  🔑 Get API Key ↗
                </a>
              </div>
              <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.5 }}>
                Tap "Get API Key" → create a key on Google AI Studio → come back and paste it below
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input type={showGeminiKey ? 'text' : 'password'} value={geminiKey} onChange={e => setGeminiKey(e.target.value)} placeholder="Paste your AIza… key here" className="input-field" style={{ flex: 1, fontSize: 13 }} />
                <button onClick={() => setShowGeminiKey(x => !x)} style={SMALL_BTN}>{showGeminiKey ? '🙈' : '👁'}</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 12, color: C.faint, fontWeight: 600 }}>Model</div>
                <button onClick={() => refreshModels('gemini', geminiKey)} disabled={!geminiKey.trim() || liveModelsLoading === 'gemini'}
                  style={{ ...SMALL_BTN, opacity: (!geminiKey.trim() || liveModelsLoading === 'gemini') ? 0.5 : 1 }}>
                  {liveModelsLoading === 'gemini' ? 'Checking…' : '🔄 Refresh list'}
                </button>
              </div>
              <select value={geminiModel} onChange={e => setGeminiModel(e.target.value)} className="input-field" style={{ fontSize: 13 }}>
                {modelOptions(liveModels.gemini?.models || GEMINI_MODELS, geminiModel).map(m =>
                  <option key={m.id} value={m.id}>{modelLabel(m, liveModels.gemini?.cheapestId)}</option>
                )}
              </select>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>
                {liveModels.gemini ? `Showing ${liveModels.gemini.models.length} models live from your Gemini account.` : 'Showing a default list — press "Refresh list" to pull the current models from your Gemini account.'}
              </div>
              {liveModelsErr.gemini && <div style={{ color: '#f87171', fontSize: 11, marginTop: 6 }}>{liveModelsErr.gemini}</div>}
            </div>
          )}

          {aiProvider === 'openai' && (
            <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginTop: 4, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: C.faint, fontWeight: 600 }}>OpenAI API Key</div>
                <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12, color: '#60a5fa', fontWeight: 600, textDecoration: 'none', padding: '4px 10px', background: '#0f2a4a', border: '1px solid #1e3a5f', borderRadius: 6, whiteSpace: 'nowrap' }}>
                  🔑 Get API Key ↗
                </a>
              </div>
              <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.5 }}>
                Tap "Get API Key" → create a key on OpenAI Platform → come back and paste it below
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                <input type={showOpenAIKey ? 'text' : 'password'} value={openaiKey} onChange={e => setOpenaiKey(e.target.value)} placeholder="Paste your sk-… key here" className="input-field" style={{ flex: 1, fontSize: 13 }} />
                <button onClick={() => setShowOpenAIKey(x => !x)} style={SMALL_BTN}>{showOpenAIKey ? '🙈' : '👁'}</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 12, color: C.faint, fontWeight: 600 }}>Model</div>
                <button onClick={() => refreshModels('openai', openaiKey)} disabled={!openaiKey.trim() || liveModelsLoading === 'openai'}
                  style={{ ...SMALL_BTN, opacity: (!openaiKey.trim() || liveModelsLoading === 'openai') ? 0.5 : 1 }}>
                  {liveModelsLoading === 'openai' ? 'Checking…' : '🔄 Refresh list'}
                </button>
              </div>
              <select value={openaiModel} onChange={e => setOpenaiModel(e.target.value)} className="input-field" style={{ fontSize: 13 }}>
                {modelOptions(liveModels.openai?.models || OPENAI_MODELS, openaiModel).map(m =>
                  <option key={m.id} value={m.id}>{modelLabel(m, liveModels.openai?.cheapestId)}</option>
                )}
              </select>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>
                {liveModels.openai ? `Showing ${liveModels.openai.models.length} models live from your OpenAI account.` : 'Showing a default list — press "Refresh list" to pull the current models from your OpenAI account.'}
              </div>
              {liveModelsErr.openai && <div style={{ color: '#f87171', fontSize: 11, marginTop: 6 }}>{liveModelsErr.openai}</div>}
            </div>
          )}

          {aiProvider === 'anthropic' && (
            <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginTop: 4, marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: C.faint, fontWeight: 600 }}>Anthropic API Key</div>
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer"
                  style={{ fontSize: 12, color: '#60a5fa', fontWeight: 600, textDecoration: 'none', padding: '4px 10px', background: '#0f2a4a', border: '1px solid #1e3a5f', borderRadius: 6, whiteSpace: 'nowrap' }}>
                  🔑 Get API Key ↗
                </a>
              </div>
              <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.5 }}>
                Tap "Get API Key" → create a key on the Anthropic Console → come back and paste it below
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type={showAnthropicKey ? 'text' : 'password'} value={anthropicKey} onChange={e => setAnthropicKey(e.target.value)} placeholder="Paste your sk-ant-… key here" className="input-field" style={{ flex: 1, fontSize: 13 }} />
                <button onClick={() => setShowAnthropicKey(x => !x)} style={SMALL_BTN}>{showAnthropicKey ? '🙈' : '👁'}</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 12, marginBottom: 6 }}>
                <div style={{ fontSize: 12, color: C.faint, fontWeight: 600 }}>Model</div>
                <button onClick={() => refreshModels('anthropic', anthropicKey)} disabled={!anthropicKey.trim() || liveModelsLoading === 'anthropic'}
                  style={{ ...SMALL_BTN, opacity: (!anthropicKey.trim() || liveModelsLoading === 'anthropic') ? 0.5 : 1 }}>
                  {liveModelsLoading === 'anthropic' ? 'Checking…' : '🔄 Refresh list'}
                </button>
              </div>
              <select value={anthropicModel} onChange={e => setAnthropicModel(e.target.value)} className="input-field" style={{ fontSize: 13 }}>
                {modelOptions(liveModels.anthropic?.models || ANTHROPIC_MODELS, anthropicModel).map(m =>
                  <option key={m.id} value={m.id}>{modelLabel(m, liveModels.anthropic?.cheapestId)}</option>
                )}
              </select>
              <div style={{ fontSize: 11, color: C.faint, marginTop: 6 }}>
                {liveModels.anthropic ? `Showing ${liveModels.anthropic.models.length} models live from your Anthropic account.` : 'Showing a default list — press "Refresh list" to pull the current models from your Anthropic account.'}
              </div>
              {liveModelsErr.anthropic && <div style={{ color: '#f87171', fontSize: 11, marginTop: 6 }}>{liveModelsErr.anthropic}</div>}
            </div>
          )}

          <button onClick={saveAISettings} style={{ ...BTN('#2563eb'), marginTop: 6 }}>
            {aiSaveMsg || 'Save AI Settings'}
          </button>
        </div>

        {/* Install on phone */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.5 }}>Install App</div>
          <p style={{ color: C.muted, fontSize: 13, marginBottom: 12 }}>Install Roy News on your phone or desktop for quick access — works like a native app.</p>
          <button onClick={handleInstall} style={{ ...BTN('#2563eb'), display: 'flex', alignItems: 'center', gap: 8 }}>
            📲 Install on this device
          </button>
          {installMsg && <div style={{ marginTop: 10, fontSize: 13, color: installMsg.startsWith('✓') ? '#4ade80' : C.muted }}>{installMsg}</div>}
          <div style={{ marginTop: 10, fontSize: 12, color: C.faint }}>
            iPhone / iPad: tap the Share button (□↑) in Safari → "Add to Home Screen"<br/>
            Android: use Chrome or Edge browser
          </div>
        </div>

        {/* Context Topic Analysis */}
        <div style={{ marginBottom: 28 }}>
          <button
            onClick={() => { setContextModeOpen(o => { if (!o) loadContextMode(); return !o; }); }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 14px', background: contextModeOpen ? C.card : '#0f1e35', border: '1px solid ' + (contextModeOpen ? C.borderLight : C.border), borderRadius: 9, cursor: 'pointer', color: C.text }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>🧭</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Context Topic Analysis</div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 1 }}>How "Context" topics (themes, not keywords) get matched — applies app-wide</div>
              </div>
            </div>
            <span style={{ color: C.faint, fontSize: 12 }}>{contextModeOpen ? '▲ Hide' : '▼ Show'}</span>
          </button>

          {contextModeOpen && (
            <div style={{ marginTop: 12, padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
              {contextModeLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>
              ) : (
                <>
                  <div style={{ fontSize: 12, color: C.faint, marginBottom: 12, lineHeight: 1.6 }}>
                    A topic like "Israel" is a word a keyword check can find. A topic like "internal politics" is a theme — no keyword check will ever match it, since an article can be about that theme without containing those words. Topics marked "Context" are judged by the AI instead of by keyword, using whichever mode is selected below.
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <button onClick={() => saveContextMode('header')} disabled={!isAdmin || contextModeSaving}
                      style={{ textAlign: 'left', padding: '10px 14px', borderRadius: 8, border: '1px solid ' + (contextMode === 'header' ? '#3b82f6' : C.border), background: contextMode === 'header' ? '#1e3a5f' : '#0f1e35', cursor: isAdmin ? 'pointer' : 'default', opacity: !isAdmin && contextMode !== 'header' ? 0.6 : 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: contextMode === 'header' ? '#60a5fa' : C.text }}>{contextMode === 'header' && '● '}Header-first analysis {contextMode === 'header' && '(active)'}</div>
                      <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>Cheap classification pass over just the article titles first; only the ones it flags get a full read. Keeps cost down, default.</div>
                    </button>
                    <button onClick={() => saveContextMode('fullBody')} disabled={!isAdmin || contextModeSaving}
                      style={{ textAlign: 'left', padding: '10px 14px', borderRadius: 8, border: '1px solid ' + (contextMode === 'fullBody' ? '#3b82f6' : C.border), background: contextMode === 'fullBody' ? '#1e3a5f' : '#0f1e35', cursor: isAdmin ? 'pointer' : 'default', opacity: !isAdmin && contextMode !== 'fullBody' ? 0.6 : 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: contextMode === 'fullBody' ? '#60a5fa' : C.text }}>{contextMode === 'fullBody' && '● '}Full body analysis {contextMode === 'fullBody' && '(active)'}</div>
                      <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>No pre-filter — every matched article gets a full read for every context topic. More thorough, priced per article regardless of relevance.</div>
                    </button>
                  </div>
                  {!isAdmin && <div style={{ fontSize: 11, color: C.faint, marginTop: 10 }}>Only an admin can change this — you're seeing the current setting.</div>}
                  {contextModeSaving && <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}><Spinner size={14} /></div>}
                </>
              )}
            </div>
          )}
        </div>

        {/* Prompt Templates */}
        <div style={{ marginBottom: 28 }}>
          <button
            onClick={() => { setPromptsOpen(o => { if (!o) loadPrompts(); return !o; }); }}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 14px', background: promptsOpen ? C.card : '#0f1e35', border: '1px solid ' + (promptsOpen ? C.borderLight : C.border), borderRadius: 9, cursor: 'pointer', color: C.text }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 16 }}>🧠</span>
              <div style={{ textAlign: 'left' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>Prompt Templates</div>
                <div style={{ fontSize: 11, color: C.faint, marginTop: 1 }}>{isAdmin ? 'Edit the instructions sent to the AI' : 'View the instructions sent to the AI'}</div>
              </div>
            </div>
            <span style={{ color: C.faint, fontSize: 12 }}>{promptsOpen ? '▲ Hide' : '▼ Show'}</span>
          </button>

          {promptsOpen && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {promptsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>
              ) : (
                <>
                  {/* Setup prompt */}
                  <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.text, marginBottom: 4 }}>Country Setup Prompt</div>
                    <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.6 }}>
                      Runs once when discovering sources for a new country.<br/>
                      Available variable: <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{country}}'}</span>
                    </div>
                    <textarea
                      value={setupPrompt}
                      onChange={e => isAdmin && setSetupPrompt(e.target.value)}
                      readOnly={!isAdmin}
                      className="input-field"
                      style={{ height: 260, resize: 'vertical', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.55, opacity: isAdmin ? 1 : 0.75, cursor: isAdmin ? 'text' : 'default' }}
                    />
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={() => savePrompt('setup', setupPrompt)} disabled={promptSaving === 'setup'}
                          style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px' }}>
                          {promptSaving === 'setup' ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => resetPrompt('setup')} style={{ ...SMALL_BTN, color: '#fb923c', borderColor: '#7c2d12' }}>
                          Reset to Default
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Analysis prompt */}
                  <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.text, marginBottom: 4 }}>Source Analysis Prompt</div>
                    <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.6 }}>
                      Runs for each news source during analysis.<br/>
                      Variables: <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{sourceName}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{sourceLean}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{country}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{leanDescription}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{date}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{topicList}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{articlesText}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{summaryLen}}'}</span>
                    </div>
                    <textarea
                      value={analysisPrompt}
                      onChange={e => isAdmin && setAnalysisPrompt(e.target.value)}
                      readOnly={!isAdmin}
                      className="input-field"
                      style={{ height: 320, resize: 'vertical', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.55, opacity: isAdmin ? 1 : 0.75, cursor: isAdmin ? 'text' : 'default' }}
                    />
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={() => savePrompt('analysis', analysisPrompt)} disabled={promptSaving === 'analysis'}
                          style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px' }}>
                          {promptSaving === 'analysis' ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => resetPrompt('analysis')} style={{ ...SMALL_BTN, color: '#fb923c', borderColor: '#7c2d12' }}>
                          Reset to Default
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Period prompt */}
                  <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.text, marginBottom: 4 }}>Period Analysis Prompt</div>
                    <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.6 }}>
                      Runs once for the full period — knowledge-based, no RSS.<br/>
                      Variables: <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{country}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{topicList}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{startDate}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{endDate}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{reportLen}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{personaLine}}'}</span>
                    </div>
                    <textarea
                      value={periodPrompt}
                      onChange={e => isAdmin && setPeriodPrompt(e.target.value)}
                      readOnly={!isAdmin}
                      className="input-field"
                      style={{ height: 320, resize: 'vertical', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.55, opacity: isAdmin ? 1 : 0.75, cursor: isAdmin ? 'text' : 'default' }}
                    />
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={() => savePrompt('period', periodPrompt)} disabled={promptSaving === 'period'}
                          style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px' }}>
                          {promptSaving === 'period' ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => resetPrompt('period')} style={{ ...SMALL_BTN, color: '#fb923c', borderColor: '#7c2d12' }}>
                          Reset to Default
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Add New Resources prompt */}
                  <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: C.text, marginBottom: 4 }}>Add New Resources Prompt</div>
                    <div style={{ fontSize: 11, color: C.faint, marginBottom: 10, lineHeight: 1.6 }}>
                      Runs when a user clicks "+ Add More" on a country's source list.<br/>
                      Variables: <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{country}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{requestCount}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{existingNames}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{locationClause}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{mediaTypeClause}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{orientationClause}}'}</span> <span style={{ color: '#60a5fa', fontFamily: 'monospace' }}>{'{{languageClause}}'}</span> — the four *Clause variables are pre-built sentence fragments (empty string if that filter wasn't set) driven by the City/Media type/Orientation/Language fields in the Add More panel.
                    </div>
                    <textarea
                      value={addSourcesPrompt}
                      onChange={e => isAdmin && setAddSourcesPrompt(e.target.value)}
                      readOnly={!isAdmin}
                      className="input-field"
                      style={{ height: 320, resize: 'vertical', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.55, opacity: isAdmin ? 1 : 0.75, cursor: isAdmin ? 'text' : 'default' }}
                    />
                    {isAdmin && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={() => savePrompt('addSources', addSourcesPrompt)} disabled={promptSaving === 'addSources'}
                          style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px' }}>
                          {promptSaving === 'addSources' ? 'Saving…' : 'Save'}
                        </button>
                        <button onClick={() => resetPrompt('addSources')} style={{ ...SMALL_BTN, color: '#fb923c', borderColor: '#7c2d12' }}>
                          Reset to Default
                        </button>
                      </div>
                    )}
                  </div>

                  {promptMsg && (
                    <div style={{ fontSize: 13, color: promptMsg.startsWith('✓') ? '#4ade80' : '#f87171', padding: '8px 12px', background: '#0a1a0a', borderRadius: 7, border: '1px solid #14532d' }}>
                      {promptMsg}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Country management */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 14, textTransform: 'uppercase', letterSpacing: 0.5 }}>Country Management</div>
          {loading ? <Spinner /> : countries.length === 0
            ? <div style={{ color: C.faint, fontSize: 13 }}>No countries configured yet</div>
            : countries.map(c => {
              const lastRun = user?.uid ? localStorage.getItem(`roy-news-lastrun-${user.uid}-${c.countryKey}`) : null;
              return (
                <div key={c.countryKey} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: C.card, borderRadius: 9, marginBottom: 7, border: '1px solid ' + C.border, padding: '11px 14px' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{c.country}</div>
                    <div style={{ color: C.faint, fontSize: 11, marginTop: 2 }}>
                      {c.sources?.length} sources · {lastRun ? `Last run: ${lastRun}` : (c.setupDate?.slice(0, 10) || '—')}
                    </div>
                  </div>
                  <button onClick={() => removeCountry(c.countryKey)}
                    style={{ ...SMALL_BTN, color: '#f87171', borderColor: '#7f1d1d' }}>Remove</button>
                </div>
              );
            })
          }
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

// ─── Scheduled Reports (admin only) ────────────────────────────────────────────
// Daily/weekly digests built from the article archive (see functions/index.js)
// instead of a live fetch — reliable because the archive has been continuously
// collecting each source's feed, rather than checking it once at report time.
const WEEKDAY_OPTIONS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

// Renders each parsed topic as a small chip toggling Exact/Context matching
// — shared by the create and edit forms in ScheduledReportsPanel below.
function TopicModeChips({ topics, contextSet, onToggle }) {
  if (topics.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, marginTop: -4 }}>
      {topics.map(t => {
        const isContext = contextSet.has(t);
        return (
          <button key={t} onClick={() => onToggle(t)} type="button"
            style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, padding: '2px 8px', borderRadius: 10, border: 'none', cursor: 'pointer', background: isContext ? '#7c3aed' : 'rgba(255,255,255,0.1)', color: isContext ? 'white' : C.faint }}>
            {t}: {isContext ? '🧭 context' : 'exact'}
          </button>
        );
      })}
    </div>
  );
}

// Domestic restricts context (🧭) topics to coverage specifically about the
// schedule's own country; Global (default) leaves them unrestricted, same as
// before this toggle existed. Only affects context-mode topics — exact
// topics (e.g. "Israel, Gaza") already scope themselves via keyword match.
function SearchScopeToggle({ value, onChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Search scope for 🧭 context topics</label>
      <div style={{ display: 'flex', gap: 6 }}>
        {['global', 'domestic'].map(v => (
          <button key={v} type="button" onClick={() => onChange(v)}
            style={{ fontSize: 12, padding: '5px 12px', borderRadius: 6, border: '1px solid ' + (value === v ? '#7c3aed' : C.border), cursor: 'pointer', background: value === v ? '#7c3aed' : 'transparent', color: value === v ? 'white' : C.muted }}>
            {v === 'domestic' ? 'Domestic' : 'Global'}
          </button>
        ))}
      </div>
      <div style={{ fontSize: 10, color: C.faint, marginTop: 3 }}>
        {value === 'domestic' ? 'Only coverage specifically about this schedule’s own country.' : 'Coverage of the topic anywhere in the world (default).'}
      </div>
    </div>
  );
}

// A single scheduled report run's detail view — same shape as the
// point-in-time results (results keyed by source id), so it reuses the same
// buildShareText/extractTexts/applyTranslations helpers. Keyed by runId at
// the call site so switching to a different report remounts this with a
// clean slate instead of carrying over the previous run's translation state.
// Extract/apply-translations + share-text builder for the new raw (no-AI)
// report shape, mirroring extractTexts/applyTranslations/buildShareText
// which serve the AI-summary shape instead.
function extractRawTexts(run) {
  const texts = [], paths = [];
  if (run.summary) { texts.push(run.summary); paths.push(['summary']); }
  (run.days || []).forEach((d, di) => {
    (d.sources || []).forEach((s, si) => {
      (s.articles || []).forEach((a, ai) => {
        if (a.title) { texts.push(a.title); paths.push(['days', di, 'sources', si, 'articles', ai, 'title']); }
        if (a.text) { texts.push(a.text); paths.push(['days', di, 'sources', si, 'articles', ai, 'text']); }
      });
    });
  });
  return { texts, paths };
}
function applyRawTranslations(run, paths, translations) {
  const copy = JSON.parse(JSON.stringify(run || {}));
  paths.forEach((path, i) => {
    let obj = copy;
    for (let j = 0; j < path.length - 1; j++) obj = obj[path[j]];
    obj[path[path.length - 1]] = translations[i] ?? obj[path[path.length - 1]];
  });
  return copy;
}
function buildRawShareText(country, dateLabel, run) {
  const days = run.days || [];
  const isMultiDay = days.length > 1;
  let text = `📰 Roy News — ${country.name}\n${formatDateLabelDMY(dateLabel)}\n`;
  if (run.topics?.length) text += `Topics: ${run.topics.join(', ')}\n`;
  if (run.summary) text += `\nSummary\n${run.summary}\n`;
  days.forEach(d => {
    if (isMultiDay) text += `\n=== Day: ${formatDateLabelDMY(d.day)} ===\n`;
    (d.sources || []).forEach(s => {
      text += `\n  Source: ${s.sourceName}\n`;
      (s.articles || []).forEach(a => { text += `    ${a.title}\n    ${a.text}\n`; });
    });
  });
  text += `\n─────────────────\nGenerated by Roy News`;
  return text;
}

// The new per-day, no-AI-summary report — raw RSS text (translated where
// needed), grouped by day → topic → source, matching daily's and weekly's
// shared structure.
function RawScheduledRunView({ scheduleCountry, dateLabel, run, onDelete, onClose }) {
  const [isHebrew, setIsHebrew] = useState(false);
  const [hebrewRun, setHebrewRun] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [translateProgress, setTranslateProgress] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);
  const [resultCopied, setResultCopied] = useState(false);
  const [showTranslateInfo, setShowTranslateInfo] = useState(false);

  const displayRun = isHebrew && hebrewRun ? hebrewRun : run;
  const displayDays = displayRun.days || [];
  const isMultiDay = displayDays.length > 1;

  async function handleTranslate() {
    if (isHebrew) { setIsHebrew(false); return; }
    if (hebrewRun) { setIsHebrew(true); return; }
    setTranslating(true);
    setTranslateProgress(0);
    try {
      const { texts, paths } = extractRawTexts(run);
      const CONCURRENCY = 6;
      const allTranslations = new Array(texts.length);
      for (let i = 0; i < texts.length; i += CONCURRENCY) {
        const batch = texts.slice(i, i + CONCURRENCY);
        const translated = await Promise.all(batch.map(t => translateViaGoogle(t)));
        translated.forEach((t, j) => { allTranslations[i + j] = t; });
        setTranslateProgress(Math.round(((i + batch.length) / texts.length) * 100));
      }
      setHebrewRun(applyRawTranslations(run, paths, allTranslations));
      setIsHebrew(true);
    } catch (e) {
      alert('Could not translate: ' + e.message);
    }
    setTranslating(false);
    setTranslateProgress(0);
  }

  async function handleCopyResult() {
    const text = buildRawShareText({ name: scheduleCountry }, dateLabel, displayRun);
    await navigator.clipboard?.writeText(text);
    setResultCopied(true);
    setTimeout(() => setResultCopied(false), 2500);
  }

  async function handleShareResult() {
    const text = buildRawShareText({ name: scheduleCountry }, dateLabel, displayRun);
    const title = `Roy News — ${scheduleCountry} · ${formatDateLabelDMY(dateLabel)}`;
    if (navigator.share) {
      navigator.share({ title, text }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(text);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
    }
  }

  return (
    <div className="panel print-root" style={{ maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto', padding: 20 }} onClick={e => e.stopPropagation()}>
      <div className="print-header" style={{ display: 'none' }}>
        <div style={{ fontSize: 22, fontWeight: 800 }}>📰 Roy News — {scheduleCountry}</div>
        <div style={{ fontSize: 14, color: '#475569', marginTop: 4 }}>{formatDateLabelDMY(dateLabel)}</div>
      </div>

      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{formatDateLabelDMY(dateLabel)}</div>
          <button onClick={onDelete} style={{ ...SMALL_BTN, color: '#f87171', borderColor: '#7f1d1d', fontSize: 11 }}>
            🗑️ Delete report
          </button>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: 20 }}>×</button>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={handleTranslate} disabled={translating}
          style={{ ...SMALL_BTN, background: isHebrew ? '#1e3a5f' : C.card, borderColor: isHebrew ? '#3b82f6' : C.border, fontWeight: isHebrew ? 700 : 400, minWidth: 130 }}>
          {translating
            ? <><Spinner size={12} /> &nbsp;{translateProgress > 0 ? `${translateProgress}%` : 'Starting…'}</>
            : isHebrew ? '🇮🇱 עברית ON' : '🇮🇱 Translate to עב'}
        </button>
        <button onClick={() => setShowTranslateInfo(o => !o)}
          style={{ background: 'none', border: 'none', color: showTranslateInfo ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1 }}
          title="About translation">ℹ️</button>
        <button onClick={handleCopyResult} style={SMALL_BTN}>{resultCopied ? '✓ Copied!' : '📋 Copy'}</button>
        <button onClick={handleShareResult} style={SMALL_BTN}>{shareCopied ? '✓ Shared!' : '🔗 Share Result'}</button>
        <button onClick={() => window.print()} style={SMALL_BTN} title="Opens print dialog — select 'Save as PDF'">🖨️ Print/PDF</button>
      </div>

      {showTranslateInfo && (
        <div className="no-print" style={{ padding: '10px 14px', background: '#0a1525', border: '1px solid #1e3a5f', borderRadius: 8, marginBottom: 10, fontSize: 12, color: C.muted, lineHeight: 1.7 }}>
          The report text is the source's own RSS wording — translated to <strong style={{ color: C.text }}>English</strong> where needed, never rewritten.<br/>
          Translation uses <strong style={{ color: C.text }}>Google Translate</strong> (free) and is cached — toggling is instant after the first time.<br/>
          <strong style={{ color: C.text }}>Share Result</strong> — on mobile opens your device's share sheet (WhatsApp, Gmail, etc.); on desktop copies the report to clipboard.
        </div>
      )}

      {run.topics?.length > 0 && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>Topics: {run.topics.join(', ')}</div>
      )}

      {displayRun.summary && (
        <div style={{ marginBottom: 20, padding: '10px 12px', background: '#0f1e35', borderRadius: 8, border: '1px solid ' + C.border }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Summary</div>
          <div style={{ fontSize: 13, color: '#cbd5e1', lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>{displayRun.summary}</div>
        </div>
      )}

      {displayDays.length === 0 ? (
        <div style={{ color: C.faint, fontSize: 13, padding: '10px 0' }}>No matches found for this period.</div>
      ) : displayDays.map((d, di) => (
        <div key={di} style={{ marginBottom: 20 }}>
          {isMultiDay && (
            <div style={{ fontSize: 13, fontWeight: 700, color: '#60a5fa', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Day: {formatDateLabelDMY(d.day)}
            </div>
          )}
          {(d.sources || []).map((s, si) => (
            <div key={si} style={{ marginBottom: 10, paddingLeft: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, marginBottom: 4 }}>Source: {s.sourceName}</div>
              {(s.articles || []).map((a, ai) => (
                <div key={ai} style={{ marginBottom: 8, padding: '8px 10px', background: '#0f1e35', borderRadius: 6 }}>
                  {a.link
                    ? <a href={a.link} target="_blank" rel="noopener noreferrer"
                        style={{ color: '#60a5fa', fontSize: 12, fontWeight: 600, lineHeight: 1.4, textDecoration: 'none', display: 'block', marginBottom: 3 }}>{a.title} ↗</a>
                    : <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 3 }}>{a.title}</div>
                  }
                  <div style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{a.text}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// Older reports generated before the raw-report rewrite still have this
// AI-summary shape (results keyed by source) — kept viewable as-is rather
// than migrated.
function LegacyScheduledRunView({ scheduleCountry, dateLabel, run, onDelete, onClose }) {
  const [isHebrew, setIsHebrew] = useState(false);
  const [hebrewResults, setHebrewResults] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [translateProgress, setTranslateProgress] = useState(0);
  const [shareCopied, setShareCopied] = useState(false);
  const [resultCopied, setResultCopied] = useState(false);

  const displayResults = isHebrew && hebrewResults ? hebrewResults : run.results;

  async function handleTranslate() {
    if (isHebrew) { setIsHebrew(false); return; }
    if (hebrewResults) { setIsHebrew(true); return; }
    setTranslating(true);
    setTranslateProgress(0);
    try {
      const { texts, paths } = extractTexts(run.results);
      const CONCURRENCY = 6;
      const allTranslations = new Array(texts.length);
      for (let i = 0; i < texts.length; i += CONCURRENCY) {
        const batch = texts.slice(i, i + CONCURRENCY);
        const translated = await Promise.all(batch.map(t => translateViaGoogle(t)));
        translated.forEach((t, j) => { allTranslations[i + j] = t; });
        setTranslateProgress(Math.round(((i + batch.length) / texts.length) * 100));
      }
      setHebrewResults(applyTranslations(run.results, paths, allTranslations));
      setIsHebrew(true);
    } catch (e) {
      alert('Could not translate: ' + e.message);
    }
    setTranslating(false);
    setTranslateProgress(0);
  }

  async function handleCopyResult() {
    const text = buildShareText({ name: scheduleCountry }, dateLabel, displayResults, false);
    await navigator.clipboard?.writeText(text);
    setResultCopied(true);
    setTimeout(() => setResultCopied(false), 2500);
  }

  async function handleShareResult() {
    const text = buildShareText({ name: scheduleCountry }, dateLabel, displayResults, false);
    const title = `Roy News — ${scheduleCountry} · ${formatDateLabelDMY(dateLabel)}`;
    if (navigator.share) {
      navigator.share({ title, text }).catch(() => {});
    } else {
      await navigator.clipboard?.writeText(text);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2500);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 640, width: '100%', maxHeight: '85vh', overflowY: 'auto', padding: 20 }} onClick={e => e.stopPropagation()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{formatDateLabelDMY(dateLabel)}</div>
          <button onClick={onDelete} style={{ ...SMALL_BTN, color: '#f87171', borderColor: '#7f1d1d', fontSize: 11 }}>
            🗑️ Delete report
          </button>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: 20 }}>×</button>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={handleTranslate} disabled={translating}
          style={{ ...SMALL_BTN, background: isHebrew ? '#1e3a5f' : C.card, borderColor: isHebrew ? '#3b82f6' : C.border, fontWeight: isHebrew ? 700 : 400, minWidth: 130 }}>
          {translating
            ? <><Spinner size={12} /> &nbsp;{translateProgress > 0 ? `${translateProgress}%` : 'Starting…'}</>
            : isHebrew ? '🇮🇱 עברית ON' : '🇮🇱 Translate to עב'}
        </button>
        <button onClick={handleCopyResult} style={SMALL_BTN}>{resultCopied ? '✓ Copied!' : '📋 Copy Result'}</button>
        <button onClick={handleShareResult} style={SMALL_BTN}>{shareCopied ? '✓ Shared!' : '🔗 Share Result'}</button>
      </div>

      <div style={{ fontSize: 11, color: C.faint, marginBottom: 14 }}>
        ${(run.costUsd || 0).toFixed(4)} · {run.provider}/{run.model} · {run.inputTokens}+{run.outputTokens} tokens
      </div>
      {Object.values(displayResults || {})
        .sort((a, b) => compareByMatchScore(topicMatchScore(a.analysis, a.relevantCount), topicMatchScore(b.analysis, b.relevantCount)))
        .map((r, i) => (
        <div key={i} style={{ marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid ' + C.border }}>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 13, color: C.text }}>{r.source.name}</span>
            <LeanBadge lean={r.source.lean} />
            <span style={{ fontSize: 11, color: C.faint }}>{r.articleCount} scanned · {r.relevantCount ?? 0} kept</span>
            <SourceInfoToggle source={r.source} />
          </div>
          {groupTopicAnalyses(r.analysis?.topicAnalyses).map((ta, j) => <TopicCard key={j} analysis={ta} />)}
        </div>
      ))}
    </div>
  );
}

function ScheduledRunView(props) {
  return Array.isArray(props.run.days) ? <RawScheduledRunView {...props} /> : <LegacyScheduledRunView {...props} />;
}

function ScheduledReportsPanel({ user, countries, defaultOpen = false }) {
  const uid = user?.uid;
  const [confirm, confirmDialog] = useConfirm();
  const [open, setOpen] = useState(defaultOpen);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const [newCountryKey, setNewCountryKey] = useState('');
  const [newSourceIds, setNewSourceIds] = useState(new Set());
  const [newTopics, setNewTopics] = useState('');
  const [newContextTopics, setNewContextTopics] = useState(new Set());
  const [newSearchScope, setNewSearchScope] = useState('global');
  const [newWeeklyDay, setNewWeeklyDay] = useState('monday');
  const [newHourUtc, setNewHourUtc] = useState(6);
  const [newWeeklySummaryWords, setNewWeeklySummaryWords] = useState(300);
  const [newSendDailyEmail, setNewSendDailyEmail] = useState(false);
  const [newSendWeeklyEmail, setNewSendWeeklyEmail] = useState(false);
  const [newEmailRecipients, setNewEmailRecipients] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [estimating, setEstimating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState('');

  const [sharedInfoId, setSharedInfoId] = useState(null);
  // All schedules' report history is auto-expanded and eager-loaded on open
  // (see loadSchedules) — no clicking through each country one at a time.
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [runsByScheduleId, setRunsByScheduleId] = useState({});
  const [viewingRun, setViewingRun] = useState(null); // { scheduleId, run }
  const [viewingRunLoadingId, setViewingRunLoadingId] = useState(null); // runId currently being opened
  const [busyId, setBusyId] = useState(null);
  const [sendingNowId, setSendingNowId] = useState(null); // `${scheduleId}:${type}` currently sending
  const [sendNowMsg, setSendNowMsg] = useState({}); // scheduleId -> status message

  const [sourcesExpandedId, setSourcesExpandedId] = useState(null);
  // Fetched fresh (not from the once-at-load `countries` prop) whenever a
  // schedule's Sources section is opened or edit started, so a feed fixed on
  // the Sources page shows up here without needing a full app reload, and so
  // we can show each source's poll history (item count / last refreshed).
  const [liveSources, setLiveSources] = useState({}); // countryKey -> sources[]
  const [archiveMeta, setArchiveMeta] = useState({}); // countryKey -> { [sourceId]: { lastPolledAt, articleCount } }
  const [metaLoading, setMetaLoading] = useState(null);

  // Sharing — owner-only. "read" can view the schedule and its reports;
  // "write" can also edit/pause/delete it, same two-level model as Buli lists.
  const [sharingId, setSharingId] = useState(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shareLevel, setShareLevel] = useState('read');
  const [sharingBusy, setSharingBusy] = useState(false);
  const [shareMsg, setShareMsg] = useState('');

  // Full edit mode — mirrors every field the "New Schedule" form sets, so
  // whatever you could configure at creation you can also change later,
  // including swapping sources via the same SourceManager used in country
  // setup (find-by-name, AI "add more" with filters, remove) instead of a
  // plain dropdown limited to already-verified, not-yet-used sources.
  const [editingId, setEditingId] = useState(null);
  const [editTopics, setEditTopics] = useState('');
  const [editContextTopics, setEditContextTopics] = useState(new Set());
  const [editSearchScope, setEditSearchScope] = useState('global');
  const [editWeeklyDay, setEditWeeklyDay] = useState('monday');
  const [editHourUtc, setEditHourUtc] = useState(6);
  const [editWeeklySummaryWords, setEditWeeklySummaryWords] = useState(300);
  const [editSendDailyEmail, setEditSendDailyEmail] = useState(false);
  const [editSendWeeklyEmail, setEditSendWeeklyEmail] = useState(false);
  const [editEmailRecipients, setEditEmailRecipients] = useState('');
  const [editSelected, setEditSelected] = useState(new Set());
  const [savingEdit, setSavingEdit] = useState(false);

  // When used as its own page (not a collapsible Settings section), start
  // already open and load immediately instead of waiting for a toggle tap.
  useEffect(() => { if (defaultOpen) loadSchedules(); }, []);

  const selectedCountry = countries.find(c => c.countryKey === newCountryKey) || null;

  function scheduleCountry(s) {
    return countries.find(c => c.countryKey === s.countryKey) || null;
  }

  function sourcesForCountry(countryKey) {
    return liveSources[countryKey] || scheduleCountry({ countryKey })?.sources || [];
  }

  async function loadCountrySourcesLive(countryKey) {
    setMetaLoading(countryKey);
    try {
      const [srcSnap, metaSnap] = await Promise.all([
        db.ref(`countries/${countryKey}/setup/sources`).once('value'),
        db.ref(`articleArchiveMeta/${countryKey}`).once('value')
      ]);
      setLiveSources(prev => ({ ...prev, [countryKey]: srcSnap.val() || [] }));
      setArchiveMeta(prev => ({ ...prev, [countryKey]: metaSnap.val() || {} }));
    } catch {}
    setMetaLoading(null);
  }

  function startEdit(s) {
    setEditingId(s.id);
    setEditTopics(s.topics.join(', '));
    setEditContextTopics(new Set(s.contextTopics || []));
    setEditSearchScope(s.searchScope === 'domestic' ? 'domestic' : 'global');
    setEditWeeklyDay(s.weeklyDay || 'monday');
    setEditHourUtc(s.hourUtc);
    setEditWeeklySummaryWords(s.weeklySummaryWords || 300);
    setEditSendDailyEmail(!!s.sendDailyEmail);
    setEditSendWeeklyEmail(!!s.sendWeeklyEmail);
    setEditEmailRecipients((s.emailRecipients || []).join(', '));
    setEditSelected(new Set(s.sourceIds));
    loadCountrySourcesLive(s.countryKey);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function editTopicsArray() {
    return editTopics.split(',').map(t => t.trim()).filter(Boolean);
  }

  async function saveEdit(schedule) {
    const topics = editTopicsArray();
    if (topics.length === 0) { alert('At least one topic is required.'); return; }
    if (editSelected.size === 0) { alert('At least one source is required.'); return; }
    const fields = {
      topics, contextTopics: topics.filter(t => editContextTopics.has(t)), searchScope: editSearchScope,
      weeklyDay: editWeeklyDay, hourUtc: editHourUtc, weeklySummaryWords: editWeeklySummaryWords,
      sendDailyEmail: editSendDailyEmail, sendWeeklyEmail: editSendWeeklyEmail,
      emailRecipients: editEmailRecipients.split(/[,\n]/).map(e => e.trim()).filter(Boolean),
      sourceIds: [...editSelected]
    };
    setSavingEdit(true);
    try {
      await fns.httpsCallable('updateSchedule')({ scheduleId: schedule.id, ...fields });
      setSchedules(prev => prev.map(x => x.id === schedule.id ? { ...x, ...fields } : x));
      setEditingId(null);
    } catch (e) {
      alert('Could not save changes: ' + e.message);
    }
    setSavingEdit(false);
  }

  async function loadSchedules() {
    setLoading(true);
    try {
      const resp = await fns.httpsCallable('listSchedules')({});
      const list = resp.data.schedules || [];
      setSchedules(list);
      // Auto-expand every schedule's report history and eager-load it —
      // "open all countries and expand their report automatically."
      setExpandedIds(new Set(list.map(s => s.id)));
      list.forEach(s => {
        fns.httpsCallable('listReportRuns')({ scheduleId: s.id }).then(r => {
          setRunsByScheduleId(prev => ({ ...prev, [s.id]: r.data.runs || [] }));
        }).catch(() => {});
      });
    } catch {}
    setLoading(false);
  }

  function toggleSource(id) {
    setNewSourceIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    setEstimate(null);
  }

  function topicsArray() {
    return newTopics.split(',').map(t => t.trim()).filter(Boolean);
  }

  async function handleEstimate() {
    const topics = topicsArray();
    if (newSourceIds.size === 0 || topics.length === 0) return;
    setEstimating(true);
    try {
      const aiSettings = await getAISettings(uid);
      const resp = await fns.httpsCallable('estimateScheduleCost')({
        sourceIds: [...newSourceIds], topics, contextTopics: topics.filter(t => newContextTopics.has(t)),
        ...aiSettings
      });
      setEstimate(resp.data);
    } catch (e) {
      setEstimate({ error: e.message });
    }
    setEstimating(false);
  }

  async function handleCreate() {
    const topics = topicsArray();
    if (!selectedCountry || newSourceIds.size === 0 || topics.length === 0) return;
    setCreating(true);
    setCreateMsg('');
    try {
      await fns.httpsCallable('createSchedule')({
        country: selectedCountry.country, countryKey: selectedCountry.countryKey,
        sourceIds: [...newSourceIds], topics, contextTopics: topics.filter(t => newContextTopics.has(t)), searchScope: newSearchScope,
        weeklyDay: newWeeklyDay, hourUtc: newHourUtc, weeklySummaryWords: newWeeklySummaryWords,
        sendDailyEmail: newSendDailyEmail, sendWeeklyEmail: newSendWeeklyEmail,
        emailRecipients: newEmailRecipients.split(/[,\n]/).map(e => e.trim()).filter(Boolean)
      });
      setCreateMsg('✓ Schedule created');
      setShowCreate(false);
      setNewCountryKey(''); setNewSourceIds(new Set()); setNewTopics(''); setNewContextTopics(new Set()); setNewSearchScope('global'); setEstimate(null);
      setNewSendDailyEmail(false); setNewSendWeeklyEmail(false); setNewEmailRecipients(''); setNewWeeklySummaryWords(300);
      await loadSchedules();
    } catch (e) {
      setCreateMsg('⚠ ' + e.message);
    }
    setCreating(false);
  }

  async function toggleEnabled(schedule) {
    setBusyId(schedule.id);
    try {
      await fns.httpsCallable('updateSchedule')({ scheduleId: schedule.id, enabled: !schedule.enabled });
      setSchedules(prev => prev.map(s => s.id === schedule.id ? { ...s, enabled: !s.enabled } : s));
    } catch (e) {
      alert('Could not update schedule: ' + e.message);
    }
    setBusyId(null);
  }

  // Manual test/trigger — sends whatever the latest report of that type
  // already contains (or, for weekly with none yet, builds one on the spot
  // from existing daily history) regardless of the schedule's own
  // sendDailyEmail/sendWeeklyEmail toggles.
  async function handleSendNow(schedule, type) {
    const key = `${schedule.id}:${type}`;
    setSendingNowId(key);
    setSendNowMsg(prev => ({ ...prev, [schedule.id]: '' }));
    try {
      const resp = await fns.httpsCallable('sendReportEmailNow')({ scheduleId: schedule.id, type });
      setSendNowMsg(prev => ({ ...prev, [schedule.id]: `✓ Sent ${type} report (${formatDateLabelDMY(resp.data.dateLabel)}) to ${(schedule.emailRecipients || []).join(', ')}` }));
    } catch (e) {
      setSendNowMsg(prev => ({ ...prev, [schedule.id]: '⚠ ' + e.message }));
    }
    setSendingNowId(null);
    setTimeout(() => setSendNowMsg(prev => ({ ...prev, [schedule.id]: '' })), 6000);
  }

  function handleDelete(schedule) {
    const topicsPart = schedule.topics?.length ? ` (${schedule.topics.join(', ')})` : '';
    confirm({
      message: `Delete this schedule for ${schedule.country}? Its entire report history will be removed too — Period Analysis will lose all real archived grounding for these topics${topicsPart} and fall back to general knowledge alone for any date this schedule covered.`,
      onConfirm: async () => {
        setBusyId(schedule.id);
        try {
          await fns.httpsCallable('deleteSchedule')({ scheduleId: schedule.id });
          setSchedules(prev => prev.filter(s => s.id !== schedule.id));
        } catch (e) {
          alert('Could not delete schedule: ' + e.message);
        }
        setBusyId(null);
      }
    });
  }

  function startShare(schedule) {
    setSharingId(sharingId === schedule.id ? null : schedule.id);
    setShareEmail(''); setShareLevel('read'); setShareMsg('');
  }

  async function handleAddShare(schedule) {
    const email = shareEmail.trim();
    if (!email) return;
    setSharingBusy(true);
    setShareMsg('');
    try {
      await fns.httpsCallable('shareSchedule')({ scheduleId: schedule.id, email, level: shareLevel });
      await loadSchedules();
      setShareEmail('');
      setShareMsg('✓ Shared');
    } catch (e) {
      setShareMsg('⚠ ' + e.message);
    }
    setSharingBusy(false);
  }

  async function handleRemoveShare(schedule, uid) {
    setSharingBusy(true);
    try {
      const entry = schedule.sharedWith?.[uid];
      await fns.httpsCallable('shareSchedule')({ scheduleId: schedule.id, email: entry?.email, level: null });
      await loadSchedules();
    } catch (e) {
      alert('Could not remove access: ' + e.message);
    }
    setSharingBusy(false);
  }

  async function toggleExpand(schedule) {
    setExpandedIds(prev => {
      const n = new Set(prev);
      n.has(schedule.id) ? n.delete(schedule.id) : n.add(schedule.id);
      return n;
    });
    if (!runsByScheduleId[schedule.id]) {
      try {
        const resp = await fns.httpsCallable('listReportRuns')({ scheduleId: schedule.id });
        setRunsByScheduleId(prev => ({ ...prev, [schedule.id]: resp.data.runs || [] }));
      } catch {}
    }
  }

  async function viewRun(scheduleId, runId) {
    setViewingRunLoadingId(runId);
    try {
      const resp = await fns.httpsCallable('getReportRun')({ scheduleId, runId });
      setViewingRun({ scheduleId, runId, run: resp.data.run });
      // Per-user read state — users/{uid} is already self-writable, so this
      // goes straight to the DB rather than through a callable. Propagates
      // up to the schedule-level and (via App's own listSchedules fetch)
      // home-page badges by recomputing hasUnread from what's now known
      // locally, instead of waiting on a full server round-trip.
      if (uid) {
        db.ref(`users/${uid}/readReports/${scheduleId}/${runId}`).set(true).catch(() => {});
        const currentList = runsByScheduleId[scheduleId] || [];
        const updatedList = currentList.map(r => r.runId === runId ? { ...r, read: true } : r);
        const stillUnread = updatedList.some(r => r.status !== 'error' && !r.read && r.relevantTotal > 0);
        setRunsByScheduleId(prev => ({ ...prev, [scheduleId]: updatedList }));
        setSchedules(prev => prev.map(s => s.id === scheduleId ? { ...s, hasUnread: stillUnread } : s));
      }
    } catch (e) {
      alert('Could not load report: ' + e.message);
    }
    setViewingRunLoadingId(null);
  }

  // Deliberately placed inside the report detail view, not the list row —
  // a delete button in a scrollable list is one accidental tap away from
  // destroying history; requiring "open it, then delete" is the friction
  // that prevents that.
  function handleDeleteRun(scheduleId, runId, dateLabel) {
    const schedule = schedules.find(s => s.id === scheduleId);
    const topicsPart = schedule?.topics?.length ? ` on ${schedule.topics.join(', ')}` : '';
    const datePart = dateLabel ? ` for ${formatDateLabelDMY(dateLabel)}` : ' for that date';
    confirm({
      title: 'Delete this report?',
      message: `This permanently removes this one report from the schedule's history. Period Analysis will no longer be able to ground itself in real archived coverage${topicsPart}${datePart} — it'll fall back to general knowledge alone for it.`,
      onConfirm: async () => {
        try {
          await fns.httpsCallable('deleteReportRun')({ scheduleId, runId });
          setRunsByScheduleId(prev => ({ ...prev, [scheduleId]: (prev[scheduleId] || []).filter(r => r.runId !== runId) }));
          setViewingRun(null);
        } catch (e) {
          alert('Could not delete report: ' + e.message);
        }
      }
    });
  }

  function scheduleTopicsLabel(s) {
    const contextSet = new Set(s.contextTopics || []);
    const label = s.topics.map(t => contextSet.has(t) ? `${t}🧭` : t).join(', ');
    return s.searchScope === 'domestic' ? `${label} · 🏠 domestic` : label;
  }

  function scheduleSummary(s) {
    const weeklyDayLabel = s.weeklyDay ? s.weeklyDay.slice(0, 3) : 'Mon';
    return `Daily ${String(s.hourUtc).padStart(2, '0')}:00 UTC · Weekly digest ${weeklyDayLabel} · ${s.sourceIds.length} src`;
  }

  return (
    <div style={{ marginBottom: 28 }}>
      <button
        onClick={() => { setOpen(o => { if (!o) loadSchedules(); return !o; }); }}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '12px 14px', background: open ? C.card : '#0f1e35', border: '1px solid ' + (open ? C.borderLight : C.border), borderRadius: 9, cursor: 'pointer', color: C.text }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 16 }}>🗓️</span>
          <div style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Scheduled Reports</div>
            <div style={{ fontSize: 11, color: C.faint, marginTop: 1 }}>Recurring daily/weekly topic digests, built from a continuously-archived feed</div>
          </div>
        </div>
        <span style={{ color: C.faint, fontSize: 12 }}>{open ? '▲ Hide' : '▼ Show'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 20 }}><Spinner /></div>
          ) : (
            <div style={{ padding: 14, background: C.card, borderRadius: 9, border: '1px solid ' + C.border }}>

              {schedules.length === 0 && !showCreate && (
                <div style={{ color: C.faint, fontSize: 12, padding: '4px 10px 12px' }}>No scheduled reports yet</div>
              )}

              {schedules.map(s => (
                <div key={s.id} style={{ padding: '10px 12px', background: '#0f1e35', borderRadius: 7, marginBottom: 8, border: '1px solid ' + C.border }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        {s.hasUnread && <span title="Has unread reports" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0 }} />}
                        <span style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{s.country}</span>
                        {s.access !== 'owner' && (
                          <button onClick={() => setSharedInfoId(sharedInfoId === s.id ? null : s.id)} title="Sharing info"
                            style={{ background: 'none', border: 'none', color: sharedInfoId === s.id ? '#60a5fa' : C.faint, cursor: 'pointer', fontSize: 12, padding: 0, lineHeight: 1 }}>👥ℹ️</button>
                        )}
                      </div>
                      {s.access !== 'owner' && sharedInfoId === s.id && (
                        <div style={{ fontSize: 11, color: C.faint, marginTop: 3, padding: '5px 8px', background: C.bg, borderRadius: 5 }}>
                          {s.access === 'write' ? 'Shared with you · can edit' : 'Shared with you · view only'}<br/>
                          Owned by {s.createdByEmail}
                        </div>
                      )}
                      <div style={{ fontSize: 12, color: C.text, fontWeight: 600, marginTop: 4, lineHeight: 1.4 }}>{scheduleTopicsLabel(s)}</div>
                      <div style={{ fontSize: 11, color: C.faint, marginTop: 2, lineHeight: 1.5 }}>{scheduleSummary(s)}</div>
                      <div style={{ fontSize: 11, color: s.lastRunStatus === 'error' ? '#f87171' : C.faint, marginTop: 1 }}>
                        {s.lastRunAt ? `${s.lastRunStatus === 'ok' ? '✓' : '⚠'} ${formatDMYTime(s.lastRunAt)}` : 'Never run yet'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 120 }}>
                      {s.access !== 'read' && (
                        <button onClick={() => toggleEnabled(s)} disabled={busyId === s.id}
                          style={{ ...SMALL_BTN, color: s.enabled ? '#4ade80' : C.faint, borderColor: s.enabled ? '#14532d' : C.border, fontSize: 10, padding: '5px 8px' }}>
                          {s.enabled ? '● On' : '○ Off'}
                        </button>
                      )}
                      {s.access !== 'read' && (
                        <button onClick={() => editingId === s.id ? cancelEdit() : startEdit(s)} disabled={busyId === s.id}
                          style={{ ...SMALL_BTN, color: editingId === s.id ? '#60a5fa' : C.faint, borderColor: editingId === s.id ? '#1e4a6e' : C.border, fontSize: 10, padding: '5px 8px' }}>
                          ✎ Edit
                        </button>
                      )}
                      {s.access === 'owner' && (
                        <button onClick={() => startShare(s)} disabled={busyId === s.id}
                          style={{ ...SMALL_BTN, color: sharingId === s.id ? '#60a5fa' : C.faint, borderColor: sharingId === s.id ? '#1e4a6e' : C.border, fontSize: 10, padding: '5px 8px' }}>
                          👥
                        </button>
                      )}
                      {s.access !== 'read' && (
                        <button onClick={() => handleDelete(s)} disabled={busyId === s.id}
                          style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 18, padding: '0 2px', opacity: 0.7 }}>×</button>
                      )}
                    </div>
                  </div>

                  {sharingId === s.id && (
                    <div style={{ marginTop: 10, padding: 12, background: '#0a1626', borderRadius: 7, border: '1px solid ' + C.border }}>
                      <div style={{ fontSize: 11, color: C.faint, marginBottom: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Shared with</div>
                      {Object.keys(s.sharedWith || {}).length === 0 ? (
                        <div style={{ color: C.faint, fontSize: 12, marginBottom: 10 }}>Not shared with anyone yet</div>
                      ) : Object.entries(s.sharedWith).map(([uid, entry]) => (
                        <div key={uid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px', background: C.bg, borderRadius: 6, marginBottom: 5, fontSize: 12 }}>
                          <span style={{ color: C.text }}>{entry.email}</span>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: entry.level === 'write' ? '#60a5fa' : C.faint, textTransform: 'uppercase' }}>{entry.level}</span>
                            <button onClick={() => handleRemoveShare(s, uid)} disabled={sharingBusy}
                              style={{ ...SMALL_BTN, color: '#f87171', borderColor: '#7f1d1d', padding: '2px 8px', fontSize: 10 }}>Remove</button>
                          </div>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                        <input type="email" value={shareEmail} onChange={e => setShareEmail(e.target.value)}
                          placeholder="name@example.com" className="input-field" style={{ flex: 1, fontSize: 12 }}
                          onKeyDown={e => { if (e.key === 'Enter') handleAddShare(s); }} />
                        <select value={shareLevel} onChange={e => setShareLevel(e.target.value)} className="input-field" style={{ fontSize: 12, width: 90 }}>
                          <option value="read">Read</option>
                          <option value="write">Write</option>
                        </select>
                        <button onClick={() => handleAddShare(s)} disabled={!shareEmail.trim() || sharingBusy}
                          style={{ ...BTN('#2563eb'), fontSize: 12, padding: '7px 14px', opacity: (!shareEmail.trim() || sharingBusy) ? 0.5 : 1 }}>
                          {sharingBusy ? <Spinner size={10} /> : 'Add'}
                        </button>
                      </div>
                      {shareMsg && <div style={{ fontSize: 11, color: shareMsg.startsWith('✓') ? '#4ade80' : '#f87171', marginTop: 8 }}>{shareMsg}</div>}
                    </div>
                  )}

                  {editingId === s.id ? (
                    <div style={{ marginTop: 10, padding: 12, background: '#0a1626', borderRadius: 7, border: '1px solid ' + C.border }}>
                      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Topics (comma-separated)</label>
                      <input className="input-field" value={editTopics} onChange={e => setEditTopics(e.target.value)}
                        placeholder="Israel, Gaza" style={{ fontSize: 13, marginBottom: 6, width: '100%' }} />
                      <TopicModeChips topics={editTopicsArray()} contextSet={editContextTopics}
                        onToggle={t => setEditContextTopics(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; })} />
                      <SearchScopeToggle value={editSearchScope} onChange={setEditSearchScope} />

                      <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Weekly digest day</label>
                          <select value={editWeeklyDay} onChange={e => setEditWeeklyDay(e.target.value)} className="input-field" style={{ fontSize: 13, width: '100%' }}>
                            {WEEKDAY_OPTIONS.map(d => <option key={d} value={d}>{d[0].toUpperCase()}{d.slice(1)}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Run time (UTC)</label>
                          <select value={editHourUtc} onChange={e => setEditHourUtc(parseInt(e.target.value))} className="input-field" style={{ fontSize: 13, width: '100%' }}>
                            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Weekly summary (words)</label>
                          <input type="number" min="50" max="1000" value={editWeeklySummaryWords}
                            onChange={e => setEditWeeklySummaryWords(parseInt(e.target.value) || 300)}
                            className="input-field" style={{ fontSize: 13, width: '100%' }} />
                        </div>
                      </div>

                      <div style={{ marginBottom: 14, padding: '10px 12px', background: C.bg, borderRadius: 7, border: '1px solid ' + C.border }}>
                        <label style={{ fontSize: 12, color: C.text, fontWeight: 600, display: 'block', marginBottom: 8 }}>📧 Send by email</label>
                        <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
                            <input type="checkbox" checked={editSendDailyEmail} onChange={e => setEditSendDailyEmail(e.target.checked)} /> Daily
                          </label>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
                            <input type="checkbox" checked={editSendWeeklyEmail} onChange={e => setEditSendWeeklyEmail(e.target.checked)} /> Weekly
                          </label>
                        </div>
                        {(editSendDailyEmail || editSendWeeklyEmail) && (
                          <textarea value={editEmailRecipients} onChange={e => setEditEmailRecipients(e.target.value)}
                            placeholder="email1@example.com, email2@example.com"
                            className="input-field" style={{ fontSize: 12, width: '100%', minHeight: 50, resize: 'vertical' }} />
                        )}
                      </div>

                      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Sources ({editSelected.size} selected)</label>
                      {metaLoading === s.countryKey ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}><Spinner size={14} /></div>
                      ) : (
                        <SourceManager
                          country={{ name: s.country, key: s.countryKey }}
                          user={user}
                          sources={sourcesForCountry(s.countryKey)}
                          onSourcesChange={newSrcs => setLiveSources(prev => ({ ...prev, [s.countryKey]: newSrcs }))}
                          selectable={true}
                          selected={editSelected}
                          onSelectionChange={setEditSelected}
                        />
                      )}

                      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                        <button onClick={cancelEdit} disabled={savingEdit} style={{ ...SMALL_BTN, fontSize: 13 }}>Cancel</button>
                        <button onClick={() => saveEdit(s)} disabled={savingEdit}
                          style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px', flex: 1, opacity: savingEdit ? 0.5 : 1 }}>
                          {savingEdit ? <><Spinner size={10} />&nbsp;Saving…</> : 'Save Changes'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button onClick={() => {
                        const next = sourcesExpandedId === s.id ? null : s.id;
                        setSourcesExpandedId(next);
                        if (next) loadCountrySourcesLive(s.countryKey);
                      }} style={{ background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: 11, padding: '8px 0 0', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span>{sourcesExpandedId === s.id ? '▾' : '▸'}</span><span>Sources ({s.sourceIds.length})</span>
                      </button>
                      {sourcesExpandedId === s.id && (() => {
                        if (metaLoading === s.countryKey) {
                          return <div style={{ display: 'flex', justifyContent: 'center', padding: 10 }}><Spinner size={14} /></div>;
                        }
                        const allSources = sourcesForCountry(s.countryKey);
                        const byId = new Map(allSources.map(src => [src.id, src]));
                        const meta = archiveMeta[s.countryKey] || {};
                        return (
                          <div style={{ marginTop: 8 }}>
                            {s.sourceIds.map(id => {
                              const src = byId.get(id);
                              const m = meta[id];
                              return (
                                <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '6px 8px', background: C.bg, borderRadius: 6, marginBottom: 5, fontSize: 11 }}>
                                  <span style={{ color: C.text }}>{src ? src.name : `(removed source: ${id})`}</span>
                                  {src && (src.rssUrl
                                    ? <span style={{ color: '#4ade80' }}>✓ feed ok</span>
                                    : <span style={{ color: '#fb923c' }}>⚠ no feed</span>)}
                                  {!src && <span style={{ color: '#f87171' }}>⚠ no longer in source list</span>}
                                  {m ? (
                                    <span style={{ color: C.faint }}>{m.articleCount} item{m.articleCount !== 1 ? 's' : ''} · refreshed {new Date(m.lastPolledAt).toLocaleString()}</span>
                                  ) : src?.rssUrl ? (
                                    <span style={{ color: C.faint }}>not polled yet</span>
                                  ) : null}
                                </div>
                              );
                            })}
                            {s.access !== 'read' && (
                              <button onClick={() => startEdit(s)} style={{ ...SMALL_BTN, fontSize: 11, marginTop: 4 }}>✎ Edit sources</button>
                            )}
                          </div>
                        );
                      })()}
                    </>
                  )}

                  {s.access !== 'read' && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      <button onClick={() => handleSendNow(s, 'daily')} disabled={sendingNowId === `${s.id}:daily`}
                        title="Send whatever the latest daily report contains, right now — a way to test delivery"
                        style={{ ...SMALL_BTN, fontSize: 10, padding: '4px 8px' }}>
                        {sendingNowId === `${s.id}:daily` ? <><Spinner size={9} />&nbsp;Sending…</> : '📧 Send Now · Daily'}
                      </button>
                      <button onClick={() => handleSendNow(s, 'weekly')} disabled={sendingNowId === `${s.id}:weekly`}
                        title="Send the latest weekly digest, building one from existing daily reports if none exists yet"
                        style={{ ...SMALL_BTN, fontSize: 10, padding: '4px 8px' }}>
                        {sendingNowId === `${s.id}:weekly` ? <><Spinner size={9} />&nbsp;Sending…</> : '📧 Send Now · Weekly'}
                      </button>
                    </div>
                  )}
                  {sendNowMsg[s.id] && (
                    <div style={{ fontSize: 11, color: sendNowMsg[s.id].startsWith('✓') ? '#4ade80' : '#f87171', marginTop: 4 }}>{sendNowMsg[s.id]}</div>
                  )}

                  <button onClick={() => toggleExpand(s)}
                    style={{ background: 'none', border: 'none', color: C.faint, cursor: 'pointer', fontSize: 11, padding: '8px 0 0', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span>{expandedIds.has(s.id) ? '▾' : '▸'}</span><span>Report history</span>
                  </button>
                  {expandedIds.has(s.id) && (
                    <div style={{ marginTop: 8 }}>
                      {!(s.id in runsByScheduleId) ? (
                        <div style={{ display: 'flex', justifyContent: 'center', padding: 12 }}><Spinner size={14} /></div>
                      ) : (runsByScheduleId[s.id] || []).length === 0 ? (
                        <div style={{ color: C.faint, fontSize: 11, padding: '4px 0' }}>No reports generated yet</div>
                      ) : (runsByScheduleId[s.id] || []).map(r => (
                        <div key={r.runId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px', background: C.bg, borderRadius: 6, marginBottom: 5, fontSize: 11 }}>
                          <div style={{ minWidth: 0 }}>
                            {!r.read && r.relevantTotal > 0 && <span title="Unread" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: '#3b82f6', marginRight: 6 }} />}
                            <span style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3, color: r.runType === 'weekly' ? '#a78bfa' : '#60a5fa', border: '1px solid ' + (r.runType === 'weekly' ? '#4c1d95' : '#1e3a5f'), borderRadius: 4, padding: '1px 5px', marginRight: 6 }}>
                              {r.runType === 'weekly' ? 'Weekly' : 'Daily'}
                            </span>
                            <span style={{ color: C.text }}>{formatDateLabelDMY(r.dateLabel)}</span>
                            <span style={{ color: r.status === 'error' ? '#f87171' : C.faint, marginLeft: 8 }}>
                              {r.status === 'error' ? '⚠ failed' : `$${r.costUsd.toFixed(4)} · ${r.sourceCount} sources`}
                            </span>
                          </div>
                          {r.status !== 'error' && (
                            <button onClick={() => viewRun(s.id, r.runId)} disabled={viewingRunLoadingId === r.runId} title={r.relevantTotal > 0 ? `${r.relevantTotal} matched article${r.relevantTotal !== 1 ? 's' : ''}` : 'No matches found'}
                              style={{ ...SMALL_BTN, fontSize: 10, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, color: r.relevantTotal > 0 ? '#4ade80' : C.faint, borderColor: r.relevantTotal > 0 ? '#14532d' : C.border }}>
                              {viewingRunLoadingId === r.runId
                                ? <><Spinner size={10} />&nbsp;View</>
                                : (r.relevantTotal > 0 ? '● View' : '○ View')}
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              {!showCreate ? (
                <button onClick={() => setShowCreate(true)} style={{ ...BTN('#2563eb'), fontSize: 13, padding: '8px 16px', width: '100%' }}>+ New Schedule</button>
              ) : (
                <div style={{ marginTop: schedules.length > 0 ? 10 : 0, padding: 12, background: '#0f1e35', borderRadius: 7, border: '1px solid ' + C.border }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 10 }}>New Schedule</div>

                  <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Country</label>
                  <select value={newCountryKey} onChange={e => { setNewCountryKey(e.target.value); setNewSourceIds(new Set()); setEstimate(null); }}
                    className="input-field" style={{ fontSize: 13, marginBottom: 10, width: '100%' }}>
                    <option value="">Select a country…</option>
                    {countries.map(c => <option key={c.countryKey} value={c.countryKey}>{c.country}</option>)}
                  </select>

                  {selectedCountry && (
                    <>
                      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Sources</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10, maxHeight: 160, overflowY: 'auto', padding: 6, background: C.bg, borderRadius: 6 }}>
                        {selectedCountry.sources.filter(s => s.rssUrl).length === 0 ? (
                          <div style={{ color: C.faint, fontSize: 11 }}>No sources with a working feed in this country yet</div>
                        ) : selectedCountry.sources.filter(s => s.rssUrl).map(s => (
                          <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.text, cursor: 'pointer' }}>
                            <input type="checkbox" checked={newSourceIds.has(s.id)} onChange={() => toggleSource(s.id)} />
                            {s.name}
                          </label>
                        ))}
                      </div>
                    </>
                  )}

                  <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Topics (comma-separated)</label>
                  <input className="input-field" value={newTopics} onChange={e => { setNewTopics(e.target.value); setEstimate(null); }}
                    placeholder="Israel, Gaza" style={{ fontSize: 13, marginBottom: 6, width: '100%' }} />
                  <TopicModeChips topics={topicsArray()} contextSet={newContextTopics}
                    onToggle={t => { setNewContextTopics(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; }); setEstimate(null); }} />
                  <SearchScopeToggle value={newSearchScope} onChange={setNewSearchScope} />

                  <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>
                    Every schedule archives and builds a daily report automatically. A weekly digest — the same days bundled together — also builds on the day below.
                  </div>

                  <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Weekly digest day</label>
                      <select value={newWeeklyDay} onChange={e => setNewWeeklyDay(e.target.value)} className="input-field" style={{ fontSize: 13, width: '100%' }}>
                        {WEEKDAY_OPTIONS.map(d => <option key={d} value={d}>{d[0].toUpperCase()}{d.slice(1)}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Run time (UTC)</label>
                      <select value={newHourUtc} onChange={e => setNewHourUtc(parseInt(e.target.value))} className="input-field" style={{ fontSize: 13, width: '100%' }}>
                        {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={{ display: 'block', fontSize: 11, color: C.faint, marginBottom: 4 }}>Weekly summary (words)</label>
                      <input type="number" min="50" max="1000" value={newWeeklySummaryWords}
                        onChange={e => setNewWeeklySummaryWords(parseInt(e.target.value) || 300)}
                        className="input-field" style={{ fontSize: 13, width: '100%' }} />
                    </div>
                  </div>

                  <div style={{ marginBottom: 12, padding: '10px 12px', background: C.bg, borderRadius: 7, border: '1px solid ' + C.border }}>
                    <label style={{ fontSize: 12, color: C.text, fontWeight: 600, display: 'block', marginBottom: 8 }}>📧 Send by email</label>
                    <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
                        <input type="checkbox" checked={newSendDailyEmail} onChange={e => setNewSendDailyEmail(e.target.checked)} /> Daily
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: C.muted, cursor: 'pointer' }}>
                        <input type="checkbox" checked={newSendWeeklyEmail} onChange={e => setNewSendWeeklyEmail(e.target.checked)} /> Weekly
                      </label>
                    </div>
                    {(newSendDailyEmail || newSendWeeklyEmail) && (
                      <textarea value={newEmailRecipients} onChange={e => setNewEmailRecipients(e.target.value)}
                        placeholder="email1@example.com, email2@example.com"
                        className="input-field" style={{ fontSize: 12, width: '100%', minHeight: 50, resize: 'vertical' }} />
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                    <button onClick={handleEstimate} disabled={estimating || newSourceIds.size === 0 || topicsArray().length === 0} style={{ ...SMALL_BTN, fontSize: 12 }}>
                      {estimating ? <><Spinner size={10} />&nbsp;Estimating…</> : '💰 Estimate Cost'}
                    </button>
                    {estimate && !estimate.error && (
                      <span style={{ fontSize: 12, color: C.muted }}>
                        ~${estimate.perRunUsd.toFixed(4)}/run · ~${estimate.monthlyUsd.toFixed(2)}/month ({estimate.provider}/{estimate.model})
                        {estimate.contextMode && ` · context mode: ${estimate.contextMode === 'fullBody' ? 'full body' : 'header-first'}`}
                      </span>
                    )}
                    {estimate?.error && <span style={{ fontSize: 12, color: '#f87171' }}>⚠ {estimate.error}</span>}
                  </div>

                  <div style={{ display: 'flex', gap: 8 }}>
                    <button onClick={() => { setShowCreate(false); setCreateMsg(''); }} style={{ ...SMALL_BTN, fontSize: 13 }}>Cancel</button>
                    <button onClick={handleCreate} disabled={creating || !selectedCountry || newSourceIds.size === 0 || topicsArray().length === 0}
                      style={{ ...BTN('#2563eb'), fontSize: 13, padding: '7px 16px', flex: 1, opacity: (creating || !selectedCountry || newSourceIds.size === 0 || topicsArray().length === 0) ? 0.5 : 1 }}>
                      {creating ? <><Spinner size={10} />&nbsp;Creating…</> : 'Create Schedule'}
                    </button>
                  </div>
                  {createMsg && <div style={{ fontSize: 12, color: createMsg.startsWith('✓') ? '#4ade80' : '#f87171', marginTop: 10 }}>{createMsg}</div>}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {viewingRun && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
          onClick={() => setViewingRun(null)}>
          <ScheduledRunView
            key={viewingRun.runId}
            scheduleCountry={schedules.find(s => s.id === viewingRun.scheduleId)?.country || ''}
            dateLabel={viewingRun.run.dateLabel}
            run={viewingRun.run}
            onDelete={() => handleDeleteRun(viewingRun.scheduleId, viewingRun.runId, viewingRun.run.dateLabel)}
            onClose={() => setViewingRun(null)}
          />
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
function App() {
  const [confirm, confirmDialog] = useConfirm();
  const [user, setUser] = useState(undefined); // undefined=checking, null=logged out, object=logged in
  const [role, setRole] = useState(undefined); // undefined=checking, null=not authorized, 'admin'|'user'=authorized
  const [page, setPage] = useState('main');
  const [step, setStep] = useState('country');
  const [country, setCountry] = useState(null);
  const [selectedSources, setSelectedSources] = useState([]);
  const [results, setResults] = useState(null);
  const [resultDate, setResultDate] = useState(null);
  const [resultUsage, setResultUsage] = useState(null);
  const [periodResult, setPeriodResult] = useState(null);
  const [periodDates, setPeriodDates] = useState({ startDate: null, endDate: null });
  const [periodContext, setPeriodContext] = useState({ topics: [], persona: '' }); // for follow-up questions
  const [pendingRunParams, setPendingRunParams] = useState(null);
  const [loadingConfig, setLoadingConfig] = useState(null); // { title, duration, steps }
  const [errors, setErrors] = useState([]);
  const cancelledRef = useRef(false);
  const deferredInstall = useRef(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const appStateRef = useRef({});
  const [scheduleCountries, setScheduleCountries] = useState([]);
  const [scheduleCountriesLoaded, setScheduleCountriesLoaded] = useState(false);
  const [hasAnyUnreadSchedules, setHasAnyUnreadSchedules] = useState(false);

  // Re-checked whenever the home page is showing (first load, and whenever
  // coming back from the Scheduled Reports page after reading something) —
  // this is what badges the home-page button itself. Delayed slightly so
  // this Cloud Function call (cold-start-prone) doesn't compete for network
  // with the country-lookup fetch that's actually on screen during the
  // critical first-paint window — the unread dot showing up a moment late
  // is unnoticeable, unlike a slower country search.
  useEffect(() => {
    if (!user || !role || page !== 'main') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fns.httpsCallable('listSchedules')({}).then(resp => {
        if (!cancelled) setHasAnyUnreadSchedules((resp.data.schedules || []).some(s => s.hasUnread));
      }).catch(() => {});
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [user, role, page]);

  // Lazy-loaded the first time the Scheduled Reports page is opened, then
  // cached for the rest of the session — it needs the full source list per
  // country (unlike CountryStep's lightweight name/key/date history).
  useEffect(() => {
    if (page !== 'schedule' || scheduleCountriesLoaded) return;
    db.ref('countries').once('value').then(snap => {
      const val = snap.val();
      const list = val ? Object.values(val).filter(c => c.setup).map(c => c.setup) : [];
      setScheduleCountries(list);
      setScheduleCountriesLoaded(true);
    });
  }, [page, scheduleCountriesLoaded]);

  // Auth state listener
  useEffect(() => {
    return auth.onAuthStateChanged(u => {
      setUser(u || null);
      if (u) db.ref(`users/${u.uid}/lastLogin`).set(Date.now()).catch(() => {});
    });
  }, []);

  // Look up the caller's role once we know who's signed in
  useEffect(() => {
    if (!user) { setRole(undefined); return; }
    let cancelled = false;
    setRole(undefined);
    fns.httpsCallable('getMyRole')()
      .then(r => {
        if (cancelled) return;
        setRole(r.data.role || null);
        if (r.data.role) {
          // Only write the shared, authorization-gated index once we're confirmed
          // authorized — otherwise this write races the authorizedUids mirror
          // (also set by getMyRole) and gets denied by rules.
          db.ref(`usersByEmail/${user.email.trim().toLowerCase().replace(/\./g, ',')}`).set(user.uid).catch(() => {});
        }
      })
      .catch(() => { if (!cancelled) setRole(null); });
    return () => { cancelled = true; };
  }, [user]);

  // Capture PWA install prompt — pick up early-fired event or listen for future one
  useEffect(() => {
    if (window.__pwaInstallEvent) {
      deferredInstall.current = window.__pwaInstallEvent;
      window.__pwaInstallEvent = null;
    }
    const handler = e => { e.preventDefault(); deferredInstall.current = e; };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  // Keep ref in sync so the back-button handler always sees current state
  useEffect(() => { appStateRef.current = { page, step, pendingRunParams }; }, [page, step, pendingRunParams]);

  // Mobile back button — navigate within app instead of exiting
  useEffect(() => {
    window.history.pushState({ roynews: true }, '');
    function onPop() {
      const { page, step, pendingRunParams } = appStateRef.current;
      let handled = true;
      if (page === 'settings' || page === 'schedule') setPage('main');
      else if (step === 'results') backFromResults();
      else if (step === 'period-results') backFromPeriodResults();
      else if (step === 'sources') { setStep('config'); setPendingRunParams(null); }
      else if (step === 'config') setStep('country');
      else if (step === 'loading') { cancelledRef.current = true; setLoadingConfig(null); setStep('config'); }
      else handled = false;
      if (handled) window.history.pushState({ roynews: true }, '');
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Close user menu when clicking anywhere outside it
  useEffect(() => {
    if (!showUserMenu) return;
    const close = () => setShowUserMenu(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [showUserMenu]);

  function friendlyError(e) {
    const raw = e?.message || '';
    // Firebase sends ALL_CAPS code words for unhandled server errors — translate them
    if (/^[A-Z_]+$/.test(raw.trim())) {
      switch (e?.code) {
        case 'functions/permission-denied':
          return 'Access denied — your AI provider API key may be invalid or missing.\n\nHow to fix: go to Settings → AI Provider and update your key.';
        case 'functions/resource-exhausted':
          return 'AI provider rate limit reached — too many requests in a short time.\n\nHow to fix: wait 30–60 seconds and try again, or switch to a different AI provider in Settings.';
        case 'functions/deadline-exceeded':
        case 'functions/unavailable':
          return 'The request timed out before the server could finish.\n\nHow to fix: try again with fewer sources or topics selected.';
        case 'functions/unauthenticated':
          return 'You\'ve been signed out.\n\nHow to fix: refresh the page and sign in again.';
        case 'functions/internal':
        default:
          return 'The server ran into an unexpected problem.\n\nHow to fix: try again. If it keeps failing, try reducing the number of sources, or switch to a different AI provider in Settings.';
      }
    }
    return raw;
  }

  function addError(operation, e) {
    const message = typeof e === 'string' ? e : friendlyError(e);
    setErrors(prev => [...prev, { id: Date.now(), operation, message, timestamp: new Date().toISOString() }]);
  }
  function dismissError(id) { setErrors(prev => prev.filter(e => e.id !== id)); }

  function cancel() {
    cancelledRef.current = true;
    setStep(pendingRunParams ? 'sources' : 'config');
    setLoadingConfig(null);
  }

  function reset() {
    cancelledRef.current = false;
    setStep('country');
    setCountry(null);
    setSelectedSources([]);
    setResults(null);
    setResultUsage(null);
    setPeriodResult(null);
    setPeriodDates({ startDate: null, endDate: null });
    setPendingRunParams(null);
    setErrors([]);
  }

  // "Back" from a results screen goes one step back to where that run was
  // configured, not all the way to country — country/selectedSources/
  // pendingRunParams stay intact so re-confirming re-runs the same setup.
  function backFromResults() {
    setStep('sources');
    setResults(null);
    setResultUsage(null);
  }
  function backFromPeriodResults() {
    setStep('config');
    setPeriodResult(null);
    setResultUsage(null);
  }

  async function handleCountryConfirmed(c) {
    setCountry(c);
    if (c.needsSetup) {
      cancelledRef.current = false;
      setLoadingConfig({ title: `Setting up ${c.name}…`, durationSec: 55, steps: ['Researching media landscape…', 'Identifying key sources…', 'Checking RSS feeds…', 'Saving to database…'] });
      setStep('loading');
      try {
        const fn = fns.httpsCallable('setupCountry', { timeout: 120000 });
        const prefs = getUserPrefs(user?.uid);
        const numSources = prefs.numSources || 7;
        const filterNoRSS = prefs.filterNoRSS ?? true;
        const result = await fn({ country: c.name, ...await getAISettings(user?.uid), numSources, filterNoRSS });
        if (cancelledRef.current) return;
        setCountry({ ...c, setup: { sources: result.data.sources }, key: result.data.countryKey });
        setStep('config');
      } catch (e) {
        if (cancelledRef.current) return;
        addError('Setup Country', e);
        setStep('country');
      }
      setLoadingConfig(null);
    } else {
      setStep('config');
    }
  }

  async function runFetchNews(sources, { topics, contextTopics, date, summaryWords, maxArticles, lookbackDays }) {
    cancelledRef.current = false;
    setResultDate(date);
    const estSec = sources.length * 35 + 30;
    setLoadingConfig({
      title: `Analyzing ${country.name} news…`,
      durationSec: estSec,
      steps: ['Fetching articles…', 'Translating content…', 'Analyzing political framing…', 'Comparing coverage angles…', 'Compiling results…']
    });
    setStep('loading');
    try {
      const fn = fns.httpsCallable('fetchNews', { timeout: 310000 });
      const resp = await fn({ country: country.name, countryKey: country.key, selectedSources: sources, topics, contextTopics: contextTopics || [], date, summaryWords: summaryWords || 100, maxArticles: maxArticles || 25, lookbackDays: lookbackDays ?? 1, ...await getAISettings(user.uid) });
      if (cancelledRef.current) return;
      setResults(resp.data.results);
      setResultUsage(resp.data.usage || null);
      localStorage.setItem(`roy-news-lastrun-${user.uid}-${country.key}`, new Date().toISOString().slice(0, 10));
      // Save per-source RSS health so Settings can show real status
      const rssHealth = {};
      Object.entries(resp.data.results).forEach(([id, r]) => { rssHealth[id] = { ok: !r.rssError, date: new Date().toISOString().slice(0, 10) }; });
      localStorage.setItem(`roy-news-rss-health-${user.uid}-${country.key}`, JSON.stringify(rssHealth));
      setStep('results');
    } catch (e) {
      if (cancelledRef.current) return;
      addError('Fetch News', e);
      setStep('sources');
    }
    setLoadingConfig(null);
  }

  async function runPeriodAnalysis({ topics, startDate, endDate, periodReportWords }) {
    cancelledRef.current = false;
    setLoadingConfig({
      title: `Analyzing ${country.name} coverage…`,
      durationSec: 60,
      steps: ['Researching media patterns…', 'Grouping by political lean…', 'Comparing narratives…', 'Writing synthesis…']
    });
    setStep('loading');
    try {
      const fn = fns.httpsCallable('fetchPeriodSummary', { timeout: 130000 });
      const [personaSnap, aiSettings] = await Promise.all([db.ref(`users/${user.uid}/persona`).once('value'), getAISettings(user.uid)]);
      const persona = personaSnap.val() || '';
      const resp = await fn({ country: country.name, countryKey: country.key, topics, startDate, endDate, periodReportWords: periodReportWords || 150, persona, ...aiSettings });
      if (cancelledRef.current) return;
      setPeriodResult(resp.data.result);
      setPeriodContext({ topics, persona });
      setResultUsage(resp.data.usage || null);
      localStorage.setItem(`roy-news-lastrun-${user.uid}-${country.key}`, new Date().toISOString().slice(0, 10));
      setStep('period-results');
    } catch (e) {
      if (cancelledRef.current) return;
      addError('Period Analysis', e);
      setStep('config');
    }
    setLoadingConfig(null);
  }

  async function handleGo({ mode, topics, contextTopics, date, summaryWords, maxArticles, lookbackDays, startDate, endDate, periodReportWords }) {
    cancelledRef.current = false;

    if (mode === 'period') {
      setPeriodDates({ startDate, endDate });
      const periodArgs = { topics, startDate, endDate, periodReportWords };
      try {
        const groundingResp = await fns.httpsCallable('checkPeriodGrounding')({ countryKey: country.key, topics, startDate, endDate });
        const { grounded, general } = groundingResp.data;
        const parts = [];
        if (grounded.length > 0) parts.push(`For ${grounded.join(', ')}, I'll combine real archived coverage from your Scheduled Reports with general media-landscape knowledge.`);
        if (general.length > 0) parts.push(`For ${general.join(', ')}, no scheduled report covers ${general.length > 1 ? 'these topics' : 'this topic'} for this period, so I'll rely on general knowledge alone.`);
        confirm({
          title: 'Before analyzing…',
          message: parts.join(' ') || 'Ready to analyze based on general media-landscape knowledge.',
          confirmLabel: 'Continue',
          danger: false,
          onConfirm: () => runPeriodAnalysis(periodArgs)
        });
      } catch (e) {
        // The pre-flight check itself failing shouldn't block the feature —
        // proceed as if nothing was grounded rather than getting the user stuck.
        runPeriodAnalysis(periodArgs);
      }
      return;
    }

    // Point-in-time: store params and go to source selection
    setPendingRunParams({ topics, contextTopics, date, summaryWords, maxArticles, lookbackDays });
    setStep('sources');
  }

  const header = (
    <div className="no-print" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '13px 20px', background: '#0a1526', borderBottom: '1px solid ' + C.border, position: 'sticky', top: 0, zIndex: 100 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 18 }}>📰</span>
        <span style={{ fontWeight: 800, fontSize: 16, color: C.text }}>Roy News</span>
        <span className="version-tag" style={{ cursor: 'pointer' }} onClick={() => window.location.reload()} title="Tap to refresh">{VERSION}</span>
        {country && step !== 'country' && step !== 'loading' && (
          <span style={{ color: C.faint, fontSize: 13, marginLeft: 4 }}>· {country.name}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Share app */}
        <button
          onClick={() => navigator.share ? navigator.share({ title: 'Roy News', url: 'https://roy-news-23ab4.web.app' }).catch(()=>{}) : navigator.clipboard?.writeText('https://roy-news-23ab4.web.app').then(() => alert('Link copied!'))}
          style={SMALL_BTN}
          title="Share Roy News"
        >
          🔗 Share
        </button>
        <button
          onClick={() => setPage(p => p === 'settings' ? 'main' : 'settings')}
          style={{ ...SMALL_BTN, background: page === 'settings' ? '#1e3a5f' : C.card, borderColor: page === 'settings' ? '#3b82f6' : C.border }}
        >
          ⚙ Settings
        </button>
        {user && (
          <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
            {user.photoURL
              ? <img src={user.photoURL} alt={user.displayName || ''} style={{ width: 28, height: 28, borderRadius: '50%', cursor: 'pointer' }} onClick={() => setShowUserMenu(p => !p)} />
              : <div onClick={() => setShowUserMenu(p => !p)} style={{ width: 28, height: 28, borderRadius: '50%', background: '#2563eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 13, cursor: 'pointer', flexShrink: 0 }}>{(user.displayName || user.email || '?')[0].toUpperCase()}</div>
            }
            {showUserMenu && (
              <div style={{ position: 'absolute', right: 0, top: 36, background: '#132236', border: '1px solid #1e3a5f', borderRadius: 9, padding: '12px 14px', minWidth: 180, zIndex: 200, boxShadow: '0 4px 20px rgba(0,0,0,0.5)' }}>
                <div style={{ fontWeight: 600, color: C.text, fontSize: 13, marginBottom: 2 }}>{user.displayName || 'User'}</div>
                <div style={{ color: C.faint, fontSize: 11, marginBottom: 12 }}>{user.email}</div>
                <button onClick={() => { setShowUserMenu(false); handleSignOut(); }} style={{ ...BTN('#7f1d1d'), fontSize: 12, padding: '7px 12px' }}>Sign Out</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  // Auth guard
  if (user === undefined) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 12, color: '#9ca3af', background: C.bg }}>
        <div style={{ fontSize: '2rem' }}>📰</div>
        <div>Loading…</div>
      </div>
    );
  }
  if (!user) {
    return <LoginScreen />;
  }
  if (role === undefined) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 12, color: '#9ca3af', background: C.bg }}>
        <div style={{ fontSize: '2rem' }}>📰</div>
        <div>Loading…</div>
      </div>
    );
  }
  if (role === null) {
    return <AccessRestrictedScreen user={user} onSignOut={() => auth.signOut()} />;
  }

  function handleSignOut() { auth.signOut(); reset(); setPage('main'); }

  let content;
  if (page === 'settings') {
    content = <SettingsPage onBack={() => setPage('main')} deferredInstall={deferredInstall} user={user} onSignOut={handleSignOut} isAdmin={role === 'admin'} />;
  } else if (page === 'schedule') {
    content = (
      <div className="fade-in" style={{ maxWidth: 640, margin: '40px auto', padding: '0 20px' }}>
        <div className="panel" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <button onClick={() => setPage('main')} style={BACK_BTN}>← Back</button>
            <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0, color: C.text }}>🗓️ Scheduled Reports</h2>
          </div>
          <ScheduledReportsPanel user={user} countries={scheduleCountries} defaultOpen />
        </div>
      </div>
    );
  } else if (step === 'loading' && loadingConfig) {
    content = <CancelableLoader {...loadingConfig} onCancel={cancel} />;
  } else if (step === 'country') {
    content = <CountryStep onCountryConfirmed={handleCountryConfirmed} onError={addError} user={user} onOpenSchedule={() => setPage('schedule')} hasUnreadSchedules={hasAnyUnreadSchedules} />;
  } else if (step === 'config') {
    content = <ConfigStep country={country} user={user} onGo={handleGo} onBack={() => setStep('country')} />;
  } else if (step === 'sources') {
    content = <SourcesStep country={country} user={user} onConfirmed={srcs => { setSelectedSources(srcs); runFetchNews(srcs, pendingRunParams); }} onBack={() => setStep('config')} />;
  } else if (step === 'results') {
    content = <ResultsView country={country} results={results} date={resultDate} includeIsrael={false} usage={resultUsage} user={user} onNewSearch={backFromResults} onError={addError} />;
  } else if (step === 'period-results') {
    content = <PeriodResultView country={country} result={periodResult} startDate={periodDates.startDate} endDate={periodDates.endDate}
      topics={periodContext.topics} persona={periodContext.persona} user={user}
      usage={resultUsage} onNewSearch={backFromPeriodResults} onError={addError} />;
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      {header}
      <div style={{ minHeight: 'calc(100vh - 56px)' }}>{content}</div>
      <ErrorPanel errors={errors} onDismiss={dismissError} />
      {confirmDialog}
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
