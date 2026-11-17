// g02-r73-branches.test.js — R73/F01 分支单元测试：unreasonOf 六分支 + mismReasonOf 两分支。
// EACCES/EPERM 在本机 Windows 无法用 statSync 真实复现（live 套件只覆盖 ENOENT/EISDIR/EINVAL），
// 这两个映射文案在此处以纯函数调用补齐口径——函数即产品代码本身，不是复刻。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadOffice } from '../test-support/g02-vm.mjs';

const ctx = loadOffice(['shared.js', 'version.js', 'approval.js', 'files.js']);

test('unreasonOf：四个已知错误码给准确文案', () => {
  assert.equal(
    ctx.run('unreasonOf("ENOENT")'),
    '文件已删除或移走（ENOENT：登记路径当前不存在）',
  );
  assert.equal(
    ctx.run('unreasonOf("EACCES")'),
    '权限拒绝（EACCES：进程无权访问该路径）',
  );
  assert.equal(
    ctx.run('unreasonOf("EPERM")'),
    '权限拒绝（EPERM：系统不允许访问该路径）',
  );
  assert.equal(
    ctx.run('unreasonOf("EISDIR")'),
    '登记路径是目录不是文件（EISDIR），无法当产物校验',
  );
});

test('unreasonOf：未知码带出真实错误码走统一说明（本机 pagefile 实测即 EINVAL 这支）', () => {
  const got = ctx.run('unreasonOf("EINVAL")');
  assert.equal(got, '后端返回错误码 EINVAL，未收录进已知分类，按不可校验处理');
});

test('unreasonOf：缺码（null/空串）走统一缺码说明，不猜原因', () => {
  assert.equal(ctx.run('unreasonOf(null)'), '后端未返回可识别的错误码，按不可校验处理');
  assert.equal(ctx.run('unreasonOf("")'), '后端未返回可识别的错误码，按不可校验处理');
});

test('mismReasonOf：有限字节数给差异事实文案；缺实测/非有限值返回 null 不编造', () => {
  assert.equal(
    ctx.run(`mismReasonOf(${JSON.stringify({ chk: { bytes: 42 } })})`),
    '实测 42 B 与登记版本不符（大小不一致，内容已变化）',
  );
  assert.equal(ctx.run(`mismReasonOf(${JSON.stringify({ chk: null })})`), null);
  assert.equal(ctx.run(`mismReasonOf(${JSON.stringify({ chk: { bytes: NaN } })})`), null);
});
