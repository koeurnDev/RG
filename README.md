# ⚡ EZA PRO — ប្រព័ន្ធទាញយករឿង បកប្រែ & បញ្ចូលសំឡេង (Full Project Guide)

គម្រោង **EZA PRO** រួមមានកម្មវិធី ៣ ផ្នែកតភ្ជាប់គ្នា៖
1. **🎬 EZA PRO Downloader (`D:\EZA_PRO`)** — កម្មវិធី Desktop `.exe` សម្រាប់ស្វែងរក និងទាញយករឿងភាគចិន/អន្តរជាតិ (HongGuo, DramaBox, ReelShort, Hema, Xifan) និងវីដេអូ Link (TikTok, YouTube, Douyin...) ល្បឿនលឿន Multi-Worker ព្រមទាំងផ្គុំជារឿងពេញដោយស្វ័យប្រវត្តិ។
2. **🎙️ EZA PRO Studio (`D:\EZARG`)** — កម្មវិធី Desktop `.exe` សម្រាប់ដកស្រង់អក្សរ (STT), បកប្រែភាសាខ្មែរតាមវចនានុក្រមជួនណាត (`ឲ្យ`), បង្កើតសំឡេង AI (Edge-TTS / Voice Clone), និង Export វីដេអូ HD។
3. **☁️ EZA PRO Cloud Admin (`Cloudflare Worker + D1`)** — ប្រព័ន្ធគ្រប់គ្រង License Key, ម៉ាស៊ីនភ្ញៀវ (Machine HWID Binding), បន្ថែមថ្ងៃ, បិទ/ផ្អាកគណនី, Router Control និងប្រកាសដំណឹងតាម Web ទាំងលើទូរស័ព្ទ និងកុំព្យូទ័រ។

---

## 📋 ១. ត្រូវការអ្វីខ្លះ? (Requirements)

### ក. សម្រាប់អ្នកប្រើប្រាស់ទូទៅ (ប្រើ `.exe` ផ្ទាល់ — មិនបាច់ចេះកូដ)
- **ប្រព័ន្ធប្រតិបត្តិការ**: Windows 10 ឬ Windows 11 (64-bit / x64)
- **អ៊ីនធឺណិត**: ត្រូវការសម្រាប់ផ្ទៀងផ្ទាត់ License Key ដំបូង និងទាញយករឿង/បកប្រែ (អាចបន្តប្រើ Offline បាន ១២ ម៉ោងក្រោយផ្ទៀងផ្ទាត់ម្ដង)
- **License Key (`EZAPRO-XXXX-...`)**: ទទួលបានពី Admin (តាមរយៈ Web Admin Panel)
- **Gemini API Key** *(បំពេញក្នុង Settings នៃកម្មវិធី)*:
  - ក្នុង **Downloader**: ស្រេចចិត្ត — ប្រើតែពេលចង់ឲ្យ AI បកប្រែចំណងជើង/សាច់រឿងចិនទៅខ្មែរ
  - ក្នុង **Studio (`D:\EZARG`)**: ចាំបាច់ — សម្រាប់បកប្រែអក្សរ និងដកស្រង់សំឡេង STT
- **Tool ផ្សេងៗ (`ffmpeg`, `ffprobe`, `yt-dlp`, `aria2c`, `N_m3u8DL-RE`, `Edge-TTS`)**: **ខ្ចប់ភ្ជាប់មកជាមួយ `.exe` ស្រាប់** មិនបាច់ដំឡើងបន្ថែមទេ។

