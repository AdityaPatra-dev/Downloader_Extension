/**
 * Robust Offscreen HLS (.m3u8) Stream Parser, Decryptor, and Multi-Chunk Assembler.
 * - Supports fMP4 / CMAF (#EXT-X-MAP:URI="init.mp4")
 * - Supports dual Audio & Video track muxing (interleaved fMP4 with updated track_ID)
 * - Supports Audio-Only extraction (.m4a/.mp3) directly from HLS streams
 * - Supports AES-128 decryption (#EXT-X-KEY) via Web Crypto API
 * - Supports classic MPEG-TS (.ts) segment streams
 * - Calculates true video duration and accurate total file size estimation
 * - Supports live cancellation via AbortController
 */

// Active download controllers: Map<string, { controller: AbortController, cancelled: boolean }>
const activeDownloads = new Map();

/**
 * Resolve relative URL against base.
 */
function resolveUrl(relativeUrl, baseUrl) {
  if (!relativeUrl) return baseUrl;
  try {
    return new URL(relativeUrl, baseUrl).href;
  } catch (_) {
    return relativeUrl;
  }
}

/**
 * Parse an M3U8 playlist text into master variants or media segments.
 */
function parseM3U8(content, baseUrl) {
  const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

  if (isMaster) {
    const variants = [];
    const audioTracks = new Map(); // groupId -> audioUri

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Parse Audio tracks: #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="...",URI="..."
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const typeMatch = line.match(/TYPE=([A-Z0-9_-]+)/i);
        const type = typeMatch ? typeMatch[1].toUpperCase() : '';
        if (type === 'AUDIO') {
          const groupMatch = line.match(/GROUP-ID=["']?([^"',\s]+)["']?/i);
          const uriMatch = line.match(/URI=["']?([^"',\s]+)["']?/i);
          if (groupMatch && uriMatch) {
            audioTracks.set(groupMatch[1], resolveUrl(uriMatch[1], baseUrl));
          }
        }
      }

      // Parse Video streams: #EXT-X-STREAM-INF:...
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const nextLine = lines[i + 1];
        if (nextLine && !nextLine.startsWith('#')) {
          const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
          const resMatch = line.match(/RESOLUTION=(\d+x\d+)/i);
          const audioGroupMatch = line.match(/AUDIO=["']?([^"',\s]+)["']?/i);
          const codecsMatch = line.match(/CODECS=["']?([^"',\s]+)["']?/i);

          const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
          const res = resMatch ? resMatch[1] : '';
          const audioGroupId = audioGroupMatch ? audioGroupMatch[1] : '';
          const codecs = codecsMatch ? codecsMatch[1] : '';

          variants.push({
            bandwidth: bw,
            resolution: res,
            audioGroupId,
            codecs,
            url: resolveUrl(nextLine, baseUrl)
          });
        }
      }
    }

    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    return { isMaster: true, variants, audioTracks };
  }

  // Media Playlist
  let initUrl = null;
  let keyInfo = null;
  const segments = [];
  let totalDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // #EXT-X-MAP:URI="init.mp4"
    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI=["']?([^"',\s]+)["']?/i);
      if (uriMatch) {
        initUrl = resolveUrl(uriMatch[1], baseUrl);
      }
    }

    // #EXT-X-KEY:METHOD=AES-128,URI="key.bin"[,IV=0x1234...]
    if (line.startsWith('#EXT-X-KEY:')) {
      const methodMatch = line.match(/METHOD=([A-Z0-9_-]+)/i);
      const uriMatch = line.match(/URI=["']?([^"',\s]+)["']?/i);
      const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);
      if (methodMatch && methodMatch[1] === 'AES-128' && uriMatch) {
        keyInfo = {
          method: 'AES-128',
          url: resolveUrl(uriMatch[1], baseUrl),
          ivHex: ivMatch ? ivMatch[1] : null
        };
      }
    }

    // #EXTINF:3.000000,
    if (line.startsWith('#EXTINF:')) {
      const durMatch = line.match(/#EXTINF:([\d.]+)/);
      const dur = durMatch ? parseFloat(durMatch[1]) : 0;
      totalDuration += dur;

      const nextLine = lines[i + 1];
      if (nextLine && !nextLine.startsWith('#')) {
        segments.push({
          duration: dur,
          url: resolveUrl(nextLine, baseUrl),
          keyInfo
        });
      }
    }
  }

  return {
    isMaster: false,
    initUrl,
    keyInfo,
    segments,
    totalDuration
  };
}

