# Surtr

**Delete your own X posts, replies and reposts in bulk — from your own
browser.** Surtr reads your account, shows you exactly what matches your
filters, and deletes only what you have looked at and approved. There is no
server, no account, and nothing is uploaded.

By [GrimnirWorks](https://grimnirworks.com) · GrimnirWorks · niamain@gmail.com
Licensed [AGPL-3.0](LICENSE).

---

## What it does

1. **Scan.** Surtr walks the three timelines X splits your profile into —
   posts, reposts, replies — and builds a list of everything it can reach.
   Scanning changes nothing.
2. **Review.** You get the matching items on screen, with their full text and a
   link to each one, plus JSON and CSV exports. This is the list. What you see
   is what would be deleted.
3. **Delete.** Only after you have armed it, typed the count, and — the first
   time — deleted five items and confirmed by hand that the right five are gone.

**Start with five.** Surtr enforces this on a full run rather than suggesting
it, because five deletions you have personally checked tell you more about
whether the tool is doing what you think than any amount of reading. It takes a
minute and it is the difference between finding a mistake at five items and
finding it at five hundred.

> ### Deleting is permanent
>
> Neither Surtr nor X can undo it. There is no trash, no restore, no
> thirty-day window.
>
> Surtr opens **not armed** every time, and the armed state is never persisted.
> A deletion requires: a completed scan from the current page session, filters
> unchanged since that scan, an explicit arm toggle, the exact item count typed
> in, and — for a full run — a completed and confirmed 5-item test run. Every
> one of those is re-checked *inside the extension*, not just in the panel.

### The kill log is the only record

Surtr writes each item into a **kill log before** its delete request is sent, so
a crash or an abort still leaves a record of what was attempted. It holds the
full text, ids and permalinks of posts that no longer exist anywhere else.

**It is never written to disk automatically.** When a run ends, Surtr says the
log exists and puts the download buttons in front of you. Deciding when your
deleted posts reach a filesystem is yours, not the tool's — an automatic write
is the tool's decision no matter how it is gated, so the code path that did it
was deleted rather than disabled. Exports and kill logs are also `.gitignore`d,
in case one is ever moved into a repository.

---

## Honest limitations

Read these before trusting a count.

### X only serves about 3,200 entries of your own history

X stops serving your older posts through this timeline somewhere around
**3,200 entries per stream**. This is not a bug in Surtr and there is no way
around it from a browser.

When enumeration ends, Surtr tells you *why* — cursor genuinely exhausted, or
stopped near the ceiling — per stream, never collapsed into one verdict, because
a run can exhaust one stream cleanly and hit the ceiling on another. If it looks
like the ceiling it says so:

> Reached X's timeline limit at N items. Older entries exist and are still
> publicly reachable by direct URL, but this method cannot see them. Requesting
> your X data archive is the only complete enumeration.

If you need genuinely complete coverage, request your archive from X first.

### A filtered scan makes no claim about the rest of your account

If your filters exclude a whole kind, that stream is never walked. Surtr treats
that as **scope, not a shortfall** — it is what you asked for, and reporting your
own filter back to you as a gap would be false.

But it also cannot then tell you how complete the scan was, because X publishes
one account-wide total and no per-stream totals. So a filtered scan makes the
weaker claim, explicitly:

> Every stream Surtr walked ran to completion — no ceiling hit, no failure, no
> cursor exhaustion. That is a statement about the posts stream only. X
> publishes no per-stream totals, so there is no number to check this against:
> Surtr cannot give you a percentage of your account here, and this is **not** a
> claim that your account holds nothing else.

A full three-stream scan *can* be checked against X's total, and there you get
the real comparison — including, when it comes up short, a red banner saying so.
A stream that was actually walked and hit the ceiling, failed, or stopped early
still warns, filtered or not.

### For reposts, "already gone" is indistinguishable from success

Re-issuing an unretweet against something already unretweeted returns the same
success shape as a real one. So for reposts the deleted count means *requests
that succeeded*, not *reposts that existed and are now gone*. Re-scan before a
run and the distinction does not arise. `DeleteTweet` does not have this problem.

### A clean run is not the same as a complete one

A stream running out of cursor says that stream ended; it says nothing about
whether your account was fully enumerated. On a full scan Surtr compares what it
enumerated against X's total and, if it is materially short, says so:

> INCOMPLETE: 604 of 2616 items X reports for this account (23%). 2012
> unaccounted for. Do not treat these results as the full account.

An export carries `"complete": true` only when every stream in scope finished
cleanly and — on a full scan — there is no unexplained shortfall; otherwise
`"complete": false` with an `incompleteReason`. That rule exists because an
earlier build reported a run as complete having seen 23% of an account. Every
stream really had exhausted its cursor, and the conclusion was still wrong.

### Scope

Posts, replies and reposts. **Likes are not enumerated and not touched.**

---

## Why you can trust this

A tool that deletes your posts in bulk is asking for an enormous amount of
trust. The only honest way to earn it is to be small enough to read.

### Every permission, and why

**Surtr requests exactly two permissions.** Both are listed here in full.

| Permission | Why it is here | What it would mean if it were missing |
|---|---|---|
| `storage` | Filter settings, the scan checkpoint, discovered query ids, the results and the kill log. Everything durable lives here because MV3 kills the service worker at will. | Closing the tab mid-scan would lose the run. |
| `sidePanel` | The UI is a side panel so it can sit next to x.com while a scan runs. | The UI would have to be a popup, which closes the moment you click away — and closing it must not stop a scan. |

Separately, one host permission — `https://x.com/*`, and nothing else. That is
the job itself: the content script runs in x.com's origin, which is what lets
the browser attach your session cookie without Surtr ever handling it.

The manifest also declares an `icons` block and an `action.default_icon`. Those
are asset paths, not permissions, and grant nothing.

**Not requested, deliberately:**

- `downloads` — exports use a blob URL and an anchor click from the panel
  (`ui/panel.js`, `download()`), which needs no permission. Asking for the
  ability to write files the user never requested, in order to save a file the
  user just clicked a button to save, is a bad trade.
- `unlimitedStorage` — X's timeline stops at roughly 3,200 entries per stream,
  comfortably inside the default quota.
- `tabs` — the relay finds an x.com tab using the host permission alone.
- `cookies` — the only cookie Surtr reads is `ct0`, from `document.cookie` in
  the page's own origin.
- `scripting`, `webRequest`, `<all_urls>`, and any host beyond x.com.

### Surtr never handles your credentials

Your X session lives in the `auth_token` cookie, which is `HttpOnly` — script
cannot read it. Surtr does not try, and does not need to: `content/executor.js`
runs **in the x.com origin**, so `fetch(..., {credentials: 'include'})` makes
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
  pages structurally cannot open a connection to any other host.
- **The content script has no special reach of its own.** It is not covered by
  that CSP — content scripts run in the page's world, and MV3's
  `extension_pages` policy does not apply to them. It does not get extra reach
  from the host permission either: under Manifest V3 a content script follows
  the **host page's** CORS policy and does *not* inherit the extension's host
  permissions. (That bypass existed under MV2 and was deliberately removed.) So
  its reach is an ordinary x.com script's reach, no more.

  Being precise, that is still not "impossible": any script in any page can fire
  a `no-cors` request whose response it cannot read, so this README will not
  claim otherwise. What is true is the thing you can count.

### The four `fetch` call sites

There are **four** `fetch` calls in this repository. Two reach the network; two
do not reach anything outside x.com or the extension itself. Here is all of
them, so that a reader who counts finds exactly what this says they will:

| # | Where | What it does |
|---|---|---|
| 1 | `lib/api.js` — in `gql()` | **GET** to `https://x.com/i/api/graphql/<queryId>/<operation>`. `credentials: 'include'`. Every read: the timeline walk and the account lookup. |
| 2 | `lib/api.js` — in `gqlPost()` | **POST** to the same GraphQL base. `credentials: 'include'`. **The only write in the project** — `DeleteTweet` and `DeleteRetweet` both go through here and nowhere else. |
| 3 | `lib/discovery.js` — in `fetchText()` | Re-reads an X JavaScript bundle **the page has already loaded** — an `abs.twimg.com` URL harvested from the page's own `<script>` tags — with **`credentials: 'omit'`**, to read the bearer token and query ids out of it. No cookie is sent. |
| 4 | `lib/build.js` — in `computeBuildId()` | **Not a network call.** `fetch(chrome.runtime.getURL(rel))` reads the extension's *own* files off disk to hash them into the build fingerprint shown in the panel. It cannot reach a remote host; the URL scheme is `chrome-extension://`. |

So the network surface is: **x.com, plus one already-loaded script bundle from
`abs.twimg.com` fetched without credentials.** There is no backend, no account,
no telemetry, no update channel and no remote config.

One more host appears in the source and is worth naming so that grepping for
hosts holds no surprises: `donate.grimnirworks.com`, in `ui/panel.js`. It is the
target of the heart link in the panel header — opened in a new tab if you click
it, never fetched, and never contacted otherwise.

### There is no build step for anything that runs

No npm, no bundler, no TypeScript, no minifier, no transpiler. **The code you
load is the code in this repository, byte for byte.** Loading unpacked points
Chrome or Edge directly at the repo directory. There is no compiled artifact
that could differ from what you read, which is the entire reason the project is
structured this way.

Two things under `tools/` are worth knowing about before you find them and
wonder:

- **`tools/build-id.mjs`** computes the build fingerprint the panel displays. It
  reads the file list out of `lib/build.js` so the two implementations cannot
  drift. It ships nothing.
- **`tools/build-icons.mjs`** rasterises `icons/*.png` from `icons/surtr.svg`
  using headless Chromium. It is a one-off asset generator, not a build step for
  shipped code.

That leaves `icons/*.png` as the only files in the tree you cannot audit by
reading them. They are reproducible: `icons/surtr.svg` is readable text, the
letterform is a **path** rather than a `<text>` element — a live `<text>` renders
differently, or not at all, depending on which fonts the rasteriser has — and
`node tools/build-icons.mjs` regenerates the PNGs from it.

Unlike GrimnirWorks' `claude-kb` extension, there is **no second live directory
and no native messaging host** here. Nothing is copied anywhere, so the
path-derived extension ID is not load-bearing and there is nothing to keep in
sync — you can move this folder wherever you like.

### Audit it in five minutes

Every command below was run against this tree while this README was written.

```sh
# 1. Every request that can WRITE. Exactly one POST call site: lib/api.js
#    gqlPost. NOTE: this prints TWO lines. The second, api.js:505, is a
#    diagnostic record written into the kill log - a description of the
#    request, not a request. Read both and you will see it.
grep -rn "method: 'POST'" --include=*.js .

# 2. Every operation name that can be constructed. Nine. Two of them delete.
grep -rhoE "'(Delete[A-Za-z]+|User[A-Za-z]+)'" --include=*.js lib/ content/ | sort -u

# 3. What decides WHICH id gets deleted - the most dangerous logic here.
#    Read planItem(): posts and replies target their own id, reposts target
#    the ORIGINAL post via sourceTweetId, and anything else is skipped.
grep -n "planItem" -A 40 lib/execute.js

# 4. What can open the gate. Every condition is re-checked in the executor.
grep -n "checkArmed" -A 45 lib/execute.js

# 5. Every fetch. FOUR call sites - see the table above for what each is.
grep -rn "fetch(" --include=*.js .

# 6. Every host that appears anywhere in the JavaScript. THREE, and only two
#    are fetched: x.com, and abs.twimg.com for the bundle. The third is
#    donate.grimnirworks.com in ui/panel.js - a link that opens in a new tab
#    when you click the heart, never fetched, never contacted otherwise.
grep -rhoE "https://[a-z0-9.]+|abs\.twimg\.com" --include=*.js . | sort -u

# 7. Nothing reads or stores your session token. Two hits, both comments,
#    in content/executor.js and lib/api.js.
grep -rni "auth_token" --include=*.js .

# 8. The tests. Four files, 392 assertions, no dependencies.
for f in tests/*.test.mjs; do node "$f"; done
```

Then read the files in this order. It is **5,628 lines** of JavaScript across
`lib/`, `content/`, `ui/panel.js` and `background.js`, a large share of it
comments explaining why, plus 2,039 lines of tests:
`manifest.json` → `content/executor.js` → `lib/api.js` → `lib/enumerate.js` →
`lib/execute.js`.

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
      +-- lib/enumerate.js   cursor walk, normalization, the author gate
      +-- lib/streams.js     three-stream planning, merge, completeness
      +-- lib/filters.js     pure predicates, no I/O
      +-- lib/execute.js     verb selection, arm gate, grading, circuit breaker
      +-- lib/killlog.js     written BEFORE each delete request
      +-- lib/store.js       chrome.storage.local, checkpointing
      +-- lib/build.js       build fingerprint over the shipped files
```

**Nothing is hardcoded that X can rotate.** The bearer token and the GraphQL
`queryId`s are scraped out of the JS bundle the page is already running. Every X
bulk-delete tool that hardcodes those is broken within weeks of the next
frontend build. If discovery fails, Surtr says so and offers a manual override —
it never falls back silently to a remembered id, because a stale `queryId`
returns a 404 that looks exactly like "your posts are gone".

X has already renamed these once during development: `UserTweetsAndReplies`
disappeared from the live site entirely and was replaced by the three
tab-scoped operations Surtr now uses — `UserOriginalsTimeline`,
`UserRepostsTimeline` and `UserRepliesTimeline`. The panel only ever shows an
operation as *confirmed live* once it has actually answered.

**Rate limits are observed, not assumed.** There is no requests-per-window
constant anywhere in this repo. Surtr reads `x-rate-limit-remaining` and
`x-rate-limit-reset` off every response, tracks them **separately per
operation** (different endpoints carry different budgets, so a merged figure
would be wrong for both), shows them live, and on a `429` sleeps until the reset
plus a pad and halves its concurrency. What it observed goes to the activity log.

**Feature negotiation.** X's GraphQL reads require a `features` object whose
required keys change constantly; a missing key returns a `400` that names the
feature. Surtr starts from a short seed set, reads the missing name out of the
error, adds it and retries — up to `MAX_NEGOTIATION_ROUNDS` (25), then fails
loudly with the raw error. A `429` does not consume a negotiation round. The
negotiated set is saved and reused.

**Checkpointing.** The executor writes to storage after *every* page during a
scan and after *every item* during a delete run. Reloading the tab or losing the
service worker costs you one page, not the run. A walk is also bounded by
`MAX_PAGES_PER_STREAM` (500) so a cursor that never terminates cannot loop
forever — and if that bound is what stopped a stream, the report says so and
calls the result a floor.

### The author gate

This is the safety-critical part of the parser, and it is worth understanding.

**Your replies do not arrive alone.** X returns a reply wrapped in a conversation
module — a thread — that also contains the posts it is replying to and the
replies around it, all written by other people. The same responses carry
who-to-follow modules and other injected content. A parser that walked entries
naively would happily hand you other people's posts as candidates for deletion.

So `collectEntries()` accepts an item only when all three hold:

1. the entry is a `TimelineTimelineItem` (or an item inside a
   `profile-conversation` / `VerticalConversation` module),
2. its `itemContent.__typename` is `TimelineTweet`, and
3. **`tweet.legacy.user_id_str` equals your own user id**, resolved at runtime.

The third is the one that matters, and it **fails closed**: called without an
expected user id, `collectEntries()` accepts nothing at all. Everything rejected
is counted and shown by reason, so the gate doing its job is visible rather than
silent.

**Measured, not promised.** A real captured replies response was run through the
real parser: 20 items enumerated, all replies; **0 foreign author ids in the
output** on a page containing 18 other authors; **0 foreign tweet ids** on a page
containing 19 other people's tweets; 19 rejections, every one recorded as
`profile-conversation (FOREIGN AUTHOR)`. On the full validated three-stream run —
2,600 items — there were **0 foreign permalinks across the 898 matched items**
and 0 cross-stream duplicates.

### Deleting: what has to be true before anything is destroyed

Every one of these is enforced **inside the extension**, re-derived from its own
state. The panel's controls are a convenience, not the gate — a UI cannot be
trusted to guard an irreversible action.

| Condition | Why |
|---|---|
| A scan completed **in this page session** | A checkpoint left over from a previous load has provenance nobody can vouch for. Re-scan instead. |
| Filters **unchanged** since that scan | A matched set is only meaningful under the filters that produced it. |
| Armed explicitly | The default, re-asserted on every load, never persisted. |
| The exact item count typed in | A number you have to read and retype is a number you have looked at. |
| The 5-item test run done **and confirmed** | Full runs stay locked until you have checked by hand that a real deletion did what you expected. |
| Vetoes re-evaluated at dispatch | `keepIdList` and `excludePinned` are re-applied against live settings, never trusted from the scan. |
| A circuit breaker that aborts the run | `CONSECUTIVE_FAILURE_LIMIT` (5) consecutive failures, or a single validation error or non-429 4xx, ends the run. A wrong request shape does not fix itself by retrying, and every further dispatch would be a wasted write. |

**Verb selection is the part to read closely.** A post or reply is deleted via
`DeleteTweet` against **its own id**. A repost is undone via `DeleteRetweet`
against the **original post's id** — which belongs to somebody else. Those are
different ids, and mixing them up would send a well-formed request naming the
wrong tweet, so a repost whose original id was never captured is **skipped and
reported**, never falls back to anything. The two operations do not even share a
variables builder: each has its own table, because one sharing bug is all it
takes to send `tweet_id` where `source_tweet_id` was meant.

**Outcomes are counted separately** — deleted, already gone, failed, skipped,
*deferred*, and *unverified-ok*. None absorbs another.

- A rate-limited item is **deferred**, never failed: it is retried after the
  window, up to `MAX_WRITE_ATTEMPTS` (3), and if the retries run out it is
  reported as still existing so a re-scan picks it up. A 429 is not a refusal.
- A `200` is not proof of deletion. Success requires a response shape confirmed
  against a real live response **for that operation**, keyed per operation so
  knowledge about one cannot leak into a claim about the other.
- `DeleteRetweet`'s check is **stricter**, because its response echoes back the
  id it acted on: Surtr checks the echoed id is the one it sent. A response
  confirming a **different** tweet is a failure and aborts the run immediately.
  A response with **no** id to check — which happens when the original post no
  longer exists — is **unverified-ok**, not a failure. An absent answer is not a
  negative answer.
- `DeleteTweet`'s response returns an empty result on success, and that empty
  result *is* the confirmation. It is not given an invented check.

### What has actually been run

Understating what a deletion tool has done would be its own kind of dishonesty,
so, precisely. Every figure below is recorded in
[DEV.md](DEV.md#recorded-run-results) under *Recorded run results*.

**Scanning is validated live.** One three-stream run enumerated **2,600 of the
2,616 items X reported for the account (99%)**, `complete: true`, 0 cross-stream
duplicates, 0 foreign permalinks across the 898 matched items, and 2 rate limits
on the replies stream, both recovered with every item retrieved.

| stream | pages | enumerated |
|---|---|---|
| posts | 25 | 480 |
| reposts | 8 | 124 |
| replies | 101 | 1,996 |
| **total** | **134** | **2,600** |

**Deleting has been run against a live account, and 576 items are gone.** Both
write operations have success shapes **captured from real responses to real
deletions** — that is where `CONFIRMED_SUCCESS_SHAPES` came from; they are not
guesses.

| run | dispatched | outcome |
|---|---|---|
| two 5-item test runs | 10 | 10 deleted, hand-verified: targets gone, controls untouched |
| posts | 447 | 445 deleted, 2 deferred on a 429 |
| deferred follow-up | 2 | 2 deleted |
| reposts | 119 | 118 confirmed by echoed id, 1 unverified-ok |
| **total** | **578** | **576 deleted** |

The Reposts tab is empty. Five of the 119 reposts had already been unretweeted
by the earlier tests and still returned success — the already-gone limitation
above, observed rather than theorised.

**The external check reconciles exactly — once you know why the count reads
low.** X's own reported account total moved **2,616 → 2,035** over the session, a
drop of **581** against **576 deleted**. Those 5 are not missing deletions. They
are 5 reposts undone during `DeleteRetweet`'s first test runs, **before that
operation's success shape had been confirmed**, so they graded `unverified` and
were excluded from the deleted count by design. X counted them; Surtr declined
to.

Checked against the kill logs rather than assumed — 581 distinct
`(operation, target)` pairs were dispatched against, the 5 appear in no other
run, and nothing is double-counted:

```
457 DeleteTweet + 119 DeleteRetweet = 576   what Surtr reported deleted
457 DeleteTweet + 124 DeleteRetweet = 581   what X's account total moved
```

**This is worth understanding before you trust any deleted count, including your
own.** A `200` is not proof of deletion, so Surtr never counts an item whose
operation has no confirmed success shape. The consequence is arithmetical:

> Any deleted total computed before an operation's success shape was confirmed
> reads **low** against X's own accounting — by exactly the number of items that
> operation dispatched successfully while still unverified.

The count is conservative on purpose, and conservative means biased, not merely
cautious. The tool would rather under-claim than tell you something is gone
when it cannot prove it.
---

## Install (unpacked)

1. Clone or download this repository.
2. Open `edge://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the repository folder — the one with
   `manifest.json` in it.
5. Open <https://x.com/home> and make sure you are logged in.
6. Click the Surtr toolbar icon to open the side panel.

## Scanning

1. With an x.com tab open, click **Connect**. The line above the button tells
   you whether Surtr found what it needs. If something is wrong, open
   **Diagnostics** underneath — ten rows covering the access token, the account
   lookup, each of the three timelines and both delete operations, plus a manual
   override if automatic discovery fails.
2. Set your filters. Everything ANDs together; blank means "no filter".
   **Always keep** (your pinned post, the keep-id list) is applied last and
   cannot be overridden by anything above it.
3. Click **Start dry-run scan**. Counters update after every page, and the scan
   is resumable — if it stops, the button offers to resume from the last cursor.
4. Read the results. Every item shown is something a delete run would act on.
5. **Save the list as JSON and CSV.** This is your pre-deletion record.

Exports are written as `surtr-report-<timestamp>.json` / `.csv`, and kill logs as
`surtr-killlog-<timestamp>.json` / `.csv`. All four patterns are gitignored,
because they contain your post text, ids and permalinks.

## Filters

| Filter | Meaning |
|---|---|
| `beforeDate` / `afterDate` | Strictly older / newer than the date. |
| `maxLikes` / `minLikes` | Inclusive bounds on the like count. |
| `maxRetweets` | Inclusive upper bound on the repost count. |
| `includeKinds` | Any of `post`, `reply`, `retweet`. Excluding a kind means that stream is not walked at all. |
| `keywordContains` | Matches if **any** term appears (case-insensitive). |
| `keywordExcludes` | Matches only if **no** term appears. |
| `hasMedia` | Tri-state: has media / no media / don't care. |
| **`excludePinned`** | **Veto.** On by default. |
| **`keepIdList`** | **Veto.** Ids that must never be touched. For a repost, keeping the original's id also keeps your repost of it. |

Both vetoes are evaluated **last** and re-evaluated again at dispatch.

## Tests

```sh
for f in tests/*.test.mjs; do node "$f"; done
```

Four files, **392 assertions**, no dependencies and no test runner — plain
`node`. Each file also asserts a **minimum assertion count**, because an earlier
edit silently deleted about fifty assertions and the suite still printed
`ALL PASS`. A suite that cannot notice its own removal is not a safety net.

## Support

Surtr is free and AGPL-licensed, and nothing in it is held back — no paid tier,
no key, no feature behind a wall. If it saved you an afternoon of clicking, there
is a tip jar at
[donate.grimnirworks.com](https://donate.grimnirworks.com/), also reachable from
the heart in the panel header. Bug reports and pull requests are worth just as
much.

## Contributing

Issues and pull requests welcome. Two rules that are not negotiable:

1. **No build step for shipped code.** No npm, no bundler, no transpiler. If it
   cannot be read directly in the repo, it does not ship.
2. **No network call outside `lib/api.js`,** and no host beyond `x.com` — with
   the single documented exception of the already-loaded bundle re-read in
   `lib/discovery.js`, with credentials omitted.