### ខ. សម្រាប់អ្នកអភិវឌ្ឍ / ម្ចាស់ប្រព័ន្ធ (Dev, Build `.exe`, និង Host Admin)
- **Node.js**: កំណែ `v20+` ឬ `v22.12+` (`npm` រួមបញ្ចូលស្រាប់)
- **Git**: សម្រាប់ Push/Pull កូដ GitHub (`RG.git` សម្រាប់ Downloader: `https://github.com/koeurnDev/RG.git` និង `EZA-PRO.git` សម្រាប់ Studio & Cloud Admin: `https://github.com/koeurnDev/EZA-PRO.git`)
- **Cloudflare Account + Wrangler CLI** (`npx wrangler`): សម្រាប់ Run/Deploy Cloud License Worker និង D1 Database (`eza-pro-licenses`)
- **Binary Tools ក្នុង `D:\EZA_PRO\bin\`** *(មិនត្រូវ Push ចូល GitHub ទេ ព្រោះទំហំធំ)*:
  - `ffmpeg.exe`
  - `ffprobe.exe`
  - `aria2c.exe`
  - `yt-dlp.exe`
  - `N_m3u8DL-RE.exe`
- **Binary Tool ក្នុង `D:\EZARG\tools\bin\`**:
  - `ffmpeg.exe`

---

## 🚀 ២. របៀបប្រើសម្រាប់អ្នកប្រើប្រាស់ទូទៅ (End-User Guide)

### A. កម្មវិធី EZA PRO Downloader (`EZA PRO Downloader-1.0.0-x64.exe` ឬ `Portable.exe`)
1. **បើក និងបញ្ចូល License Key**:
   - ដំឡើងឬបើកកម្មវិធី រួចផ្ទាំងផ្ទៀងផ្ទាត់នឹងបង្ហាញ **Machine ID** (`EZA-XXXX-XXXX-XXXX`) របស់កុំព្យូទ័រ។
   - បើមិនទាន់មាន Key សូមចុច **📋 ចម្លង ID** ផ្ញើទៅ Admin ដើម្បីទទួល Key ប្រភេទ `Downloader` ឬ `ទាំងពីរ App`។
   - បញ្ចូល Key រួចចុច **🔓 បើកចូលប្រើប្រាស់**។
2. **ទាញយករឿងភាគ (HongGuo, DramaBox, ReelShort, Hema, Xifan)**:
   - ជ្រើសប្រភេទរឿង (កំពុងល្បី, កម្សត់, ស្នេហា, CEO, សងសឹក...) ឬវាយឈ្មោះរឿង / បិទភ្ជាប់ Link ក្នុងប្រអប់ស្វែងរក។
   - ចុចរឿងដែលចង់បាន → ជ្រើសភាគ (`EP01..EP80`) ឬចុច **ទាញយកទាំងអស់**។
   - អាចបើក **Auto-Merge** ដើម្បីឲ្យកម្មវិធីផ្គុំភាគទាំងអស់ជារឿងពេញ ១ ឯកសារដោយស្វ័យប្រវត្តិក្រោយទាញចប់។
3. **ទាញយកវីដេអូ Link (TikTok, YouTube, Facebook...)**:
   - ចុច Tab **🌐 Social Video / Link** → បិទភ្ជាប់ URL → ពិនិត្យគុណភាព → ចុចទាញយក។
4. **មើល និងគ្រប់គ្រងវីដេអូ**:
   - ចូល **📥 គ្រប់គ្រងវីដេអូ** ដើម្បីមើលល្បឿនទាញយក បញ្ឈប់ ផ្គុំរឿងពេញ ឬបើកមើលវីដេអូភ្លាមៗ។
   - ឯកសារដែលទាញរួចត្រូវបានរក្សាទុកតាមលំនាំដើមក្នុង `Videos\EZA PRO Downloader` (អាចប្ដូរថតក្នុង ⚙️ ការកំណត់)។

### B. កម្មវិធី EZA PRO Studio (`D:\EZARG\dist\EZA PRO-1.0.0-x64.exe`)
1. បើកកម្មវិធី និងផ្ទៀងផ្ទាត់ License Key ប្រភេទ `Studio` ឬ `ទាំងពីរ App` (Machine ID ដូចគ្នាជាមួយ Downloader លើកុំព្យូទ័រតែ ១)។
2. ចូល **⚙️ កំណត់** ឬ **Router Manager** ដើម្បីបញ្ចូល **Gemini API Key** ផ្ទាល់ខ្លួន។
3. បញ្ចូលវីដេអូពីកុំព្យូទ័រ → ចុចដកស្រង់អក្សរ/បកប្រែ → កែសម្រួលអក្សរ និងសំឡេង AI (Edge-TTS) → ចុច **Export MP4**។

---

## 🛡️ ៣. របៀបគ្រប់គ្រងសម្រាប់ Admin (Cloudflare Admin Panel)

- **Admin Web URL**: `https://eza-pro-license-admin.koeurnseab630.workers.dev/admin`
- **លេខសម្ងាត់ Admin**: រក្សាទុកដោយសុវត្ថិភាពក្នុងម៉ាស៊ីនផ្ទាល់ខ្លួន (`D:\EZARG\cloudflare-license-worker\.admin-credentials.local.txt` — *ហាមផ្សព្វផ្សាយឬ Push ចូល GitHub!*)។

