'use strict';

/* ================= approval.js — 审批视图（G02 拆分自 app.js M4） =================
   审批门禁（类型/版本）+ 决策面板。G02 拆分：decideHtml 原为 232 行整块渲染，
   现按视图职责拆成子视图（failed 重提 / 完成反馈 / 等待说明 / 需求对象 / 文件
   对象 / 类型与策略行 / 版本差异警示 / 证据区 / 操作条），decideHtml 只做上下文
   汇集与分支调度——输出与拆分前逐字一致（模板原样搬运，未改任何文案与口径）。
   状态归属：decisionBusy / pendingOps / decisionNotes 等提交态随 M4 交互块
   （本文件后半）走；数据快照（lastFlow/fileStatus/versionGate）在 app.js /
   version.js，调用期取用。 */

/* ================= M4 · decide — 决策/重提（TASK-R2：真处理，不再只定位） ================= */

// 决策前提：前序步骤清单（gate 步必须全部 ✓ 才能动）
function priorsOf(steps, idx) {
  return steps.slice(0, idx).map((p) => ({
    ok: p.status === 'done',
    label: `${String(p.no ?? '').padStart(2, '0')} ${p.name}`,
  }));
}

/* ================= R9（评审 P0）：审批对象先行 =================
   「确认通过」之前必须先看到批的是什么。审批对象按步骤类型取：
   - req：审的是需求本身（标题 + 需求原文备注），不需要文件；
   - 其余产物型步骤：审的是本步登记的产物文件；
   - final / verify / 决策门禁本步未单独登记时，引用前序已登记产物
     （交付确认审的就是上游成果，但引用要明说，不冒充本步产物）。
   产物型步骤拿不出对象 → 没有「通过」可点（灰置 + 原因），
   唯一真实动作是「补齐材料」＝打回让执行者把材料交上来。 */
function approvalObjectOf(t, s, steps, idx) {
  const own = dedupFiles(s.files || []);
  if (s.key === 'req') return { kind: 'demand', files: [] };
  if (own.length) return { kind: 'files', files: own, src: 'own' };
  if (s.key === 'final' || s.key === 'verify' || s.gate === true) {
    const upstream = dedupFiles(steps.slice(0, idx).flatMap((p) => p.files || []));
    if (upstream.length) return { kind: 'files', files: upstream, src: 'upstream' };
  }
  return { kind: 'none', files: [] };
}

/* 按钮文案跟对象走：审文件的写明审什么，批准开展的写「批准开始」——
   不再一律「确认通过」让人猜批的是文档还是许可 */
const APPROVE_LABEL = {
  req: '批准 · 开始编写', doc: '通过文档', plan: '通过计划', brief: '通过简报',
  deliverable: '通过产物', verify: '通过验收', final: '通过 · 确认交付',
};
const OBJECT_LABEL = {
  req: '原始需求', doc: '需求文档', plan: '开发计划', brief: '任务简报',
  deliverable: '交付产物', verify: '验收结论', final: '最终交付',
};

/* ================= W01：声明的产物类型门禁（与服务端 artifactGateOf 同一规则） =================
   审批对象关联 = 真实 step_id + 产物登记（path/sha256）+ 声明的产物类型（files[].kind）。
   类型只认档案里显式声明的 kind 字段——不看扩展名、不猜路径：
   - 步骤未声明 expectsKinds：无类型要求，有登记产物即有效（原口径不变）；
   - 任务声明 test-any-file 测试策略：任意登记产物有效（依据入档，页面如实展示）；
   - 否则必须至少一个产物声明了匹配类型，拿不出 → 无效：主操作禁用 +
     服务端 409 ARTIFACT_KIND_MISMATCH 双保险，前端禁用只是提示，不冒充安全边界。 */
function declaredKindOf(f) {
  return f && typeof f.kind === 'string' && f.kind.trim() ? f.kind.trim() : null;
}
/* 任务级测试策略（与服务端 artifactPolicyOf 同一规则）：档案显式声明
   artifactPolicy.mode === 'test-any-file' 且 basis 入档才生效，不靠标题/ID 猜 */
