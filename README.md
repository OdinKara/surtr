# Surtr

**Bulk X post removal.** Runs entirely in your browser. Nothing is uploaded.

By [GrimnirWorks](https://grimnirworks.com) · GrimnirWorks · niamain@gmail.com
Licensed [AGPL-3.0](LICENSE).

> **Phase 1: this build cannot delete anything.**
> There is no `DeleteTweet` call, no `DeleteRetweet` call, no execution code —
> not disabled, not commented out, not behind a flag. Surtr today enumerates
> your posts, filters them, and shows you exactly what a future execution phase
> *would* act on. Deletion lands only after the scanner has been validated
> against real accounts. You can verify this claim yourself in about ten
> seconds — see [Audit it in five minutes](#audit-it-in-five-minutes).

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
# 1. No deletion request can be built. Both must print nothing.
grep -rn "operationName:.*Delete"       --include=*.js .
grep -rni "method:.*['\"]\(post\|put\|delete\|patch\)" --include=*.js .

# The two words themselves DO appear once each - in a comment in
# lib/enumerate.js explaining what phase 2 will do. Read it and confirm that is
# all it is:
grep -rn "DeleteTweet\|DeleteRetweet" --include=*.js .

# 2. Every network call. There are exactly two call sites.
grep -rn "fetch(" --include=*.js .

# 3. Every host that can be reached: x.com, and abs.twimg.com for the bundle.
grep -rn "https://\|twimg" --include=*.js .

# 4. Nothing reads or stores your session token.
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

## Phase 2 (not in this build)

Execution — `DeleteTweet` for your own posts, `DeleteRetweet` against the
*original* post for retweets — is added only once the scanner is trusted. The
normalizer already records `sourceTweetId` for every retweet so that phase does
not require a second full scan.

## Contributing

Issues and pull requests welcome. Two rules that are not negotiable:

1. **No build step.** No npm, no bundler, no transpiler. If it cannot be read
   directly in the repo, it does not ship.
2. **No network call outside `lib/api.js`,** and no host beyond `x.com`.
