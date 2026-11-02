/**
 * Content Script running in the page context (Chrome Isolated World).
 * Performs deep DOM inspection and communicates with the background service worker.
 * Operates purely through passive DOM inspection and event capture with ZERO prototype modification,
 * making it completely undetectable to webpage anti-tamper scripts.
 */

const registeredUrls = new Set();

/**
 * Filter and normalize candidate media URLs.
 */
function toAbsoluteUrl(url) {
  if (!url) return null;
  try {
    return new URL(url, window.location.href).href;
  } catch (_) {
    return null;
  }
}

/**
 * Soul Browser title sanitizer (MainUtil.p3 + Z6):
 * Strips illegal filename characters, normalizes whitespace and hyphens.
 */
function sanitizeTitle(str) {
  if (!str) return '';
  try {
    let clean = decodeURIComponent(str).replace(/[\\/:*?"<>|]/g, '-').trim();
    clean = clean.replace(/^[\s-]+|[\s-]+$/g, '');
    return clean.substring(0, 150);
  } catch (_) {
    return str.replace(/[\\/:*?"<>|]/g, '-').trim().substring(0, 150);
  }
}

/**
 * Extract human-readable video title from DOM hierarchy.
 */
function getBestVideoTitle() {
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute('content');
  const schemaTitle = document.querySelector('meta[itemprop="name"]')?.getAttribute('content');
  const h1 = document.querySelector('h1')?.innerText?.trim();
  const raw = ogTitle || twitterTitle || schemaTitle || h1 || document.title || 'Video';
  // Strip common branding suffixes
  const stripped = raw.replace(/\s*[-|–—]\s*(YouTube|Vimeo|Dailymotion|Facebook|Twitter|TikTok|Twitch).*$/i, '').trim();
  return sanitizeTitle(stripped) || 'Video';
}

/**
 * Format duration in seconds to MM:SS or HH:MM:SS.
 */
function formatDuration(seconds) {
  if (!seconds || isNaN(seconds) || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const sec = total % 60;
  const min = Math.floor((total / 60) % 60);
  const hrs = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  if (hrs > 0) {
    return `${hrs}:${pad(min)}:${pad(sec)}`;
  }
  return `${min}:${pad(sec)}`;
}

/**
 * Format resolution width & height to standard tag (e.g. 1080p, 720p).
 */
function getResolutionTag(width, height) {
  if (!width && !height) return '';
  const h = height || 0;
  const w = width || 0;
  const minDim = Math.min(w, h);
  const maxDim = Math.max(w, h);

  if (maxDim >= 3800 || minDim >= 2100) return '4K';
  if (maxDim >= 2500 || minDim >= 1400) return '2K';
  if (maxDim >= 1900 || minDim >= 1000) return '1080p';
  if (maxDim >= 1200 || minDim >= 700) return '720p';
  if (maxDim >= 800 || minDim >= 450) return '480p';
  if (maxDim >= 600 || minDim >= 340) return '360p';
  if (minDim > 0) return `${minDim}p`;
  return '';
}

/**
 * Inspect a video element and extract its updated metadata.
 */
function inspectVideoElement(video) {
  const src = video.currentSrc || video.src;
  const sources = Array.from(video.querySelectorAll('source')).map(s => s.src).filter(Boolean);
  const candidates = [src, ...sources].filter(Boolean);
  if (candidates.length === 0) return;

  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;
  const duration = video.duration && !isNaN(video.duration) ? video.duration : 0;
  const poster = video.poster || '';
  const title = getBestVideoTitle();
  const resTag = getResolutionTag(width, height);
  const durationStr = formatDuration(duration);

  const items = [];
  for (const rawUrl of candidates) {
    const absUrl = toAbsoluteUrl(rawUrl);
    if (!absUrl) continue;

    const isM3u8 = absUrl.includes('.m3u8');
    let cleanFilename = title || 'Video';
    if (resTag) cleanFilename += ` (${resTag})`;
    cleanFilename += isM3u8 ? '.mp4' : '.mp4';

    items.push({
      url: absUrl,
      category: 'video',
      title: title || 'Video',
      filename: cleanFilename,
      width,
      height,
      resolutionTag: resTag,
      duration,
      durationFormatted: durationStr,
      poster,
      isStream: isM3u8,
      streamType: isM3u8 ? 'hls' : undefined,
      referer: window.location.href,
      origin: window.location.origin
    });
  }

  if (items.length > 0) {
    chrome.runtime.sendMessage({
      type: 'REGISTER_MEDIA_FROM_DOM',
      payload: { items }
    }).catch(() => {});
  }
}

/**
 * Attach listeners to a video element to capture metadata as soon as it loads.
 */
function hookVideoElement(video) {
  if (video.__downloader_hooked__) return;
  video.__downloader_hooked__ = true;

  ['loadedmetadata', 'canplay', 'playing', 'timeupdate'].forEach(evt => {
    video.addEventListener(evt, () => inspectVideoElement(video), { passive: true });
  });

  inspectVideoElement(video);
}

/**
 * Extract highest-resolution candidate from srcset string.
 */
function parseSrcsetBest(srcsetString) {
  if (!srcsetString) return null;
  const candidates = srcsetString.split(',').map(s => s.trim()).filter(Boolean);
  let bestUrl = null;
  let bestWidth = 0;

  for (const item of candidates) {
    const parts = item.split(/\s+/);
    const url = parts[0];
    const descriptor = parts[1] || '1x';
    const width = descriptor.endsWith('w') ? parseInt(descriptor, 10) : (descriptor.endsWith('x') ? parseFloat(descriptor) * 1000 : 0);
    if (width >= bestWidth) {
      bestWidth = width;
      bestUrl = url;
    }
  }

  return bestUrl || candidates[0]?.split(/\s+/)[0];
}

/**
 * Deep DOM scanning function.
 */
function scanPageMedia() {
  const detected = [];

  // 1. Scan and Hook HTML5 Videos
  document.querySelectorAll('video').forEach((video) => {
    hookVideoElement(video);
  });

  // 2. Scan HTML5 Audio
  document.querySelectorAll('audio').forEach((audio) => {
    const src = audio.currentSrc || audio.src;
    const sources = Array.from(audio.querySelectorAll('source')).map(s => s.src).filter(Boolean);
    const candidates = [src, ...sources].filter(Boolean);

    for (const rawUrl of candidates) {
      const absUrl = toAbsoluteUrl(rawUrl);
      if (absUrl && !registeredUrls.has(absUrl)) {
        registeredUrls.add(absUrl);
        const title = getBestVideoTitle() || 'Audio Track';
        detected.push({
          url: absUrl,
          category: 'audio',
          title,
          filename: `${title}.mp3`,
          duration: audio.duration && !isNaN(audio.duration) ? audio.duration : 0,
          durationFormatted: formatDuration(audio.duration),
          referer: window.location.href,
          origin: window.location.origin
        });
      }
    }
  });

  // 3. Scan High-Resolution Images (Gallery Scraper)
  document.querySelectorAll('img, picture source').forEach((img) => {
    let candidate = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original');
    const srcset = img.getAttribute('srcset');
    if (srcset) {
      const bestFromSrcset = parseSrcsetBest(srcset);
      if (bestFromSrcset) candidate = bestFromSrcset;
    }

    const absUrl = toAbsoluteUrl(candidate);
    if (!absUrl || registeredUrls.has(absUrl)) return;

    // Filter out tiny tracking pixels
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    if (absUrl.startsWith('data:') && absUrl.length < 5000) return;
    if (width > 0 && height > 0 && width < 120 && height < 120) return;

    registeredUrls.add(absUrl);
    const imgTitle = img.alt ? sanitizeTitle(img.alt) : '';
    detected.push({
      url: absUrl,
      category: 'image',
      title: imgTitle || 'Image',
      width,
      height,
      referer: window.location.href,
      origin: window.location.origin
    });
  });

  // 4. Scan Downloadable Links (PDFs, ZIPs, APKs, etc.)
  document.querySelectorAll('a[href]').forEach((link) => {
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

    const absUrl = toAbsoluteUrl(href);
    if (!absUrl || registeredUrls.has(absUrl)) return;

    const cleanPath = absUrl.split('?')[0].split('#')[0].toLowerCase();
    const isDocOrArchive = /\.(pdf|epub|docx|xlsx|zip|rar|7z|apk|xapk|tar\.gz|exe|dmg|mp3|flac|wav)$/.test(cleanPath);
    const hasDownloadAttr = link.hasAttribute('download');

    if (isDocOrArchive || hasDownloadAttr) {
      registeredUrls.add(absUrl);
      const linkText = link.innerText?.trim() || link.getAttribute('download') || '';
      detected.push({
        url: absUrl,
        title: sanitizeTitle(linkText) || 'Document',
        referer: window.location.href,
        origin: window.location.origin
      });
    }
  });

  if (detected.length > 0) {
    chrome.runtime.sendMessage({
      type: 'REGISTER_MEDIA_FROM_DOM',
      payload: { items: detected }
    }).catch(() => {});
  }
}

// Initial scan
scanPageMedia();

// Passive event capturing for video and audio playback across any dynamically created elements
['play', 'playing', 'loadedmetadata', 'canplay'].forEach(evt => {
  document.addEventListener(evt, (e) => {
    if (e.target && e.target.nodeName === 'VIDEO') {
      inspectVideoElement(e.target);
    } else if (e.target && e.target.nodeName === 'AUDIO') {
      scanPageMedia();
    }
  }, { capture: true, passive: true });
});

// Observe dynamic DOM changes (infinite scrolling galleries, SPAs)
let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(scanPageMedia, 400);
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'srcset', 'data-src']
});
