# HDRG Pro Plus Studio 🎬

All-in-One Hongguo Short Drama Downloader & AI Subtitle Dubbing Studio.

## 🚀 Features (មុខងារសំខាន់ៗ)
- **Fast Multi-Thread Downloader**: Supports downloading episodes with multi-worker threads (2-6 workers).
- **Interactive Episode Grid**: Live status for each episode (Done, Downloading %, Pending).
- **Auto-Merge**: Concatenates all episodes into a single Full Movie MP4 via FFmpeg.
- **Smart Resolver**: Resolves dramas by Series ID, direct URL, or Chinese drama title search.
- **Khmer AI Dubbing**: Text-to-speech integration with Edge-TTS (`km-KH-PisethNeural` & `km-KH-SreymomNeural`).

## 📦 Getting Started (ការដំឡើង និងដំណើរការ)

### 1. Prerequisites
- **Node.js**: v18+ or v20+ installed
- **FFmpeg**: Required for decrypting CENC stream and merging. Ensure `ffmpeg.exe` is placed in `hongguo-drama/build/ffmpeg/` or available in system PATH.

### 2. Install Dependencies
```bash
npm install
```

### 3. Run Studio
```bash
npm start
# Or double-click: បើកកម្មវិធីទាញយក.bat
```
Then open your browser at:
```
http://localhost:3000
```

## 🛠️ Project Structure
- `ui_server.js` - Main HTTP & SSE server with Web UI and download orchestrator.
- `hongguo-drama/src/native/` - Core decryption, search, catalog, and play URL resolvers.
- `generate_khmer_dub_ep1.js` - Khmer subtitle (.srt) and voiceover generation script.
- `បើកកម្មវិធីទាញយក.bat` - Windows 1-click batch launcher.

## 📄 License
MIT License - Created for development by koeurnDev.
