/**
 * Classifier engine directly derived from Soul Browser's classification
 * and MIME extraction architecture.
 */

export const EXTENSION_MAP = {
  // Video Formats (Compress.K)
  video: new Set([
    'mp4', 'webm', 'mkv', 'avi', 'flv', 'mov', 'wmv', '3gp', '3gpp', '3g2',
    'asf', 'f4v', 'hlv', 'm4v', 'mpe', 'mpeg', 'mpg', 'mts', 'ogv', 'qt',
    'rm', 'rmvb', 'swf', 'ts', 'm4s', 'vob', 'wtv', 'yuv', 'm3u8', 'mpd'
  ]),

  // Audio Formats (Compress.E)
  audio: new Set([
    'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma', 'aiff', 'ape', 'mid', 'midi'
  ]),

  // Subtitles (Subtitle.b)
  subtitle: new Set([
    'srt', 'vtt', 'ass', 'ssa', 'sub', 'smi', 'ttml', 'stl', 'psb', 'scc'
  ]),

  // Images & Visuals (Compress.I)
  image: new Set([
    'jpg', 'jpeg', 'png', 'webp', 'gif', 'svg', 'bmp', 'ico', 'avif', 'tiff', 'heic'
  ]),

  // Documents & eBooks (Compress.G, J, L)
  document: new Set([
    'pdf', 'epub', 'mobi', 'azw3', 'cbr', 'cbz', 'docx', 'xlsx', 'pptx',
    'doc', 'xls', 'ppt', 'txt', 'csv', 'mht', 'mhtml', 'rtf'
  ]),

  // Archives & Packages (Compress.b)
  archive: new Set([
    'zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'tbz2'
  ]),

  // Installers & Executables
  package: new Set([
    'apk', 'xapk', 'exe', 'msi', 'dmg', 'pkg', 'deb', 'rpm', 'bin', 'iso'
  ])
};

export const MIME_PREFIX_MAP = [
  { prefix: 'video/', category: 'video' },
  { prefix: 'audio/', category: 'audio' },
  { prefix: 'image/', category: 'image' },
  { prefix: 'application/vnd.apple.mpegurl', category: 'video', isStream: true, streamType: 'hls' },
  { prefix: 'application/x-mpegurl', category: 'video', isStream: true, streamType: 'hls' },
  { prefix: 'application/dash+xml', category: 'video', isStream: true, streamType: 'dash' },
  { prefix: 'application/pdf', category: 'document' },
  { prefix: 'application/epub+zip', category: 'document' },
  { prefix: 'application/zip', category: 'archive' },
  { prefix: 'application/x-zip-compressed', category: 'archive' },
  { prefix: 'application/x-rar-compressed', category: 'archive' },
  { prefix: 'application/x-7z-compressed', category: 'archive' },
  { prefix: 'application/vnd.android.package-archive', category: 'package' }
];

/**
 * Extract filename from Content-Disposition header.
 */
export function extractFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null;

  // RFC 5987 (filename*=UTF-8''encoded_name)
  const rfcMatch = headerValue.match(/filename\*=(?:UTF-8|utf-8)''([^;]+)/i);
  if (rfcMatch && rfcMatch[1]) {
    try {
      return decodeURIComponent(rfcMatch[1].trim());
    } catch (_) {}
  }

  // Standard filename="..." or filename=...
  const match = headerValue.match(/filename="?([^";]+)"?/i);
  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

/**
 * Extract file extension from URL or filename.
 */
export function extractExtension(pathOrUrl) {
  if (!pathOrUrl) return '';
  try {
    // Check main path
    const cleanUrl = pathOrUrl.split('?')[0].split('#')[0];
    const lastSlash = cleanUrl.lastIndexOf('/');
    const filename = lastSlash !== -1 ? cleanUrl.substring(lastSlash + 1) : cleanUrl;
    const lastDot = filename.lastIndexOf('.');
    if (lastDot !== -1 && lastDot < filename.length - 1) {
      const ext = filename.substring(lastDot + 1).toLowerCase();
      // Ensure ext is reasonable (1-10 alphanumeric characters)
      if (/^[a-z0-9]{1,10}$/.test(ext)) {
        return ext;
      }
    }

    // If not found in path, check URL query parameters (e.g. ?format=mp4 or &ext=m3u8)
    const urlObj = new URL(pathOrUrl);
    for (const [key, val] of urlObj.searchParams.entries()) {
      const k = key.toLowerCase();
      const v = (val || '').toLowerCase().trim();
      if ((k === 'format' || k === 'ext' || k === 'extension') && /^[a-z0-9]{2,5}$/.test(v)) {
        return v;
      }
      if (k === 'mime' && v.startsWith('video/')) {
        return v.split('/')[1] || 'mp4';
      }
      if (v.endsWith('.m3u8')) return 'm3u8';
      if (v.endsWith('.mp4')) return 'mp4';
    }
  } catch (_) {}
  return '';
}

