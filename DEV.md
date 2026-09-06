# Surtr — DEV

Handoff file. Read this first; it should be enough to resume without asking.

> **This file is COMMITTED and the repo is destined to go public.** No absolute
> machine paths, no LAN addresses, no handles, no numeric user ids. Where a
> local path matters it is written relative to the repo root. That is why this
> file looks less specific than the DEV.md in a private project — the
> constraint is deliberate, not an oversight.

---

## CURRENT STATE (resume here)

**Phase 1 scaffold complete and committed.** Repo is **private** on GitHub as
`OdinKara/surtr`, and stays private until the scanner is validated.

What exists and is believed correct:

- `manifest.json` — MV3, side panel, content script on `https://x.com/*`.
- `background.js` — relay + `setPanelBehavior`. Stateless by design.
- `content/executor.js` — owns every network call and all job state.
- `lib/discovery.js` — scrapes bearer + `queryId`s from the live bundle.
- `lib/api.js` — headers, rate-limit accounting, feature negotiation.
- `lib/enumerate.js` — cursor walk, normalization, ceiling detection.
- `lib/filters.js` — pure predicates. Testable with plain node, no browser.
- `lib/store.js` — `chrome.storage.local` + checkpointing.
- `ui/panel.{html,css,js}` — display and control only.

**Not yet done:** nobody has run this against a live logged-in account. The
response-shape assumptions in `lib/enumerate.js` are written from X's known
GraphQL structure but have **not been confirmed against a live response**. That
is the first job — see WHAT'S NEXT.

**There is no deletion code anywhere in this repo.** Keep it that way until the
scanner is validated. That is the whole point of the phase split.

---

## WHAT'S NEXT

1. **Load unpacked and run a real dry-run scan.** Confirm, in order:
   - Discovery finds a bearer and both `queryId`s on the first try.
   - `resolveUser` gets a `rest_id` from `UserByScreenName`.
   - The first `UserTweetsAndReplies` page returns entries and a bottom cursor.
2. **Verify the parse against a real response.** In the x.com tab's DevTools
   console, snapshot one raw GraphQL response and check
   `instructionsOf` / `collectEntries` / `normalize` against it. The likely
   points of drift are listed under KEY FACTS → "Response shapes to re-check".
3. **Confirm feature negotiation actually converges.** The seed set in
   `api.seedFeatures()` is short on purpose; the log will show every feature it
   had to add. Record what the live build demanded.
4. **Record the observed rate ceiling.** The activity log prints
   `limit`, lowest `remaining` seen, and the 429 count at the end of a run.
   Write the real numbers into KEY FACTS below once they are known — do not turn
   them into constants in the code.
5. **Establish whether the account actually hits the ~3,200 ceiling.** The
   `endReason` and `ceilingSuspected` fields on the finished job say which.
6. Only then: consider phase 2.

---

## KEY FACTS

### Layout

```
manifest.json
background.js            service worker: relay + side panel opener
content/executor.js      ALL network calls + job orchestration
lib/discovery.js         bearer + queryId scraping
lib/api.js               headers, rate limits, feature negotiation
lib/enumerate.js         timeline walk + normalization
lib/filters.js           pure predicates
lib/store.js             storage + checkpointing
ui/panel.{html,css,js}   side panel
```

### Non-negotiable design rules

- **No build step.** No npm, no bundler, no TypeScript. The security argument is
  "read the source yourself", so shipped code and repo code must be identical.
- **All network calls in the content script.** It runs in the x.com origin, so
  `credentials: 'include'` lets the browser attach the HttpOnly `auth_token`
  cookie. Surtr therefore never handles a credential. Moving a fetch into the
  panel or the worker breaks that property and is not an acceptable refactor.
- **The service worker holds no state.** MV3 kills it whenever it likes. If a
  module-scope variable in `background.js` starts to matter, it belongs in
  `lib/store.js`.
- **Checkpoint after every page.** Not every N pages. A tab reload must cost one
  page, not the run.
- **Nothing X can rotate is hardcoded.** No bearer, no `queryId`, no
  requests-per-window number. All three are discovered or observed.
- **`ct0` is read fresh on every request.** It rotates. A cached one starts
  returning 403 mid-run and looks exactly like a revoked session.

### The one deviation from the original spec, and why

The spec gave `manifest.json` verbatim, without `web_accessible_resources`.
**It was added.** Chrome does not support `"type": "module"` on *declared*
content scripts, so `content/executor.js` is a classic script that pulls the
shared modules in with `import(chrome.runtime.getURL('lib/...'))` — and a
dynamic import of an extension file from a content script requires the file to
be web-accessible. Without it the executor throws on load and nothing runs.

The addition is scoped as tightly as it can be:

```json
"web_accessible_resources": [
  { "resources": ["lib/*.js"], "matches": ["https://x.com/*"] }
]
```

