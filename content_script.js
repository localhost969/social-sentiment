/* ### FLOW:
 * - Finds post elements
 * - Extracts text
 * - Sends text to background service worker to get sentiment
 * - Shows sentiment UI in the post
 */

const SENTIMENT_MARKER_ATTR = 'data-ps-sentiment';
const SENTIMENT_UI_CLASS = 'ps-sentiment-ui';

const POST_SELECTOR = 'article[role="article"], div[data-testid="tweet"]';


const sentimentCache = new Map(); 

function cacheKeyFor(postId, text) {
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
  articleEl.classList.add('ps-sentiment-container');

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

  summary.classList.remove('ps-sentiment-positive', 'ps-sentiment-neutral', 'ps-sentiment-negative');
  summary.classList.add(`ps-sentiment-${bestLabel}`);
  summary.setAttribute('data-label', bestLabel);

  const allLabels = ['negative', 'neutral', 'positive'];
  const otherLabels = allLabels.filter(l => l !== bestLabel);
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
  applySentimentSummary(articleEl, labelScores);
}

function createSentimentElement(label, score) {
  const el = document.createElement('div');
  el.className = SENTIMENT_UI_CLASS;
  const scorePct = (score * 100).toFixed(0);
  const displayMap = { negative: 'NEGATIVE', neutral: 'NEUTRAL', positive: 'POSITIVE' };
  const displayLabel = displayMap[String(label).toLowerCase()] || String(label).toUpperCase();
  el.setAttribute('title', `${displayLabel} ${scorePct}%`);
  el.innerText = `${displayLabel} ${scorePct}%`;
  el.setAttribute('data-label', label);
  el.classList.add('ps-inline');
  return el;
}

function getPostId(articleEl) {
  const anchor = articleEl.querySelector('a[href*="/status/"]');
  if (anchor) {
    const m = anchor.getAttribute('href').match(/status\/(\d+)/);
    if (m) return m[1];
  }
  return articleEl.getAttribute('data-testid') || null;
}

function hasMediaContent(articleEl) {
  const hasImages = articleEl.querySelector('[data-testid="tweetPhoto"], [data-testid="tweet-image"], img[alt], .r-1p0dwe6 img');
  const hasVideo = articleEl.querySelector('[data-testid="videoComponent"], video, [data-testid="tweet-video"]');
  const hasPlayButton = articleEl.querySelector('[aria-label*="video"], [aria-label*="image"]');
  return !!(hasImages || hasVideo || hasPlayButton);
}

function extractTextFromPost(articleEl) {
  const textEl = articleEl.querySelector('[data-testid="tweetText"]');
  if (textEl) {
    const tweetText = textEl.innerText.trim();
    if (tweetText && tweetText.length > 2) {
      return tweetText;
    }
  }
  

  if (hasMediaContent(articleEl)) {
    return '';
  }
  
  const fallbackText = textEl ? textEl.innerText.trim() : '';
  return fallbackText;
}

async function analyzeAndShow(articleEl, text, postId) {
  if (articleEl.getAttribute(SENTIMENT_MARKER_ATTR) === 'pending' || articleEl.getAttribute(SENTIMENT_MARKER_ATTR) === 'done') {
    return;
  }
  articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'pending');

  chrome.runtime.sendMessage({ type: 'analyze', text: text, postId }, (resp) => {
    if (!resp) {
      console.warn('No response from background script');
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
    if (!Array.isArray(result) || result.length === 0) {
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }

    let labelScores = result;
    if (Array.isArray(result[0])) {
      if (typeof result.flat === 'function') {
        labelScores = result.flat();
      } else {
        labelScores = result.reduce((acc, arr) => acc.concat(arr), []);
      }
    }

    labelScores = Array.isArray(labelScores) ? labelScores.filter(item => item && typeof item.score === 'number') : [];
    if (labelScores.length === 0) {
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }

    const best = labelScores.reduce((a, b) => (b.score > a.score ? b : a), { score: -1 });

    saveToCache(postId, text, labelScores);


    const existing = articleEl.querySelector(`.${SENTIMENT_UI_CLASS}`);
    if (existing) existing.remove();

    const label = (best && best.label) ? String(best.label).toLowerCase() : 'neutral';
    const classMap = {
      positive: 'ps-sentiment-positive',
      neutral: 'ps-sentiment-neutral',
      negative: 'ps-sentiment-negative'
    };
    const sentimentClass = classMap[label] || classMap.neutral;

    applySentimentToElement(articleEl, labelScores);
    articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
  });
}

function processPost(articleEl) {
  if (!articleEl) return;
  const marker = articleEl.getAttribute(SENTIMENT_MARKER_ATTR);

  const text = extractTextFromPost(articleEl);
  if (!text) return;
  const postId = getPostId(articleEl);

    const cached = getFromCache(postId, text);
    if (cached && cached.labelScores) {
      applySentimentToElement(articleEl, cached.labelScores);
      articleEl.setAttribute(SENTIMENT_MARKER_ATTR, 'done');
      return;
    }

    if (marker === 'done') return;

  analyzeAndShow(articleEl, text, postId);
}

function scanAndProcessAll() {
  const posts = document.querySelectorAll(POST_SELECTOR);
  posts.forEach((post) => {
    processPost(post);
  });
}

const observer = new MutationObserver((mutationsList) => {
  let found = false;
  for (const mutation of mutationsList) {
    if (mutation.type === 'childList' && mutation.addedNodes.length) {
      found = true;
      break;
    }
  }
  if (found) {
    setTimeout(scanAndProcessAll, 200);
  }
});

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

  setInterval(scanAndProcessAll, 3000);
}

init();
