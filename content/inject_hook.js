/**
 * Injected script running in the webpage execution context.
 * Hooks into URL.createObjectURL and HTMLMediaElement to capture dynamic in-memory media.
 */
(function() {
  if (window.__UNIVERSAL_DOWNLOADER_INJECTED__) return;
  window.__UNIVERSAL_DOWNLOADER_INJECTED__ = true;

  // 1. Hook window.URL.createObjectURL to detect Blobs (PDFs, images, video segments)
  const origCreateObjectURL = window.URL.createObjectURL;
  window.URL.createObjectURL = function(blob) {
    const url = origCreateObjectURL.apply(this, arguments);
    try {
      if (blob instanceof Blob && blob.size > 2048) { // Skip tiny blobs
        window.postMessage({
          source: '__UNIVERSAL_DOWNLOADER_HOOK__',
          type: 'BLOB_CREATED',
          payload: {
            url,
            size: blob.size,
            mimeType: blob.type
          }
        }, '*');
      }
    } catch (_) {}
    return url;
  };

  // 2. Hook HTMLMediaElement play
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function() {
    try {
      const src = this.currentSrc || this.src;
      if (src && !src.startsWith('data:')) {
        window.postMessage({
          source: '__UNIVERSAL_DOWNLOADER_HOOK__',
          type: 'MEDIA_PLAY',
          payload: {
            url: src,
            tag: this.tagName.toLowerCase(),
            duration: this.duration || 0,
            videoWidth: this.videoWidth || 0,
            videoHeight: this.videoHeight || 0
          }
        }, '*');
      }
    } catch (_) {}
    return origPlay.apply(this, arguments);
  };
})();

