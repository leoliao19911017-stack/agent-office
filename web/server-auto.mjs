// server-auto.mjs — TASK-R87整改 X01/X03：需求讨论自动推进器（服务端模块，不经 STATIC_APP）。
// 职责：新建任务后【不问用户要不要】，自动驱动「两轮真实 AI 讨论 → 生成需求文档 →
// 推到需求确认节点（doc=awaiting）停下」。删掉的是讨论前那道审批，req/doc 七步
// 记录口径不变，老任务档案一个字不改（推进器只碰新建任务和它自己写的讨论留档）。
//
// 真实性硬约束（任务书 X03）：讨论只跑真实子进程 AUTOLOOP_HOME/discuss.mjs
// （Codex → GPT 网页 → DSH 自动降级，Leo 定的优先级）。每条落档消息都是该子进程
// stdout 原文，agent 名从它的 stderr 诊断行解析；拿不到就如实记失败原因，
// 绝不拿预设文案冒充 Agent 输出。讨论留档：office-data/discuss/<taskId>.json
// （tmp→rename 原子写），供 GET /api/office/discuss 给首页「AI 讨论了什么」块。
//
// 失败口径（X02「不许假装在整理」）：三轮引擎全失败 → 留档 phase='error' +
// 真实原因，doc 保持 running 但 note 改成失败摘要——展示层据此说「停住了」，
// 不冒充进行中。中断恢复：进程重启时扫一遍 mid-flight 留档（discussing/writing）
// 重新拉起；phase='error' 的不盲目重试，等人来看。

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DISCUSS_TIMEOUT_MS = 25 * 60 * 1000;   // 一轮讨论最长 25 分钟（覆盖 codex 4min + gpt 网页降级链）
const MSG_CLIP = 12000;                      // 单条消息落档上限，防超大输出撑爆留档
const NOTE_CLIP = 80;                        // flow note 上限（与展示层截断口径一致）

function discussDirOf(AUTOLOOP_HOME) { return join(AUTOLOOP_HOME, 'office-data', 'discuss'); }
function discussFileOf(AUTOLOOP_HOME, taskId) { return join(discussDirOf(AUTOLOOP_HOME), `${taskId}.json`); }

/** 读讨论留档；没有就 null（老任务/未开跑都走这里，不编造） */
export function readDiscuss(AUTOLOOP_HOME, taskId) {
  try { return JSON.parse(readFileSync(discussFileOf(AUTOLOOP_HOME, taskId), 'utf8')); }
  catch { return null; }
}

/** 原子写留档（与 review 账本同口径：同目录 tmp → rename 顶替） */
function writeDiscuss(AUTOLOOP_HOME, taskId, rec) {
  mkdirSync(discussDirOf(AUTOLOOP_HOME), { recursive: true });
  rec.updatedAt = new Date().toISOString();
  const tmp = join(discussDirOf(AUTOLOOP_HOME), `.${taskId}.tmp-${Date.now()}.json`);
  writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
  renameSync(tmp, discussFileOf(AUTOLOOP_HOME, taskId));
}

const activeRunners = new Set();   // 本进程在跑的推进器（taskId），防同一任务重复开跑

/** flow.mjs 写通道（与 makeNewTaskRoute 同一调用口径；stub/真实两用） */
function runFlow(AUTOLOOP_HOME, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(AUTOLOOP_HOME, 'flow.mjs'), ...args],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
      (err, stdout) => { if (err) reject(err); else resolve(stdout); });
  });
}

/** 跑一轮真实讨论：discuss.mjs（Codex → GPT 网页 → DSH 降级链，外部基础设施）。
 *  返回 { agent, text }（agent 从 stderr 的「[discuss] X 成功」真实诊断行解析，
 *  解析不出就叫「AI 助手」，不猜具体是谁）或 { error }（如实记录原因）。 */
