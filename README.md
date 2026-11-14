# ⚡ EZA PRO Downloader

កម្មវិធី Desktop (`.exe`) និង Web UI សម្រាប់ស្វែងរក និងទាញយករឿងភាគចិន/អន្តរជាតិ (HongGuo, DramaBox, ReelShort, Hema, Xifan) និងវីដេអូ Link (TikTok, YouTube, Facebook, Douyin...) ល្បឿនលឿន Multi-Worker ព្រមទាំងផ្គុំជារឿងពេញដោយស្វ័យប្រវត្តិ (Auto-Merge)។

*(Repository នេះសម្រាប់តែ **EZA PRO Downloader** ប៉ុណ្ណោះ)*

---

## 📋 ១. ត្រូវការអ្វីខ្លះ? (Requirements)

### ក. សម្រាប់អ្នកប្រើទូទៅ (ប្រើ `.exe` ផ្ទាល់ — មិនបាច់ចេះកូដ)
- **ប្រព័ន្ធប្រតិបត្តិការ**: Windows 10 ឬ Windows 11 (64-bit / x64)
- **អ៊ីនធឺណិត**: ត្រូវការសម្រាប់ផ្ទៀងផ្ទាត់ License Key និងទាញយករឿង/វីដេអូ *(អាចបន្តប្រើ Offline បាន ១២ ម៉ោងក្រោយផ្ទៀងផ្ទាត់ម្ដង)*
- **License Key (`EZAPRO-XXXX-...`)**: សម្រាប់បើកសិទ្ធិប្រើប្រាស់កម្មវិធី Downloader
- **Gemini API Key** *(ស្រេចចិត្ត)*: បំពេញក្នុង **⚙️ ការកំណត់** បើចង់ឲ្យ AI បកប្រែចំណងជើង/សាច់រឿងចិនទៅជាភាសាខ្មែរ
- **Tool ទាញយក និងផ្គុំវីដេអូ**: `ffmpeg.exe`, `ffprobe.exe`, `aria2c.exe`, `yt-dlp.exe`, `N_m3u8DL-RE.exe` **ខ្ចប់ភ្ជាប់មកជាមួយ `.exe` ស្រាប់** មិនបាច់ដំឡើងបន្ថែមទេ។

### ខ. សម្រាប់អ្នកអភិវឌ្ឍ (Dev & Build `.exe`)
- **Node.js**: កំណែ `v20+` ឬ `v22.12+` (`npm` រួមបញ្ចូលស្រាប់)
- **Git**: សម្រាប់ Push/Pull កូដពី `https://github.com/koeurnDev/RG.git`
- **Binary Tools ក្នុងថត `bin/`** *(មិនត្រូវ Push ចូល GitHub ទេ ព្រោះទំហំធំ)*:
  - `bin/ffmpeg.exe`
  - `bin/ffprobe.exe`
  - `bin/aria2c.exe`
  - `bin/yt-dlp.exe`
  - `bin/N_m3u8DL-RE.exe`

---

## 🚀 ២. របៀបប្រើសម្រាប់អ្នកប្រើទូទៅ (End-User Guide)

1. **បើក និងបញ្ចូល License Key**:
   - បើកកម្មវិធី `EZA PRO Downloader-1.0.0-x64.exe` (ឬ `Portable.exe`)។
   - ផ្ទាំងផ្ទៀងផ្ទាត់នឹងបង្ហាញ **Machine ID** (`EZA-XXXX-XXXX-XXXX`) របស់កុំព្យូទ័រ។
   - ចុច **📋 ចម្លង ID** ផ្ញើទៅ Admin ដើម្បីទទួល Key → បិទភ្ជាប់ Key រួចចុច **🔓 បើកចូលប្រើប្រាស់**។
2. **ទាញយករឿងភាគ (HongGuo, DramaBox, ReelShort, Hema, Xifan)**:
   - ជ្រើសប្រភេទរឿង (កំពុងល្បី, កម្សត់, ស្នេហា, CEO, សងសឹក...) ឬវាយឈ្មោះរឿង / បិទភ្ជាប់ Link ក្នុងប្រអប់ស្វែងរក។
   - ចុចរឿងដែលចង់បាន → ជ្រើសភាគ (`EP01..EP80`) ឬចុច **ទាញយកទាំងអស់**។
   - អាចបើក **Auto-Merge** ដើម្បីឲ្យកម្មវិធីផ្គុំភាគទាំងអស់ជារឿងពេញ ១ ឯកសារដោយស្វ័យប្រវត្តិក្រោយទាញចប់។
3. **ទាញយកវីដេអូ Link (TikTok, YouTube, Facebook...)**:
   - ចុច Tab **🌐 Social Video / Link** → បិទភ្ជាប់ URL → ពិនិត្យគុណភាព → ចុចទាញយក។
4. **គ្រប់គ្រង និងថតរក្សាទុកវីដេអូ**:
   - ចូល **📥 គ្រប់គ្រងវីដេអូ** ដើម្បីមើលល្បឿនទាញយក បញ្ឈប់ ផ្គុំរឿងពេញ ឬបើកមើលវីដេអូភ្លាមៗ។
   - ឯកសារដែលទាញរួចត្រូវបានរក្សាទុកតាមលំនាំដើមក្នុង `Videos\EZA PRO Downloader` *(អាចប្ដូរថតក្នុង ⚙️ ការកំណត់)*។

---

## 💻 ៣. សម្រាប់អ្នកអភិវឌ្ឍ (Developer Commands)

```bash
# ១. ដំឡើងកញ្ចប់ Node
npm install

# ២. បើកកម្មវិធី Desktop (Electron)
npm start

# ៣. បើកជា Web Local Server (http://localhost:3000 ឬចុច បើកកម្មវិធីទាញយក.bat)
npm run start:web

# ៤. តេស្តប្រព័ន្ធ License និង Security API Gate
npm test

# ៥. បង្កើត Windows .exe Installer & Portable ក្នុង dist/
npm run build:win
```

> ⚠️ **កំណត់សម្គាល់សុវត្ថិភាព**: ឯកសារ `.env*`, `config.json`, `cloud-license-state.json`, និងថត `bin/*.exe` / `dist/` ត្រូវបានការពារក្នុង `.gitignore` មិនឲ្យចូល GitHub ឡើយ។
