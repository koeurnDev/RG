const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { fetchEpisodeList, fetchPlayUrlSingle } = require('./hongguo-drama/src/native/hongguo');

async function downloadEpisode() {
  const seriesId = '7701328280862854168';
  console.log('កំពុងទាញយកព័ត៌មានរឿងភាគ:', seriesId);
  const info = await fetchEpisodeList(seriesId);
  console.log('ចំណងជើងរឿង:', info.series_title);
  
  const ep = info.episodes[0];
  console.log('កំពុងស្វែងរក Link វីដេអូភាគទី ១ (vid:', ep.vid + ')...');
  const play = await fetchPlayUrlSingle(ep.vid, seriesId);
  console.log('ទទួលបាន Play Data! ContentKey:', play.contentKey);

  const cleanTitle = info.series_title.replace(/[\\/:*?"<>|]/g, '_');
  const outputDir = path.join('D:\\HDRG', cleanTitle);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const tempEncrypted = path.join(outputDir, 'ep1_temp.enc');
  const finalMp4 = path.join(outputDir, `${cleanTitle}_第01集.mp4`);

  const urls = [
    ...(play.variants ? play.variants.map(v => v.url) : []),
    play.url
  ].filter(Boolean);

  console.log('រកឃើញតំណភ្ជាប់ CDN ចំនួន:', urls.length);

  let downloaded = false;
  for (let i = 0; i < urls.length; i++) {
    const candidateUrl = urls[i];
    console.log(`[សាកល្បង CDN ${i + 1}/${urls.length}] កំពុងទាញយក...`);
    try {
      execSync(`curl.exe -s -L --connect-timeout 8 "${candidateUrl}" -o "${tempEncrypted}"`);
      if (fs.existsSync(tempEncrypted) && fs.statSync(tempEncrypted).size > 100000) {
        console.log('ទាញយកឯកសារវីដេអូចប់! ទំហំ:', (fs.statSync(tempEncrypted).size / (1024 * 1024)).toFixed(2), 'MB');
        downloaded = true;
        break;
      }
    } catch (e) {
      console.warn('CDN នេះមិនឆ្លើយតប កំពុងប្ដូរទៅ CDN បន្ទាប់...');
    }
  }

  if (!downloaded) {
    throw new Error('មិនអាចទាញយកវីដេអូបានទេ សូមពិនិត្យមើលបណ្ដាញអ៊ីនធឺណិត');
  }

  const ffmpegExe = path.join(__dirname, 'hongguo-drama', 'build', 'ffmpeg', 'ffmpeg.exe');
  
  if (play.contentKey) {
    console.log('កំពុងបម្លែង និង Decrypt វីដេអូឱ្យទៅជា MP4 ច្បាស់ត្រជាក់ភ្នែក (FFmpeg)...');
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegExe, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-decryption_key', play.contentKey,
        '-i', tempEncrypted,
        '-map', '0:v:0', '-map', '0:a?',
        '-c', 'copy',
        '-movflags', '+faststart',
        '-f', 'mp4', finalMp4
      ], { stdio: 'inherit' });
      child.on('close', code => code === 0 ? resolve() : reject(new Error('FFmpeg code: ' + code)));
    });
  } else {
    fs.renameSync(tempEncrypted, finalMp4);
  }

  if (fs.existsSync(tempEncrypted)) {
    try { fs.unlinkSync(tempEncrypted); } catch (_) {}
  }

  const finalBytes = fs.statSync(finalMp4).size;
  console.log('ជោគជ័យ ១០០%! វីដេអូភាគទី ១ ត្រូវបានរក្សាទុកនៅ:', finalMp4);
  console.log('ទំហំវីដេអូពេញលេញ:', (finalBytes / (1024 * 1024)).toFixed(2), 'MB');
}

downloadEpisode().catch(err => console.error('កំហុស:', err.message));
