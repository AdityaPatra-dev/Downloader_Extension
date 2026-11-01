# Universal Media & File Downloader Extension

A high-performance, cross-platform browser extension inspired by **Soul Browser's** universal media sniffing, album/gallery scraping, and stream download architecture. Compatible with all modern PC browsers including **Google Chrome**, **Microsoft Edge**, **Brave**, **Opera**, and **Firefox**.

---

## 🌟 Features

* **🎬 Universal Video & Stream Sniffer**:
  * Detects direct videos (`.mp4`, `.webm`, `.mkv`, `.avi`, `.flv`, `.mov`, etc.).
  * Native in-browser **HLS (`.m3u8`)** stream parser: automatically resolves multi-bitrate master playlists, fetches segments in parallel, and repacks them into `.mp4`.
* **🎵 Audio & Podcast Extractor**:
  * Captures `.mp3`, `.m4a`, `.aac`, `.flac`, `.wav`, `.ogg`, and `.opus` streams.
* **🖼️ Batch Image & Gallery Downloader**:
  * Extracts high-resolution images (`<img>`, `<picture>`, responsive `srcset`, and CSS `background-image`).
  * Filters out low-res tracking pixels and icons.
  * One-click batch selection and downloading.
* **📁 Documents, Books & Archives**:
  * Automatically detects `.pdf`, `.epub`, `.docx`, `.xlsx`, `.zip`, `.rar`, `.7z`, `.apk`, and other binary downloads.
* **⚡ Anti-Hotlinking Protection**:
  * Replays authentic `Referer`, `Origin`, and session credentials to bypass CDN `403 Forbidden` protection.
* **🧩 In-Memory Blob Capture**:
  * Hooks into `URL.createObjectURL` to catch dynamically generated Blobs from Web Workers, Canvas, and web apps.

---

## 🚀 How to Install in Your PC Browser

### Google Chrome / Microsoft Edge / Brave
1. Open your browser and navigate to the extensions management page:
   * **Chrome**: `chrome://extensions/`
   * **Edge**: `edge://extensions/`
   * **Brave**: `brave://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click the **Load unpacked** button.
4. Select this directory:
   ```text
   /home/adityapatra/Documents/GitHub/Downloader_Extension
   ```
5. The extension icon will appear in your browser toolbar. Pin it for quick access!

### Firefox
1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select the [`manifest.json`](file:///home/adityapatra/Documents/GitHub/Downloader_Extension/manifest.json) file in this directory.

---

## 🏗️ Architecture & Component Layout

```text
Downloader_Extension/
├── manifest.json              # Manifest V3 configuration
├── background/
│   ├── service_worker.js      # Background network coordinator & request listener
│   └── classifier.js          # Soul Browser classification rules & MIME tables
├── content/
│   ├── dom_scanner.js         # Deep DOM inspector for video, audio & image galleries
│   └── inject_hook.js         # Webpage hook for in-memory Blobs & MediaElement plays
├── popup/
│   ├── popup.html             # Multi-category dashboard (Video, Audio, Images, Docs, Archives)
│   ├── popup.css              # Dark theme styling
│   └── popup.js               # Category tabs, progress bars, and download handlers
├── offscreen/
│   ├── offscreen.html         # Offscreen processing sandbox
│   └── hls_stream_muxer.js    # Multi-threaded HLS chunk fetcher & reassembler
├── icons/                     # Vector SVG and PNG icon sizes (16, 32, 48, 128)
├── SOUL_DOWNLOADER_SPEC.md    # Extracted specification from soul_browser.apk
└── SOUL_BROWSER_SNIFFER_ARCHITECTURE.md # REA reverse engineering technical report
```

---

## 📜 Reverse Engineering Reference

Extracted directly from decompiled Android bytecode of **Soul Browser** (`soul_browser.apk` / `com.mycompany.app`):
* `LocalWebViewClient.shouldInterceptRequest`: Network stream interception.
* `MainUtil`: MIME dictionaries, filename cleaning, and Content-Disposition parser.
* `Compress`: 36+ video extensions, audio, and archive definitions.
* `Subtitle`: Multilingual subtitle track associations.

