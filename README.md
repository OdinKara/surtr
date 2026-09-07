# Surtr

**Bulk X post removal.** Runs entirely in your browser. Nothing is uploaded.

By [GrimnirWorks](https://grimnirworks.com) · GrimnirWorks · niamain@gmail.com
Licensed [AGPL-3.0](LICENSE).

> **This build CAN delete. Read this section before running it.**
>
> Phase 1 (scan) is validated: a live run enumerated 2,600 of the 2,616 items X
> reports for an account, with zero foreign ids and zero cross-stream
> duplicates. Phase 2 (execute) now exists, and deletion is **permanent** —
> neither this tool nor X can undo it.
>
> Surtr still **opens in dry-run every time**, and dry-run is never persisted.
> Deleting requires: a completed scan from the current page session, filters
> unchanged since that scan, an explicit arm toggle, typing the exact item
> count, and — for a full run — having first completed and confirmed a 5-item
> test run. Every one of those is re-checked inside the extension, not just in
> the panel.
>
> The **kill log** records every item *before* its delete request is sent, so a
> crash still leaves a record of what was attempted. It is the only record of
> what was destroyed, and Surtr never writes it to disk on its own — when a run
> ends it says so and puts the download buttons in front of you. Deciding when
> your deleted posts reach a filesystem is yours, not the tool's.

---

## Why you can trust this

A tool that deletes your posts in bulk is asking for an enormous amount of
trust. The only honest way to earn it is to be small enough to read. So:

### Every permission, and why

**Surtr requests exactly two permissions.** Both are listed here in full.

| Permission | Why it is here | What it would mean if it were missing |
|---|---|---|
| `storage` | Filter settings, the scan checkpoint, discovered query ids, and the results table. Everything durable lives here because MV3 kills the service worker at will. | Closing the tab mid-scan would lose the run. |
| `sidePanel` | The UI is a side panel so it can sit next to x.com while a scan runs. | The UI would have to be a popup, which closes the moment you click away — and closing it must not stop a scan. |

Separately, one host permission — `https://x.com/*`, and nothing else. That is
the job itself: the content script runs in x.com's origin, which is what lets
the browser attach your session cookie without Surtr ever handling it.

**Not requested, deliberately:**

- `downloads` — exports use a blob URL and an anchor click from the panel, which
  needs no permission. Asking for the ability to write files the user never
  requested, in order to save a file the user just clicked a button to save, is
  a bad trade.
- `unlimitedStorage` — X's timeline stops at roughly 3,200 entries (see below),
  which is comfortably inside the default quota. The permission was in an early
  draft for archive-scale lists and is not needed for the scope that shipped.
- `tabs` — the relay finds an x.com tab using the host permission alone.
- `cookies` — see the section above; the only cookie Surtr reads is `ct0`, from
  `document.cookie` in the page's own origin.
- `scripting`, `webRequest`, `<all_urls>`, and any host beyond x.com.

### Surtr never handles your credentials

Your X session lives in the `auth_token` cookie, which is `HttpOnly` — script
cannot read it. Surtr does not try, and does not need to: `content/executor.js`
runs **in the x.com origin**, so a `fetch(..., {credentials: 'include'})` makes
*the browser* attach that cookie. Surtr never sees it.

The only cookie Surtr reads is `ct0`, the CSRF token, which X exposes to script
on purpose and which every x.com page reads on every request. It is read fresh
out of `document.cookie` on each call and never stored — see the comment at the
top of [`lib/api.js`](lib/api.js).

This is why *all* network calls live in the content script and why the side
panel never fetches x.com. Move those calls into the panel or the service
worker and you would have to start handling tokens yourself. This design
refuses to be in a position where it could leak one.

### Where your data can and cannot go

- **The panel and the service worker are locked down by CSP.**
  `connect-src 'self' https://x.com` in the manifest means the extension's own
  pages structurally cannot open a connection to any other host. There is no
  analytics endpoint they could reach even if one were added.
- **The content script has no special reach of its own.** It is not covered by
  that CSP — content scripts run in the page's world, and MV3's
  `extension_pages` policy does not apply to them. It does not get extra reach
  from the host permission either: under Manifest V3 a content script follows
  the **host page's** CORS policy and does *not* inherit the extension's host
  permissions. (That bypass existed under MV2 and was deliberately removed.) So
  its network reach is an ordinary x.com script's reach, no more. Being precise,
  that is still not "impossible": any script in any page can fire a `no-cors`
  request whose response it cannot read, so this README will not claim
  otherwise. What is actually true is the thing you can check:
  **there are exactly two `fetch` call sites in this repo.** One, in
  `lib/api.js`, only ever builds `https://x.com/i/api/graphql/...` URLs. The
  other, in `lib/discovery.js`, re-fetches an X JavaScript bundle the page has
  *already loaded* — a `abs.twimg.com` URL harvested from the page's own
  `<script>` tags — with `credentials: 'omit'`, to read the bearer token and
  query ids out of it. That is the entire network surface. Grep for it; it takes
  a minute.
- **No server.** There is no backend, no account, no telemetry, no update
  channel, no remote config. Exports go to your own Downloads folder.

### There is no build step

No npm, no bundler, no TypeScript, no minifier. **The code you load is the code
in this repository, byte for byte.** Loading unpacked points Chrome or Edge
directly at the repo directory. There is no compiled artifact that could differ
from what you read, which is the entire reason the project is structured this
way.

Unlike GrimnirWorks' `claude-kb` extension, there is **no second live directory
and no native messaging host** here. Nothing is copied anywhere, so the
path-derived extension ID is not load-bearing and there is nothing to keep in
sync — you can move this folder wherever you like.

### Audit it in five minutes

```sh
# 1. Every request that can WRITE. There is exactly one POST call site,
#    lib/api.js gqlPost, and it is used only by the execute path.
grep -rn "method: 'POST'" --include=*.js .

# 2. Every operation name that can be constructed. Two of them delete.
grep -rhoE "'(Delete[A-Za-z]+|User[A-Za-z]+)'" --include=*.js lib/ content/ | sort -u

# 3. What decides WHICH id gets deleted - the most dangerous logic here.
#    Read planItem(): posts and replies target their own id, retweets target
#    the ORIGINAL post via sourceTweetId, and anything else is skipped.
grep -n "planItem" -A 40 lib/execute.js

# 4. What can open the gate. Every condition is re-checked in the executor.
grep -n "checkArmed" -A 45 lib/execute.js

# 5. Every network call. Three call sites: two reads and one write.
grep -rn "fetch(" --include=*.js .

# 6. Every host that can be reached: x.com, and abs.twimg.com for the bundle.
grep -rn "https://\|twimg" --include=*.js .

# 7. Nothing reads or stores your session token.
grep -rni "auth_token" --include=*.js .     # comments only
```

Then read the files in this order — it is under 2,000 lines of JavaScript
in total, a large share of which is comments explaining why:
`manifest.json` → `content/executor.js` → `lib/api.js` → `lib/enumerate.js`.

---

## How it works

```
  ui/panel.js          display + control only. NEVER fetches x.com.
      |  messages
  background.js        dumb relay. Holds no state. Assumed dead at all times.
      |  messages
  content/executor.js  runs on x.com. Owns ALL network calls and job state.
      |
      +-- lib/discovery.js   scrapes bearer + queryIds from the live bundle
      +-- lib/api.js         headers, rate limits, feature negotiation
      +-- lib/enumerate.js   cursor-paginated timeline walk, normalization
      +-- lib/filters.js     pure predicates, no I/O
      +-- lib/store.js       chrome.storage.local, checkpointing
```

**Nothing is hardcoded that X can rotate.** The bearer token and the GraphQL
`queryId`s are scraped out of the JS bundle the page is already running. Every
X bulk-delete tool that hardcodes those is broken within weeks of the next
frontend build; Surtr keeps working with no update from us. If discovery fails
it says so and offers a manual override — it never falls back silently to a
remembered id, because a stale `queryId` returns a 404 that looks exactly like
"your posts are gone".

**Rate limits are observed, not assumed.** There is no requests-per-window
constant anywhere in this repo. Surtr reads `x-rate-limit-remaining` and
`x-rate-limit-reset` off every response, shows them live, and on a `429` sleeps
until the reset plus a two-second pad and halves its concurrency. What it
observed is written to the activity log.

**Feature negotiation.** `UserTweetsAndReplies` requires a `features` object
whose required keys change constantly; a missing key returns a `400` that names
the feature. Surtr starts from a short seed set, reads the missing name out of
the error, adds it, and retries — up to 25 rounds, then fails loudly with the
raw error. The negotiated set is saved and reused. This is what keeps Surtr
working across X frontend changes without shipping an update.

**Checkpointing.** The executor writes to storage after *every* page. Reloading
the tab or losing the service worker costs you one page, not the run — press
Start again and it resumes from the last cursor.

### The 3,200 ceiling — read this before you trust a count

X stops serving your own older history through this timeline somewhere around
**3,200 entries**. This is not a bug in Surtr and there is no way around it from
a browser.

When enumeration ends, Surtr tells you *why*: either the cursor genuinely ran
out, or the run stopped near the ceiling. If it looks like the ceiling, it says
so plainly:

> Reached X's timeline limit at N posts. Older posts exist and are still
> publicly reachable by direct URL, but this method cannot see them. Requesting
> your X data archive is the only complete enumeration.

Surtr will not report a clean sweep it cannot verify. If you need genuinely
complete coverage, request your archive from X first.

### A clean run is not the same as a complete one

X splits your profile into three tab-scoped timelines, and Surtr walks all
three in turn: **posts**, then **reposts**, then **replies**.

Each stream ends for its own reason, and Surtr reports each separately. It
deliberately does not collapse them into a single verdict, because a run can
exhaust one stream cleanly and hit the ceiling on another.

More importantly, **a stream running out of cursor does not mean your account
was fully enumerated.** Surtr compares what it enumerated against the total X
reports for the account, and if it is materially short it says so at the top of
the panel:

> INCOMPLETE: 604 of 2616 items X reports for this account (23%). 2012
> unaccounted for. Do not treat these results as the full account.

An export is marked `"complete": true` only when **both** every stream finished
**and** there is no unexplained shortfall. Otherwise it carries
`"complete": false` and an `incompleteReason`. That rule exists because an
earlier build reported a run as complete having seen 23% of an account: every
stream really had exhausted its cursor, and the conclusion was still wrong.

If a filter excludes a whole kind, the matching stream is not walked at all,
and that is shown as a banner and recorded in the export — a scan that quietly
did less work than you assumed is the same problem as an export that reads as
complete and is not.

### Deleting: what has to be true before anything is destroyed

Every one of these is enforced **inside the extension**, re-derived from its own
state. The panel's controls are a convenience, not the gate — a UI cannot be
trusted to guard an irreversible action.

| Condition | Why |
|---|---|
| A scan completed **in this page session** | A checkpoint left over from a previous load has provenance nobody can vouch for. Re-scan instead. |
| Filters **unchanged** since that scan | A matched set is only meaningful under the filters that produced it. |
| Dry-run explicitly turned off | The default, re-asserted on every load, never persisted. |
| The exact item count typed in | A number you have to read and retype is a number you have looked at. |
| The 5-item test run done **and confirmed** | Full runs stay locked until you have checked by hand that a real deletion did what you expected. |
| Vetoes re-evaluated at dispatch | `keepIdList` and `excludePinned` are re-applied against live settings, never trusted from the scan. |
| A circuit breaker that aborts the run | 5 consecutive failures, or a single validation error or non-429 4xx, ends the run. A wrong request shape does not fix itself by retrying, and every further dispatch would be a wasted write. |

**Verb selection is the part to read closely.** A post or reply is deleted via
`DeleteTweet` against **its own id**. A retweet is undone via `DeleteRetweet`
against the **original post's id** — which belongs to somebody else. Those are
different ids and mixing them up would send a well-formed request naming the
wrong tweet, so a retweet whose original id was never captured is **skipped and
reported**, never falls back to anything.

**Outcomes are counted separately** — deleted, already gone, failed, skipped,
and *unverified*. A `200` is not proof of deletion, so success requires a
response shape confirmed against a real live response **for that operation**.

Both write operations now have shapes confirmed against live responses, and
`DeleteRetweet`'s is **stricter**: its response echoes back the id it acted on,
so Surtr checks that the echoed id is the one it sent. A response confirming a
different tweet is treated as a failure and aborts the run immediately.
`DeleteTweet`'s response returns nothing to check against, so it is not given an
invented check — verify what the response actually gives you.

One limitation worth knowing: re-issuing an unretweet against something already
unretweeted returns the same success shape as a real one, so for retweets the
deleted count means *requests that succeeded*, not *retweets that existed and
are now gone*. Re-scan before a run and the distinction does not arise.

### Scope

Posts, replies and retweets. **Likes are not enumerated and not touched.**

---

## Install (unpacked)

1. Clone or download this repository.
2. Open `edge://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the repository folder — the one with
   `manifest.json` in it.
5. Open <https://x.com/home> and make sure you are logged in.
6. Click the Surtr toolbar icon to open the side panel.

## Run a dry-run scan

1. With an x.com tab focused, click **Discover**. All four connection rows
   should turn green.
2. Set your filters. Everything ANDs together; blank means "no filter".
   **Never touch** (pinned post, keep-id list) is applied last and cannot be
   overridden by anything above it.
3. Click **Start dry-run scan**. Counters update after every page.
4. Read the results table. Every row is something a future execution phase
   would act on — check it.
5. **Export JSON and CSV.** This is your pre-deletion record. Keep it.

Exports are written as `surtr-report-<timestamp>.json` / `.csv` and are
gitignored, because they contain your post text, ids and permalinks.

## Filters

| Filter | Meaning |
|---|---|
| `beforeDate` / `afterDate` | Strictly older / newer than the date. |
| `maxLikes` / `minLikes` | Inclusive bounds on the like count. |
| `maxRetweets` | Inclusive upper bound on the retweet count. |
| `includeKinds` | Any of `post`, `reply`, `retweet`. |
| `keywordContains` | Matches if **any** term appears (case-insensitive). |
| `keywordExcludes` | Matches only if **no** term appears. |
| `hasMedia` | Tri-state: has media / no media / don't care. |
| **`excludePinned`** | **Veto.** On by default. |
| **`keepIdList`** | **Veto.** Ids that must never be touched. For a retweet, keeping the original's id also keeps your retweet of it. |

## Phase 2

Phase 2 has landed — see **Deleting** above. It has not yet been run against a
live account: the 5-item test run is the next step, and full runs are locked
until it has been done and confirmed by hand.

## Contributing

Issues and pull requests welcome. Two rules that are not negotiable:

1. **No build step.** No npm, no bundler, no transpiler. If it cannot be read
   directly in the repo, it does not ship.
2. **No network call outside `lib/api.js`,** and no host beyond `x.com`.
