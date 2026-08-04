# Roy News — Claude Context

AI-assisted news aggregation app, owned by Eitan. Pulls RSS sources per country/topic, uses AI (Anthropic by default) to translate/summarize/analyze, and can email scheduled reports.

- **Repo:** github.com/eitanfisher2026/roy-news
- **Firebase project:** roy-news-23ab4
- **Functions region:** us-central1
- Sibling projects (same owner, separate everything): [buli](../buli/CLAUDE.md), [foufou-pets](../FouFou-Pets/CLAUDE.md) — nothing shared with those.

## Stack
- Client: no build step — `public/app.js` is loaded directly with `<script type="text/babel" src="app.js?v=X.X">`, compiled in-browser by Babel. Unlike Buli, there is **no compiled/`app.compiled.js` step** — editing `app.js` is enough, just bump `VERSION` (top of `app.js`) and the matching `?v=` in `index.html` together.
- Server: `functions/index.js` (~2600 lines), Firebase Cloud Functions 2nd gen, Node 20, `us-central1`.
- Firebase Realtime Database + Auth.

## Env setup — the one thing that doesn't come from git
`functions/.env` holds `ANTHROPIC_API_KEY` and is git-ignored. If functions fail citing a missing Anthropic key, that's why — ask Eitan for the key rather than searching the repo for it.

## Versioning
Keep bumping the minor version (v3.1, v3.2, …) on every change — only jump to a new major version when Eitan explicitly says so.

## Deploy
```bash
firebase deploy --only hosting --project roy-news-23ab4
firebase deploy --only functions --project roy-news-23ab4
```
Functions deploys routinely take 60-120s+ and may need to run in the background.

## Architecture — key server functions (`functions/index.js`)
- `fetchNews` / `addSources` / `findSource` / `fixSourceUrl` / `checkFeedStats` — RSS source management and ingestion.
- `generateScheduledReports` / `createSchedule` / `updateSchedule` / `deleteSchedule` / `listSchedules` / `estimateScheduleCost` — the scheduled-report system (a schedule = country + topics + recipients + cadence).
- `sendReportEmailNow` — manual "send now" trigger for a report, separate from the scheduled path.
- `translateResults` / `checkContextGrounding` / `fetchPeriodSummary` / `askPeriodFollowUp` — AI-assisted analysis on top of collected articles.
- `pollArchivedSources` — background archival job; see the shared-source note below.
- `getMyRole` / `listAuthorizedUsers` / `addAuthorizedUser` / `removeAuthorizedUser` — same authorized-user/role pattern as Buli.

## Known non-obvious traps (found the hard way — check before assuming otherwise)
- **Shared sources across schedules:** two schedules for the same country can share one RSS source (e.g. both using Bangkok Post). Pruning logic must never let one schedule's cleanup strip articles a *different* schedule still needs from the shared `articleArchive/{countryKey}/{sourceId}/{day}` node — a source used by more than one enabled schedule skips pruning entirely (fixed in commit `b596933`). This means shared-source entries currently accumulate with **no age-based cleanup** — deliberately deferred; don't add an expiry job until Eitan asks for it.
- **Report email subjects must be unique per report**, not just per country — two reports for the same country with different topic sets previously collided on subject line, causing only one of several "send all" emails to actually arrive (some email clients/relays dedupe on subject+recipient). Include enough of the topic name in the subject to disambiguate, without letting it grow so long it truncates.
- **Topic filtering is not free-form keyword matching** — over-inclusive matching previously let clearly off-topic articles (e.g. Trump/Iran geopolitics) into a report scoped to "internal politics" for a specific country. If a report looks like it's showing the full unfiltered RSS firehose instead of topic-matched articles, suspect the matching/filtering logic first, not "not enough articles."
- **Language leakage:** article text has shown up in the source language (e.g. Thai) inside a report meant to be all-English — check wherever translation is applied (or skipped) for an article field before assuming a new language always gets translated.

## Standing workflow rules (shared with Buli, established over many sessions)
- **Decide and act, don't ask process questions.** Eitan is not technical and thinks in outcomes, not implementation mechanics. Carry an agreed change through edit → deploy → verify → commit → push without pausing at each step. Reserve real stops for genuinely irreversible actions.
- **Batch fixes into one deploy, don't deploy after every tiny change.** Fix everything reported, verify locally, then do one deploy/commit/push pass.
- **Before building something new, check whether it already exists.**
- Communicate in product-level terms, not code details — see the global `~/.claude/CLAUDE.md` for the full shared communication-style rule.
