const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Reuse the existing isolated component harness, without running its test suite.
const harness = fs.readFileSync(`${__dirname}/check-download-manager.cjs`, 'utf8').split('\n(async () => {')[0];
const harnessModule = { exports: {} };
vm.runInNewContext(`${harness}\nmodule.exports = { mount, task, rows };`, {
  module: harnessModule, require, __dirname, console,
});
const { mount, task, rows } = harnessModule.exports;
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node?.children?.map(text).join('') || '';
const descendants = node => [node, ...(node?.children || []).filter(child => child && typeof child === 'object').flatMap(descendants)];

async function main() {
  const deleted = [];
  const ui = mount({
    getDownloadTasks: async () => Array.from({ length: 205 }, (_, index) => task(index + 1, 'completed')),
    deleteTasksWithFiles: async (ids, files) => { deleted.push({ ids, files }); return { success: false, error: '测试保留选择' }; },
  });
  await ui.flush();
  const visibleDelete = () => {
    const summary = ui.find(node => node.props.className === 'dm-selection-summary');
    return descendants(summary).find(node => node?.type === 'button' && text(node).startsWith('删除已选'));
  };
  assert.ok(visibleDelete(), '批量删除必须常显在全选旁，不能藏在更多操作');
  assert.equal(text(visibleDelete()), '删除已选（0项）');
  assert.equal(visibleDelete().props.disabled, true);
  ui.button('全选').props.onClick(); ui.render();
  assert.equal(text(visibleDelete()), '删除已选（205项）');
  assert.equal(visibleDelete().props.disabled, false);
  ui.button('下一页').props.onClick(); ui.render();
  ui.button('下一页').props.onClick(); ui.render();
  assert.equal(rows(ui).length, 5);
  assert.equal(text(visibleDelete()), '删除已选（205项）', '跨页数量包含所有选中任务');
  await visibleDelete().props.onClick(); ui.render();
  assert.equal(deleted.length, 0, '点击入口只能弹确认，不得立即删除');
  assert.ok(ui.text().includes('共 205 个任务'));
  const dialog = ui.find(node => node.props.role === 'dialog');
  const checkbox = descendants(dialog).find(node => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkbox.props.checked, false, '保留现有默认：仅删任务记录');
  assert.ok(ui.button('仅删除记录'));
  checkbox.props.onChange({ target: { checked: true } }); ui.render();
  assert.ok(ui.button('删除任务和文件'));
  descendants(ui.find(node => node.props.role === 'dialog'))
    .find(node => node.type === 'button' && text(node) === '取消').props.onClick(); ui.render();
  assert.equal(deleted.length, 0);
  await visibleDelete().props.onClick(); ui.render();
  await ui.button('仅删除记录').props.onClick(); await ui.flush();
  assert.equal(deleted.length, 1);
  assert.equal(deleted[0].ids.length, 205);
  assert.equal(deleted[0].files, false);
  assert.equal(text(visibleDelete()), '删除已选（205项）', '删除失败保留选择');
  ui.unmount();
  console.log('PASS download selection delete: visible beside select-all, zero disabled, cross-page count, existing safe confirmation and failure preservation');
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