function taskArtifactPolicy(t) {
  const p = t && t.artifactPolicy;
  return p && p.mode === 'test-any-file' && typeof p.basis === 'string' && p.basis.trim()
    ? { mode: p.mode, basis: p.basis.trim() } : null;
}
function artifactGate(t, s) {
  const expects = Array.isArray(s.expectsKinds) && s.expectsKinds.length ? s.expectsKinds : null;
  const policy = taskArtifactPolicy(t);
  const own = dedupFiles(s.files || []);
  if (!expects) return { expects: null, policy, valid: true, matched: own, unmatched: [] };
  if (policy) return { expects, policy, valid: own.length > 0, matched: own, unmatched: [] };
  const matched = own.filter((f) => expects.includes(declaredKindOf(f)));
  const unmatched = own.filter((f) => !expects.includes(declaredKindOf(f)));
  return { expects, policy: null, valid: matched.length > 0, matched, unmatched };
}

/* ================= W02（版本门禁轮）：审批对象版本门禁改为消费服务端判定 =================
   判定唯一来源是 /api/office/version-gate（decide/decision 的 409 重跑同一
   artifactVersionGateOf）：登记快照 bytes/sha256 对当前物理文件核对，字节一致
   还要过内容哈希关（大小相同内容被改也拦下）。两个例外分开判定：类型例外在
   服务端 artifactGateOf（test-any-file 豁免类型要求）；版本例外在服务端
   artifactVersionGateOf 内独立放行（versionExempt=true、valid=true）——豁免只
   免阻断，drifted 差异照实上报，中央异常标签与右侧警示块继续展示。
   判定未到手（请求在途/失败/离线）时 valid:null：前端不显示异常、不禁用主操作，
   安全边界始终在服务端 409，不在前端猜测。 */
function artifactVersionGate(t, s, obj) {
  const policy = taskArtifactPolicy(t);
  if (obj.kind !== 'files') return { policy, valid: true, drifted: [], verified: [], pending: false, src: 'none', versionExempt: false };
  const g = versionGate;
  const key = `${t.id}/${s.key}`;
  if (!g || g.key !== key) {
    // 服务端判定未到手：不捏造「一致」也不捏造「不一致」，主操作交给服务端 409 兜底
    return { policy, valid: null, drifted: [], verified: [], pending: true, src: 'none' };
  }
  const byPath = new Map(obj.files
    .filter((f) => f && typeof f.path === 'string' && f.path)
    .map((f) => [physKey(f.path), f]));
  const drifted = g.drifted.map((d) => ({
    f: byPath.get(physKey(d.path)) || { path: d.path },   // 登记条目找不到时按服务端路径如实展示
    np: normPath(d.path),
    why: d.why, exists: d.exists !== false,
    regB: Number.isFinite(d.regBytes) ? d.regBytes : null,
    actB: Number.isFinite(d.actBytes) ? d.actBytes : null,
    regSha: d.regSha || null,
  }));
  // W01（第 79 轮）：核对通过的文件同样带回内容级证据——服务端在通过分支现算了
  // sha256（登记指纹 vs 实测指纹），前端把「指纹 ✓」亮在条目上；旧响应无 verified
  // 字段按空集容错，条目回落到只并列大小口径。
  const verified = (Array.isArray(g.verified) ? g.verified : []).map((v) => ({
    np: normPath(v.path),
    regSha: v.regSha || null,
    shaMatch: v.shaMatch === true,
  }));
  return { policy: g.policy || policy, valid: g.valid, drifted, verified, pending: false, src: g.src, versionExempt: g.versionExempt === true };
}