Only `lib/*.js`, and only readable from x.com. It grants no permission, loosens
no CSP, and exposes no secret — those files are already published in a repo
that is going public. The alternatives were worse: bundling (breaks the "no
build step" security argument) or moving orchestration into the service worker
(breaks "the worker holds no state", which is the whole MV3 survival story).

### README accuracy note

The spec asked the README to state that `connect-src` makes Surtr
"structurally incapable of sending your data anywhere". That is true of the
**extension pages and the service worker**, which `extension_pages` CSP governs.
It is **not** true of the content script: MV3's `extension_pages` policy does
not cover content scripts, and any script in any page can fire a `no-cors`
request whose response it cannot read. The README therefore makes the narrower,
true claim plus the check that actually settles it — two `fetch` call sites,
one building only `https://x.com/i/api/graphql/...` URLs and one re-reading an
already-loaded `abs.twimg.com` bundle, both verifiable by grep. Overclaiming in
a security README is worse than the nuance.

### Response shapes to re-check against live data

These are the assumptions in `lib/enumerate.js` most likely to have drifted:

- **Timeline root.** Tried in order: `timeline_v2.timeline`, `timeline.timeline`,
  `timeline_response.timeline`. If a live response nests it elsewhere,
  `instructionsOf()` returns `[]` and the scan reports zero posts on page one —
  that symptom means this, not an empty account.
- **Tweet unwrapping.** `TweetWithVisibilityResults` wraps the real tweet under
  `.tweet`. Handled, but the `__typename` list may have grown.
- **Modules.** Conversation threads arrive as `TimelineTimelineModule` with
  `items[].item.itemContent`. Their internal `ShowMore` cursor is ignored on
  purpose — phase 1 wants your posts, not full reply trees.
- **Pinned.** Comes via a `TimelinePinEntry` instruction. It may not appear in
  `UserTweetsAndReplies` at all; if it does not, `excludePinned` never fires
  there and the pinned post is simply absent from the scan. Verify which.
- **Screen name in a normalized permalink.** Read from
  `core.user_results.result.legacy.screen_name`, falling back to
  `core.user_results.result.core.screen_name` — X moved this field once
  already. Falls back to the resolved handle, then to `i`, which still produces
  a working URL.

### Known risk to confirm on first live run: the bundle fetch and CORS

`lib/discovery.js` re-fetches an `abs.twimg.com` bundle URL harvested from the
page's own `<script>` tags, with `credentials: 'omit'`, to read the bearer and
query ids out of it. The extension holds **no host permission for
abs.twimg.com** - only `https://x.com/*` - so that fetch is an ordinary
cross-origin request and succeeds only because X's CDN serves those assets with
`Access-Control-Allow-Origin: *` (it has to; the page loads them with
`crossorigin`). That is believed true but is **unverified against live traffic**.

If it turns out CORS blocks it, the failure is loud, not silent: `discover()`
catches per-URL fetch errors, logs `skipped <file>: <error>`, and ends with
`missing: [bearer, ...]`, which the panel shows and which unlocks the manual
override. The fix if it ever happens is to add `https://abs.twimg.com/*` to
`host_permissions` - a real permission widening, so it needs a line in the
README's permission table, not a quiet edit.

### Rate limits — fill in once observed

| What | Value |
|---|---|
| `x-rate-limit-limit` on `UserTweetsAndReplies` | *not yet observed* |
| Lowest `remaining` seen in a full run | *not yet observed* |
| 429s in a full run | *not yet observed* |
| Wall-clock for a full history scan | *not yet observed* |

Record what was seen. **Do not turn these into constants in the code** — they
differ per endpoint and per account, and a guessed ceiling either throttles
pointlessly or trips a 429 anyway.

### Tooling

- **Pre-commit PII sweep is installed** in this repo's `.git/hooks/pre-commit`,
  copied from the canonical machine-level copy. Hooks are not pushed, so a fresh
  clone has to reinstall it. The sweep script and its watch-list live outside
  every repo on purpose — the watch-list enumerates the identifiers being
  watched for, so committing it would itself be the leak.
- Every failure path in that hook exits non-zero. A missing script blocks the
  commit rather than warning: a safety net that reports success when it did not
  run is worse than none.

### Public-safety rules for this repo

Enforced from commit #1, because the repo is destined to go public and history
is not retroactively cleanable in any way that matters:

- No X handle, no numeric user id, no LAN addresses, no machine-specific
  absolute paths, no personal data anywhere in the tree.
- The user id is resolved **at runtime** and never persisted. It is not written
  to storage and does not appear in an exported report.
- `.gitignore` covers `surtr-report-*.json` / `.csv`, since scan output is
  personal data by definition.

---

## STAGE LOG

*Append only. Newest at the bottom.*

### 2026-09-06 — Phase 1 scaffold

- Created the repo **private**. `.gitignore` written and staged **before** any
  source file entered the tree.
- Installed the canonical pre-commit PII sweep into `.git/hooks/`.
- Wrote the full phase-1 tree: manifest, background relay, executor, five lib
  modules, side panel.
- AGPL-3.0 `LICENSE` added.
- **No deletion code written.** No `DeleteTweet`, no `DeleteRetweet`, not
  commented out, not behind a flag.
- Added `web_accessible_resources` to the otherwise-verbatim manifest, for the
  reason recorded under KEY FACTS.
- Narrowed the README's `connect-src` claim to the one that is actually true,
  for the reason recorded under KEY FACTS.
- Not yet run against a live account.