/**
 * Merge video fMP4 init box and audio fMP4 init box into a single standard MP4 header.
 */
function mergeFmp4Init(videoInit, audioInit) {
  if (!videoInit || !audioInit) return videoInit || audioInit;

  let aTrak = null;
  let aTrex = null;

  // Extract aTrak and aTrex from audioInit
  let pos = 0;
  while (pos + 8 <= audioInit.length) {
    const size = (audioInit[pos] << 24) | (audioInit[pos+1] << 16) | (audioInit[pos+2] << 8) | audioInit[pos+3];
    const type = String.fromCharCode(audioInit[pos+4], audioInit[pos+5], audioInit[pos+6], audioInit[pos+7]);
    if (type === 'moov') {
      let mpos = pos + 8;
      const mend = pos + size;
      while (mpos + 8 <= mend) {
        const msize = (audioInit[mpos] << 24) | (audioInit[mpos+1] << 16) | (audioInit[mpos+2] << 8) | audioInit[mpos+3];
        const mtype = String.fromCharCode(audioInit[mpos+4], audioInit[mpos+5], audioInit[mpos+6], audioInit[mpos+7]);
        if (mtype === 'trak') {
          aTrak = new Uint8Array(audioInit.subarray(mpos, mpos + msize));
        } else if (mtype === 'mvex') {
          let xpos = mpos + 8;
          const xend = mpos + msize;
          while (xpos + 8 <= xend) {
            const xsize = (audioInit[xpos] << 24) | (audioInit[xpos+1] << 16) | (audioInit[xpos+2] << 8) | audioInit[xpos+3];
            const xtype = String.fromCharCode(audioInit[xpos+4], audioInit[xpos+5], audioInit[xpos+6], audioInit[xpos+7]);
            if (xtype === 'trex') {
              aTrex = new Uint8Array(audioInit.subarray(xpos, xpos + xsize));
            }
            xpos += xsize;
          }
        }
        mpos += msize;
      }
    }
    pos += size;
  }

  if (!aTrak || !aTrex) return videoInit;

  // Set track_id = 2 in audio trak (offset 28) and trex (offset 12)
  new DataView(aTrak.buffer, aTrak.byteOffset).setUint32(28, 2);
  new DataView(aTrex.buffer, aTrex.byteOffset).setUint32(12, 2);

  // Locate moov and mvex in videoInit
  let vMoovOffset = -1;
  let vMoovSize = 0;
  pos = 0;
  while (pos + 8 <= videoInit.length) {
    const size = (videoInit[pos] << 24) | (videoInit[pos+1] << 16) | (videoInit[pos+2] << 8) | videoInit[pos+3];
    const type = String.fromCharCode(videoInit[pos+4], videoInit[pos+5], videoInit[pos+6], videoInit[pos+7]);
    if (type === 'moov') {
      vMoovOffset = pos;
      vMoovSize = size;
      break;
    }
    pos += size;
  }
  if (vMoovOffset < 0) return videoInit;

  let vMvexOffset = -1;
  let vMvexSize = 0;
  pos = vMoovOffset + 8;
  const vMoovEnd = vMoovOffset + vMoovSize;
  while (pos + 8 <= vMoovEnd) {
    const size = (videoInit[pos] << 24) | (videoInit[pos+1] << 16) | (videoInit[pos+2] << 8) | videoInit[pos+3];
    const type = String.fromCharCode(videoInit[pos+4], videoInit[pos+5], videoInit[pos+6], videoInit[pos+7]);
    if (type === 'mvex') {
      vMvexOffset = pos;
      vMvexSize = size;
      break;
    }
    pos += size;
  }
  if (vMvexOffset < 0) return videoInit;

  // Merge audio track into video moov
  const part1 = videoInit.subarray(0, vMvexOffset);
  const part2 = aTrak;

  const newMvexSize = vMvexSize + aTrex.length;
  const newMvex = new Uint8Array(newMvexSize);
  new DataView(newMvex.buffer).setUint32(0, newMvexSize);
  newMvex.set(videoInit.subarray(vMvexOffset + 4, vMvexOffset + vMvexSize), 4);
  newMvex.set(aTrex, vMvexSize);

  const part4 = videoInit.subarray(vMvexOffset + vMvexSize);

  const totalLength = part1.length + part2.length + newMvex.length + part4.length;
  const merged = new Uint8Array(totalLength);
  let writeOffset = 0;
  merged.set(part1, writeOffset); writeOffset += part1.length;
  merged.set(part2, writeOffset); writeOffset += part2.length;
  merged.set(newMvex, writeOffset); writeOffset += newMvex.length;
  merged.set(part4, writeOffset);

  // Update moov size header
  const newMoovSize = vMoovSize + aTrak.length + aTrex.length;
  new DataView(merged.buffer).setUint32(vMoovOffset, newMoovSize);

  return merged;
}

