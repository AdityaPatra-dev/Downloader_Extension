let activeTabId = null;
let allItems = [];
let selectedItemIds = new Set();
let currentCategory = 'all';
let currentSearch = '';
let currentHlsInstance = null;
let currentPreviewItem = null;

/**
 * Format bytes into human-readable string.
 */
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Check if an item matches the category.
 */
function matchesCategory(item, category) {
  if (!item) return false;
  if (category === 'all') return true;

  const itemCat = (item.category || '').toLowerCase();
  if (category === itemCat) return true;

  // Grouping rules
  if (category === 'archive' && (itemCat === 'package' || itemCat === 'archive')) return true;
  if (category === 'document' && (itemCat === 'document' || itemCat === 'subtitle')) return true;

  return false;
}

/**
 * Get items matching current category and search query.
 */
function getFilteredItems() {
  return allItems.filter(item => {
    // 1. Category check
    if (!matchesCategory(item, currentCategory)) {
      return false;
    }

    // 2. Search query check
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      const matchTitle = (item.title || '').toLowerCase().includes(q);
      const matchName = (item.filename || '').toLowerCase().includes(q);
      const matchUrl = (item.url || '').toLowerCase().includes(q);
      const matchExt = (item.extension || '').toLowerCase().includes(q);
      return matchTitle || matchName || matchUrl || matchExt;
    }

    return true;
  });
}

/**
 * Update counts on category tabs.
 */
function updateCategoryCounts() {
  const counts = {
    all: allItems.length,
    video: 0,
    audio: 0,
    image: 0,
    document: 0,
    archive: 0
  };

  for (const item of allItems) {
    const cat = (item.category || '').toLowerCase();
    if (cat === 'video') counts.video++;
    else if (cat === 'audio') counts.audio++;
    else if (cat === 'image') counts.image++;
    else if (cat === 'document' || cat === 'subtitle') counts.document++;
    else if (cat === 'archive' || cat === 'package') counts.archive++;
  }

  for (const [cat, count] of Object.entries(counts)) {
    const el = document.getElementById(`count-${cat}`);
    if (el) el.innerText = String(count);
  }
}

let activeMasterBlobUrl = null;

/**
 * Synthesize a clean HLS Master Playlist in a Blob URL that binds
 * a video stream and an audio stream together.
 */
function createCombinedMasterBlob(videoUrl, audioUrl) {
  const masterContent = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio-main",NAME="Main Audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audioUrl}"`,
    `#EXT-X-STREAM-INF:BANDWIDTH=2500000,AUDIO="audio-main"`,
    videoUrl
  ].join('\n');

  return URL.createObjectURL(new Blob([masterContent], { type: 'application/vnd.apple.mpegurl' }));
}

/**
 * Open Video Preview Modal.
 */
