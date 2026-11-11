// Hema/Xifan searches must honor the same total deadline as the other sources.
const assert = require('node:assert/strict');
const axios = require('axios');
const hema = require('../src/native/hema');
const xifan = require('../src/native/xifan');

(async () => {
  const originalPost = axios.post, originalGet = axios.get;
  let postOptions, getOptions, calls = 0;
  try {
    axios.post = async (_url, _body, options) => { calls++; postOptions = options; return { data: { retCode: 0, data: { bookList: [], isMore: 0, totalSize: 0 } } }; };
    const hemaResult = await hema.search('测试', 1, { deadline: Date.now() + 500 });
    assert.equal(hemaResult.success, true);
    assert.ok(postOptions.timeout > 0 && postOptions.timeout <= 500, 'hema timeout must fit the remaining deadline');
    assert.ok(postOptions.signal instanceof AbortSignal);

    axios.get = async (_url, options) => { calls++; getOptions = options; return { data: { ret: 0, result: { elements: [] } } }; };
    const xifanResult = await xifan.search('测试', 1, { deadline: Date.now() + 500 });
    assert.equal(xifanResult.success, true);
    assert.ok(getOptions.timeout > 0 && getOptions.timeout <= 500, 'xifan timeout must fit the remaining deadline');
    assert.ok(getOptions.signal instanceof AbortSignal);

    calls = 0;
    const expiredHema = await hema.search('测试', 1, { deadline: Date.now() - 1 });
    const expiredXifan = await xifan.search('测试', 1, { deadline: Date.now() - 1 });
    assert.equal(expiredHema.success, false);
    assert.equal(expiredXifan.success, false);
    assert.equal(calls, 0, 'an expired budget must not start another request');
  } finally {
    axios.post = originalPost; axios.get = originalGet;
  }
  console.log('PASS search deadline: hema/xifan requests fit the remaining budget and skip expired work');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