/**
 * Update track_ID in audio segment's tfhd box to 2.
 */
function updateAudioSegmentTrackId(segData) {
  let pos = 0;
  while (pos + 8 <= segData.length) {
    const size = (segData[pos] << 24) | (segData[pos+1] << 16) | (segData[pos+2] << 8) | segData[pos+3];
    const type = String.fromCharCode(segData[pos+4], segData[pos+5], segData[pos+6], segData[pos+7]);
    if (type === 'moof') {
      let mpos = pos + 8;
      const mend = pos + size;
      while (mpos + 8 <= mend) {
        const msize = (segData[mpos] << 24) | (segData[mpos+1] << 16) | (segData[mpos+2] << 8) | segData[mpos+3];
        const mtype = String.fromCharCode(segData[mpos+4], segData[mpos+5], segData[mpos+6], segData[mpos+7]);
        if (mtype === 'traf') {
          let tpos = mpos + 8;
          const tend = mpos + msize;
          while (tpos + 8 <= tend) {
            const tsize = (segData[tpos] << 24) | (segData[tpos+1] << 16) | (segData[tpos+2] << 8) | segData[tpos+3];
            const ttype = String.fromCharCode(segData[tpos+4], segData[tpos+5], segData[tpos+6], segData[tpos+7]);
            if (ttype === 'tfhd') {
              new DataView(segData.buffer, segData.byteOffset + tpos).setUint32(12, 2);
              return;
            }
            tpos += tsize;
          }
        }
        mpos += msize;
      }
    }
    pos += size;
  }
}

/**
 * Decrypt AES-128 segment chunk if encrypted.
 */
async function decryptAes128Chunk(chunkBuffer, cryptoKey, seqIndex, ivHex) {
  let iv;
  if (ivHex) {
    const hex = ivHex.startsWith('0x') ? ivHex.substring(2) : ivHex;
    iv = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      iv[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    }
  } else {
    // Default IV is 16-byte segment sequence number
    iv = new Uint8Array(16);
    const view = new DataView(iv.buffer);
    view.setBigUint64(8, BigInt(seqIndex));
  }

  return await crypto.subtle.decrypt(
    { name: 'AES-CBC', iv },
    cryptoKey,
    chunkBuffer
  );
}

/**
 * Probe an HLS playlist to calculate real duration, estimated sizes, and variant list.
 */
