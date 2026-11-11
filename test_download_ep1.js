const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fetchEpisodeList, fetchPlayUrlSingle } = require('./hongguo-drama/src/native/hongguo');

async function downloadEp1() {
  const seriesId = '7701328280862854168';
  console.log('Fetching episode list...');
  const info = await fetchEpisodeList(seriesId);
  const outDir = path.join('D:\\HDRG', info.series_title);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const ep1 = info.episodes[0];
  console.log('Fetching play url for Ep 1...');
  const play = await fetchPlayUrlSingle(ep1.vid, seriesId);

  const urls = (play.variants ? play.variants.map(v => v.url) : []);
  // prioritize v26-
  urls.sort((a, b) => (b.includes('v26-') ? 1 : 0) - (a.includes('v26-') ? 1 : 0));

  const encFile = path.join(outDir, 'temp_ep1.enc');
  const finalFile = path.join(outDir, `${info.series_title}_第01集.mp4`);

  for (const u of urls) {
    console.log('Downloading from CDN:', u.slice(0, 60) + '...');
    try {
      execSync(`curl.exe -s -L -m 45 "${u}" -o "${encFile}"`);
      if (fs.existsSync(encFile) && fs.statSync(encFile).size > 1000000) {
        console.log('Downloaded enc file size:', fs.statSync(encFile).size);
        break;
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
  }

  const ffmpegExe = path.join(__dirname, 'hongguo-drama', 'build', 'ffmpeg', 'ffmpeg.exe');
  console.log('Decrypting with ffmpeg...');
  execSync(`"${ffmpegExe}" -y -decryption_key ${play.contentKey} -i "${encFile}" -c copy -movflags +faststart "${finalFile}"`);
  if (fs.existsSync(encFile)) fs.unlinkSync(encFile);
  console.log('SUCCESS! File saved to:', finalFile, 'Size:', (fs.statSync(finalFile).size / (1024 * 1024)).toFixed(2), 'MB');
}

downloadEp1().catch(console.error);
