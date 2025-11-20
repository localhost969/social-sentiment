/* Background service worker (Manifest V3 service worker)
 * - Receives messages from content scripts
 * - Calls the local sentiment API and returns the result
 */

const BACKEND_URL = "https://ps-2025-backend-production.up.railway.app/analyze";

// Simple in-memory cache to avoid duplicate fetches in short time window
const cache = new Map(); // key: textHash -> {timestamp, result}
const CACHE_TTL_MS = 1000 * 60 * 2; // 2 minutes

/* listens to messages from content scripts */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'analyze') return; // ignore
  const { text, postId } = message;
  if (!text) {
    sendResponse({ error: 'No text provided' });
    return;
  }

  // create simple cache key (could be improved)
  const key = `${postId || ''}:${text.slice(0, 200)}`;
  const now = Date.now();
  if (cache.has(key)) {
    const cached = cache.get(key);
    if (now - cached.ts < CACHE_TTL_MS) {
      sendResponse({ result: cached.result, cached: true });
      return; // return cached result
    }
  }

  // Fetch the API and return the JSON
  fetch(BACKEND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  })
    .then(async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text}`);
      }
      return res.json();
    })
    .then((json) => {
      cache.set(key, { ts: now, result: json });
      sendResponse({ result: json });
    })
    .catch((err) => {
      console.error('Error while fetching sentiment:', err);
      sendResponse({ error: String(err) });
    });

  // Indicate we'll send an async response
  return true;
});
