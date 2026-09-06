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
- **Two permissions, and adding a third needs an argument.** `storage` and
  `sidePanel`, plus the one host permission. `downloads` and `unlimitedStorage`
  were both dropped: exports use a blob URL and an anchor click from the panel,
  which needs no permission at all, and the ~3,200 timeline ceiling keeps the
  result set inside the default storage quota. Do not reach for
  `chrome.downloads` again to save a file the user just clicked a button to
  save.

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
  {
    "resources": ["lib/*.js"],
    "matches": ["https://x.com/*"],
    "use_dynamic_url": true
  }
]
```

Only `lib/*.js`, and only readable from x.com. It grants no permission, loosens
no CSP, and exposes no secret — those files are already published in a repo
that is going public. The alternatives were worse: bundling (breaks the "no
build step" security argument) or moving orchestration into the service worker
(breaks "the worker holds no state", which is the whole MV3 survival story).

**`use_dynamic_url: true` is the important half of that entry.** A
web-accessible resource under a stable extension id is a fingerprinting oracle:
any x.com page could `fetch('chrome-extension://<id>/lib/api.js')` and learn
that Surtr is installed. X has an active interest in knowing that. The dynamic
URL swaps the id for a per-session random token, so there is no stable string to
probe for.

Verified empirically rather than assumed, because the flag interacts with the
dynamic `import()` the executor depends on. Both variants were loaded headless
and evaluated inside the content script's isolated world:

| | `getURL('lib/store.js')` | `import()` |
|---|---|---|
| without the flag | `chrome-extension://<extension id>/lib/store.js` | works |
| with the flag | `chrome-extension://6abf90b2-58c5-…/lib/store.js` | works |

So `chrome.runtime.getURL()` transparently returns the dynamic form to the
content script and the import sites need no change. The control run matters as
much as the test: without it, "the imports still work" would not distinguish
"the flag is safe" from "the flag did nothing".

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
override.

**The fallback is NOT "add the host permission".** An earlier version of this
note said it was, and that was wrong. **In MV3 a content script follows the
HOST PAGE's CORS policy and does not inherit the extension's host permissions**
- the CORS bypass content scripts had under MV2 was removed in the MV3
transition, precisely so that a compromised page cannot borrow an extension's
reach. Adding `https://abs.twimg.com/*` to `host_permissions` on its own would
change nothing about a fetch issued from `content/executor.js`; it would look
like a fix, ship as a fix, and fail identically.

The actual fallback is two changes together:

1. Add `https://abs.twimg.com/*` to `host_permissions` - a real permission
   widening, so it needs a row in the README's permission table, not a quiet
   edit.
2. **Relocate the bundle fetch out of the content script and into
   `background.js`**, which is an extension context and therefore does get the
   CORS bypass that host permission grants. The executor asks for the bundle
   text over runtime messaging and keeps doing all the parsing itself.

Constraint on doing that, and it is not negotiable: the worker's half is a
**stateless fetch-and-return** - receive a URL, check it is an allowed host,
fetch with `credentials: 'omit'`, return the text. No discovery logic, no
caching, no job state, nothing that has to survive the worker being killed.
`lib/discovery.js` keeps every decision; the worker only holds the one privilege
the content script cannot have. The rule that `background.js` holds no state
still stands after this change, which is the test of whether it was done right.

Not implemented. Do it only if a live run actually shows the fetch blocked.

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

- **A pre-commit secret-scanning hook is installed** in this repo's
  `.git/hooks/pre-commit`. Git hooks are not pushed, so a fresh clone has to
  reinstall it; it comes from the studio's tooling, which is kept outside every
  repo.
- **It hard-fails, never warns.** Every failure path exits non-zero — including
  the ones where the scanner could not run at all, not just the ones where it
  found something. A safety net that reports success when it did not run is
  worse than no safety net, because it gets trusted.
- **It blocked its own author twice while this repo was being written.** Once on
  a false positive, once correctly. Neither commit landed until the text was
  changed; neither was bypassed, and no exemption was added to get past either.
  That is worth stating plainly rather than tidying away: a scanner that has
  never stopped anyone has not been tested, and this one has now been tested
  against the person most motivated to wave it through.

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
- Installed the studio's pre-commit secret-scanning hook into `.git/hooks/`.
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

### 2026-09-06 — Hardening pass

Four changes, none of them touching the scanner logic.

- **Corrected the CORS fallback note.** It said the fix for a blocked
  `abs.twimg.com` fetch was to add the host permission. That was wrong: in MV3 a
  content script follows the host page's CORS policy and does NOT inherit the
  extension's host permissions — that bypass was removed in the MV2 transition.
  Adding the permission alone would have looked like a fix and failed
  identically. The note now says the fallback is the host permission **plus**
  relocating the bundle fetch into `background.js` as a stateless
  fetch-and-return. Still not implemented; only do it if a live run shows the
  fetch actually blocked. The same correction was applied to the README's
  "where your data can and cannot go" section, which had inherited the same
  wrong reasoning.
- **`use_dynamic_url: true`** on the web-accessible-resources entry, so a stable
  extension id cannot be probed from an x.com page to fingerprint that Surtr is
  installed. Verified against a control run that the flag both takes effect and
  leaves the dynamic `import()`s working — table under KEY FACTS.
- **Dropped `unlimitedStorage` and `downloads`.** Exports now use a blob URL and
  a synthetic anchor click from the panel. Verified in a headless browser that
  `chrome.downloads` is genuinely gone from the panel's API surface and that
  both files still land, with the CSV correctly quoting a field containing a
  comma and quotes. README permission table is down to two rows.
- The studio's machine-level scanning tooling was hardened alongside this and
  gained a test harness. Details are kept outside this repo; see Tooling
  above for what is relevant here.

Still not run against a live account. That remains job one.

### 2026-09-06 — DEV.md made public-safe

This repo is going public **with its history intact**, which is unusual for the
studio: the normal go-public sequence starts a fresh `git init`, because a
handoff file written for a private project cannot be selectively cleaned out of
old commits afterwards.

The exception is deliberate. The commit trail here — including the pre-commit
hook stopping its own author — is part of the argument for a tool that asks
permission to delete your posts in bulk, and that argument is worth more than a
tidy history. But it only works if this file is public-safe **from here
forward**, not scrubbed at flip time. So the split happened now, at two commits,
while it was still cheap.

- Machine-level tooling detail — anything about the scanning setup beyond the
  fact that it exists and hard-fails — moved out of this file to a location
  outside every git working tree. Nothing was added to `.gitignore` for it: an
  ignore entry naming a private file is itself a pointer to that file.
- This file now keeps only Surtr's own technical state: stack, repo-relative
  paths, the manifest and README departures, the MV3 CORS correction, response
  shapes to re-check, what's next, and this log.
- The hook-blocked-its-author story stays, rewritten to name nothing. It is a
  feature of the project, not an incident to bury.
- Full history was audited first — every blob in every commit and both commit
  messages — for absolute machine paths, lab hostnames, LAN addresses,
  environment-variable names, handles and user ids. Nothing of that kind is
  committed.

Still not run against a live account.
