# Privacy Policy

**Universal Media & File Downloader** ("the Extension") is dedicated to protecting user privacy and data security.

### 1. Data Collection and Transmission
- **Zero Personal Data Collection**: The Extension does not collect, record, track, store, or transmit any personally identifiable information (PII), browsing history, search queries, or user activity.
- **Zero Third-Party Tracking / Telemetry**: The Extension contains no analytics, telemetry, trackers, external scripts, or remote advertising SDKs.
- **No Remote Servers**: All media detection, sniffing, playlist parsing, and MP4 reassembly operate strictly locally within the user's browser.

### 2. Permissions Justification
- **`<all_urls>`**: Required locally to detect video, audio, image galleries, and downloadable files across websites visited by the user.
- **`declarativeNetRequest`**: Used strictly to apply temporary local request and response headers (`Referer`, `Origin`, and CORS headers) for media playback previews and chunk downloads. The active webpage tab is explicitly excluded from modification.
- **`webRequest`**: Used passively to inspect response headers (`Content-Type`, `Content-Disposition`, `Content-Length`) to classify downloadable files.
- **`downloads`**: Required to invoke the browser's native download manager when the user explicitly clicks "Download".
- **`offscreen` / `storage`**: Used locally for in-memory stream segment reassembly and preserving local UI category preferences.

### 3. Third-Party Services & Platform Terms
- In compliance with Google Chrome Web Store Developer Program Policies, downloading media from YouTube is strictly disabled.
- The Extension adheres to the Terms of Service of all host platforms.

### 4. Contact
For questions regarding this privacy policy or the extension:
- GitHub: [https://github.com/AdityaPatra-dev/Downloader_Extension](https://github.com/AdityaPatra-dev/Downloader_Extension)
