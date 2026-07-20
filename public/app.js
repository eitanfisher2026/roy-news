// ─── Version ──────────────────────────────────────────────────────────────────
const VERSION = 'v1.76';

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
function formatDisplayDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
}
function formatLastLogin(ts) {
  if (!ts) return 'Never logged in';
  return 'Last logged in: ' + new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TOPICS = ['Gaza', 'Iran & Nuclear', 'Hezbollah', 'Israel', 'USA', 'Economy', 'Internal Politics', 'Security & Terrorism', 'Refugees', 'Normalization'];

const DEFAULT_PROMPTS = {
  setup:
`You are a media research expert. Research the news media landscape of "{{country}}".

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
const TYPE_LABELS  = { newspaper: 'Newspaper', tv: 'TV', online: 'Online', radio: 'Radio', news_agency: 'Agency' };

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

  const isBusy = refreshing || adding || finding || !!fixingSourceId;

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
      } else {
        setAddMsg('No new sources found — all results were already in the list or filtered out.');
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
      onSourcesChange(sources.map(s => s.id === src.id ? { ...s, rssUrl: newUrl } : s));
      if (!newUrl) alert(`Could not find a working RSS feed for ${src.name}. The feed link has been cleared.`);
    } catch (e) {
      alert('Fix failed: ' + e.message);
    }
    setFixingSourceId(null);
  }

  async function handleRemoveSource(id) {
    if (!window.confirm('Remove this source permanently?')) return;
    const newSources = sources.filter(s => s.id !== id);
    onSourcesChange(newSources);
    if (selectable && onSelectionChange) {
      const n = new Set(selected); n.delete(id); onSelectionChange(n);
    }
    fns.httpsCallable('updateSources')({ countryKey: country.key, sources: newSources }).catch(() => {});
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
        <button onClick={() => { setActivePanel(p => p === 'addmore' ? null : 'addmore'); setAddMsg(''); }} disabled={isBusy}
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

      {/* Sort control */}
      {sources.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ color: C.faint, fontSize: 12 }}>Sort by</span>
          <select value={sortBy} onChange={e => changeSortBy(e.target.value)} className="input-field" style={{ fontSize: 12, padding: '4px 10px', width: 'auto' }}>
            <option value="default">Default</option>
            <option value="name">Name</option>
            <option value="lean">Orientation</option>
          </select>
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
              style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', background: active ? C.card : '#0f1e35', border: '1px solid ' + (active ? C.borderLight : C.border), borderRadius: 8, cursor: selectable ? 'pointer' : 'default', ...(isNew ? { outline: '2px dashed #3b82f6', outlineOffset: 2 } : {}) }}>
              {selectable && (
                <input type="checkbox" checked={active} readOnly
                  style={{ marginTop: 3, accentColor: getLeanColor(src.lean), flexShrink: 0, pointerEvents: 'none' }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
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
              <div style={{ display: 'flex', gap: 5, flexShrink: 0, alignItems: 'flex-start' }} onClick={e => e.stopPropagation()}>
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
    </div>
  );
}

// ─── Step 1: Country Selection ────────────────────────────────────────────────
function CountryStep({ onCountryConfirmed, onError, user }) {
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

  return (
    <div className="fade-in" style={{ maxWidth: 500, margin: '60px auto', padding: '0 20px' }}>
      <div style={{ textAlign: 'center', marginBottom: 36 }}>
        <div style={{ fontSize: 40, marginBottom: 8 }}>📰</div>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0, color: C.text }}>Roy News</h1>
        <div style={{ color: C.faint, fontSize: 12, marginTop: 4, cursor: 'pointer' }} onClick={() => window.location.reload()} title="Tap to refresh">{VERSION}</div>
      </div>

      <div className="panel" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 16, color: C.text }}>Select Country</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input-field"
            placeholder="Type a country name…"
            value={input}
            onChange={e => { setInput(e.target.value); setLookup(null); }}
            onKeyDown={e => e.key === 'Enter' && handleLookup()}
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

        {history.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Recent Countries</div>
            {history.map(c => {
              const isLast = c.key === lastKey;
              const lastRun = user?.uid ? localStorage.getItem(`roy-news-lastrun-${user.uid}-${c.key}`) : null;
              const displayDate = lastRun || c.date;
              return (
                <button key={c.key} onClick={() => { setInput(c.name); handleLookup(c.name); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', background: isLast ? '#0f2744' : C.card, border: '1px solid ' + (isLast ? '#2563eb' : C.border), borderRadius: 7, color: C.text, cursor: 'pointer', marginBottom: 4, fontSize: 14 }}>
                  {c.name} {isLast && <span style={{ color: '#60a5fa', fontSize: 11, fontWeight: 600 }}>★ last used</span>} {displayDate && <span style={{ color: C.faint, fontSize: 11 }}>· {displayDate}</span>}
                </button>
              );
            })}
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
  const [topicsLoaded, setTopicsLoaded]         = useState(false);
  const [summaryWords, setSummaryWords]         = useState(() => loadLocal('summaryWords', 100));
  const [maxArticles, setMaxArticles]           = useState(() => loadLocal('maxArticles', 25));
  const [mode, setMode]                         = useState(() => loadLocal('mode', 'pointintime'));
  const [periodType, setPeriodType]             = useState(() => loadLocal('periodType', 'days'));
  const [periodDays, setPeriodDays]             = useState(() => loadLocal('periodDays', 30));
  const [periodFrom, setPeriodFrom]             = useState(() => loadLocal('periodFrom', ''));
  const [periodTo, setPeriodTo]                 = useState(() => loadLocal('periodTo', todayStr()));
  const [periodReportWords, setPeriodReportWords] = useState(() => loadLocal('periodReportWords', 150));

  const [customInput, setCustomInput] = useState('');
  const [date, setDate]               = useState(todayStr());

  // Load topic list from Firebase on mount; if none saved yet, keeps localStorage-seeded defaults
  useEffect(() => {
    if (!uid) { setTopicsLoaded(true); return; }
    db.ref(`users/${uid}/topics`).once('value').then(snap => {
      const data = snap.val();
      if (data) {
        setCustomTopics(data.custom || []);
        setRemovedDefaultTopics(new Set(data.removedDefaults || []));
      }
      setTopicsLoaded(true);
    }).catch(() => setTopicsLoaded(true));
  }, [uid]);

  // Sync topic list to Firebase whenever it changes (only after initial load)
  useEffect(() => {
    if (!uid || !topicsLoaded) return;
    db.ref(`users/${uid}/topics`).set({ custom: customTopics, removedDefaults: [...removedDefaultTopics] });
  }, [customTopics, removedDefaultTopics, topicsLoaded, uid]);

  // Save session preferences to localStorage
  useEffect(() => {
    if (topicsKey) {
      localStorage.setItem(topicsKey, JSON.stringify({
        selected: [...selectedTopics], summaryWords, maxArticles,
        mode, periodType, periodDays, periodFrom, periodTo, periodReportWords
      }));
    }
  }, [selectedTopics, summaryWords, maxArticles, mode, periodType, periodDays, periodFrom, periodTo, periodReportWords, topicsKey]);

  function toggleTopic(t) { setSelectedTopics(prev => { const n = new Set(prev); n.has(t) ? n.delete(t) : n.add(t); return n; }); }
  function addCustom() { const t = customInput.trim(); if (!t || customTopics.includes(t)) return; setCustomTopics(p => [...p, t]); setSelectedTopics(p => new Set([...p, t])); setCustomInput(''); }
  function removeTopic(t) {
    if (!window.confirm(`Remove topic "${t}"?`)) return;
    if (customTopics.includes(t)) {
      setCustomTopics(p => p.filter(x => x !== t));
    } else {
      setRemovedDefaultTopics(prev => new Set([...prev, t]));
    }
    setSelectedTopics(prev => { const n = new Set(prev); n.delete(t); return n; });
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

  function WordsStepper({ label, sublabel, value, onChange, min = 30, max = 500, step = 25 }) {
    return (
      <div style={{ padding: '10px 14px', background: C.card, borderRadius: 9, border: '1px solid ' + C.border, marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>{sublabel}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button onClick={() => onChange(Math.max(min, value - step))}
            style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>−</button>
          <input type="number" min={min} max={max} value={value} inputMode="numeric" pattern="[0-9]*"
            onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || value)))}
            style={{ width: 80, textAlign: 'center', fontSize: 22, fontWeight: 700, padding: '10px 6px', background: C.bg, border: '1px solid ' + C.borderLight, borderRadius: 10, color: C.text, outline: 'none' }} />
          <button onClick={() => onChange(Math.min(max, value + step))}
            style={{ width: 44, height: 44, borderRadius: '50%', border: '1px solid ' + C.borderLight, background: C.card, color: C.text, fontSize: 24, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>+</button>
          <span style={{ fontSize: 13, color: C.muted }}>words</span>
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

        {/* Topic grid */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {allTopics.map(t => {
            const active = selectedTopics.has(t);
            return (
              <button key={t} onClick={() => toggleTopic(t)} style={{ padding: '6px 13px', borderRadius: 20, fontSize: 13, cursor: 'pointer', background: active ? '#1d4ed8' : C.card, color: active ? 'white' : C.muted, border: '1px solid ' + (active ? '#3b82f6' : C.border), transition: 'all 0.15s', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {t}
                <span onClick={e => { e.stopPropagation(); removeTopic(t); }}
                  style={{ opacity: 0.6, fontSize: 15, lineHeight: 1, marginLeft: 2 }}>×</span>
              </button>
            );
          })}
        </div>

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
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 20, lineHeight: 1.8, padding: '8px 12px', background: C.card, borderRadius: 7, border: '1px solid ' + C.border }}>
          <strong style={{ color: C.muted }}>How to name topics:</strong><br/>
          <span style={{ color: '#60a5fa' }}>Economy</span> — single word, finds any article about economy<br/>
          <span style={{ color: '#60a5fa' }}>Red card</span> — phrase, finds articles containing "red card" together<br/>
          <span style={{ color: '#60a5fa' }}>Mundial &amp; red card</span> — both must appear in the article, not necessarily together
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
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 16, lineHeight: 1.6, padding: '7px 12px', background: C.card, borderRadius: 7, border: '1px solid ' + C.border }}>
              ℹ In Point in Time mode, topics filter which articles the AI reads — single words (<em>Iran</em>), phrases (<em>red card</em>), or combined with &amp; (<em>Mundial &amp; red card</em>) all work.
            </div>
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
                {date === todayStr() && <span style={{ color: C.faint, fontSize: 12 }}>Today</span>}
              </div>
            </div>

            <button onClick={() => onGo({ mode: 'pointintime', topics: [...selectedTopics], date, summaryWords, maxArticles })}
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
              const disabled = selectedTopics.size === 0 || !startDate || !endDate || startDate > endDate;
              return (
                <button
                  onClick={() => onGo({ mode: 'period', topics: [...selectedTopics], periodReportWords, ...computePeriodDates() })}
                  disabled={disabled}
                  style={{ ...BTN('#7c3aed'), width: '100%', padding: '12px', fontSize: 15, opacity: disabled ? 0.4 : 1 }}>
                  📆 Analyze Period
                </button>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Topic Card ───────────────────────────────────────────────────────────────
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
function buildPeriodShareText(country, startDate, endDate, result) {
  let text = `📰 Roy News — ${country.name} Period Analysis\n${formatDisplayDate(startDate)} → ${formatDisplayDate(endDate)}\n`;
  (result.leanGroups || []).forEach(g => {
    text += `\n── ${g.label || g.lean} ──\n`;
    if (g.overallNarrative) text += `${g.overallNarrative}\n`;
    (g.topics || []).forEach(t => {
      text += `\n${t.topic}${t.tone ? ` [${t.tone}]` : ''}\n${(t.summary || '').slice(0, 220)}\n`;
    });
  });
  const s = result.synthesis;
  if (s) {
    text += '\n─── Synthesis ───\n';
    if (s.consensus)  text += `Consensus: ${s.consensus}\n`;
    if (s.faultLines) text += `Fault Lines: ${s.faultLines}\n`;
    if (s.blindSpots) text += `Blind Spots: ${s.blindSpots}\n`;
    if (s.evolution)  text += `Evolution: ${s.evolution}\n`;
  }
  text += `\n─────────────────\nGenerated by Roy News\nhttps://roy-news-23ab4.web.app`;
  return text;
}

// ─── Period Result View ───────────────────────────────────────────────────────
function PeriodResultView({ country, result, startDate, endDate, usage, onNewSearch, onError }) {
  const [isHebrew, setIsHebrew]           = useState(false);
  const [hebrewResult, setHebrewResult]   = useState(null);
  const [translating, setTranslating]     = useState(false);
  const [translateProgress, setTranslateProgress] = useState(0);
  const [showTranslateInfo, setShowTranslateInfo] = useState(false);
  const [shareCopied, setShareCopied]     = useState(false);
  const [resultCopied, setResultCopied]   = useState(false);

  const displayResult = isHebrew && hebrewResult ? hebrewResult : result;
  const { leanGroups = [], synthesis } = displayResult || {};

  const leanColors = { government: '#ef4444', 'pro-government': '#f97316', opposition: '#3b82f6', independent: '#64748b' };
  const leanBg    = { government: '#1a0a0a', 'pro-government': '#1a0f08', opposition: '#080f1a', independent: '#0f1217' };

  function LeanGroupCard({ group }) {
    const [open, setOpen] = useState(true);
    const color = leanColors[group.lean] || '#64748b';
    const bg    = leanBg[group.lean]    || '#0f1217';
    return (
      <div style={{ marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid ' + C.border }}>
        <button onClick={() => setOpen(o => !o)}
          style={{ display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: bg, border: 'none', cursor: 'pointer', textAlign: 'left', borderBottom: open ? '1px solid ' + C.border : 'none' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: color }}>{group.label || group.lean}</div>
            {group.outlets?.length > 0 && (
              <div style={{ fontSize: 11, color: C.faint, marginTop: 2 }}>{group.outlets.join(' · ')}</div>
            )}
          </div>
          <span style={{ color: C.faint, fontSize: 12 }}>{open ? '▲' : '▼'}</span>
        </button>
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
    if (hebrewResult) { setIsHebrew(true); return; }
    setTranslating(true);
    setTranslateProgress(0);
    try {
      const { texts, paths } = extractPeriodTexts(result);
      const CONCURRENCY = 6;
      const allTranslations = new Array(texts.length);
      for (let i = 0; i < texts.length; i += CONCURRENCY) {
        const batch = texts.slice(i, i + CONCURRENCY);
        const translated = await Promise.all(batch.map(t => translateViaGoogle(t)));
        translated.forEach((t, j) => { allTranslations[i + j] = t; });
        setTranslateProgress(Math.round(((i + batch.length) / texts.length) * 100));
      }
      setHebrewResult(applyPeriodTranslations(result, paths, allTranslations));
      setIsHebrew(true);
    } catch (e) {
      onError?.('Translate to Hebrew', e.message);
    }
    setTranslating(false);
    setTranslateProgress(0);
  }

  async function handleCopyResult() {
    const text = buildPeriodShareText(country, startDate, endDate, displayResult);
    await navigator.clipboard?.writeText(text);
    setResultCopied(true);
    setTimeout(() => setResultCopied(false), 2500);
  }

  async function handleShareResult() {
    const text = buildPeriodShareText(country, startDate, endDate, displayResult);
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

      {/* Lean groups */}
      {leanGroups.length === 0
        ? <div style={{ color: C.muted, padding: 24, textAlign: 'center' }}>No data returned — try again.</div>
        : leanGroups.map((g, i) => <LeanGroupCard key={i} group={g} />)
      }

      {/* Synthesis */}
      {synthesis && (
        <div style={{ marginTop: 20, padding: 18, background: '#0a1220', borderRadius: 10, border: '1px solid #1e3a5f' }}>
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
        : topicAnalyses.map((ta, i) => <TopicCard key={i} analysis={ta} />)
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
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=he&dt=t&q=${encodeURIComponent(text)}`;
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
  text += `\n─────────────────\nGenerated by Roy News\nhttps://roy-news-23ab4.web.app`;
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

  function handleShare() {
    const url = window.location.href;
    const text = `Roy News — ${country.name} media analysis for ${formatDisplayDate(date)}`;
    if (navigator.share) {
      navigator.share({ title: 'Roy News', text, url }).catch(() => {});
    } else {
      navigator.clipboard?.writeText(url).then(() => alert('Link copied to clipboard!'));
    }
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
        {visibleSourceIds.map(id => <SourceColumn key={id} sourceResult={displayResults[id]} requestedDate={date} />)}
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

  const [promptsOpen, setPromptsOpen] = useState(false);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [setupPrompt, setSetupPrompt] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [periodPrompt, setPeriodPrompt] = useState('');
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

  async function handleRemoveUser(email) {
    if (!window.confirm(`Remove access for ${email}?`)) return;
    setUserBusy(true);
    try {
      await fns.httpsCallable('removeAuthorizedUser')({ email });
      await loadAuthUsers();
    } catch (e) {
      setUserMsg('⚠ ' + e.message);
    }
    setUserBusy(false);
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
    } catch (e) {
      setSetupPrompt(DEFAULT_PROMPTS.setup);
      setAnalysisPrompt(DEFAULT_PROMPTS.analysis);
      setPeriodPrompt(DEFAULT_PROMPTS.period);
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

  async function removeCountry(key) {
    if (!window.confirm(`Remove ${key}?`)) return;
    await fns.httpsCallable('deleteCountry')({ countryKey: key });
    setCountries(p => p.filter(c => c.countryKey !== key));
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
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────────────────────
function App() {
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
  const [pendingRunParams, setPendingRunParams] = useState(null);
  const [loadingConfig, setLoadingConfig] = useState(null); // { title, duration, steps }
  const [errors, setErrors] = useState([]);
  const cancelledRef = useRef(false);
  const deferredInstall = useRef(null);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const appStateRef = useRef({});

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
      if (page === 'settings') setPage('main');
      else if (step === 'results' || step === 'period-results') reset();
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

  async function runFetchNews(sources, { topics, date, summaryWords, maxArticles }) {
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
      const resp = await fn({ country: country.name, countryKey: country.key, selectedSources: sources, topics, date, summaryWords: summaryWords || 100, maxArticles: maxArticles || 25, ...await getAISettings(user.uid) });
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

  async function handleGo({ mode, topics, date, summaryWords, maxArticles, startDate, endDate, periodReportWords }) {
    cancelledRef.current = false;

    if (mode === 'period') {
      setPeriodDates({ startDate, endDate });
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
        setResultUsage(resp.data.usage || null);
        localStorage.setItem(`roy-news-lastrun-${user.uid}-${country.key}`, new Date().toISOString().slice(0, 10));
        setStep('period-results');
      } catch (e) {
        if (cancelledRef.current) return;
        addError('Period Analysis', e);
        setStep('config');
      }
      setLoadingConfig(null);
      return;
    }

    // Point-in-time: store params and go to source selection
    setPendingRunParams({ topics, date, summaryWords, maxArticles });
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
          🔗 Share App
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
  } else if (step === 'loading' && loadingConfig) {
    content = <CancelableLoader {...loadingConfig} onCancel={cancel} />;
  } else if (step === 'country') {
    content = <CountryStep onCountryConfirmed={handleCountryConfirmed} onError={addError} user={user} />;
  } else if (step === 'config') {
    content = <ConfigStep country={country} user={user} onGo={handleGo} onBack={() => setStep('country')} />;
  } else if (step === 'sources') {
    content = <SourcesStep country={country} user={user} onConfirmed={srcs => { setSelectedSources(srcs); runFetchNews(srcs, pendingRunParams); }} onBack={() => setStep('config')} />;
  } else if (step === 'results') {
    content = <ResultsView country={country} results={results} date={resultDate} includeIsrael={false} usage={resultUsage} user={user} onNewSearch={reset} onError={addError} />;
  } else if (step === 'period-results') {
    content = <PeriodResultView country={country} result={periodResult} startDate={periodDates.startDate} endDate={periodDates.endDate} usage={resultUsage} onNewSearch={reset} onError={addError} />;
  }

  return (
    <div style={{ minHeight: '100vh', background: C.bg }}>
      {header}
      <div style={{ minHeight: 'calc(100vh - 56px)' }}>{content}</div>
      <ErrorPanel errors={errors} onDismiss={dismissError} />
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────
ReactDOM.createRoot(document.getElementById('root')).render(<App />);