function runDiscussRound(AUTOLOOP_HOME, prompt) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(AUTOLOOP_HOME, 'discuss.mjs'), prompt],
      { timeout: DISCUSS_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err || !out) {
          const why = (err && err.code === 'ENOENT')
            ? `discuss.mjs 不存在（${join(AUTOLOOP_HOME, 'discuss.mjs')}）——这台机器没装讨论引擎`
            : `discuss.mjs 退出失败：${(err && err.message) || '无输出'}`;
          resolve({ error: `${why}${stderr ? `；诊断：${String(stderr).trim().slice(0, 300)}` : ''}` });
          return;
        }
        const m = String(stderr || '').match(/\[discuss\]\s*([^\s（(]+)\s*成功/);
        resolve({ agent: m ? m[1] : 'AI 助手', text: out.slice(0, MSG_CLIP) });
      });
  });
}

/* ---- 两轮讨论的提问词：要的就是可落档的结构（功能清单 + 不做什么），
   用户原话一字不改地进 prompt。---- */
function promptRoundA(idea) {
  return [
    '你是资深软件需求顾问。用户想让你帮忙做一个软件，他的原话是：',
    `「${idea}」`,
    '请直接输出三部分，不要寒暄：',
    '一、核心功能：列出 3~5 条这个软件必须有的功能，每条一行，用「1. 2. 3.」编号开头；',
    '二、不做什么：列出 2~3 条明确排除、第一版不做的范围，每条一行；',
    '三、风险与注意：两三条实现上最容易踩坑的点。',
  ].join('\n');
}
function promptRoundB(idea, roundA) {
  return [
    '你是另一位资深软件顾问，负责评审同行的需求方案。用户想做的软件，原话是：',
    `「${idea}」`,
    '另一位 AI 助手给出的初步方案如下（原文）：',
    '----',
    String(roundA).slice(0, 4000),
    '----',
    '请直接输出三部分，不要寒暄：',
    '一、争议点：指出上面的方案里最值得商榷的 1~2 点，说明理由；',
    '二、最终功能清单：给出你修订后的 3~5 条功能，每条一行，用「1. 2. 3.」编号开头；',
    '三、最终不做什么：1~3 条，每条一行。',
  ].join('\n');
}

/** 从真实讨论输出里抽「功能清单 / 不做什么」两组条目。
 *  认编号/圆点行；出现在「不做什么」标题之后的归不做桶，其余归功能桶。
 *  抽不出来就两边留空——文档仍附两轮原文，展示层如实说抽不出来，不硬编。 */
function parseDocLists(text) {
  const lines = String(text || '').split(/\r?\n/);
  const feat = [];
  const notdo = [];
  let inNot = false;
  for (const raw of lines) {
    if (/不做什么|不做的|明确不做|第一版不|排除范围/.test(raw)) { inNot = true; continue; }
    if (/^(一|二|三|四|1\.|2\.|3\.)\s*[、.．]?\s*(核心功能|功能清单|争议|风险|最终)/.test(raw.trim())) { inNot = false; }
    const m = raw.match(/^\s{0,4}(?:[-*•·]|\d{1,2}[.、)])\s+(.{2,60})\s*$/);
    if (!m) continue;
    const s = m[1].replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').trim();
    if (!s) continue;
    if (inNot) { if (notdo.length < 5) notdo.push(s); }
    else if (feat.length < 8) feat.push(s);
  }
  return { feat, notdo };
}

/** 组装需求文档 md。内容全部来自：用户原话 + 两轮真实讨论原文 + 从原文里抽的清单。 */
function buildDocMd(title, idea, msgs, lists, participants) {
  const rounds = msgs.filter((m) => m && m.round && m.text);
  const at = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const featLines = lists.feat.length
    ? lists.feat.map((f) => `- ${f}`).join('\n')
    : '- （两轮讨论输出里没有逐条列出功能清单，请看下面的讨论原文确认范围）';
  const notdoLines = lists.notdo.length
    ? lists.notdo.map((f) => `- ${f}`).join('\n')
    : '- （讨论里没有明确列出不做什么）';
  const transcript = rounds.map((m) => [
    `### 第 ${m.round} 轮 · ${m.role || '讨论'}（${m.agent || 'AI 助手'}）`,
    '',
    String(m.text),
    '',
  ].join('\n')).join('\n');
  return [
    `# 需求文档：${title}`,
    '',
    `> 由苏打工作台自动推进生成。讨论参与：${participants}。生成时间 ${at}。`,
    '> 下面每一行讨论都是 AI 引擎的真实输出原文；清单是从原文里抽的，原文全附在文末。',
    '',
    '## 用户原始想法（原话）',
    '',
    idea,
    '',
    '## 功能清单（这个软件将包含）',
    '',
    featLines,
    '',
    '## 不做什么（明确排除的范围）',
    '',
    notdoLines,
    '',
    '## AI 讨论记录（原文）',
    '',
    transcript,
    '',
  ].join('\n');
}

