# Soul Browser Downloader: Extracted Specification & Rule Catalog

Extracted from decompiled bytecode of `soul_browser.apk` (`com.mycompany.app`, version 1.4.85).

---

## 1. File Classification & Format Matrix

### Video & Stream Formats (`Compress.K` & `MainUtil`)
* **Direct Video Extensions**:
  `mp4`, `webm`, `mkv`, `avi`, `flv`, `mov`, `wmv`, `3gp`, `3gpp`, `3g2`, `3gpp2`, `asf`, `asx`, `avs`, `f4v`, `hlv`, `m1v`, `m4v`, `mp2`, `mpe`, `mpeg`, `mpg`, `mts`, `ogv`, `qt`, `rm`, `rmvb`, `swf`, `tp`, `viv`, `vivo`, `vob`, `wtv`, `yuv`
* **Stream Manifests & Segments**:
  `m3u8` (HLS playlist), `mpd` (DASH manifest), `ts` (MPEG-2 Transport Stream), `m4s` (Fragmented MP4 segment)
* **Video MIME Types**:
  `video/*`, `application/vnd.apple.mpegurl`, `application/x-mpegurl`, `application/dash+xml`

### Audio Formats (`Compress.E` & `MainUtil`)
* **Audio Extensions**:
  `mp3`, `m4a`, `aac`, `flac`, `wav`, `ogg`, `opus`, `wma`, `aiff`, `ape`, `mid`, `midi`
* **Audio MIME Types**:
  `audio/*`, `application/ogg`, `application/x-ogg`

### Subtitle Formats (`Subtitle.f18306a`)
* **Extensions**:
  `srt`, `vtt`, `ass`, `ssa`, `sub`, `smi`, `ttml`, `stl`, `psb`, `scc`

### Image & Visual Media (`Compress.I`, `WebViewActivity`)
* **Web Image Extensions**:
  `jpg`, `jpeg`, `png`, `webp`, `gif`, `svg`, `bmp`, `tiff`, `ico`, `avif`, `heic`
* **Data Schemas**:
  `data:image/*` (Base64 data URIs), `blob:...` (In-memory Object URLs)
* **DOM Selectors**:
  `img[src]`, `img[data-src]`, `img[srcset]`, `picture source[srcset]`, `canvas`, `[style*="background-image"]`

### Documents & Books (`Compress.G`, `Compress.J`, `Compress.L`)
* **Document Extensions**:
  `pdf`, `epub`, `mobi`, `azw3`, `cbr`, `cbz`, `docx`, `xlsx`, `pptx`, `doc`, `xls`, `ppt`, `txt`, `csv`, `mht`, `mhtml`
* **Document MIME Types**:
  `application/pdf`, `application/epub+zip`, `text/*`

### Archives, Installers & Binaries (`Compress.b`, `MainUtil`)
* **Archive Extensions**:
  `zip`, `rar`, `7z`, `tar`, `gz`, `bz2`, `xz`, `tgz`, `tbz2`
* **Executable & Package Extensions**:
  `apk`, `xapk`, `exe`, `msi`, `dmg`, `pkg`, `deb`, `rpm`, `bin`, `iso`
* **Binary MIME Types**:
  `application/octet-stream`, `application/zip`, `application/x-zip-compressed`, `application/x-rar-compressed`, `application/x-7z-compressed`

---

## 2. Request Interception & Anti-Hotlinking Pipeline

Soul Browser's interception flow in `LocalWebViewClient.shouldInterceptRequest`:

1. **Pre-Filter**:
   - Check URL schema: Must be `http://`, `https://`, `blob:`, or `data:image/`.
   - Strip tracking query parameters from known video hosts while preserving signed authorization tokens (`expires`, `signature`, `token`, `key`).
2. **Context Retention**:
   - Preserve `Referer` (the host web page).
   - Preserve `Origin`.
   - Preserve session `Cookie` tokens.
   - Retain the active browser `User-Agent`.
3. **Filename & Content-Disposition Parsing** (`MainUtil.z2`, `URLUtilCompat.b`):
   - Parse `Content-Disposition: attachment; filename="filename.ext"` or `filename*=UTF-8''filename.ext`.
   - Fallback to URL path segment: `https://domain.com/path/to/media.mp4?query=1` -> `media.mp4`.
   - If resolved name is generic (`downloadfile.bin` or empty), compute name from document `<title>` + detected MIME extension.

---

## 3. HLS Multi-Stream Muxing Specification

When an `.m3u8` playlist is intercepted:
1. **Master Playlist Resolution**: If the playlist contains `#EXT-X-STREAM-INF`, evaluate `BANDWIDTH` and `RESOLUTION` to select the highest quality stream URL.
2. **Chunk Inventory**: Parse `#EXTINF` segment tags and compute absolute segment URLs from relative paths.
3. **Concurrent Download Engine**: Download chunks using a thread-pool (worker queue) with retry counters.
4. **Muxing**: Remux audio AAC/AC3 and video H.264/H.265 chunks into a single fragmented MP4 container.

