/**
 * Rasterise icons/surtr.svg to the four PNG sizes the manifest asks for.
 *
 * THE SVG IS THE SOURCE OF TRUTH and the PNGs are build output, so they are
 * reproducible rather than opaque binaries someone has to take on trust - the
 * same reason this extension has no build step for its code: what ships and
 * what is in the repo have to be checkable against each other.
 *
 * The S in the SVG is a PATH, not a <text> element. A live <text> renders
 * differently, or not at all, depending on which fonts the rasteriser happens
 * to have, which is exactly the kind of difference that only shows up on
 * someone else's machine.
 *
 *   node tools/build-icons.mjs
 *
 * Uses headless Chromium over CDP - no npm, no bundler, nothing installed.
 * Point CHROME at a binary if the search below does not find one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'icons', 'surtr.svg');
const OUT = path.join(ROOT, 'icons');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Per-size optical corrections.
 *
 * A mark that is right at 128px is not automatically right at 16px: the
 * corner radius scales down into mush and the stem of the S thins out until it
 * reads as grey rather than red. `grow` fattens the path by stroking it in its
 * own colour - the nearest thing to a heavier weight when the glyph is already
 * an outline - and `rx` is the corner radius in VIEWBOX units, so it is chosen
 * to land near 3 device pixels at the small sizes.
 */
const SIZES = [
  { size: 16, rx: 22, grow: 0.5, scale: 1.14 },
  { size: 32, rx: 24, grow: 0.4, scale: 1.06 },
  { size: 48, rx: 26, grow: 0.3, scale: 1.0 },
  { size: 128, rx: 26, grow: 0, scale: 1.0 },
];

const CANDIDATES = [
  process.env.CHROME,
  'C:\\Users\\' + (process.env.USERNAME || '') +
    '\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].filter(Boolean);

function findChrome() {
  const glob = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(glob)) {
    for (const d of fs.readdirSync(glob)) {
      const p = path.join(glob, d, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(p)) CANDIDATES.push(p);
    }
  }
  const hit = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (!hit) {
    console.error('No Chromium found. Set CHROME to a browser binary.');
    process.exit(1);
  }
  return hit;
}

/**
 * The SVG with its corner radius, stroke weight and glyph scale adjusted for
 * one output size. `scale` is about the centre of the tile, so the mark grows
 * into the space rather than drifting off it.
 */
function variant(svg, { rx, grow, scale }) {
  let out = svg.replace(/rx="[\d.]+"/, 'rx="' + rx + '"');
  if (grow > 0) {
    out = out.replace(
      '<path fill="#E5231B"',
      '<path fill="#E5231B" stroke="#E5231B" stroke-width="' + grow +
      '" stroke-linejoin="round" vector-effect="non-scaling-stroke"');
  }
  if (scale && scale !== 1) {
    out = out
      .replace('<path fill="#E5231B"',
        '<g transform="translate(64 64) scale(' + scale + ') translate(-64 -64)">' +
        '<path fill="#E5231B"')
      .replace('</svg>', '</g>\n</svg>');
  }
  return out;
}

const CHROME = findChrome();
const svg = fs.readFileSync(SVG, 'utf8');
const WORK = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'surtr-icons-'));
const PORT = 9500 + (Date.now() % 60);

const child = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + path.join(WORK, 'profile'),
  'about:blank',
], { stdio: 'ignore' });

const cdp = (ws) => {
  const c = { ws, id: 0, pending: new Map() };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id !== undefined && c.pending.has(m.id)) {
      const { resolve, reject } = c.pending.get(m.id);
      c.pending.delete(m.id);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
  });
  c.send = (method, params = {}) => {
    const id = ++c.id;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => c.pending.set(id, { resolve: res, reject: rej }));
  };
  return c;
};

try {
  let version = null;
  for (let i = 0; i < 80 && !version; i += 1) {
    await sleep(250);
    try {
      version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    } catch { /* not up yet */ }
  }
  if (!version) throw new Error('Chromium did not come up on port ' + PORT);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const page = cdp(ws);
  await page.send('Page.enable');

  for (const spec of SIZES) {
    const { size } = spec;
    const doc = '<!doctype html><meta charset="utf-8">' +
      '<style>html,body{margin:0;padding:0;background:transparent}' +
      `svg{display:block;width:${size}px;height:${size}px}</style>` +
      variant(svg, spec);

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: size, height: size, deviceScaleFactor: 1, mobile: false,
    });
    // Transparent outside the rounded corners, rather than white.
    await page.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    await page.send('Page.navigate', {
      url: 'data:text/html;base64,' + Buffer.from(doc, 'utf8').toString('base64'),
    });
    await sleep(400);

    const shot = await page.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: size, height: size, scale: 1 },
    });
    const file = path.join(OUT, `icon-${size}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`icon-${size}.png  ${fs.statSync(file).size} bytes` +
      (spec.grow ? `  (rx ${spec.rx}, weight +${spec.grow})` : ''));
  }
  ws.close();
} finally {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
  await sleep(500);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
}