/* 决策面板（TASK-R2，TASK-R4 评审 #2/#3 修订）：
   - failed 步骤 → 重提面板优先于一切成功反馈的提前 return（打回成功后步骤就是
     failed，反馈「✓ 已打回」嵌在重提面板顶部，两者同时可见，打回不再是死路）
   - 可处理 → 琥珀面板：前提清单 + 备注 + 通过/打回（真写回 flow.mjs）
   - gate+pending 但前序未齐 → 「门禁未到」+ 待办清单，不计入待决策
   - pending（超时待确认）→ 琥珀色 fb.pend，锁按钮防重复执行
   - 刚处理完 → 一条确认反馈（面板消失但不留空窗）
   W01（底部固定操作区轮）：返回 {html, acts}——html 是卡内说明（随 #insp-body
   滚动），acts 是审批按钮条（renderInspector 移入 #insp-foot 固定底栏）。
   仅可拍板分支产出 acts；failed/门禁/等待前置等分支 acts 为空 → 底栏不占位。 */

/* ================= 决策面板子视图（G02 自 decideHtml 拆出，输出逐字不变） ================= */

// failed 步骤的重提面板（TASK-R4 评审 #2）——打回成功反馈嵌在顶部，重提按钮留在卡内
//（短内容），不入底栏。c = { resultKey, rFor, okFb, pendFb, fbErr, lockBusy, draft }。
function decideFailedHtml(s, c) {
  const okLine = c.okFb
    ? `<div class="done-line">${c.rFor.unconfirmed ? '⚠' : '✓'} ${c.rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : '已打回'}${!c.rFor.unconfirmed && c.rFor.at ? ' · ' + esc(fmtTime(c.rFor.at)) : ''}${c.rFor.note ? '<br>备注：' + esc(c.rFor.note) : ''}${c.rFor.unconfirmed && c.rFor.msg ? '<br>' + esc(c.rFor.msg) : ''}</div>`
    : '';
  return { html: `<div class="ip-decide rej">
      <h4>↩ 已打回 · 待修改后重提</h4>
      ${okLine}
      ${s.note ? `<p class="rej-why">打回理由：${esc(s.note)}</p>` : '<p class="rej-why">打回理由未登记（打回时没写备注）</p>'}
      <textarea id="ip-resubmit-note" maxlength="500" placeholder="重提说明（可选）：改了什么、为什么这次能过" oninput="saveNoteDraft('${esc(c.resultKey)}',this.value,'note-cnt')">${esc(c.draft)}</textarea>
      <div class="note-cnt" id="note-cnt">${c.draft.length}/500${c.draft.length ? ' · 草稿已留存' : ''}</div>
      <div class="acts">
        <button class="btn btn-primary" data-decide="resubmit" ${c.lockBusy ? 'disabled' : ''}>重提 · 回到待拍板</button>
      </div>
      ${decisionBusy ? '<div class="fb busy">提交中…</div>' : ''}
      ${c.pendFb}
      ${c.fbErr}
    </div>`, acts: '' };
}

// 刚处理完且不可再决策 → 一条确认反馈（面板消失但不留空窗）
function decideDoneHtml(rFor) {
  const verb = rFor.action === 'approve' ? '通过' : rFor.action === 'resubmit' ? '重提' : rFor.action === 'request' ? '催材料' : '打回';
  // TASK-R5（评审 #3）：回查兜底判定的成功是「档案已是目标状态」，归属不确定——
  // 用 ⚠ 并明说，不冒充服务端确认过的结果。
  const mark = rFor.unconfirmed ? '⚠' : '✓';
  const main = rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : `已${verb}`;
  const unconfirmedNote = rFor.unconfirmed && rFor.msg
    ? `<br>${esc(rFor.msg)}` : '';
  return { html: `<div class="ip-decide"><div class="done-line">${mark} ${main}${!rFor.unconfirmed && rFor.at ? ' · ' + esc(fmtTime(rFor.at)) : ''}${rFor.note ? '<br>备注：' + esc(rFor.note) : ''}${unconfirmedNote}</div></div>`, acts: '' };
}