async function probeHlsStreamInfo(url, referer) {
  try {
    const headers = referer ? { 'Referer': referer } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = parseM3U8(text, url);

    let bandwidth = 0;
    let resolution = '';
    let totalDuration = 0;
    let totalSegments = 0;
    const variants = [];
    let audioUrl = null;

    if (parsed.isMaster && parsed.variants.length > 0) {
      if (parsed.audioTracks.size > 0) {
        audioUrl = Array.from(parsed.audioTracks.values())[0];
      }

      const best = parsed.variants[0];
      bandwidth = best.bandwidth || 0;
      resolution = best.resolution || '';

      // Probe duration from top variant
      try {
        const vRes = await fetch(best.url, { headers });
        if (vRes.ok) {
          const vText = await vRes.text();
          const vParsed = parseM3U8(vText, best.url);
          totalDuration = vParsed.totalDuration;
          totalSegments = vParsed.segments.length;
        }
      } catch (_) {}

      // Build rich variant options
      for (const v of parsed.variants) {
        let label = '';
        if (v.resolution) {
          const parts = v.resolution.split('x');
          const h = parseInt(parts[1], 10);
          if (h >= 1080) label = '1080p (FHD)';
          else if (h >= 720) label = '720p (HD)';
          else if (h >= 480) label = '480p (SD)';
          else if (h >= 360) label = '360p (SD)';
          else label = `${h}p`;
        } else if (v.bandwidth) {
          label = `${Math.round(v.bandwidth / 1000)} kbps`;
        } else {
          label = 'Original';
        }

        let codecTag = '';
        const cLower = (v.codecs || '').toLowerCase();
        const uLower = (v.url || '').toLowerCase();
        if (cLower.includes('avc') || uLower.includes('h264')) {
          codecTag = 'H.264 Universal';
        } else if (cLower.includes('av01') || uLower.includes('av1')) {
          codecTag = 'AV1';
        } else if (cLower.includes('hvc') || cLower.includes('hev') || uLower.includes('hevc')) {
          codecTag = 'HEVC';
        }

        if (codecTag) {
          label = `${label} (${codecTag})`;
        }

        const estSize = (totalDuration > 0 && v.bandwidth > 0)
          ? Math.round((v.bandwidth * totalDuration) / 8)
          : 0;

        let vAudio = audioUrl;
        if (v.audioGroupId && parsed.audioTracks.has(v.audioGroupId)) {
          vAudio = parsed.audioTracks.get(v.audioGroupId);
        }

        variants.push({
          label,
          resolution: v.resolution,
          bandwidth: v.bandwidth,
          codecs: v.codecs,
          isH264: codecTag.includes('H.264'),
          url: v.url,
          audioUrl: vAudio,
          estimatedSize: estSize
        });
      }

      // Prioritize H.264 variants for maximum out-of-the-box player compatibility
      variants.sort((a, b) => {
        if (a.isH264 && !b.isH264) return -1;
        if (!a.isH264 && b.isH264) return 1;
        return (b.bandwidth || 0) - (a.bandwidth || 0);
      });

      // Add "Audio Only" option if audio track exists
      if (audioUrl) {
        const audioEstSize = totalDuration > 0 ? Math.round((128000 * totalDuration) / 8) : 0;
        variants.push({
          label: '🎵 Audio Only (M4A/MP3)',
          resolution: 'Audio',
          bandwidth: 128000,
          url: audioUrl,
          audioUrl: audioUrl,
          isAudioOnly: true,
          estimatedSize: audioEstSize
        });
      }
    } else {
      totalDuration = parsed.totalDuration;
      totalSegments = parsed.segments.length;
    }

    let estimatedSize = 0;
    if (bandwidth > 0 && totalDuration > 0) {
      estimatedSize = Math.round((bandwidth * totalDuration) / 8);
    }

    return {
      isMaster: parsed.isMaster,
      totalDuration,
      totalSegments,
      estimatedSize,
      resolution,
      variants,
      audioUrl
    };
  } catch (_) {
    return null;
  }
}

/**
 * Discover sibling audio playlist if url is a bare variant playlist without master.
 */
