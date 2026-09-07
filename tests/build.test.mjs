/**
 * Tests for the build fingerprint, and a guard against invisible bytes.
 *
 *     node tests/build.test.mjs
 *
 * The control-byte check is here because of a real defect: a stray NUL byte
 * landed inside a string literal in lib/build.js, replacing a space. The source
 * looked identical in every editor, every test passed, and the only outward
 * sign was that grep started calling the file binary - while the panel's
 * fingerprint and the tool's fingerprint silently disagreed.
 *
 * A file whose bytes differ from what its text appears to say is exactly the
 * kind of thing this project keeps being bitten by, so it gets a test rather
 * than a resolution to be careful.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

let fails = 0;
let passes = 0;
const ok = (c, m) => { console.log((c ? '[OK]  ' : '[X]   ') + m); if (c) passes++; else fails++; };

/* ------------------------------------------------------- control bytes --- */

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

const offenders = [];
for (const abs of walk(ROOT)) {
  const b = fs.readFileSync(abs);
  for (let i = 0; i < b.length; i += 1) {
    const c = b[i];
    // Everything below 0x20 except tab (9), LF (10) and CR (13).
    if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
      offenders.push(path.relative(ROOT, abs) + ' byte ' + i + ' = 0x' +
        c.toString(16).padStart(2, '0'));
      break;
    }
  }
}
ok(offenders.length === 0,
   'no control bytes anywhere in the tree' +
   (offenders.length ? ': ' + offenders.join(', ') : ''));

/* ------------------------------------------------------------ contract --- */

const src = fs.readFileSync(path.join(ROOT, 'lib', 'build.js'), 'utf8');

const listMatch = /export const BUILD_FILES = \[([\s\S]*?)\];/.exec(src);
ok(Boolean(listMatch), 'tools/build-id.mjs can find BUILD_FILES in lib/build.js');
const files = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const sepMatch = /export const SEPARATOR = '([^']*)';/.exec(src);
ok(Boolean(sepMatch), 'and can find SEPARATOR - the two implementations share one value');
const SEPARATOR = JSON.parse('"' + sepMatch[1] + '"');
ok([...SEPARATOR].every((ch) => ch === '\n' || (ch >= ' ' && ch <= '~')),
   'the separator is made of printable characters and newlines only');

ok(files.length > 0, 'the build file list is not empty');
for (const rel of files) {
  ok(fs.existsSync(path.join(ROOT, rel)), 'build file exists: ' + rel);
}
ok(files.includes('lib/build.js'),
   'the fingerprint covers lib/build.js itself, so tampering with it changes the id');
ok(files.includes('manifest.json') && files.includes('content/executor.js') &&
   files.includes('ui/panel.js'),
   'the fingerprint covers the manifest, the executor and the panel');

/* -------------------------------------------------------- reproducible --- */

function fingerprint(overrides = {}) {
  const parts = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const text = Object.prototype.hasOwnProperty.call(overrides, rel)
      ? overrides[rel]
      : fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    parts.push(rel + '\n' + text.length + '\n' + text);
  }
  return crypto.createHash('sha256')
    .update(parts.join(SEPARATOR), 'utf8').digest('hex').slice(0, 12);
}

const a = fingerprint();
ok(a === fingerprint(), 'the fingerprint is stable across runs');
ok(/^[0-9a-f]{12}$/.test(a), 'it is 12 hex characters: ' + a);

const changed = fingerprint({ 'lib/filters.js': 'x' });
ok(changed !== a, 'changing one file changes the fingerprint');

// Length is part of each record, so truncation cannot collide with an edit.
const first = files[0];
const original = fs.readFileSync(path.join(ROOT, first), 'utf8').replace(/\r\n/g, '\n');
ok(fingerprint({ [first]: original.slice(0, -1) }) !== a,
   'truncating a file by one character changes the fingerprint');


/* ------------------------------------------------------- coverage floor --- */

/**
 * MINIMUM ASSERTION COUNT.
 *
 * An edit to the execute suite once deleted ~50 assertions - an entire section -
 * and it still printed ALL PASS, because fewer passing tests is
 * indistinguishable from all tests passing. A green signal that means less than
 * it appears is the exact failure class this project keeps meeting.
 *
 * Raise this when adding tests. If it fails after a refactor, tests were lost.
 */
const MIN_ASSERTIONS = 26;
ok(passes + 1 >= MIN_ASSERTIONS,
   'assertion count ' + (passes + 1) + ' is at or above the floor of ' + MIN_ASSERTIONS +
   ' - if this fails, tests were deleted rather than fixed');

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