// 不可决策的如实说明：门禁未到 / 等待前置条件；其余不出面板
function decideWaitHtml(s, steps, idx) {
  if (s.gate === true && s.status === 'pending') {
    const waiting = priorsOf(steps, idx).filter((p) => !p.ok).map((p) => p.label);
    return { html: `<div class="ip-sec"><h4>门禁未到</h4><div class="ip-v">这一步是决策门禁，但前序还没走完，暂时不能拍板：<br>${waiting.map((w) => '· ' + esc(w)).join('<br>')}</div></div>`, acts: '' };
  }
  if (s.status === 'awaiting') {
    // W02：审批记录已创建，但按流水线依赖（串行：前序全部通过）还没轮到它拍板。
    // 面板如实说在等谁，不渲染通过/打回——「记录存在」≠「现在能批」。
    const waiting = priorsOf(steps, idx).filter((p) => !p.ok).map((p) => p.label);
    return { html: `<div class="ip-sec"><h4>等待前置条件</h4><div class="ip-v">这一步已有待审批记录，但前序还没走完，暂时不能拍板：<br>${waiting.map((w) => '· ' + esc(w)).join('<br>')}<br>前序通过并同步后，这里会变成可处理的待拍板。</div></div>`, acts: '' };
  }
  return { html: '', acts: '' };
}

// 需求类审批：对象是需求本身（标题 + 原文备注），永远可见，不依赖文件
function decideDemandHtml(t, s) {
  return s.key !== 'req' ? '' : `<div class="ev-row"><span class="ev-k">需求原文</span><span class="ev-v"><p class="ev-demand">${esc(t.title)}</p>${s.note
        ? `<p class="ev-demand ev-note" title="${esc(s.note)}">${esc(s.note)}</p>`
        : '<p class="ev-none">（需求未附补充说明）</p>'}</span></div>`;
}

// 文件类审批：对象是产物清单，逐个可点开预览（走全局 data-open-file）。
// W01：每个文件标注声明的产物类型（未声明也如实标「未声明」）——
// 「批的是什么类型的东西」必须看得见，不让人猜。
// W01（本轮）：文件条目改两行——第一行文件名（真实登记记录取 basename），
// 第二行大小 + 声明类型。单行布局里元信息会把文件名挤没了，审批时认不出批的是哪个文件。
// 第二行拆成大小段（.msz）+ 类型段（.mtp）：面板窄时两段自动换行各自完整显示，
// 大小和类型任何情况下都不能被省略号吃掉（文件名行才允许单行省略）。
// W02（版本门禁轮）：msz 是简短异常摘要——有服务端判定（vgate）时按判定 why
// 分流（bytes ≠ / sha 指纹不一致 / noreg 登记缺失），数字取判定自带的实测与
// 登记值，与下方警示块逐字相同；无漂移或判定未到时只并列实测·登记双口径，
// 完整的版本差异说明只留警示块一处，这里不再重复叙述。
function decideFileEntryHtml(f, vgate) {
  const np = normPath(f.path);
  const pk = physKey(f.path);
  const chk = fileStatus.get(pk);   // F02：物理键与文件库同一份校验结果
  const missing = chk && chk.exists === false;
  const regB = f && f.bytes != null && Number.isFinite(f.bytes) ? f.bytes : null;
  const vd = vgate.pending ? undefined : vgate.drifted.find((d) => physKey(d.np) === pk);
  let size;
  if (chk && chk.exists) {
    const meas = fmtBytes(chk.bytes);
    if (vd) {
      size = vd.why === 'bytes'
        ? `实测 ${fmtBytes(vd.actB)} ≠ 登记 ${fmtBytes(vd.regB)}`
        : vd.why === 'sha'
          ? `实测 ${fmtBytes(vd.actB)} · 登记 ${fmtBytes(vd.regB)} · 指纹不一致`
          : vd.why === 'noreg'
            ? `实测 ${fmtBytes(vd.actB)} · 登记 —（缺失）`
            : `实测 ${meas}`;
    } else {
      size = regB == null ? `实测 ${meas} · 登记 —（缺失）` : `实测 ${meas} · 登记 ${fmtBytes(regB)}`;
    }
  } else {
    size = `${fmtBytes(f.bytes)}（登记）`;
  }
  // W01（第 79 轮）：无漂移条目补内容级证据——服务端现算 SHA-256 与登记指纹比对
  // 通过的标「指纹 a1b2c3d4 ✓」（大小与内容双一致）；登记无指纹的老档案不标，
  // 不冒充已核内容。
  const vv = vgate.pending ? undefined : (vgate.verified || []).find((v) => physKey(v.np) === pk);
  const shaHtml = vv && vv.shaMatch && vv.regSha
    ? `<span class="msha">指纹 ${esc(String(vv.regSha).slice(0, 8))} ✓</span>`
    : '';
  const kind = declaredKindOf(f);
  return `<button type="button" class="ev-file${missing ? ' miss' : ''}" data-open-file="${esc(f.path)}" title="${esc(f.path)}&#10;点击预览内容">
          <i class="fm">${missing ? '✗' : '·'}</i><span class="ev-file-txt"><span class="fn">${esc(np.split('/').pop())}</span><small class="ev-file-meta">${missing ? '<span class="msz">文件不存在</span>' : `<span class="msz">${esc(size)}</span><span class="mtp">类型 ${esc(kind || '未声明')}</span>${shaHtml}`}</small></span></button>`;
}