### មុខងារ Admin សំខាន់ៗ៖
1. **➕ បង្កើត License Key**:
   - ជ្រើសប្រភេទ App:
     - `🌟 ទាំងពីរ App` — Key ១ ប្រើបានទាំង Studio និង Downloader
     - `🎙️ Studio (បកប្រែ)` — ប្រើបានតែ Studio
     - `🎬 Downloader (ដោនរឿង)` — ប្រើបានតែ Downloader
   - រើសថ្ងៃផុតកំណត់ (`7 ថ្ងៃ`, `30 ថ្ងៃ`, `90 ថ្ងៃ`, `1 ឆ្នាំ`, `Lifetime`) និងចំនួនម៉ាស៊ីនអនុញ្ញាត (`1–20`)។
   - ចុច **💬 ចម្លងសារផ្ញើភ្ញៀវ** ដើម្បីផ្ញើ Key ជាភាសាខ្មែរទៅ Telegram ភ្ញៀវភ្លាមៗ។
2. **⚙️ គ្រប់គ្រងគណនីភ្ញៀវ**:
   - **+ថ្ងៃ / Lifetime**: បន្តថ្ងៃប្រើប្រាស់បន្ថែមពីថ្ងៃផុតចាស់
   - **✅ សកម្ម / ⏸ ផ្អាក / ⛔ Ban**: បិទ ឬបើកសិទ្ធិភ្លាមៗ (កម្មវិធីភ្ញៀវនឹងជាប់សោស្វ័យប្រវត្តិ)
   - **🔄 Reset ម៉ាស៊ីន**: លាង Machine ID ចាស់ចេញ ពេលភ្ញៀវដូរកុំព្យូទ័រថ្មី
   - **កែ App Scope**: ដំឡើង Key ពី ១ App ទៅ `ទាំងពីរ App` ពេលភ្ញៀវ Upgrade កញ្ចប់
3. **📢 កំណត់ប្រព័ន្ធ & ប្រវត្តិ**:
   - បង្ហាញសារប្រកាស (Maintenance Banner) ឬបិទប្រព័ន្ធទាំងមូលបណ្ដោះអាសន្ន (`Maintenance Lock`)
   - ដាក់ Link Update កំណែថ្មី (`download_url`) និងគ្រប់គ្រង `Router Lock` សម្រាប់ Studio

---

## 💻 ៤. សម្រាប់អ្នកអភិវឌ្ឍ (Developer Commands)

### A. EZA PRO Downloader (`D:\EZA_PRO`)
```bash
# ដំឡើងកញ្ចប់ Node
npm install

# បើកកម្មវិធី Desktop (Electron)
npm start

# បើកជា Web Local Server (http://localhost:3000 ឬចុច បើកកម្មវិធីទាញយក.bat)
npm run start:web

# តេស្តប្រព័ន្ធ License និង Security API Gate
npm test

# បង្កើត Windows .exe Installer & Portable ក្នុង dist/
npm run build:win
```

### B. EZA PRO Studio & Cloud Worker (`D:\EZARG`)
```bash
# បើក EZA PRO Studio
npm start

# តេស្តប្រព័ន្ធ Studio & Cloud License
node --test test-fixes.js test-speech-route.js

# បង្កើត Windows .exe សម្រាប់ Studio
npm run build:win

# Deploy Cloudflare License Worker (នៅក្នុង D:\EZARG\cloudflare-license-worker)
npx wrangler deploy
```

> ⚠️ **កំណត់សម្គាល់សុវត្ថិភាព**: ឯកសារ `.admin-credentials.local.txt`, `config.json`, `accounts.json`, `.env*`, និង `cloud-license-state.json` ត្រូវបានការពារមិនឲ្យចូល GitHub និងមិនឲ្យចូលក្នុងកញ្ចប់ `.exe` (`app.asar`) ឡើយ។