/** 同步起头留档（new-task 路由内在响应前调用）：保证紧接着的
 *  GET /api/office/discuss 一定能读到 exists:true、phase='discussing'、messages:[]。
 *  已有留档就不覆盖（幂等；恢复场景下不抹掉已跑的轮次）。 */
export function startDiscussRecord({ AUTOLOOP_HOME, taskId, title }) {
  if (readDiscuss(AUTOLOOP_HOME, taskId)) return;
  writeDiscuss(AUTOLOOP_HOME, taskId, {
    taskId, title: title || taskId,
    phase: 'discussing', startedAt: new Date().toISOString(),
    messages: [],
  });
}

/**
 * 自动推进：new-task 建档（req=done、doc=running、留档已起头）之后调用。
 * 幂等：同任务在跑 / 已推完（phase=done）都直接返回。
 * 全程只通过 flow.mjs set 改步骤状态；结束时 doc=awaiting —— 用户唯一需要确认的节点。
 */
export async function kickoffAutoAdvance({ AUTOLOOP_HOME, taskId, title, idea }) {
  if (activeRunners.has(taskId)) return;
  const prior = readDiscuss(AUTOLOOP_HOME, taskId);
  if (prior && prior.phase === 'done') return;
  activeRunners.add(taskId);
  const rec = prior || {
    taskId, title: title || taskId,
    phase: 'discussing', startedAt: new Date().toISOString(), messages: [],
  };
  rec.phase = 'discussing';
  try {
    // 第一轮：提出方案（真实子进程；失败如实落档并停下，不冒充进行中）
    const a = await runDiscussRound(AUTOLOOP_HOME, promptRoundA(idea));
    if (a.error) { await failDiscuss(AUTOLOOP_HOME, taskId, rec, a.error); return; }
    rec.messages.push({ at: new Date().toISOString(), round: 1, role: '提出方案', agent: a.agent, text: a.text });
    writeDiscuss(AUTOLOOP_HOME, taskId, rec);

    // 第二轮：评审与修订。失败不整个废掉——第一轮结果是真实的，按单轮结论出文档并如实注明。
    const b = await runDiscussRound(AUTOLOOP_HOME, promptRoundB(idea, a.text));
    let finalText; let participants; let roundsNote;
    if (b.error) {
      rec.messages.push({ at: new Date().toISOString(), kind: 'system', text: `第二轮评审没有成功（已按第一轮结论整理文档）：${b.error}` });
      finalText = a.text;
      participants = a.agent;
      roundsNote = `仅第一轮成功（${a.agent}）`;
    } else {
      rec.messages.push({ at: new Date().toISOString(), round: 2, role: '评审与修订', agent: b.agent, text: b.text });
      finalText = b.text;
      participants = `${a.agent} 与 ${b.agent}`;
      roundsNote = `两轮（${a.agent} 提方案、${b.agent} 评审修订）`;
    }
    writeDiscuss(AUTOLOOP_HOME, taskId, rec);

    // 文档生成中（状态表第三行）：真实写盘 + 从两轮原文抽清单
    rec.phase = 'writing';
    writeDiscuss(AUTOLOOP_HOME, taskId, rec);
    const listsA = parseDocLists(a.text);
    const listsB = b.error ? { feat: [], notdo: [] } : parseDocLists(b.text);
    const lists = {
      feat: (listsB.feat.length ? listsB.feat : listsA.feat),
      notdo: (listsB.notdo.length ? listsB.notdo : listsA.notdo),
    };
    const docMd = buildDocMd(title || taskId, idea, rec.messages, lists, participants);
    const docDir = join(AUTOLOOP_HOME, 'office-data', 'docs', taskId);
    mkdirSync(docDir, { recursive: true });
    const docPath = join(docDir, '01-需求文档.md');
    const tmpDoc = join(docDir, '.01-需求文档.tmp.md');
    writeFileSync(tmpDoc, docMd, 'utf8');
    renameSync(tmpDoc, docPath);

    // 推到需求确认节点：doc=awaiting（--file 让真实 flow.mjs 登记 bytes+sha256）
    await runFlow(AUTOLOOP_HOME, ['set', taskId, 'doc', '--status', 'awaiting', '--file', docPath,
      '--note', `AI 自动讨论完成（${roundsNote}），需求文档已生成，等你确认`, '--by', '苏打工作台·自动推进']);
    rec.phase = 'done';
    rec.docFile = docPath;
    writeDiscuss(AUTOLOOP_HOME, taskId, rec);
  } catch (e) {
    await failDiscuss(AUTOLOOP_HOME, taskId, rec, `自动推进异常：${e && e.message}`);
  } finally {
    activeRunners.delete(taskId);
  }
}