// 文件清单行 + 核对口径/上游引用说明（decideFileEntryHtml 的包装）
function decideFilesHtml(obj, vgate) {
  return obj.kind !== 'files' ? '' : `<div class="ev-row"><span class="ev-k">文件预览</span><span class="ev-v">${obj.files.map((f) => decideFileEntryHtml(f, vgate)).join('')}</span></div>
      ${vgate.drifted.length ? '' : '<p class="ev-src">核对口径：条目大小与点击预览读取的都是当前物理文件（实时实测），「登记」是提交时的元数据，两者并列以便对版本；标注「指纹 ✓」的条目，内容已由服务端现算 SHA-256 与登记指纹比对通过（大小与内容双一致）。</p>'}
      ${obj.src === 'upstream' ? '<p class="ev-src">本步骤未单独登记产物，列出的是前序步骤已登记产物，供核对。</p>' : ''}`;
}

// W01：本步骤有类型要求时明确列出；测试策略生效时把豁免依据原样挂出来，
// 页面解释「为什么这个文件能批」，不静默放行。
// W02 第 12 轮：测试策略说明合并为一处——类型要求行只报类型本身，策略的
// 声明 + 含义 + 依据统一由 policyNote 展示（依据全文可见，不再只藏 tooltip）。
function decidePolicyHtml(gate) {
  const expectsHtml = gate.expects
    ? `<div class="ev-row"><span class="ev-k">类型要求</span><span class="ev-v">${esc(gate.expects.join(' / '))}</span></div>`
    : '';
  const policyNote = gate.policy && gate.expects
    ? `<p class="ev-src" title="${esc(gate.policy.basis)}">本需求档案声明了测试策略（test-any-file）：任意登记产物均可作为审批对象。依据：${esc(gate.policy.basis.length > 80 ? gate.policy.basis.slice(0, 80) + '…' : gate.policy.basis)}</p>`
    : '';
  return { expectsHtml, policyNote };
}

