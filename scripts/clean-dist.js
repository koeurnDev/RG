const fs = require('fs');
const path = require('path');

function cleanDist(rootDir = path.join(__dirname, '..')) {
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const productName = String(pkg.productName || pkg.name || 'EZA PRO Downloader').trim();
  const version = String(pkg.version || '1.0.0').trim();
  const targetExe = `${productName}-${version}-x64.exe`;
  const distDir = path.join(rootDir, 'dist');

  if (!fs.existsSync(distDir)) {
    throw new Error(`dist directory not found: ${distDir}`);
  }
  const targetPath = path.join(distDir, targetExe);
  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size <= 0) {
    throw new Error(`Expected installer missing or empty: ${targetPath}`);
  }

  const removed = [];
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    if (entry.name === targetExe) continue;
    fs.rmSync(path.join(distDir, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }

  const sizeMb = (fs.statSync(targetPath).size / (1024 * 1024)).toFixed(2);
  return { distDir, targetExe, targetPath, sizeMb, removed };
}

if (require.main === module) {
  const res = cleanDist();
  console.log(`[Build Clean] Kept only: dist/${res.targetExe} (${res.sizeMb} MB); removed ${res.removed.length} extra item(s).`);
}

module.exports = { cleanDist };
