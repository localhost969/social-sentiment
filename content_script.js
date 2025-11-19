/* Content script to run on x.co / twitter pages.
 * - Finds post elements
 * - Extracts text
 * - Sends text to background service worker to get sentiment
 * - Shows sentiment UI in the post
 */

const SENTIMENT_MARKER_ATTR = 'data-ps-sentiment';
const SENTIMENT_UI_CLASS = 'ps-sentiment-ui';

// Helpful selectors; X/Twitter uses articles for posts; also fallback to div[data-testid="tweet"]
const POST_SELECTOR = 'article[role="article"], div[data-testid="tweet"]';

// Cache sentiment results to re-apply visuals when the page re-renders and
// elements are replaced (which happens often while scrolling on X/Twitter).
const sentimentCache = new Map(); // key -> { labelScores: [] }

function cacheKeyFor(postId, text) {
  // Prefer persistent postId; fallback to a trimmed text hash/key
  if (postId) return `id:${postId}`;
  const keyText = (text || '').slice(0, 200);
  return `text:${keyText}`;
}

function saveToCache(postId, text, labelScores) {
  const key = cacheKeyFor(postId, text);
  sentimentCache.set(key, { labelScores });
}

function getFromCache(postId, text) {
  const key = cacheKeyFor(postId, text);
  return sentimentCache.get(key);
}

function applySentimentSummary(articleEl, labelScores) {
  if (!Array.isArray(labelScores) || labelScores.length === 0) return;
  // Ensure container for absolute positioned summary
  articleEl.classList.add('ps-sentiment-container');

  // Build a score map to display consistent order
  const scoreMap = { negative: 0, neutral: 0, positive: 0 };
  labelScores.forEach((s) => {
    if (s && s.label) scoreMap[String(s.label).toLowerCase()] = Number(s.score) || 0;
  });

  const best = labelScores.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });
  const bestLabel = (best && best.label) ? String(best.label).toLowerCase() : 'neutral';
  const bestPct = Math.round(best.score * 100);

  const negPct = Math.round((scoreMap.negative || 0) * 100);
  const neutPct = Math.round((scoreMap.neutral || 0) * 100);
  const posPct = Math.round((scoreMap.positive || 0) * 100);

  // Map labels to consistent display strings (avoid half-spellings like NEUT)
  const displayMap = {
    negative: 'NEGATIVE',
    neutral: 'NEUTRAL',
    positive: 'POSITIVE'
  };

  let summary = articleEl.querySelector('.ps-sentiment-summary');
  if (!summary) {
    summary = document.createElement('div');
    summary.className = 'ps-sentiment-summary';
    articleEl.appendChild(summary);
  }

  // Clean classes and set new
  summary.classList.remove('ps-sentiment-positive', 'ps-sentiment-neutral', 'ps-sentiment-negative');
  summary.classList.add(`ps-sentiment-${bestLabel}`);
  summary.setAttribute('data-label', bestLabel);

  // Render text: show top label accuracy, then the TWO OTHER labels' percentages
  const allLabels = ['negative', 'neutral', 'positive'];
  const otherLabels = allLabels.filter(l => l !== bestLabel);
  // Display the remaining two labels ordered by their score desc so the more
  // likely of the two shows first (more informative than a fixed order).
  const sortedOtherLabels = otherLabels
    .map(l => ({ label: l, score: scoreMap[l] || 0 }))
    .sort((a, b) => b.score - a.score)
    .map(item => item.label);
  const otherStr = sortedOtherLabels.map((l) => `${displayMap[l]} ${Math.round((scoreMap[l] || 0) * 100)}%`).join(' • ');

  summary.innerText = `${displayMap[bestLabel]} ${bestPct}%\n${otherStr}`;
  summary.setAttribute('title', `${displayMap[bestLabel]} ${bestPct}%\n${displayMap.negative}: ${negPct}%\n${displayMap.neutral}: ${neutPct}%\n${displayMap.positive}: ${posPct}%`);
}

function applySentimentToElement(articleEl, labelScores) {
  if (!Array.isArray(labelScores) || labelScores.length === 0) return;
  const best = labelScores.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });
  const label = (best && best.label) ? String(best.label).toLowerCase() : 'neutral';
  const classMap = { positive: 'ps-sentiment-positive', neutral: 'ps-sentiment-neutral', negative: 'ps-sentiment-negative' };
  const sentimentClass = classMap[label] || classMap.neutral;

  articleEl.classList.remove('ps-sentiment-positive', 'ps-sentiment-neutral', 'ps-sentiment-negative', 'ps-sentiment-border');
  articleEl.classList.add('ps-sentiment-container', 'ps-sentiment-border', sentimentClass);
  articleEl.setAttribute('data-ps-sentiment-label', label);
  // Apply the small summary UI to the right
  applySentimentSummary(articleEl, labelScores);
}

function createSentimentElement(label, score) {
  const el = document.createElement('div');
  el.className = SENTIMENT_UI_CLASS;
  const scorePct = (score * 100).toFixed(0);
  // Display friendly uppercase label text
  const displayMap = { negative: 'NEGATIVE', neutral: 'NEUTRAL', positive: 'POSITIVE' };
  const displayLabel = displayMap[String(label).toLowerCase()] || String(label).toUpperCase();
  el.setAttribute('title', `${displayLabel} ${scorePct}%`);
  el.innerText = `${displayLabel} ${scorePct}%`;
  // Set data attribute for CSS color styling
  el.setAttribute('data-label', label);
  el.classList.add('ps-inline');
  return el;
}