// W02（版本门禁轮）：材料不一致警示块是版本差异的唯一完整说明处——条目与数字
// 直接取服务端判定（vgate.drifted，why 分流：missing/noreg/bytes/sha），上方
// msz 只留简短摘要、核对口径段在有警示时让位，不再重复叙述同一事实。沿用
// 现有审批信息区域，不加新操作按钮：打回 / 补齐材料是既有出口。结尾按服务端
// 判定分流：正式流程有差异就禁止按原版本通过（服务端同样 409）；test-any-file
// 的版本例外独立生效（versionExempt，与类型例外分开判定）——差异照说，但不阻断
// 该测试流程的审批，服务端按同一规则放行，不说「已禁止」的假话。
// W02 第 10 轮：策略已在下方 policyNote 完整说明（声明+依据）时，结尾不再重复
// 「已入档」引子，只留本块独有的判定口径；policyNote 未渲染的边缘态保留全句。
function decideDriftNote(vgate, gate) {
  if (!vgate.drifted.length) return '';
  const mmTail = vgate.versionExempt
    ? (gate.policy && gate.expects
        ? `登记产物为占位产物，文件类型例外与版本变化例外分别判定——上述版本差异照常展示，但不阻断本测试流程的审批（服务端按同一规则放行）。`
        : `本任务声明的测试策略（test-any-file）已入档：登记产物为占位产物，文件类型例外与版本变化例外分别判定——上述版本差异照常展示，但不阻断本测试流程的审批（服务端按同一规则放行）。`)
    : `正式流程按提交登记的版本审批：上述材料提交后发生过变化（或登记缺失版本标识），已禁止按原版本通过，服务端同样会拒绝。请先「打回」要求重新提交——重新登记后的档案才是新版本。`;
  return `<div class="material-mismatch">材料与提交登记不一致：审批读取的是当前物理文件，下列材料与提交登记的版本对不上（「登记」是提交时快照，含字节与内容指纹）——<br>${vgate.drifted.map(({ np, why, exists, regB, actB, regSha }) => {
        const cmp = !exists
          ? `文件不存在，无法按登记版本核对`
          : why === 'noreg'
            ? `实测 ${esc(fmtBytes(actB))} · 登记大小缺失，无版本标识可比`
            : why === 'sha'
              ? `实测 ${esc(fmtBytes(actB))} · 登记 ${esc(fmtBytes(regB))} · 内容指纹不一致`
              : `实测 ${esc(fmtBytes(actB))} ≠ 登记 ${esc(fmtBytes(regB))}`;
        const ver = regSha ? `（登记内容指纹 ${esc(String(regSha).slice(0, 8))}）` : '';
        return `· ${esc(np.split('/').pop())}：${cmp}${ver}`;
      }).join('<br>')}<br>${mmTail}</div>`;
}

// 审批对象证据区（R9 评审 P0：放在备注和动作之前——先看，再批）
function decideEvidenceHtml(obj, objLabel, demandHtml, filesHtml, expectsHtml, priorsHtml, s, policyNote) {
  return `
    <div class="ev">
      <div class="ev-head">审批对象 · ${esc(objLabel)}${obj.kind === 'files' ? `（${obj.files.length} 个文件）` : obj.kind === 'none' ? ' · 无' : ''}</div>
      ${demandHtml}
      ${filesHtml}
      ${expectsHtml}
      <div class="ev-row"><span class="ev-k">提交者</span><span class="ev-v">${s.by ? esc(s.by) : '<span class="ev-none">—</span>'}</span></div>
      <div class="ev-row"><span class="ev-k">提交时间</span><span class="ev-v">${s.at ? esc(fmtTime(s.at)) + ' · ' + esc(ago(s.at)) : '<span class="ev-none">—</span>'}</span></div>
      ${priorsHtml}
    </div>
    ${policyNote}`;
}

// 底部操作条（W01：acts 独立，renderInspector 写入 #insp-foot 固定底栏，
// 说明区（对象核对/警示/备注框）留在卡内随内容滚动）
function decideActsHtml(obj, approveLabel, lockBusy, materialInvalid, versionInvalid) {
  const hasObject = obj.kind !== 'none';
  return `<div class="acts">
      ${hasObject
        ? `<button class="btn btn-primary${materialInvalid || versionInvalid ? ' btn-invalid-material' : ''}" data-decide="approve" ${lockBusy || materialInvalid || versionInvalid ? 'disabled' : ''} title="${materialInvalid ? '登记产物不符合本步骤类型要求，服务端同样会拒绝' : versionInvalid ? '审批对象与提交登记的版本不一致，服务端同样会拒绝；请先打回要求重新提交' : ''}">${esc(approveLabel)}</button>
           <button class="btn btn-secondary" data-decide="reject" ${lockBusy ? 'disabled' : ''}>打回</button>`
        : `<button class="btn btn-secondary" data-decide="request" ${lockBusy ? 'disabled' : ''} title="步骤留在待拍板，要求执行者先补交产物材料">补齐材料</button>`}
    </div>`;
}

