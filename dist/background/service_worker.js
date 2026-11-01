import { classifyResource, extractFilenameFromContentDisposition, isStreamFragment } from './classifier.js';

// In-memory media store: Map<tabId, Map<url, MediaItem>>
const tabMediaStore = new Map();
// Request headers store: Map<requestId, HeadersObject>
const requestHeadersMap = new Map();
// Tab titles store: Map<tabId, string>
const tabTitleMap = new Map();
// Mapping of variant URL -> { masterUrl, audioUrl, variants, duration }
const variantToMasterMap = new Map();
// Mapping of tabId -> active audio track URL
const tabAudioMap = new Map();

const STREAM_RULE_ID = 9998;

/**
 * Configure dynamic DeclarativeNetRequest rules to inject Referer and allow CORS
 * for preview playback and stream chunk fetching.
 */
async function setupStreamHeaders(url, referer, origin) {
  if (!url) return;
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname;

    const requestHeaders = [];
    if (referer) {
      requestHeaders.push({ header: 'Referer', operation: 'set', value: referer });
    }
    if (origin) {
      requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
    } else {
      requestHeaders.push({ header: 'Origin', operation: 'remove' });
    }

    const responseHeaders = [
      { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
      { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' }
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [STREAM_RULE_ID],
      addRules: [{
        id: STREAM_RULE_ID,
        priority: 100,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
          responseHeaders
        },
        condition: {
          urlFilter: `||${domain}`,
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other']
        }
      }]
    });
  } catch (err) {
    console.warn('Could not set stream headers rule:', err);
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
    // Strip common branding suffixes
    clean = clean.replace(/\s*[-|–—]\s*(YouTube|Vimeo|Dailymotion|Facebook|Twitter|TikTok|Twitch|DonghuaStream).*$/i, '').trim();
    // Trim leading/trailing whitespace and hyphens
    clean = clean.replace(/^[\s-]+|[\s-]+$/g, '');
    return clean.substring(0, 150);
  } catch (_) {
    return str.replace(/[\\/:*?"<>|]/g, '-').trim().substring(0, 150);
  }
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
 * Update the extension badge count for a tab.
 */
function updateBadge(tabId) {
  if (tabId < 0) return;
  const store = tabMediaStore.get(tabId);
  const count = store ? store.size : 0;
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';

  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#4F46E5' }).catch(() => {});
}

/**
 * Register or update a media item for a tab.
 */
function registerMediaItem(tabId, item) {
  if (!tabId || tabId < 0 || !item || !item.url) return;

  if (!tabMediaStore.has(tabId)) {
    tabMediaStore.set(tabId, new Map());
  }

  const store = tabMediaStore.get(tabId);
  if (store.has(item.url)) {
    const existing = store.get(item.url);
    // Merge richer metadata without losing existing fields
    store.set(item.url, {
      ...existing,
      ...item,
      title: item.title || existing.title || tabTitleMap.get(tabId) || '',
      filename: item.filename || existing.filename,
      width: item.width || existing.width || 0,
      height: item.height || existing.height || 0,
      resolutionTag: item.resolutionTag || existing.resolutionTag || '',
      duration: item.duration || existing.duration || 0,
      durationFormatted: item.durationFormatted || existing.durationFormatted || '',
      poster: item.poster || existing.poster || '',
      size: item.size || existing.size || 0,
      estimatedSize: item.estimatedSize || existing.estimatedSize || 0,
      referer: item.referer || existing.referer || '',
      origin: item.origin || existing.origin || ''
    });
    return;
  }

  // Derive sensible title and filename
  const pageTitle = tabTitleMap.get(tabId) || '';
  const cleanTitle = sanitizeTitle(item.title || pageTitle);

  let finalFilename = item.filename;
  if (!finalFilename || /^(manifest|index|master|video|stream|download)/i.test(finalFilename)) {
    if (cleanTitle) {
      const ext = item.extension || (item.category === 'video' ? 'mp4' : 'bin');
      const resSuffix = item.resolutionTag ? ` (${item.resolutionTag})` : '';
      finalFilename = `${cleanTitle}${resSuffix}.${ext}`;
    }
  }

  // Track audio tracks per tab for dual-track muxing and playback
  if (item.category === 'audio' && item.isStream) {
    tabAudioMap.set(tabId, item.url);
    const s = tabMediaStore.get(tabId);
    if (s) {
      for (const v of s.values()) {
        if (v.category === 'video' && !v.audioUrl) {
          v.audioUrl = item.url;
        }
      }
    }
  }

  // If registering a video without audioUrl, check if an audio track was already detected for this tab
  if (item.category === 'video' && !item.audioUrl && tabAudioMap.has(tabId)) {
    item.audioUrl = tabAudioMap.get(tabId);
  }

  // Check if this URL is already linked to a known master playlist
  const masterLink = variantToMasterMap.get(item.url);

  const registeredItem = {
    id: `media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
    timestamp: Date.now(),
    title: item.title || cleanTitle || 'Media File',
    filename: finalFilename || 'download.bin',
    masterUrl: masterLink?.masterUrl || item.masterUrl || null,
    audioUrl: masterLink?.audioUrl || item.audioUrl || tabAudioMap.get(tabId) || null,
    variants: masterLink?.variants || item.variants || [],
    ...item
  };

  store.set(item.url, registeredItem);
  updateBadge(tabId);

  // If this is an HLS stream, asynchronously probe for real duration, variants, and audio
  if (item.isStream) {
    ensureOffscreenDocument()
      .then(() => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_PROBE_HLS_INFO',
          payload: { url: item.url, referer: item.referer }
        }, (res) => {
          if (res?.success && res.info) {
            const current = store.get(item.url);
            if (current) {
              const info = res.info;
              const variants = info.variants && info.variants.length > 0 ? info.variants : current.variants;
              const audioUrl = info.audioUrl || current.audioUrl || null;

              // If it's a master playlist, map all variants
              if (info.isMaster && variants.length > 0) {
                for (const v of variants) {
                  variantToMasterMap.set(v.url, {
                    masterUrl: item.url,
                    audioUrl: v.audioUrl || audioUrl,
                    variants,
                    duration: info.totalDuration
                  });
                }
              }

              store.set(item.url, {
                ...current,
                duration: current.duration || info.totalDuration,
                durationFormatted: current.durationFormatted || formatDuration(info.totalDuration),
                estimatedSize: info.estimatedSize || current.estimatedSize || 0,
                resolutionTag: current.resolutionTag || info.resolution || '',
                isMaster: info.isMaster ?? current.isMaster,
                variants: variants || [],
                audioUrl: audioUrl
              });
            }
          }
        });
      })
      .catch(() => {});
  }
}

// 1. Capture outgoing request headers (Referer, Origin, etc.)
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.requestHeaders) {
      const headers = {};
      for (const h of details.requestHeaders) {
        headers[h.name.toLowerCase()] = h.value;
      }
      requestHeadersMap.set(details.requestId, headers);
      if (requestHeadersMap.size > 2000) {
        const oldestKeys = Array.from(requestHeadersMap.keys()).slice(0, 500);
        oldestKeys.forEach(k => requestHeadersMap.delete(k));
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// 2. Intercept network responses to inspect MIME, Content-Disposition, and Size
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { tabId, url, responseHeaders, requestId } = details;
    if (tabId < 0 || !url || url.startsWith('chrome-extension://')) return;

    // Filter out internal streaming segment chunks (0.m4s, init.mp4, chunk.ts, etc.)
    if (isStreamFragment(url)) {
      return;
    }

    let mimeType = '';
    let contentDisposition = '';
    let contentLength = 0;

    if (responseHeaders) {
      for (const h of responseHeaders) {
        const name = h.name.toLowerCase();
        if (name === 'content-type') {
          mimeType = h.value;
        } else if (name === 'content-disposition') {
          contentDisposition = h.value;
        } else if (name === 'content-length') {
          contentLength = parseInt(h.value, 10) || 0;
        }
      }
    }

    const reqHeaders = requestHeadersMap.get(requestId) || {};
    const classification = classifyResource(url, mimeType, contentDisposition);

    // Filter out generic HTML/JS that are not downloads
    if (classification.category === 'other' && !contentDisposition) {
      return;
    }

    // Skip tiny tracking pixels or ad images from network sniffer
    if (classification.category === 'image' && contentLength > 0 && contentLength < 5120) {
      return;
    }

    // Pull page title if available
    const pageTitle = tabTitleMap.get(tabId) || '';
    const cleanTitle = sanitizeTitle(pageTitle);

    let displayFilename = classification.filename;
    // Replace generic hash / index filename with page title
    if (classification.category === 'video' && cleanTitle) {
      if (/^(index|master|manifest|video|stream|chunk|segment|play|\d+)/i.test(classification.filename)) {
        displayFilename = `${cleanTitle}.${classification.extension || 'mp4'}`;
      }
    }

    // For HLS streams, never display the tiny playlist content-length as the video size
    const reportedSize = classification.isStream ? 0 : contentLength;

    registerMediaItem(tabId, {
      url,
      tabId,
      category: classification.category,
      extension: classification.extension,
      filename: displayFilename,
      title: cleanTitle || displayFilename,
      isStream: classification.isStream,
      streamType: classification.streamType,
      mimeType,
      size: reportedSize,
      referer: reqHeaders['referer'] || details.initiator || '',
      origin: reqHeaders['origin'] || '',
      userAgent: reqHeaders['user-agent'] || navigator.userAgent,
      source: 'network'
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

// 3. Track Tab Titles and Navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title || tab?.title) {
    tabTitleMap.set(tabId, changeInfo.title || tab.title);
  }
  if (changeInfo.status === 'loading') {
    tabMediaStore.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMediaStore.delete(tabId);
  tabTitleMap.delete(tabId);
});

// 4. Ensure Offscreen Document for HLS Muxing / Stream processing
let offscreenCreating = null;
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existingContexts.length > 0) {
    return;
  }
  if (offscreenCreating) {
    await offscreenCreating;
  } else {
    offscreenCreating = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS', 'WORKERS'],
      justification: 'HLS stream downloading, chunk reassembly and MP4 remuxing.'
    });
    await offscreenCreating;
    offscreenCreating = null;
  }
}

// 5. Message bus for Content Scripts & Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;
  const tabId = sender.tab?.id ?? payload?.tabId;

  if (sender.tab?.title && tabId) {
    tabTitleMap.set(tabId, sender.tab.title);
  }

  if (type === 'REGISTER_MEDIA_FROM_DOM') {
    if (payload && Array.isArray(payload.items)) {
      for (const item of payload.items) {
        const classification = classifyResource(item.url, item.mimeType);
        const resolvedCategory = (item.category && item.category !== 'other') ? item.category : classification.category;
        
        let resolvedExt = item.extension || classification.extension;
        if (!resolvedExt || resolvedExt === 'bin') {
          if (resolvedCategory === 'video') resolvedExt = 'mp4';
          else if (resolvedCategory === 'audio') resolvedExt = 'mp3';
          else if (resolvedCategory === 'image') resolvedExt = 'jpg';
        }

        registerMediaItem(tabId, {
          ...item,
          category: resolvedCategory,
          extension: resolvedExt,
          filename: item.filename || classification.filename,
          isStream: item.isStream || classification.isStream,
          streamType: item.streamType || classification.streamType,
          source: 'dom'
        });
      }
    }
    sendResponse({ success: true });
    return true;
  }

  if (type === 'GET_MEDIA_ITEMS') {
    const store = tabMediaStore.get(payload.tabId);
    const items = store ? Array.from(store.values()) : [];
    sendResponse({ items });
    return true;
  }

  if (type === 'START_DIRECT_DOWNLOAD') {
    const { url, filename, referer, origin } = payload;
    const downloadOptions = {
      url,
      filename: filename || 'download.bin',
      saveAs: false
    };

    const ruleId = 9999;
    const executeDownload = async () => {
      if (referer || origin) {
        const requestHeaders = [];
        if (referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: referer });
        if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });

        try {
          const urlBase = url.split('?')[0];
          await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [ruleId],
            addRules: [{
              id: ruleId,
              priority: 100,
              action: {
                type: 'modifyHeaders',
                requestHeaders
              },
              condition: {
                urlFilter: urlBase,
                resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other']
              }
            }]
          });
        } catch (_) {}
      }

      chrome.downloads.download(downloadOptions, (downloadId) => {
        setTimeout(() => {
          chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] }).catch(() => {});
        }, 5000);

        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId });
        }
      });
    };

    executeDownload();
    return true;
  }

  if (type === 'PREPARE_STREAM_HEADERS') {
    const { url, referer, origin } = payload;
    setupStreamHeaders(url, referer, origin)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (type === 'START_HLS_DOWNLOAD') {
    setupStreamHeaders(payload.url, payload.referer, payload.origin)
      .then(() => ensureOffscreenDocument())
      .then(() => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START_HLS_DOWNLOAD',
          payload
        });
        sendResponse({ success: true });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }

  if (type === 'CANCEL_DOWNLOAD') {
    const { id, downloadId } = payload;
    if (downloadId) {
      chrome.downloads.cancel(downloadId).catch(() => {});
    }
    ensureOffscreenDocument()
      .then(() => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_CANCEL_DOWNLOAD',
          payload: { id }
        });
      })
      .catch(() => {});
    sendResponse({ success: true });
    return true;
  }

  if (type === 'OFFSCREEN_DOWNLOAD_COMPLETE') {
    const { blobUrl, filename, id } = payload;
    chrome.downloads.download({
      url: blobUrl,
      filename: filename || 'stream.mp4',
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        chrome.runtime.sendMessage({
          type: 'HLS_ERROR',
          payload: { id, error: chrome.runtime.lastError.message }
        }).catch(() => {});
      } else {
        chrome.runtime.sendMessage({
          type: 'HLS_PROGRESS_UPDATE',
          payload: { id, percent: 100, status: 'complete', downloadId }
        }).catch(() => {});
      }
    });
    sendResponse({ success: true });
    return true;
  }
});