async function discoverSiblingAudioPlaylist(videoUrl, headers) {
  try {
    const urlObj = new URL(videoUrl);
    const pathname = urlObj.pathname;

    // Pattern 1: Dailymotion / Akamai (.../h264_fhd/3/manifest.m3u8 or .../av1_fhd/3/manifest.m3u8 -> .../aac_q2_0/3/manifest.m3u8)
    if (/(h264|av1|hevc)_[a-z0-9]+/i.test(pathname)) {
      const audioPath = pathname.replace(/(h264|av1|hevc)_[a-z0-9]+/i, 'aac_q2_0');
      const candidateUrl = new URL(audioPath + urlObj.search, urlObj.origin).href;
      const res = await fetch(candidateUrl, { headers });
      if (res.ok) return candidateUrl;
    }

    // Pattern 2: Generic video/ -> audio/
    if (pathname.includes('/video/')) {
      const audioPath = pathname.replace('/video/', '/audio/');
      const candidateUrl = new URL(audioPath + urlObj.search, urlObj.origin).href;
      const res = await fetch(candidateUrl, { headers });
      if (res.ok) return candidateUrl;
    }
  } catch (_) {}
  return null;
}

/**
 * Download HLS Stream with full fMP4 init inclusion, AES decryption, and Audio+Video muxing.
 */