function decideHtml(t, s, steps, idx) {
  const decidable = isDecidable(s, steps);
  const resultKey = `${t.id}/${s.key}`;
  // TASK-R6（评审 #4/#6）：反馈按 key 读取（decisionResultFor），切走再切回来
  // 10 分钟内还能看到这一步上次的提交结果；归属未确认的成功统一显示
  // 「档案已变更，本次提交尚未确认」，不冒充服务端确认过的结论。
  const rFor = decisionResultFor(resultKey);
  const okFb = rFor && rFor.ok;
  // TASK-R5（评审 #2）：待确认以 pendingOps 集合为准，不再依赖 decisionResult——
  // 导航会清 decisionResult（防串台），但操作本身还在回查中。从集合判断后，
  // 切走再切回来依然显示「结果待确认」并锁住按钮，生命周期不被导航破坏。
  const pend = pendingOps.has(resultKey);
  const pendFb = pend
    ? `<div class="fb pend">⏳ 结果待确认：写回可能仍在进行，自动核对服务端操作记录（独立于页面轮询），落定前不能重复提交</div>`
    : '';
  const fbErr = rFor && !rFor.ok
    ? `<div class="fb err">${esc(rFor.msg)}</div>` : '';
  // 待确认期间禁止再点（操作标识占用中，防重复执行）
  const lockBusy = decisionBusy || pend;
  // TASK-R6（评审 #4）：备注草稿按 key 留存，切走再回来不丢
  const draft = decisionNotes.get(resultKey) || '';
  const c = { resultKey, rFor, okFb, pendFb, fbErr, lockBusy, draft };

  // TASK-R4（评审 #2）：failed 步骤的重提面板必须先于成功反馈的提前 return——
  // 打回成功后步骤状态就是 failed 且不可决策，旧顺序里「不可决策+成功」先 return，
  // 页面只剩「✓ 已打回」没有重提按钮，打回成死路。现在成功反馈嵌在重提面板顶部，
  // 两者同时可见。重提成功后状态回 awaiting，落到下面的正常决策面板。
  if (s.status === 'failed') return decideFailedHtml(s, c);
  if (!decidable && okFb) return decideDoneHtml(rFor);
  if (!decidable) return decideWaitHtml(s, steps, idx);

  // ---- R9（评审 P0）：审批对象区放在备注和动作之前——先看，再批 ----
  const obj = approvalObjectOf(t, s, steps, idx);
  const hasObject = obj.kind !== 'none';
  const objLabel = OBJECT_LABEL[s.key] || s.name;
  const approveLabel = APPROVE_LABEL[s.key] || '确认通过';

  // W01：产物类型门禁——登记产物不满足本步骤声明的类型要求时，主操作禁用
  // （服务端另有 409 兜底，这里只是让用户在看板上先看到为什么不能批）。
  const gate = artifactGate(t, s);
  const materialInvalid = hasObject && !gate.valid;

  // W02：审批对象版本门禁——判定来自服务端 version-gate（与 decide/decision 的
  // 409 同一函数同一数据源）：登记版本与当前物理文件核对不过（字节/内容指纹/
  // 缺失/无版本标识）时正式流程禁止按原版本通过，主操作禁用 + 服务端 409 双保险。
  // test-any-file 的版本例外由服务端独立判定（versionExempt）：豁免时 valid=true、
  // 主操作不禁用（服务端同规则放行），差异仍照实展示。判定未到手（pending）时
  // 不禁用，交给服务端 409 兜底——不拿前端猜测冒充权威判定。
  const vgate = artifactVersionGate(t, s, obj);
  const versionInvalid = hasObject && vgate.valid === false;

  const demandHtml = decideDemandHtml(t, s);
  const filesHtml = decideFilesHtml(obj, vgate);
  const { expectsHtml, policyNote } = decidePolicyHtml(gate);
  const mmNote = decideDriftNote(vgate, gate);
  const priorsHtml = idx > 0
    ? `<div class="ev-row"><span class="ev-k">前置条件</span><span class="ev-v">${priorsOf(steps, idx).map((p) => `<span class="ev-pre ${p.ok ? 'ok' : ''}">${p.ok ? '✓' : '·'} ${esc(p.label)}</span>`).join('')}</span></div>`
    : '';
  const evidenceHtml = decideEvidenceHtml(obj, objLabel, demandHtml, filesHtml, expectsHtml, priorsHtml, s, policyNote);
  // 无对象（TASK-11.1 / R1）：明说为什么不能通过，并且「确认通过」按钮根本不渲染——
  // 不是灰掉摆在那。唯一动作是「补齐材料」（request）：步骤留在待拍板，等材料交上来。
  const noObjNote = !hasObject
    ? '<div class="fb warn">本步骤尚无登记产物——没有可审批的对象，先有证据再审批。请「补齐材料」并写明缺什么，材料登记后再来通过。</div>' : '';
  // W01：有产物但类型不符——对象在、关联不成立。警示块说明规则，主操作禁用，
  // 但打回 / 补齐材料保持可用（材料不合格正是这两个动作的用武之地）。
  const invalidNote = materialInvalid
    ? `<div class="invalid-material">本步骤要求声明类型为「${esc((gate.expects || []).join(' / '))}」的材料，登记产物（${gate.unmatched.map((f) => esc(normPath(f.path).split('/').pop()) + '：' + esc(declaredKindOf(f) || '未声明类型')).join('、')}）不满足类型要求，不能作为有效审批对象。请先「补齐材料」要求提交计划类产物，或「打回」处理。</div>`
    : '';

  // TASK-R3：重提成功的反馈——步骤已回 awaiting（可决策），顶部挂一条「已重提」。
  // TASK-R6（评审 #6）：归属未确认时不再显示「✓ 已重提」，统一为未确认措辞。
  const resubmitted = okFb && rFor.action === 'resubmit'
    ? `<div class="done-line">${rFor.unconfirmed ? '⚠' : '✓'} ${rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : '已重提，等待重新拍板'}${rFor.unconfirmed && rFor.msg ? '<br>' + esc(rFor.msg) : ''}</div>` : '';
  // TASK-11.1：补齐材料成功的反馈——步骤留在 awaiting（仍可决策），顶部挂一条说明。
  // 它不是通过也不是打回：待决策 ≠ 执行失败，步骤状态不变，只留了催材料的记录。
  const requested = okFb && rFor.action === 'request'
    ? `<div class="done-line">${rFor.unconfirmed ? '⚠' : '✓'} ${rFor.unconfirmed ? '档案已变更，本次提交尚未确认' : '已发出补齐材料要求，本步仍停在待拍板——材料登记后这里会列出文件'}${rFor.unconfirmed && rFor.msg ? '<br>' + esc(rFor.msg) : ''}</div>` : '';
  const acts = decideActsHtml(obj, approveLabel, lockBusy, materialInvalid, versionInvalid);
  return { html: `<div class="ip-decide">
    <h4>⏸ ${s.gate === true ? '决策门禁 · 等 Leo 拍板' : '待 Leo 确认'}</h4>
    ${resubmitted}
    ${requested}
    ${evidenceHtml}
    ${mmNote}
    ${noObjNote}
    ${invalidNote}
    <textarea id="ip-decide-note" maxlength="500" placeholder="${hasObject ? '备注（打回必填，≤500 字）' : '说明缺什么材料（必填，≤500 字）'}" oninput="saveNoteDraft('${esc(resultKey)}',this.value,'ip-note-cnt')">${esc(draft)}</textarea>
    <div class="note-cnt" id="ip-note-cnt">${draft.length}/500${draft.length ? ' · 草稿已留存' : ''}</div>
    ${decisionBusy ? '<div class="fb busy">提交中…</div>' : ''}
    ${pendFb}
    ${fbErr}
  </div>`, acts };
}

/* G02：决策执行段（localDecisions / renderDecisionPop / applyDecisionOutcome / submitDecision / reconcile 回查 / settleOp）→ decision-ops.js */