/**
 * Service worker: message relay + side panel opener. Nothing else.
 *
 * ASSUME THIS IS KILLED AT ANY MOMENT. Chrome tears MV3 workers down after ~30
 * seconds of idle and there is no way to prevent it, so this file deliberately
 * holds NO job state, NO counters, NO cursor, and NO discovered values. Every
 * one of those lives in chrome.storage.local, written by the executor, read by
 * the panel. If you find yourself adding a module-scope variable here that
 * matters, it belongs in lib/store.js instead.
 *
 * The relay exists so the panel never has to know which tab is which. It finds
 * an x.com tab, forwards, and returns whatever comes back.
 */

const X_TAB_QUERY = { url: 'https://x.com/*' };

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[surtr] setPanelBehavior:', e));
});

// Also on worker start, because onInstalled only fires on install/update and a
// profile that already had the extension would otherwise never get the behavior
// set after a browser restart.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((e) => console.warn('[surtr] setPanelBehavior:', e));

/** Prefer the active x.com tab; fall back to any x.com tab. */
async function findXTab() {
  const active = await chrome.tabs.query({ ...X_TAB_QUERY, active: true, currentWindow: true });
  if (active.length > 0) return active[0];
  const any = await chrome.tabs.query(X_TAB_QUERY);
  return any[0] || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'SURTR_RELAY') return undefined;

  (async () => {
    try {
      const tab = await findXTab();
      if (!tab) {
        sendResponse({
          ok: false,
          error: 'No x.com tab is open. Open https://x.com/home and try again.',
        });
        return;
      }
      const reply = await chrome.tabs.sendMessage(tab.id, msg.payload);
      sendResponse(reply ?? { ok: false, error: 'The page did not answer.' });
    } catch (e) {
      const detail = String(e && e.message ? e.message : e);
      sendResponse({
        ok: false,
        error:
          /Receiving end does not exist/i.test(detail)
            ? 'The x.com tab has not loaded Surtr yet. Reload that tab and try again.'
            : detail,
      });
    }
  })();

  return true; // async sendResponse
});