async function downloadHlsStream(item, onProgress) {
  const { id, url, filename, referer, selectedVariantUrl, isAudioOnly, audioUrl: passedAudioUrl } = item;
  const headers = referer ? { 'Referer': referer } : {};

  // Setup AbortController for cancel support
  const controller = new AbortController();
  activeDownloads.set(id, { controller, cancelled: false });
  const signal = controller.signal;

  try {
    // 1. Determine target stream URLs
    let targetUrl = selectedVariantUrl || url;
    let audioMediaUrl = passedAudioUrl || null;

    // Fetch initial playlist
    const res = await fetch(targetUrl, { headers, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching playlist`);
    const playlistText = await res.text();
    let parsed = parseM3U8(playlistText, targetUrl);

    let videoMediaUrl = targetUrl;

    if (parsed.isMaster && parsed.variants.length > 0) {
      if (isAudioOnly) {
        // Direct audio extraction from master
        audioMediaUrl = parsed.audioTracks.size > 0 ? Array.from(parsed.audioTracks.values())[0] : null;
        if (!audioMediaUrl) {
          // Fallback to lowest variant if no audio track
          audioMediaUrl = parsed.variants[parsed.variants.length - 1].url;
        }
      } else {
        // Select matching variant or best variant
        const chosen = selectedVariantUrl
          ? (parsed.variants.find(v => v.url === selectedVariantUrl) || parsed.variants[0])
          : parsed.variants[0];

        videoMediaUrl = chosen.url;
        if (chosen.audioGroupId && parsed.audioTracks.has(chosen.audioGroupId)) {
          audioMediaUrl = parsed.audioTracks.get(chosen.audioGroupId);
        } else if (parsed.audioTracks.size > 0) {
          audioMediaUrl = Array.from(parsed.audioTracks.values())[0];
        }

        const vRes = await fetch(videoMediaUrl, { headers, signal });
        if (!vRes.ok) throw new Error(`HTTP ${vRes.status} fetching video playlist`);
        parsed = parseM3U8(await vRes.text(), videoMediaUrl);
      }
    }

    // If audio-only mode requested
    if (isAudioOnly) {
      const aUrl = audioMediaUrl || targetUrl;
      const aRes = await fetch(aUrl, { headers, signal });
      if (!aRes.ok) throw new Error(`HTTP ${aRes.status} fetching audio playlist`);
      const aParsed = parseM3U8(await aRes.text(), aUrl);

      if (aParsed.segments.length === 0) {
        throw new Error('No audio segments found in audio playlist.');
      }

      // Download audio init
      let aInitBuffer = null;
      if (aParsed.initUrl) {
        const initRes = await fetch(aParsed.initUrl, { headers, signal });
        if (initRes.ok) {
          aInitBuffer = new Uint8Array(await initRes.arrayBuffer());
        }
      }

      // Download audio segments
      const aChunks = new Array(aParsed.segments.length);
      let completed = 0;
      let downloadedBytes = aInitBuffer?.byteLength || 0;

      for (let i = 0; i < aParsed.segments.length; i++) {
        if (signal.aborted) return;
        const seg = aParsed.segments[i];
        const sRes = await fetch(seg.url, { headers, signal });
        if (!sRes.ok) throw new Error(`HTTP ${sRes.status}`);
        const buf = new Uint8Array(await sRes.arrayBuffer());
        aChunks[i] = buf;
        downloadedBytes += buf.byteLength;
        completed++;

        if (onProgress) {
          onProgress({
            completed,
            total: aParsed.segments.length,
            percent: Math.round((completed / aParsed.segments.length) * 100),
            downloadedBytes
          });
        }
      }

      const audioParts = [];
      if (aInitBuffer) audioParts.push(aInitBuffer);
      for (const c of aChunks) {
        if (c) audioParts.push(c);
      }

      const audioBlob = new Blob(audioParts, { type: 'audio/mp4' });
      const blobUrl = URL.createObjectURL(audioBlob);

      let cleanName = (filename || 'Audio').replace(/\.[a-z0-9]+$/i, '').trim();
      cleanName = `${cleanName}.m4a`;

      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_DOWNLOAD_COMPLETE',
        payload: { id, blobUrl, filename: cleanName }
      });
      return;
    }

    // Video + Audio Muxing Pipeline
    const vInitUrl = parsed.initUrl;
    const vSegments = parsed.segments;

    if (vSegments.length === 0) {
      throw new Error('No playable media segments found in stream playlist.');
    }

    // If audioMediaUrl is still not found, attempt sibling discovery
    if (!audioMediaUrl) {
      audioMediaUrl = await discoverSiblingAudioPlaylist(videoMediaUrl, headers);
    }

    // Parse audio playlist if present
    let aInitUrl = null;
    let aSegments = [];
    if (audioMediaUrl) {
      try {
        const aRes = await fetch(audioMediaUrl, { headers, signal });
        if (aRes.ok) {
          const aParsed = parseM3U8(await aRes.text(), audioMediaUrl);
          aInitUrl = aParsed.initUrl;
          aSegments = aParsed.segments;
        }
      } catch (_) {}
    }

    // Handle AES-128 Encryption Keys
    let vCryptoKey = null;
    if (parsed.keyInfo?.url) {
      const keyRes = await fetch(parsed.keyInfo.url, { headers, signal });
      if (keyRes.ok) {
        const rawKey = await keyRes.arrayBuffer();
        vCryptoKey = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-CBC' }, false, ['decrypt']);
      }
    }

    // Download Video and Audio Init Segments
    let vInitBuffer = null;
    if (vInitUrl) {
      const initRes = await fetch(vInitUrl, { headers, signal });
      if (initRes.ok) {
        vInitBuffer = new Uint8Array(await initRes.arrayBuffer());
      }
    }

    let aInitBuffer = null;
    if (aInitUrl) {
      const aInitRes = await fetch(aInitUrl, { headers, signal });
      if (aInitRes.ok) {
        aInitBuffer = new Uint8Array(await aInitRes.arrayBuffer());
      }
    }

    // Concurrently download segments
    const totalSegmentsCount = vSegments.length + aSegments.length;
    const vChunks = new Array(vSegments.length);
    const aChunks = new Array(aSegments.length);

    let completed = 0;
    let downloadedBytes = (vInitBuffer?.byteLength || 0) + (aInitBuffer?.byteLength || 0);

    async function downloadSegmentPool(segmentList, targetArray, cryptoKey, isAudio) {
      const CONCURRENCY = 6;
      let idx = 0;

      async function worker() {
        while (idx < segmentList.length) {
          if (signal.aborted) return;
          const i = idx++;
          const seg = segmentList[i];

          let attempts = 0;
          let success = false;
          while (attempts < 3 && !success) {
            if (signal.aborted) return;
            attempts++;
            try {
              const sRes = await fetch(seg.url, { headers, signal });
              if (!sRes.ok) throw new Error(`HTTP ${sRes.status}`);
              let chunkBuf = await sRes.arrayBuffer();

              if (cryptoKey) {
                chunkBuf = await decryptAes128Chunk(chunkBuf, cryptoKey, i, seg.keyInfo?.ivHex);
              }

              const uint8Chunk = new Uint8Array(chunkBuf);
              if (isAudio) {
                updateAudioSegmentTrackId(uint8Chunk);
              }

              targetArray[i] = uint8Chunk;
              downloadedBytes += uint8Chunk.byteLength;
              success = true;
            } catch (err) {
              if (signal.aborted) return;
              if (attempts >= 3) throw err;
              await new Promise(r => setTimeout(r, 600));
            }
          }

          completed++;
          if (onProgress && !signal.aborted) {
            onProgress({
              completed,
              total: totalSegmentsCount,
              percent: Math.round((completed / totalSegmentsCount) * 100),
              downloadedBytes
            });
          }
        }
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, segmentList.length) }, () => worker());
      await Promise.all(workers);
    }

    // Download video and audio segments
    await downloadSegmentPool(vSegments, vChunks, vCryptoKey, false);
    if (signal.aborted) return;

    if (aSegments.length > 0) {
      await downloadSegmentPool(aSegments, aChunks, null, true);
    }
    if (signal.aborted) return;

    // Assemble final MP4 File
    const finalParts = [];

    if (vInitBuffer && aInitBuffer && aChunks.length > 0) {
      // Mux separate Audio and Video fMP4
      const mergedInit = mergeFmp4Init(vInitBuffer, aInitBuffer);
      finalParts.push(mergedInit);

      const maxLen = Math.max(vChunks.length, aChunks.length);
      for (let i = 0; i < maxLen; i++) {
        if (i < vChunks.length && vChunks[i]) finalParts.push(vChunks[i]);
        if (i < aChunks.length && aChunks[i]) finalParts.push(aChunks[i]);
      }
    } else {
      // Single track stream (fMP4 with init or classic TS)
      if (vInitBuffer) finalParts.push(vInitBuffer);
      for (const chunk of vChunks) {
        if (chunk) finalParts.push(chunk);
      }
    }

    const finalBlob = new Blob(finalParts, { type: 'video/mp4' });
    const blobUrl = URL.createObjectURL(finalBlob);

    // Format clean filename
    let cleanName = filename || 'video.mp4';
    cleanName = cleanName.replace(/\.m3u8(\.mp4)?$/i, '').trim();
    if (!cleanName || cleanName.toLowerCase() === 'manifest' || cleanName.toLowerCase() === 'index') {
      cleanName = item.title || 'Video';
    }
    if (!cleanName.endsWith('.mp4')) {
      cleanName += '.mp4';
    }

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_DOWNLOAD_COMPLETE',
      payload: { id, blobUrl, filename: cleanName }
    });
  } catch (err) {
    if (signal.aborted) {
      console.log('HLS download cancelled by user:', id);
      return;
    }
    throw err;
  } finally {
    activeDownloads.delete(id);
  }
}

// Message Listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_START_HLS_DOWNLOAD') {
    downloadHlsStream(message.payload, (progress) => {
      chrome.runtime.sendMessage({
        type: 'HLS_PROGRESS_UPDATE',
        payload: {
          id: message.payload.id,
          ...progress
        }
      }).catch(() => {});
    }).catch((err) => {
      chrome.runtime.sendMessage({
        type: 'HLS_ERROR',
        payload: {
          id: message.payload.id,
          error: err.message
        }
      }).catch(() => {});
    });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OFFSCREEN_CANCEL_DOWNLOAD') {
    const { id } = message.payload;
    const item = activeDownloads.get(id);
    if (item) {
      item.cancelled = true;
      item.controller.abort();
      activeDownloads.delete(id);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'OFFSCREEN_PROBE_HLS_INFO') {
    probeHlsStreamInfo(message.payload.url, message.payload.referer)
      .then((info) => {
        sendResponse({ success: true, info });
      })
      .catch((err) => {
        sendResponse({ success: false, error: err.message });
      });
    return true;
  }
});