async function openPreview(item) {
  const modal = document.getElementById('playerModal');
  const title = document.getElementById('modalTitle');
  const video = document.getElementById('modalVideo');
  const info = document.getElementById('modalInfo');
  const statusEl = document.getElementById('playerStatus');
  const unmuteBtn = document.getElementById('unmuteBtn');
  currentPreviewItem = item;

  title.innerText = item.title || item.filename || 'Stream Preview';
  info.innerText = item.resolutionTag ? `${item.resolutionTag} • ${item.isStream ? 'HLS Stream' : 'Video'}` : 'Media Preview';

  let chosenVideoUrl = item.selectedVariantUrl || item.url;
  let chosenAudioUrl = item.selectedAudioUrl || item.audioUrl;

  modal.style.display = 'flex';
  statusEl.style.display = 'block';
  statusEl.innerText = 'Connecting to stream...';
  statusEl.style.color = '#94a3b8';

  // Ensure dynamic declarativeNetRequest rules are fully applied before loading stream
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'PREPARE_STREAM_HEADERS',
      payload: {
        url: chosenVideoUrl,
        referer: item.referer,
        origin: item.origin,
        audioUrl: chosenAudioUrl
      }
    }, () => resolve());
  });

  if (activeMasterBlobUrl) {
    URL.revokeObjectURL(activeMasterBlobUrl);
    activeMasterBlobUrl = null;
  }

  if (currentHlsInstance) {
    currentHlsInstance.destroy();
    currentHlsInstance = null;
  }

  // Autoplay requires muted state in modern Chromium
  video.muted = true;
  unmuteBtn.style.display = 'block';

  unmuteBtn.onclick = () => {
    video.muted = false;
    unmuteBtn.style.display = 'none';
  };

  video.onvolumechange = () => {
    if (!video.muted) {
      unmuteBtn.style.display = 'none';
    }
  };

  video.onplaying = () => {
    statusEl.style.display = 'none';
  };

  video.oncanplay = () => {
    statusEl.style.display = 'none';
  };

  const showStreamErrorUi = () => {
    statusEl.style.display = 'block';
    statusEl.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 4px;">Stream connection blocked or token expired.</div>
      <div style="font-size: 11px; color: #94a3b8; margin-bottom: 10px;">The host CDN requires an active session or a fresh auth token.</div>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button type="button" class="refresh-stream-btn" id="streamReloadBtn">
          🔄 Reload Tab
        </button>
        <button type="button" class="refresh-stream-btn" id="streamDownloadDirectBtn" style="background: #10b981; border-color: #059669; color: #ffffff;">
          ⬇ Download Media
        </button>
      </div>
    `;
    const reloadBtn = document.getElementById('streamReloadBtn');
    if (reloadBtn) {
      reloadBtn.onclick = () => {
        if (activeTabId) {
          chrome.tabs.reload(activeTabId, () => {
            closePreview();
            window.close();
          });
        }
      };
    }
    const dlBtn = document.getElementById('streamDownloadDirectBtn');
    if (dlBtn) {
      dlBtn.onclick = () => {
        closePreview();
        startDownload(item);
      };
    }
  };

  video.onerror = () => {
    console.warn('[Preview] Native HTML5 video error occurred on src:', video.src);
    showStreamErrorUi();
  };

  // Determine effective stream source:
  // Only synthesize combined master blob if explicitly dual-track or audio is known separate
  let effectiveSourceUrl = chosenVideoUrl;
  if (item.category === 'video' && chosenAudioUrl && item.isDualTrack && !chosenVideoUrl.includes('master') && !chosenVideoUrl.includes('xbsobkq')) {
    activeMasterBlobUrl = createCombinedMasterBlob(chosenVideoUrl, chosenAudioUrl);
    effectiveSourceUrl = activeMasterBlobUrl;
  }

  let retryCount = 0;
  let droppedSyntheticBlob = false;
  let triedVariantFallback = false;
  let triedNativeFallback = false;

  const isHlsTarget = Boolean(window.Hls && window.Hls.isSupported() && (
    effectiveSourceUrl.includes('.m3u8') || 
    effectiveSourceUrl.startsWith('blob:') || 
    item.isStream
  ));

  if (isHlsTarget) {
    currentHlsInstance = new window.Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 60,
      maxBufferLength: 30,
      manifestLoadingTimeOut: 20000,
      manifestLoadingMaxRetry: 4,
      manifestLoadingRetryDelay: 500,
      levelLoadingTimeOut: 20000,
      levelLoadingMaxRetry: 4,
      levelLoadingRetryDelay: 500,
      fragLoadingTimeOut: 25000,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 500,
      xhrSetup: (xhr) => {
        xhr.withCredentials = false;
      }
    });

    currentHlsInstance.loadSource(effectiveSourceUrl);
    currentHlsInstance.attachMedia(video);

    currentHlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
      statusEl.innerText = 'Buffering stream...';
      video.play().catch(() => {});
    });

    currentHlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
      console.warn('HLS preview error:', data.type, data.details, data.fatal);
      if (data.fatal) {
        if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
          // Recovery Stage 1: Auto-retry via Hls.js startLoad
          if (retryCount < 2) {
            retryCount++;
            console.log(`[Preview] Network recovery attempt ${retryCount}/2...`);
            statusEl.innerText = `Reconnecting stream (attempt ${retryCount}/2)...`;
            setTimeout(() => {
              if (currentHlsInstance) currentHlsInstance.startLoad();
            }, 600);
            return;
          }

          // Recovery Stage 2: If we were playing a synthetic audio-paired blob, revert to direct video stream
          if (!droppedSyntheticBlob && activeMasterBlobUrl && effectiveSourceUrl === activeMasterBlobUrl) {
            droppedSyntheticBlob = true;
            retryCount = 0;
            console.log('[Preview] Falling back from synthesized audio blob to direct video stream...');
            statusEl.innerText = 'Connecting directly to primary media stream...';
            effectiveSourceUrl = chosenVideoUrl;
            currentHlsInstance.loadSource(chosenVideoUrl);
            return;
          }

          // Recovery Stage 3: If alternate variants exist, try alternative quality variant
          if (!triedVariantFallback && item.variants && item.variants.length > 1) {
            triedVariantFallback = true;
            retryCount = 0;
            const alt = item.variants.find(v => v.url && v.url !== effectiveSourceUrl && v.url !== chosenVideoUrl);
            if (alt && alt.url) {
              console.log('[Preview] Switching to alternative quality variant:', alt.label);
              statusEl.innerText = `Switching to ${alt.label || 'alternative'} quality...`;
              effectiveSourceUrl = alt.url;
              currentHlsInstance.loadSource(alt.url);
              return;
            }
          }

          // Recovery Stage 4: Fall back to native HTML5 video element
          if (!triedNativeFallback) {
            triedNativeFallback = true;
            console.log('[Preview] Testing native HTML5 video player fallback...');
            statusEl.innerText = 'Testing native browser playback...';
            currentHlsInstance.destroy();
            currentHlsInstance = null;
            video.src = chosenVideoUrl;
            video.play().catch(() => {});
            return;
          }

          showStreamErrorUi();
        } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
          console.log('[Preview] Recovering media error...');
          currentHlsInstance.recoverMediaError();
        } else {
          console.log('[Preview] Fatal error encountered, attempting native player...');
          currentHlsInstance.destroy();
          currentHlsInstance = null;
          video.src = chosenVideoUrl;
          video.play().catch(() => {});
        }
      }
    });
  } else {
    video.src = effectiveSourceUrl;
    video.play().catch(() => {});
  }
}

/**
 * Close Video Preview Modal.
 */
function closePreview() {
  const modal = document.getElementById('playerModal');
  const video = document.getElementById('modalVideo');
  const statusEl = document.getElementById('playerStatus');
  const unmuteBtn = document.getElementById('unmuteBtn');

  if (activeMasterBlobUrl) {
    URL.revokeObjectURL(activeMasterBlobUrl);
    activeMasterBlobUrl = null;
  }

  if (currentHlsInstance) {
    currentHlsInstance.destroy();
    currentHlsInstance = null;
  }
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (statusEl) statusEl.style.display = 'none';
  if (unmuteBtn) unmuteBtn.style.display = 'none';
  modal.style.display = 'none';
  currentPreviewItem = null;
}

/**
 * Trigger download for an item.
 */
function triggerDownload(item) {
  const dlBtn = document.querySelector(`.download-btn[data-id="${item.id}"]`);
  const cancelBtn = document.querySelector(`.cancel-btn[data-id="${item.id}"]`);
  const progWrap = document.getElementById(`prog-wrap-${item.id}`);

  if (dlBtn) dlBtn.style.display = 'none';
  if (cancelBtn) {
    cancelBtn.style.display = 'inline-block';
    cancelBtn.innerText = '✕ Cancel';
  }
  if (progWrap) progWrap.style.display = 'block';

  let downloadFilename = item.filename;
  if (item.isAudioOnly) {
    downloadFilename = downloadFilename.replace(/\.[a-z0-9]+$/i, '') + '.m4a';
  }

  if (item.isStream && item.streamType === 'hls') {
    chrome.runtime.sendMessage({
      type: 'START_HLS_DOWNLOAD',
      payload: {
        id: item.id,
        url: item.url,
        filename: downloadFilename,
        referer: item.referer,
        origin: item.origin,
        selectedVariantUrl: item.selectedVariantUrl,
        isAudioOnly: item.isAudioOnly,
        audioUrl: item.selectedAudioUrl || item.audioUrl
      }
    });
  } else {
    chrome.runtime.sendMessage({
      type: 'START_DIRECT_DOWNLOAD',
      payload: {
        url: item.selectedVariantUrl || item.url,
        filename: downloadFilename,
        referer: item.referer,
        origin: item.origin
      }
    }, (res) => {
      if (res && res.success) {
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (dlBtn) {
          dlBtn.style.display = 'inline-block';
          dlBtn.innerText = 'Saved!';
          setTimeout(() => { dlBtn.innerText = 'Download'; }, 2000);
        }
      } else {
        if (cancelBtn) cancelBtn.style.display = 'none';
        if (dlBtn) {
          dlBtn.style.display = 'inline-block';
          dlBtn.innerText = 'Failed';
          setTimeout(() => { dlBtn.innerText = 'Download'; }, 2000);
        }
      }
    });
  }
}

/**
 * Trigger cancel for an active download.
 */
function triggerCancel(id) {
  const dlBtn = document.querySelector(`.download-btn[data-id="${id}"]`);
  const cancelBtn = document.querySelector(`.cancel-btn[data-id="${id}"]`);
  const progWrap = document.getElementById(`prog-wrap-${id}`);
  const bar = document.getElementById(`prog-bar-${id}`);

  chrome.runtime.sendMessage({
    type: 'CANCEL_DOWNLOAD',
    payload: { id }
  });

  if (cancelBtn) cancelBtn.style.display = 'none';
  if (dlBtn) {
    dlBtn.style.display = 'inline-block';
    dlBtn.innerText = 'Download';
    dlBtn.disabled = false;
  }
  if (progWrap) progWrap.style.display = 'none';
  if (bar) bar.style.width = '0%';
}

/**
 * Render media items according to active tab and search query.
 */
function renderMediaList() {
  const cardsList = document.getElementById('cardsList');
  const emptyState = document.getElementById('emptyState');
  const emptyTitle = document.getElementById('emptyTitle');
  const emptySubtext = document.getElementById('emptySubtext');

  const filtered = getFilteredItems();

  if (filtered.length === 0) {
    cardsList.innerHTML = '';
    emptyState.style.display = 'flex';

    if (currentCategory === 'all') {
      emptyTitle.innerText = 'No media or files detected on this page yet.';
      emptySubtext.innerText = 'Play a video, scroll the page, or click refresh to trigger deep detection.';
    } else {
      emptyTitle.innerText = `No ${currentCategory} files detected on this page.`;
      emptySubtext.innerText = `Switch to 'All' or another category tab above to see other detected items.`;
    }
    updateSelectionUI();
    return;
  }

  emptyState.style.display = 'none';
  cardsList.innerHTML = '';

  for (const item of filtered) {
    const isSelected = selectedItemIds.has(item.id);
    const card = document.createElement('div');
    card.className = 'media-card';
    card.id = `card-${item.id}`;

    // Thumbnail / Icon box
    let thumbHtml = '';
    if (item.poster) {
      thumbHtml = `<img src="${item.poster}" class="media-thumb" onerror="this.style.display='none'">`;
    } else if (item.category === 'image') {
      thumbHtml = `<img src="${item.url}" class="media-thumb" onerror="this.parentElement.innerHTML='<span class=\\'media-badge badge-image\\'>IMG</span>'">`;
    } else {
      const badgeCat = (item.category === 'package' ? 'archive' : item.category) || 'other';
      const label = item.resolutionTag || (item.extension || item.category || 'FILE').toUpperCase();
      thumbHtml = `<span class="media-badge badge-${badgeCat}">${label}</span>`;
    }

    // Metadata pills
    const metaParts = [];
    if (item.resolutionTag) {
      metaParts.push(`<span class="meta-pill meta-resolution">${item.resolutionTag}</span>`);
    }
    if (item.width && item.height) {
      metaParts.push(`<span class="meta-pill">${item.width}x${item.height}</span>`);
    }
    if (item.durationFormatted) {
      metaParts.push(`<span class="meta-pill meta-duration">⏱ ${item.durationFormatted}</span>`);
    }

    // Accurate size display
    const activeSize = item.currentSelectedSize || item.estimatedSize || item.size;
    if (activeSize > 1024) {
      const prefix = item.isStream ? '~' : '';
      metaParts.push(`<span class="meta-pill meta-size" id="size-pill-${item.id}">${prefix}${formatBytes(activeSize)}</span>`);
    }

    if (item.isStream) {
      metaParts.push(`<span class="meta-pill meta-stream">HLS Stream</span>`);
    }

    const displayTitle = item.title || item.filename || item.url;
    const subtext = (item.filename && item.filename !== displayTitle) ? item.filename : '';

    // Quality selector HTML (Soul Browser style)
    let qualityHtml = '';
    if (item.category === 'video' || item.isStream) {
      let optionsHtml = '';
      if (item.variants && item.variants.length > 0) {
        optionsHtml = item.variants.map((v, idx) => {
          const selected = idx === 0 ? 'selected' : '';
          const sizeText = v.estimatedSize ? ` (~${formatBytes(v.estimatedSize)})` : '';
          return `<option value="${v.url}" data-bw="${v.bandwidth}" data-size="${v.estimatedSize}" data-audioonly="${v.isAudioOnly ? '1' : '0'}" data-audiourl="${v.audioUrl || ''}" ${selected}>${v.label}${sizeText}</option>`;
        }).join('');
      } else {
        optionsHtml = `
          <option value="${item.url}" selected>${item.resolutionTag || 'Original Quality'}</option>
          <option value="${item.url}" data-audioonly="1">🎵 Audio Only</option>
        `;
      }

      qualityHtml = `
        <div class="quality-select-wrapper">
          <label style="font-size: 10px; color: var(--text-muted);">Quality:</label>
          <select class="quality-select" data-id="${item.id}">
            ${optionsHtml}
          </select>
        </div>
      `;
    }

    // Play preview button for video / audio items
    const canPlay = item.category === 'video' || item.category === 'audio' || item.isStream;
    const playBtnHtml = canPlay ? `
      <button type="button" class="btn-icon play-btn" data-id="${item.id}" title="Play preview">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      </button>
    ` : '';

    card.innerHTML = `
      <input type="checkbox" class="card-checkbox" data-id="${item.id}" ${isSelected ? 'checked' : ''}>
      <div class="media-thumb-box">
        ${thumbHtml}
      </div>
      <div class="media-info">
        <div class="media-title" title="${displayTitle}">${displayTitle}</div>
        ${subtext ? `<div class="media-subtext" title="${subtext}">${subtext}</div>` : ''}
        <div class="media-meta">${metaParts.join('')}</div>
        ${qualityHtml}
        <div class="progress-bar-container" id="prog-wrap-${item.id}" style="display:none;">
          <div class="progress-bar-fill" id="prog-bar-${item.id}"></div>
        </div>
      </div>
      <div class="card-actions">
        ${playBtnHtml}
        <button type="button" class="btn-icon copy-btn" data-url="${item.url}" title="Copy URL">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button type="button" class="btn btn-primary download-btn" data-id="${item.id}">
          Download
        </button>
        <button type="button" class="btn btn-danger cancel-btn" data-id="${item.id}" style="display: none;">
          ✕ Cancel
        </button>
      </div>
    `;

    cardsList.appendChild(card);
  }

  attachCardEvents();
  updateSelectionUI();
}

/**
 * Attach interaction events to cards.
 */
function attachCardEvents() {
  // Checkbox toggle
  document.querySelectorAll('.card-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const id = e.target.getAttribute('data-id');
      if (e.target.checked) {
        selectedItemIds.add(id);
      } else {
        selectedItemIds.delete(id);
      }
      updateSelectionUI();
    });
  });

  // Quality selector change
  document.querySelectorAll('.quality-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const id = sel.getAttribute('data-id');
      const item = allItems.find(i => i.id === id);
      if (!item) return;

      const opt = sel.selectedOptions[0];
      item.selectedVariantUrl = sel.value;
      item.isAudioOnly = opt.getAttribute('data-audioonly') === '1';
      item.selectedAudioUrl = opt.getAttribute('data-audiourl') || item.audioUrl;

      const estSize = parseInt(opt.getAttribute('data-size'), 10) || 0;
      if (estSize > 0) {
        item.currentSelectedSize = estSize;
        const sizePill = document.getElementById(`size-pill-${id}`);
        if (sizePill) {
          sizePill.innerText = `~${formatBytes(estSize)}`;
        }
      }
    });
  });

  // Play preview button
  document.querySelectorAll('.play-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const item = allItems.find(i => i.id === id);
      if (item) {
        openPreview(item);
      }
    });
  });

  // Copy link
  document.querySelectorAll('.copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const url = btn.getAttribute('data-url');
      try {
        await navigator.clipboard.writeText(url);
        btn.style.borderColor = '#10B981';
        setTimeout(() => btn.style.borderColor = '', 1200);
      } catch (_) {}
    });
  });

  // Download single item
  document.querySelectorAll('.download-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      const item = allItems.find(i => i.id === id);
      if (item) {
        triggerDownload(item);
      }
    });
  });

  // Cancel single item download
  document.querySelectorAll('.cancel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-id');
      triggerCancel(id);
    });
  });
}

function updateSelectionUI() {
  const countEl = document.getElementById('selectedCount');
  const dlSelectedBtn = document.getElementById('downloadSelectedBtn');
  const selectAll = document.getElementById('selectAllCheckbox');

  const filtered = getFilteredItems();
  const selectedInFiltered = filtered.filter(i => selectedItemIds.has(i.id)).length;

  countEl.innerText = String(selectedItemIds.size);
  dlSelectedBtn.disabled = selectedItemIds.size === 0;

  if (filtered.length === 0) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  } else {
    selectAll.checked = selectedInFiltered === filtered.length;
    selectAll.indeterminate = selectedInFiltered > 0 && selectedInFiltered < filtered.length;
  }
}

/**
 * Fetch media items from background worker.
 * If empty, automatically injects DOM scanner on the active tab.
 */
async function loadMediaItems() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    activeTabId = tab.id;

    chrome.runtime.sendMessage({
      type: 'GET_MEDIA_ITEMS',
      payload: { tabId: activeTabId }
    }, (response) => {
      if (response && Array.isArray(response.items) && response.items.length > 0) {
        allItems = response.items;
        updateCategoryCounts();
        renderMediaList();
      } else {
        // Active tab scan if store was reset upon extension reload
        try {
          chrome.scripting.executeScript({
            target: { tabId: activeTabId, allFrames: true },
            files: ['content/dom_scanner.js']
          }).then(() => {
            setTimeout(() => {
              chrome.runtime.sendMessage({
                type: 'GET_MEDIA_ITEMS',
                payload: { tabId: activeTabId }
              }, (retryRes) => {
                if (retryRes && Array.isArray(retryRes.items)) {
                  allItems = retryRes.items;
                  updateCategoryCounts();
                  renderMediaList();
                }
              });
            }, 300);
          }).catch(() => {});
        } catch (_) {}

        allItems = response?.items || [];
        updateCategoryCounts();
        renderMediaList();
      }
    });
  } catch (_) {}
}

// 1. Tab Bar Navigation
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    const target = e.currentTarget;
    document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
    target.classList.add('active');
    currentCategory = target.getAttribute('data-category') || 'all';
    renderMediaList();
  });
});

// 2. Search filtering
const searchInput = document.getElementById('searchInput');
if (searchInput) {
  searchInput.addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    renderMediaList();
  });
}

// 3. Select All checkbox
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
if (selectAllCheckbox) {
  selectAllCheckbox.addEventListener('change', (e) => {
    const filtered = getFilteredItems();
    if (e.target.checked) {
      for (const item of filtered) {
        selectedItemIds.add(item.id);
      }
    } else {
      for (const item of filtered) {
        selectedItemIds.delete(item.id);
      }
    }
    renderMediaList();
    updateSelectionUI();
  });
}

// 4. Download Selected Batch
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');
if (downloadSelectedBtn) {
  downloadSelectedBtn.addEventListener('click', () => {
    const selectedItems = allItems.filter(i => selectedItemIds.has(i.id));
    if (selectedItems.length === 0) return;

    downloadSelectedBtn.disabled = true;
    downloadSelectedBtn.innerText = `Downloading ${selectedItems.length}...`;

    for (const item of selectedItems) {
      triggerDownload(item);
    }

    setTimeout(() => {
      downloadSelectedBtn.innerText = 'Started!';
      setTimeout(() => {
        downloadSelectedBtn.innerText = 'Download Selected';
        updateSelectionUI();
      }, 2000);
    }, 500);
  });
}

// 5. Refresh detection
const refreshBtn = document.getElementById('refreshBtn');
if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    if (activeTabId) {
      refreshBtn.style.transform = 'rotate(360deg)';
      refreshBtn.style.transition = 'transform 0.6s ease';
      setTimeout(() => { refreshBtn.style.transform = ''; }, 700);

      chrome.tabs.reload(activeTabId, () => {
        setTimeout(() => {
          loadMediaItems();
        }, 1200);
      });
    }
  });
}

// 6. Modal Preview Events
const modalCloseBtn = document.getElementById('modalCloseBtn');
if (modalCloseBtn) {
  modalCloseBtn.addEventListener('click', closePreview);
}

const modalDownloadBtn = document.getElementById('modalDownloadBtn');
if (modalDownloadBtn) {
  modalDownloadBtn.addEventListener('click', () => {
    if (currentPreviewItem) {
      triggerDownload(currentPreviewItem);
      closePreview();
    }
  });
}

const playerModal = document.getElementById('playerModal');
if (playerModal) {
  playerModal.addEventListener('click', (e) => {
    if (e.target === playerModal) {
      closePreview();
    }
  });
}

// 7. Listen for HLS progress broadcasts from offscreen document
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'HLS_PROGRESS_UPDATE') {
    const { id, percent, status, downloadedBytes } = message.payload;
    const bar = document.getElementById(`prog-bar-${id}`);
    const dlBtn = document.querySelector(`.download-btn[data-id="${id}"]`);
    const cancelBtn = document.querySelector(`.cancel-btn[data-id="${id}"]`);
    const progWrap = document.getElementById(`prog-wrap-${id}`);

    if (status === 'cancelled') {
      triggerCancel(id);
      return;
    }

    if (bar) bar.style.width = `${percent}%`;
    if (cancelBtn && percent < 100) {
      const mbText = downloadedBytes ? ` (${formatBytes(downloadedBytes)})` : '';
      cancelBtn.innerText = `✕ ${percent}%${mbText}`;
    }

    if (status === 'complete' || percent >= 100) {
      if (cancelBtn) cancelBtn.style.display = 'none';
      if (dlBtn) {
        dlBtn.style.display = 'inline-block';
        dlBtn.innerText = 'Saved!';
        setTimeout(() => {
          dlBtn.innerText = 'Download';
          dlBtn.disabled = false;
          if (progWrap) progWrap.style.display = 'none';
          if (bar) bar.style.width = '0%';
        }, 2500);
      }
    }
  } else if (message.type === 'HLS_ERROR') {
    const { id, error } = message.payload;
    const dlBtn = document.querySelector(`.download-btn[data-id="${id}"]`);
    const cancelBtn = document.querySelector(`.cancel-btn[data-id="${id}"]`);
    const progWrap = document.getElementById(`prog-wrap-${id}`);

    if (cancelBtn) cancelBtn.style.display = 'none';
    if (dlBtn) {
      dlBtn.style.display = 'inline-block';
      dlBtn.innerText = 'Error';
      setTimeout(() => {
        dlBtn.innerText = 'Download';
        dlBtn.disabled = false;
        if (progWrap) progWrap.style.display = 'none';
      }, 2500);
    }
    console.error('HLS stream error:', error);
  }
});

// Initial boot
loadMediaItems();