/** 失败落档：phase=error + 真实原因；doc 保持 running 但 note 换成失败摘要（展示层不冒充进行中） */
async function failDiscuss(AUTOLOOP_HOME, taskId, rec, why) {
  rec.phase = 'error';
  rec.error = String(why || '未知原因').slice(0, 500);
  writeDiscuss(AUTOLOOP_HOME, taskId, rec);
  try {
    await runFlow(AUTOLOOP_HOME, ['set', taskId, 'doc', '--status', 'running',
      '--note', `自动推进失败：${String(why || '').slice(0, NOTE_CLIP)}`, '--by', '苏打工作台·自动推进']);
  } catch { /* note 更新失败不影响留档事实；下次读档仍能看到 phase=error */ }
}

/** 进程重启恢复：只拉回「留档 mid-flight（discussing/writing）且 doc 仍 running」的新流程任务。
 *  phase=error 的不盲目重试（等人处理）；doc=pending 的老任务一律不碰（历史原样保留）。 */
export async function resumeInterruptedAuto(AUTOLOOP_HOME) {
  const dir = join(AUTOLOOP_HOME, 'office-data', 'tasks');
  let names;
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const taskId = name.slice(0, -5);
    if (activeRunners.has(taskId)) continue;
    let rec;
    try { rec = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    const doc = rec && rec.steps && rec.steps.doc;
    const idea = doc && doc.status === 'running' ? (rec.steps.req && rec.steps.req.note) || '' : '';
    const dsc = readDiscuss(AUTOLOOP_HOME, taskId);
    if (doc && doc.status === 'running' && dsc && (dsc.phase === 'discussing' || dsc.phase === 'writing') && idea) {
      console.log(`[自动推进] 恢复中断的讨论：${taskId}`);
      kickoffAutoAdvance({ AUTOLOOP_HOME, taskId, title: rec.title || taskId, idea }).catch(() => {});
    }
  }
}

/** /api/office/discuss 的视图（只读；active 是本进程真实在跑的标记） */
export function discussView(AUTOLOOP_HOME, taskId) {
  const rec = readDiscuss(AUTOLOOP_HOME, taskId);
  return {
    exists: !!rec,
    phase: rec ? rec.phase || null : null,
    active: activeRunners.has(taskId),
    startedAt: rec ? rec.startedAt || null : null,
    updatedAt: rec ? rec.updatedAt || null : null,
    messages: rec && Array.isArray(rec.messages) ? rec.messages : [],
    error: rec ? rec.error || null : null,
    docFile: rec ? rec.docFile || null : null,
  };
}