/**
 * Generate human-readable clean filename.
 */
export function generateFilename(url, declaredName, extension, defaultBase = 'download') {
  if (declaredName) {
    return declaredName.replace(/[/\\?%*:|"<>]/g, '_');
  }

  try {
    const cleanUrl = url.split('?')[0].split('#')[0];
    const segments = cleanUrl.split('/').filter(Boolean);
    if (segments.length > 0) {
      let candidate = decodeURIComponent(segments[segments.length - 1]);
      if (candidate && candidate.length > 1 && !candidate.startsWith('stream.')) {
        if (!candidate.endsWith('.' + extension) && extension) {
          candidate = `${candidate}.${extension}`;
        }
        return candidate.replace(/[/\\?%*:|"<>]/g, '_');
      }
    }
  } catch (_) {}

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${defaultBase}_${timestamp}.${extension || 'bin'}`;
}

/**
 * Check if a URL corresponds to an individual HLS/DASH segment chunk or init box
 * rather than a master/variant playlist or standalone video file.
 */
export function isStreamFragment(url) {
  if (!url) return false;
  try {
    const cleanUrl = url.split('?')[0].toLowerCase();
    // Segment files: 0.m4s, seg-1.m4s, segment-12.ts, etc.
    if (/\.(m4s|ts)$/i.test(cleanUrl)) {
      if (/\/(\d+|chunk|seg|fragment|part|media)[^\/]*\.(m4s|ts)$/i.test(cleanUrl)) {
        return true;
      }
    }
    // Sub-init boxes for fragments
    if (/\/init\.mp4$/i.test(cleanUrl) || /\/init-[^\/]+\.mp4$/i.test(cleanUrl)) {
      return true;
    }
  } catch (_) {}
  return false;
}

/**
 * Classify request by URL, MIME type, and Content-Disposition.
 */
export function classifyResource(url, mimeType = '', contentDisposition = '') {
  const normMime = (mimeType || '').toLowerCase().trim();
  const declaredName = extractFilenameFromContentDisposition(contentDisposition);
  let ext = extractExtension(declaredName) || extractExtension(url);

  let category = 'other';
  let isStream = false;
  let streamType = null;

  // Check streaming extension
  if (ext === 'm3u8' || normMime.includes('mpegurl')) {
    const isAudioStream = /(?:aac_|audio[_\-\/]|_audio|\/a\/)/i.test(url);
    const cat = isAudioStream ? 'audio' : 'video';
    const defBase = isAudioStream ? 'stream_audio' : 'stream_video';
    const defExt = isAudioStream ? 'm4a' : 'mp4';

    return {
      category: cat,
      isStream: true,
      streamType: 'hls',
      isAudioOnly: isAudioStream,
      extension: 'm3u8',
      filename: generateFilename(url, declaredName, defExt, defBase)
    };
  }
  if (ext === 'mpd' || normMime.includes('dash+xml')) {
    return {
      category: 'video',
      isStream: true,
      streamType: 'dash',
      extension: 'mpd',
      filename: generateFilename(url, declaredName, 'mp4', 'dash_video')
    };
  }

  // Check known extensions
  for (const [cat, extSet] of Object.entries(EXTENSION_MAP)) {
    if (extSet.has(ext)) {
      category = cat;
      break;
    }
  }

  // Fallback to MIME prefixes
  if (category === 'other' && normMime) {
    for (const rule of MIME_PREFIX_MAP) {
      if (normMime.startsWith(rule.prefix) || normMime.includes(rule.prefix)) {
        category = rule.category;
        if (rule.isStream) {
          isStream = true;
          streamType = rule.streamType;
        }
        break;
      }
    }
  }

  // Content-Disposition check: if attachment, mark downloadable
  if (contentDisposition && contentDisposition.toLowerCase().includes('attachment') && category === 'other') {
    category = 'document';
  }

  // Assign default extension if missing
  if (!ext) {
    if (category === 'video') ext = 'mp4';
    else if (category === 'audio') ext = 'mp3';
    else if (category === 'image') ext = 'jpg';
    else if (category === 'document') ext = 'pdf';
    else if (category === 'archive') ext = 'zip';
    else ext = 'bin';
  }

  const filename = generateFilename(url, declaredName, ext);

  return {
    category,
    extension: ext,
    filename,
    isStream,
    streamType
  };
}
