# HDRG Pro Plus Studio 🎬

All-in-One Hongguo Short Drama Downloader & AI Subtitle Dubbing Studio.

## 🚀 Features (មុខងារសំខាន់ៗ)
- **Top 100 Live Trending Rankings (រឿងល្បីៗ ១០០ រឿង)**: Auto-fetched from official Hongguo rankings and auto-refreshed/rotated every 10 minutes with countdown timer.
- **Multi-Category Drama Engine (ស្វែងរករឿងតាមប្រភេទ)**:
  - 🔥 **កំពុងល្បី (Trending Top 100)**: តារាងចំណាត់ថ្នាក់ផ្លូវការប្រចាំថ្ងៃ
  - 😭 **កម្សត់ & ទុក្ខសោក (Sad / Melodrama)**: រឿងសម្រក់ទឹកភ្នែក ឈឺចាប់ 虐恋 苦情
  - 💖 **Sweet & ផ្អែមល្ហែម (Sweet Rom-com)**: រឿងផ្អែមល្ហែម ស្នេហាយកចិត្ត 甜宠 先婚后爱
  - 🌹 **ស្នេហារ៉ូមែនទិក (Romance)**: រឿងមនោសញ្ចេតនាជ្រាលជ្រៅ 爱情
  - 👑 **CEO & អភិជន (Billionaire Boss)**: លោកប្រធានផ្ដាច់ការ ត្រកូលអភិជន 总裁 豪门
  - ⚔️ **សងសឹក & វាយបក (Revenge & Comeback)**: អ្នកក្រក្លាយជាស្ដេច វាយបកយកឈ្នះ 逆袭 战神
  - ⏳ **ឆ្លងភព & បុរាណ (Historical / Time Travel)**: រឿងឆ្លងភព សម័យបុរាណ 古装 穿越 重生
  - 🎭 **កំប្លែង & សប្បាយ (Comedy & Fun)**: រឿងសើចសប្បាយ បន្ធូរអារម្មណ៍ 喜剧 轻松
  - 👨‍👩‍👧 **គ្រួសារ & ជីវិត (Family & Urban)**: រឿងទំនាស់គ្រួសារ សង្គមពិត 家庭 伦理
  - 🔍 **អាថ៌កំបាំង & ព្រឺព្រួច (Mystery & Suspense)**: រឿងស៊ើបអង្កេត អាថ៌កំបាំង 悬疑 惊悚
- **Auto Khmer Title Translation**: បកប្រែចំណងជើងរឿងចិនមកជាភាសាខ្មែរដោយស្វ័យប្រវត្តិតាមវចនានុក្រមឆ្លាតវៃ។
- **Fast 1-Click Episode Download**: ចុចលើភាគណា ទាញយកភាគនោះភ្លាមៗ ឬចុចប៊ូតុងយក្សដើម្បីទាញយកគ្រប់ភាគទាំងអស់។
- **Instant Stop Button (⏹ ផ្អាកភ្លាមៗ)**: បញ្ឈប់ការទាញយកនិងកាត់ផ្តាច់ Process curl/ffmpeg ដោយមិនបង្កកកម្មវិធី។
- **Fast Multi-Thread Downloader**: Supports downloading episodes with multi-worker threads (2-6 workers).
- **Auto-Merge Full Movie**: Concatenates all episodes into a single Full Movie MP4 via FFmpeg.
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

