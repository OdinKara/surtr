/**
 * Compute the build fingerprint from a working tree.
 *
 *     node tools/build-id.mjs
 *
 * Prints the same value the panel shows for the loaded extension, so a run can
 * be tied to specific code rather than to a guess about whether the extension
 * was reloaded. If the panel and this disagree, the browser is running
 * something other than this working tree. That is the whole point.
 *
 * The file list AND the separator are read out of lib/build.js rather than
 * restated here. A second copy of either is a second thing to forget - and the
 * separator in particular has already caused these two to disagree once, over a
 * byte that was invisible in an editor.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildSrc = fs.readFileSync(path.join(ROOT, 'lib', 'build.js'), 'utf8');

const listMatch = /export const BUILD_FILES = \[([\s\S]*?)\];/.exec(buildSrc);
if (!listMatch) {
  console.error('could not read BUILD_FILES out of lib/build.js');
  process.exit(2);
}
const files = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const sepMatch = /export const SEPARATOR = '([^']*)';/.exec(buildSrc);
if (!sepMatch) {
  console.error('could not read SEPARATOR out of lib/build.js');
  process.exit(2);
}
// The captured text is a JS string literal body; parse it the same way JS would.
const SEPARATOR = JSON.parse('"' + sepMatch[1] + '"');

const parts = [];
const missing = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    missing.push(rel);
    parts.push(rel + '\nMISSING\n');
    continue;
  }
  const text = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  parts.push(rel + '\n' + text.length + '\n' + text);
}

const full = crypto.createHash('sha256')
  .update(parts.join(SEPARATOR), 'utf8').digest('hex');

console.log('build ' + full.slice(0, 12) + '  (' + files.length + ' files' +
  (missing.length ? ', ' + missing.length + ' MISSING: ' + missing.join(', ') : '') + ')');