function getPostId(articleEl) {
  // Look for link that contains /status/ or newer tweet id anchors
  const anchor = articleEl.querySelector('a[href*="/status/"]');
  if (anchor) {
    const m = anchor.getAttribute('href').match(/status\/(\d+)/);
    if (m) return m[1];
  }
  // fallback: check data-testid or other id attributes
  return articleEl.getAttribute('data-testid') || null;
}

function extractTextFromPost(articleEl) {
  // Prefer the tweet text container: data-testid="tweetText"
  const textEl = articleEl.querySelector('[data-testid="tweetText"]');
  if (textEl) {
    return textEl.innerText.trim();
  }
  // Fallback to getting the visible textual content
  const allText = Array.from(articleEl.querySelectorAll('div, span'))
    .map(n => n.innerText)
    .filter(Boolean)
    .join('\n')
    .trim();
  return allText;
}

async function analyzeAndShow(articleEl, text, postId) {
  // Avoid sending duplicates
  if (articleEl.getAttribute(SENTIMENT_MARKER_ATTR) === 'pending' || articleEl.getAttribute(SENTIMENT_MARKER_ATTR) === 'done') {
    return;
  }
  articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'pending');

  // Ask background script to analyze
  chrome.runtime.sendMessage({ type: 'analyze', text: text, postId }, (resp) => {
    if (!resp) {
      console.warn('No response from background script');
      // show a small error marker
      const uiErr = createSentimentElement('ERR', 0);
      uiErr.style.background = '#777';
      articleEl.appendChild(uiErr);
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }
    if (resp.error) {
      console.warn('Error from background:', resp.error);
      const uiErr = createSentimentElement('ERR', 0);
      uiErr.style.background = '#777';
      articleEl.appendChild(uiErr);
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }
    const result = resp.result;
    // The API usually returns array of label/score objects, but sometimes it's
    // wrapped in a nested array (e.g. [ [ {label, score}, ... ] ]). Normalize
    // to a flat array of {label, score} objects before picking the highest.
    if (!Array.isArray(result) || result.length === 0) {
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }

    // Flatten one level if the first item is itself an array.
    let labelScores = result;
    if (Array.isArray(result[0])) {
      // Use native flat if available, otherwise fallback to concat
      if (typeof result.flat === 'function') {
        labelScores = result.flat();
      } else {
        labelScores = result.reduce((acc, arr) => acc.concat(arr), []);
      }
    }

    // Ensure we still have an array and that items contain numeric scores
    labelScores = Array.isArray(labelScores) ? labelScores.filter(item => item && typeof item.score === 'number') : [];
    if (labelScores.length === 0) {
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }

    const best = labelScores.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });

    // Save to cache so we can reapply visual styling if DOM nodes are replaced.
    saveToCache(postId, text, labelScores);

    // Create UI and inject
    // Instead of a small inline UI, add a sentiment border to the whole post.
    // Remove any existing small UI if present
    const existing = articleEl.querySelector(`.${SENTIMENT_UI_CLASS}`);
    if (existing) existing.remove();

    // Normalize label and map to CSS class
    const label = (best && best.label) ? String(best.label).toLowerCase() : 'neutral';
    const classMap = {
      positive: 'ps-sentiment-positive',
      neutral: 'ps-sentiment-neutral',
      negative: 'ps-sentiment-negative'
    };
    const sentimentClass = classMap[label] || classMap.neutral;

    // Clean up any previous sentiment classes and then apply the border class + summary using helper
    applySentimentToElement(articleEl, labelScores);
    articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
  });
}

function processPost(articleEl) {
  if (!articleEl) return;
  // Skip if already processed; however, if the DOM node lost our visuals (class
  // removal by re-render) we'll reapply from cache below.
  const marker = articleEl.getAttribute(SENTIMENT_MARKER_ATTR);

  const text = extractTextFromPost(articleEl);
  if (!text) return;
  const postId = getPostId(articleEl);

    // If we already have a cached result for this post, reapply it and avoid
    // sending another analysis request. This helps keep visuals persistent
    // across DOM replacements that happen on scroll.
    const cached = getFromCache(postId, text);
    if (cached && cached.labelScores) {
      applySentimentToElement(articleEl, cached.labelScores);
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }

    // If this element is already marked 'done', nothing to do; if 'pending', let it be
    if (marker === 'done') return;

  analyzeAndShow(articleEl, text, postId);
}

function scanAndProcessAll() {
  const posts = document.querySelectorAll(POST_SELECTOR);
  posts.forEach((post) => {
    processPost(post);
  });
}

// Observe DOM changes to handle infinite scrolling/new tweets
const observer = new MutationObserver((mutationsList) => {
  let found = false;
  for (const mutation of mutationsList) {
    if (mutation.type === 'childList' && mutation.addedNodes.length) {
      found = true;
      break;
    }
  }
  if (found) {
    // Use a small timeout to allow UI elements to settle
    setTimeout(scanAndProcessAll, 200);
  }
});

// Add basic CSS so UI is visible; also supports re-injection if needed
function injectCss() {
  if (document.getElementById('ps-extension-css')) return;
  const link = document.createElement('link');
  link.id = 'ps-extension-css';
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content_style.css');
  document.head.appendChild(link);
}

function init() {
  injectCss();
  scanAndProcessAll();
  observer.observe(document.body, { childList: true, subtree: true });

  // Also scan periodically to catch inline updates
  setInterval(scanAndProcessAll, 3000);
}

init();
