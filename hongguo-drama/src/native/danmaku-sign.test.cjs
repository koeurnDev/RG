// Adapted from dawei233/hongguo-drama (GPL-3.0), commit c884fab6c6e36ad38173e251738b9b35f958383f.
// https://github.com/dawei233/hongguo-drama/tree/c884fab6c6e36ad38173e251738b9b35f958383f
'use strict';

/**
 * 弹幕签名器与参考实现的一致性测试。
 *
 * 签名算法没有官方文档，唯一能证明移植正确的办法是：拿已验证可用的参考实现
 * （`nas-backend/danmaku.py`，仓库外）在固定输入下的输出，逐字节比对。
 * 向量由 `scripts/gen-danmaku-sign-vectors.py` 生成，生成过程可复现。
 *
 * 这个测试是**离线**的：不需要网络，也不需要 Python。它一旦失败，说明签名器
 * 与参考实现已经不一致，此时不应该去联网碰运气 —— 先修这里。
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');

let sign;
try { sign = require('./danmaku-sign.js'); } catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}
assert.equal(typeof sign, 'object', 'danmaku module must exist');

const vectorsPath = path.join(__dirname, '..', '..', 'scripts', 'fixtures', 'danmaku-sign-vectors.json');
const fixture = JSON.parse(fs.readFileSync(vectorsPath, 'utf8'));

test('向量文件记录了参考实现来源，避免用到来路不明的期望值', () => {
  assert.equal(fixture.source, 'nas-backend/danmaku.py');
  assert.ok(Array.isArray(fixture.vectors) && fixture.vectors.length >= 3);
});

test('构建出的 raw query 与参考实现一致（含参数排序与编码）', () => {
  for (const vector of fixture.vectors) {
    const actual = sign.buildQuery({
      stampMs: vector.stamp_ms,
      deviceId: vector.device_id,
      installId: vector.install_id,
    });
    assert.equal(actual, vector.raw_query, `stamp_ms=${vector.stamp_ms} 的 raw query 不一致`);
  }
});

test('X-Gorgon 与参考实现逐字节一致', () => {
  for (const vector of fixture.vectors) {
    const actual = sign.commentXGorgon(vector.raw_query, vector.stamp, Buffer.from(vector.nonce_hex, 'hex'));
    assert.equal(actual, vector.x_gorgon, `stamp=${vector.stamp} 的 X-Gorgon 不一致`);
  }
});

test('X-Ladon 与参考实现逐字节一致', () => {
  for (const vector of fixture.vectors) {
    const actual = sign.commentLadon(vector.aid, vector.stamp, Buffer.from(vector.nonce_hex, 'hex').subarray(2, 6));
    assert.equal(actual, vector.x_ladon, `stamp=${vector.stamp} 的 X-Ladon 不一致`);
  }
});

test('X-Argus 与参考实现逐字节一致', () => {
  for (const vector of fixture.vectors) {
    const actual = sign.commentArgus(vector.raw_query, vector.stamp, Buffer.from(vector.nonce_hex, 'hex'));
    assert.equal(actual, vector.x_argus, `stamp=${vector.stamp} 的 X-Argus 不一致`);
  }
});

test('整组头部与参考实现一致', () => {
  for (const vector of fixture.vectors) {
    const headers = sign.signCommentHeaders({
      rawQuery: vector.raw_query,
      stamp: vector.stamp,
      nonce: Buffer.from(vector.nonce_hex, 'hex'),
      aid: vector.aid,
    });
    assert.equal(headers['X-Khronos'], vector.x_khronos);
    assert.equal(headers['X-SS-Req-Ticket'], vector.x_ss_req_ticket);
    assert.equal(headers['X-SS-STUB'], vector.x_ss_stub);
    assert.deepEqual(Object.keys(headers).sort(), ['X-Argus', 'X-Gorgon', 'X-Khronos', 'X-Ladon', 'X-SS-Req-Ticket', 'X-SS-STUB']);
  }
});

test('设备指纹是 19 位数字串，且两次生成不同', () => {
  const first = sign.newDeviceId();
  const second = sign.newDeviceId();
  assert.match(first, /^\d{19}$/);
  assert.match(second, /^\d{19}$/);
  assert.notEqual(first, second);
});

test('nonce 契约是 11 字节：长度不对会算出服务端拒绝的签名', () => {
  // 这条断言是文档化的护栏：各段分别喂给不同算法，长度错了不会抛异常，
  // 只会静默产生无效签名。调用方必须自己保证 11 字节。
  assert.equal(sign.NONCE_BYTES, 11);
  const short = Buffer.alloc(4);
  assert.doesNotThrow(() => sign.commentXGorgon('a=1', 1, short));
});

test('SM3 与标准向量一致，且与系统 Node 的 native 实现互为印证', () => {
  // 标准向量（与 scripts/check-app-source.cjs 用的是同一组）。
  // 长输入是必须的：它跨多个 64 字节分组，能抓出填充与消息扩展的边界错误。
  const vectors = [
    ['abc', '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0'],
    ['abcd'.repeat(16), 'debe9ff92275b8a138604889c18e5a4d6fdb70e5387e5765293dcba39c0c5732'],
    ['x'.repeat(10000), '335de0cbf893f7af9a3e548067c72f47630b9fa9293d93959c79c2085fab7e5e'],
    ['', '1ab21d8355cfa17f8e61194831e81a8f22bec8c728fefb747ed035eb5082aa2b'],
  ];
  for (const [input, expected] of vectors) {
    assert.equal(sign.sm3(Buffer.from(input, 'utf8')).toString('hex'), expected, `SM3("${input.slice(0, 12)}…") 与标准向量不一致`);
  }

  // 与 native 实现在多种长度上比对。长度取 55/56/63/64/65 是因为它们正好压着
  // "填充后是否多出一个分组"的分界，是这类实现最容易写错的地方。
  let native;
  try {
    native = require('node:crypto').createHash('sm3');
  } catch {
    native = null;
  }
  if (!native) {
    // Electron 的 BoringSSL 就是这种情况：没有 SM3，只能靠上面的标准向量。
    return;
  }
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 1000]) {
    const buffer = Buffer.alloc(length);
    for (let i = 0; i < length; i++) buffer[i] = (i * 37 + 11) & 0xff;
    const expected = require('node:crypto').createHash('sm3').update(buffer).digest('hex');
    assert.equal(sign.sm3(buffer).toString('hex'), expected, `长度 ${length} 时与 native SM3 不一致`);
  }
});

test('SM3 走仓库共用的实现，且不依赖运行时是否提供 sm3', () => {
  // 回归护栏：如果有人把共用实现换回 createHash('sm3')，在系统 Node 上测不出来，
  // 但应用里会让所有弹幕请求失败。
  // 先剥掉注释 —— 实现里正解释"为什么不能用它"，注释里的字样不算违规。
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'danmaku-sign.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /createHash\(['"]sm3['"]\)/, '不得依赖运行时的 sm3，Electron 的 BoringSSL 没有它');
  assert.match(source, /require\(['"]\.\/sm3['"]\)/, '应复用仓库里已有的 sm3.js，而不是再写一份');

  // 共用实现本身也必须是对的：标准向量在前面那条测试里已覆盖。
  assert.equal(require('./sm3')(Buffer.from('abc')).toString('hex'),
    '66c7f0f462eeedd9d1f2d46bdc10e4e24167c4875cf2f7a2297da02b8f4ba8e0');
});

test('签名结果随 query、时间戳与各自 nonce 段变化（防止退化成常量）', () => {
  const nonce = Buffer.from('000102030405060708090a', 'hex');
  const base = sign.commentXGorgon('a=1', 1760000000, nonce);
  assert.notEqual(base, sign.commentXGorgon('a=2', 1760000000, nonce), 'query 变化必须改变 X-Gorgon');
  assert.notEqual(base, sign.commentXGorgon('a=1', 1760000001, nonce), '时间戳变化必须改变 X-Gorgon');

  // nonce 是**分段**使用的：Gorgon 只用 [0:2]，Ladon 只用 [2:6]，Argus 只用 [6:11]。
  // 改 nonce[0] 必须影响 Gorgon 且不影响 Ladon；改 nonce[10] 只影响 Argus。
  const flipHead = Buffer.from(nonce);
  flipHead[0] ^= 0x01;
  assert.notEqual(base, sign.commentXGorgon('a=1', 1760000000, flipHead), 'nonce[0] 参与 X-Gorgon');
  assert.equal(
    sign.commentLadon('8662', 1760000000, nonce.subarray(2, 6)),
    sign.commentLadon('8662', 1760000000, flipHead.subarray(2, 6)),
    'nonce[0] 不应影响 X-Ladon',
  );

  const flipTail = Buffer.from(nonce);
  flipTail[10] ^= 0x01;
  assert.equal(
    sign.commentXGorgon('a=1', 1760000000, nonce),
    sign.commentXGorgon('a=1', 1760000000, flipTail),
    'nonce[10] 不参与 X-Gorgon',
  );
  assert.notEqual(
    sign.commentArgus('a=1', 1760000000, nonce),
    sign.commentArgus('a=1', 1760000000, flipTail),
    'nonce[10] 参与 X-Argus',
  );
});
