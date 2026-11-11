// Run only after both final Apps have been signed, notarized and stapled.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const yaml = require('js-yaml');
const pkg = require('../package.json');
const publicVersion = pkg.version.replace(/^(\d+\.\d+)\.0$/, '$1');
const [arm64App, x64App, output] = process.argv.slice(2);
assert.equal(process.platform, 'darwin', 'Mac update packages require macOS');
assert(arm64App && x64App && output, 'Usage: node scripts/prepare-mac-update.cjs ARM64.app X64.app OUTPUT');
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const files = [];
fs.mkdirSync(output, { recursive: true });
for (const [arch, source] of [['arm64', arm64App], ['x64', x64App]]) {
  const app = path.resolve(source);
  const plist = path.join(app, 'Contents/Info.plist');
  assert.equal(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist]), pkg.version);
  const executable = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist]);
  assert.equal(run('lipo', ['-archs', path.join(app, 'Contents/MacOS', executable)]), arch === 'arm64' ? 'arm64' : 'x86_64');
  run('codesign', ['--verify', '--deep', '--strict', app]);
  run('xcrun', ['stapler', 'validate', app]);
  const url = `hongguo-downloader-${publicVersion}-mac-${arch}.zip`;
  const destination = path.resolve(output, url);
  assert(!fs.existsSync(destination), 'Refusing to overwrite an existing update ZIP');
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, destination]);
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'hongguo-update-verify-'));
  try {
    run('ditto', ['-x', '-k', destination, extracted]);
    const restored = path.join(extracted, path.basename(app));
    run('codesign', ['--verify', '--deep', '--strict', restored]);
    run('xcrun', ['stapler', 'validate', restored]);
    assert.equal(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(restored, 'Contents/Info.plist')]), pkg.version);
    assert(fs.readFileSync(path.join(app, 'Contents/Resources/app.asar')).equals(fs.readFileSync(path.join(restored, 'Contents/Resources/app.asar'))), 'ZIP changed the signed application archive');
  } finally { fs.rmSync(extracted, { recursive: true, force: true }); }
  const bytes = fs.readFileSync(destination);
  files.push({ url, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length });
}
const metadata = { version: pkg.version, files, path: files[0].url, sha512: files[0].sha512, releaseDate: new Date().toISOString() };
const file = path.join(output, 'latest-mac.yml');
assert(!fs.existsSync(file), 'Refusing to overwrite existing update metadata');
fs.writeFileSync(file, yaml.dump(metadata));
assert.deepEqual(yaml.load(fs.readFileSync(file, 'utf8')), metadata);
console.log(`PASS Mac update ZIPs: ${pkg.version}, both architectures, restored signatures and notarization, exact SHA512 metadata`);
