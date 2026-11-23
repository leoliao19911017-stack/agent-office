// fake-dsh.mjs — selftest 用的假 DSH 事件流。
//
// 它不是 DSH 本身，只模拟 DSH --json 在 stdout 上逐行吐事件的行为。
// 用真子进程跑，是为了让 selftest 真正经历「spawn → 收事件 → 强杀 → 退出归因」，
// 而不是在内存里伪造状态。
//
// 用法: node scripts/fixtures/fake-dsh.mjs <scenario>
//   think       持续思考/工具调用，不产出文件
//   permission  发一次权限请求后保持存活
//   quota       发明确额度耗尽错误后保持存活（进程还在）
//   crash       发一条事件后自行失败退出
//   claim-done  自称完成（但测试结果失败），保持存活
//   artifact    产出文件事件后保持存活

const scenario = process.argv[2] || 'think';
let seq = 0;

function emit(obj) {
  seq += 1;
  process.stdout.write(JSON.stringify({ seq, timestamp: new Date().toISOString(), ...obj }) + '\n');
}

emit({ type: 'thinking', text: '正在分析任务（尚未写文件）' });

if (scenario === 'permission') {
  emit({ type: 'tool_call', tool: 'write_file', path: 'src/a.js' });
  setTimeout(() => {
    emit({ type: 'permission_request', request_id: 'req-1', tool: 'write_file', detail: '需要写入 src/a.js' });
  }, 60);
} else if (scenario === 'quota') {
  emit({ type: 'tool_call', tool: 'write_file', path: 'src/a.js' });
  setTimeout(() => {
    emit({
      type: 'api_error',
      error: {
        code: 'usage_limit_exceeded',
        message: '已达到 5 小时的使用上限，限额将在 18:00 重置',
      },
    });
  }, 60);
} else if (scenario === 'crash') {
  setTimeout(() => {
    emit({ type: 'tool_call', tool: 'write_file', path: 'src/a.js' });
    setTimeout(() => process.exit(1), 60);
  }, 60);
} else if (scenario === 'claim-done') {
  setTimeout(() => {
    emit({
      type: 'result',
      status: 'completed',
      tests: { command: 'npm test', result: 'failed', failing: 2 },
      summary: 'Agent 自称完成',
    });
  }, 60);
} else if (scenario === 'artifact') {
  setTimeout(() => {
    emit({ type: 'file_changed', path: 'out/new-file.txt', files: ['out/new-file.txt'] });
  }, 60);
} else {
  // think：每 150ms 一条活动事件，进程一直活着；强杀由测试发起。
  setInterval(() => {
    emit({ type: 'tool_call', tool: 'read_file', path: 'README.md' });
  }, 150);
}

// 保持事件循环存活（crash 场景会自行退出）。
setInterval(() => {}, 1000);
