/**
 * Build fingerprint: which code is actually loaded right now.
 *
 * WHY THIS EXISTS. A 45-minute live run was interpreted against the wrong
 * build - the extension had not been reloaded, so a run that appeared to test
 * new parser code was actually exercising the old, and the results read as a
 * regression in code that was never running. There was no way to tell from the
 * panel which build was loaded, and "did you reload?" is not a diagnostic.
 *
 * THE FINGERPRINT IS COMPUTED FROM THE LOADED FILES, not written down. A
 * hand-maintained version string answers the question you asked it, not the
 * question you meant: it says what someone last remembered to type, which is
 * exactly the failure mode when the thing you doubt is whether the code on disk
 * is the code in memory. Hashing what the browser actually loaded cannot drift,
 * because there is nothing to keep in sync.
 *
 * `tools/build-id.mjs` computes the identical value from a working tree, so a
 * fingerprint in the panel can be checked against any commit:
 *
 *     node tools/build-id.mjs            # this working tree
 *
 * If the panel and that disagree, the browser is running something other than
 * this working tree. That is the whole point.
 *
 * This module is a LEAF, like everything under lib/.
 */

/**
 * Every file whose contents define behaviour, in a fixed order.
 *
 * Order is part of the hash, so this list must not be reordered casually. CSS
 * is included: a purely visual change still changes what you are looking at
 * when you compare two runs.
 */
export const BUILD_FILES = [
  'manifest.json',
  'background.js',
  'content/executor.js',
  'lib/api.js',
  'lib/build.js',
  'lib/discovery.js',
  'lib/enumerate.js',
  'lib/execute.js',
  'lib/filters.js',
  'lib/killlog.js',
  'lib/store.js',
  'lib/streams.js',
  'ui/panel.html',
  'ui/panel.css',
  'ui/panel.js',
];

/**
 * Separator between per-file records in the hashed input.
 *
 * A NAMED CONSTANT MADE OF PRINTABLE CHARACTERS, deliberately. This started as
 * an inline separator containing a space, and a stray NUL byte replaced that
 * space in the shipped file. The hash changed while the source looked identical
 * in every editor; the only outward sign was grep calling the file binary. Two
 * implementations of the same fingerprint then disagreed for a reason that was
 * invisible on the page - which is precisely the failure this whole module
 * exists to prevent, so it is worth the constant.
 *
 * `tools/build-id.mjs` reads this value out of this file rather than restating
 * it, and `tests/build.test.mjs` fails on any control byte anywhere in the tree.
 */
export const SEPARATOR = '\n--\n';

/** Normalise line endings so a checkout with CRLF hashes the same as one without. */
export function normalize(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/** One file's contribution: path, length and contents, so a rename or a
 * truncation changes the result as surely as an edit does. */
export function record(rel, text) {
  return rel + '\n' + text.length + '\n' + text;
}

/** Hex SHA-256 of a string, via SubtleCrypto (extension pages are secure contexts). */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fingerprint the running extension.
 *
 * Reads each file back through chrome.runtime.getURL - i.e. the bytes the
 * browser has, not the bytes on disk.
 *
 * Returns { id, files, missing }. `id` is the first 12 hex characters, which is
 * plenty to distinguish builds by eye and short enough to read out.
 */
export async function computeBuildId() {
  const parts = [];
  const missing = [];

  for (const rel of BUILD_FILES) {
    try {
      const res = await fetch(chrome.runtime.getURL(rel));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      parts.push(record(rel, normalize(await res.text())));
    } catch {
      // A file that cannot be read is itself part of the identity - two builds
      // differing only in a missing file must not fingerprint the same.
      missing.push(rel);
      parts.push(rel + '\nMISSING\n');
    }
  }

  const full = await sha256Hex(parts.join(SEPARATOR));
  return { id: full.slice(0, 12), files: BUILD_FILES.length, missing };
}
