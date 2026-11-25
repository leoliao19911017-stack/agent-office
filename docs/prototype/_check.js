
/* ==================================================
   09. 内嵌图标
   无外部字体、图片、CDN 或第三方依赖
   ================================================== */

const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8"/>',
  "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  folder: '<path d="M3 7V5a2 2 0 012-2h4l3 4h7a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2Z"/>',
  file: '<path d="M13 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V10zM13 3v7h7M8 14h8M8 17h6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  alert: '<path d="M10.3 3.9 2.8 18a2 2 0 001.8 3h14.8a2 2 0 001.8-3L13.7 3.9a2 2 0 00-3.4 0ZM12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  inbox: '<path d="M4 4h16l2 11v5H2v-5L4 4ZM2 15h6l2 3h4l2-3h6"/>',
  code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18"/>',
  command: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m7 8 4 4-4 4M13 16h4"/>',
  sparkle: '<path d="M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z"/>'
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24"
          aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;
}

function hydrateIcons() {
  document.querySelectorAll("[data-icon]").forEach(el => {
    el.innerHTML = icon(el.dataset.icon);
  });
}

document.getElementById("brandLogo").innerHTML = icon("layers");
hydrateIcons();

/* ==================================================
   10. 示意数据模型
   主状态与执行异常是两个独立字段
   ================================================== */

const WORKFLOW = [
  {
    name: "需求输入",
    owner: "Leo",
    output: "原始需求.md",
    description: "记录原始需求、工作区归属及任务目标。"
  },
  {
    name: "需求澄清",
    owner: "Hermes",
    output: "需求澄清记录.md",
    description: "识别不明确的需求，并向负责人确认约束条件。"
  },
  {
    name: "讨论与确认",
    owner: "Hermes · Codex",
    output: "需求基线.md",
    description: "组织需求讨论，形成需求基线，等待负责人确认。"
  },
  {
    name: "开发任务书",
    owner: "Hermes",
    output: "开发任务书.md",
    description: "将确认后的需求拆成可执行任务、测试标准及依赖关系。"
  },
  {
    name: "开发与自测",
    owner: "Claude Code",
    output: "开发记录与自测报告.md",
    description: "执行开发子任务，并记录每项任务的开发与自测结果。"
  },
  {
    name: "独立评审",
    owner: "Codex",
    output: "独立评审报告.md",
    description: "独立审查实现质量，检查问题并按验收标准打分。"
  },
  {
    name: "整改复验",
    owner: "Claude Code · Codex",
    output: "整改与复验报告.md",
    description: "修复评审问题，直到达到目标分数与必要验收条件。"
  },
  {
    name: "成果验收",
    owner: "Hermes · Leo",
    output: "验收报告.md",
    description: "核对最终成果、功能与测试证据，确认是否可以交付。"
  },
  {
    name: "正式交付",
    owner: "Hermes",
    output: "交付清单.md",
    description: "归档最终交付物、测试报告及完整过程记录。"
  }
];

const STATUSES = [
  { id: "todo", label: "待开始", color: "" },
  { id: "running", label: "进行中", color: "blue" },
  { id: "decision", label: "待决策", color: "amber" },
  { id: "review", label: "待验收", color: "purple" },
  { id: "done", label: "已完成", color: "green" }
];

let workspaces = [
  {
    id: "ease",
    name: "EaseDraw",
    symbol: "E",
    theme: "ease",
    type: "Coding 工作流",
    path: "D:/Projects/EaseDraw"
  },
  {
    id: "office",
    name: "Agent Office",
    symbol: "A",
    theme: "office",
    type: "Coding 工作流",
    path: "D:/Projects/AgentOffice"
  },
  {
    id: "visual",
    name: "视觉设计",
    symbol: "V",
    theme: "visual",
    type: "设计工作流（原型共用九步）",
    path: "D:/Projects/VisualDesign"
  }
];

const AGENTS = [
  {
    id: "hermes",
    name: "Hermes",
    initials: "H",
    role: "调度与需求管理",
    status: "运行中",
    color: "green",
    task: "整理工作台重构需求基线",
    engine: "本地 Agent 网关"
  },
  {
    id: "claude",
    name: "Claude Code",
    initials: "C",
    role: "开发与自测",
    status: "运行中",
    color: "green",
    task: "实现锁屏进度组件",
    engine: "Claude Code CLI"
  },
  {
    id: "codex",
    name: "Codex",
    initials: "X",
    role: "独立评审",
    status: "待命",
    color: "",
    task: "等待开发成果提交",
    engine: "Codex CLI"
  },
  {
    id: "dsh",
    name: "DSH",
    initials: "D",
    role: "备用开发执行器",
    status: "连接异常",
    color: "red",
    task: "执行器连接超时（示意）",
    engine: "DeepSeek Harness"
  }
];

function buildTask(id, workspace, title, status, step,
                   agent, total, completed, tested,
                   summary, error = null) {

  const stepStates = WORKFLOW.map((_, i) => {
    if (status === "done") return "done";
    if (status === "todo") return "pending";
    if (i < step - 1) return "done";
    if (i > step - 1) return "pending";
    if (error) return "failed";
    if (status === "decision" || status === "review")
      return "waiting";
    return "current";
  });

  const taskNames = [
    "需求约束与接口核对",
    "基础数据结构实现",
    "核心业务逻辑开发",
    "页面组件及交互实现",
    "异常与边界条件处理",
    "自动化测试及回归验证"
  ];

  const subtasks = Array.from({length: total}, (_, i) => ({
    id: i + 1,
    name: taskNames[i] || `开发子任务 ${i + 1}`,
    status: i < completed
      ? "done"
      : (i === completed && status === "running"
        ? "running" : "pending"),
    tested: i < tested
  }));

  return {
    id, workspace, title, status, step, agent,
    total, completed, tested, summary, error,
    stepStates, subtasks,
    targetScore: 8.0,
    score: status === "done" ? 8.7 :
           status === "review" ? 8.4 : null,
    createdAt: "11月25日",
    history: []
  };
}

let tasks = [
  buildTask(
    "ED-001", "ease",
    "画作收藏与展厅优化",
    "todo", 1, "hermes", 0, 0, 0,
    "优化用户完成绘画后的收藏和展厅浏览体验。"
  ),
  buildTask(
    "ED-002", "ease",
    "iOS 锁屏进度组件",
    "running", 5, "claude", 6, 3, 2,
    "让用户在专注过程中无需解锁手机，即可查看绘画进度与剩余时间。"
  ),
  buildTask(
    "ED-003", "ease",
    "睡前体验交互调整",
    "decision", 3, "hermes", 0, 0, 0,
    "需要确认睡前模式的呼吸节律及交互反馈方式。"
  ),
  buildTask(
    "ED-004", "ease",
    "画作生成接口封装",
    "review", 8, "codex", 4, 4, 4,
    "统一画作生成服务的接口与错误处理。"
  ),
  buildTask(
    "ED-005", "ease",
    "移动端展厅适配",
    "done", 9, "claude", 5, 5, 5,
    "完成移动端展厅布局与图片浏览交互。"
  ),
  buildTask(
    "ED-006", "ease",
    "专注计时器回归测试",
    "running", 5, "dsh", 4, 1, 1,
    "验证计时器在切换页面和恢复会话时的状态。",
    "DSH 执行器连接超时，当前任务已暂停。"
  ),
  buildTask(
    "AO-021", "office",
    "工作台三栏结构重构",
    "decision", 3, "hermes", 0, 0, 0,
    "固定左右栏，将工作区看板、需求详情和运行观测统一到中间视图。"
  ),
  buildTask(
    "AO-022", "office",
    "工作流决策引擎",
    "running", 5, "claude", 6, 4, 3,
    "实现审批节点、决策记录和工作流恢复机制。"
  ),
  buildTask(
    "AO-023", "office",
    "Agent 运行日志归档",
    "todo", 1, "hermes", 0, 0, 0,
    "统一不同 Agent 的执行日志和产物归档结构。"
  ),
  buildTask(
    "AO-024", "office",
    "需求数据结构迁移",
    "done", 9, "codex", 4, 4, 4,
    "完成工作区、需求和流程实例的数据关系调整。"
  )
];

let decisions = [
  {
    id: "D-001",
    taskId: "ED-003",
    type: "需求确认",
    title: "确认睡前模式的交互方式",
    summary: "Hermes 已整理两种方案，需要你确定产品方向。",
    question: "睡前绘画应该采用完全自动播放，还是保留轻量交互？",
    options: [
      {
        id: "A",
        title: "自动绘画与呼吸节律",
        description: "开始后无需操作，画作按设定节律逐渐完成。降低睡前手机交互频率。",
        impact: "改动较小 · 更适合睡前使用"
      },
      {
        id: "B",
        title: "保留轻量触摸交互",
        description: "用户通过触摸推进画作，保留主动参与感，同时提供自动模式。",
        impact: "交互更丰富 · 开发成本较高"
      }
    ],
    recommended: "A",
    reason: "睡前场景的首要目标是减少注意力刺激，而非增加互动次数。建议先完成自动模式，再根据体验反馈决定是否增加触摸交互。",
    resolved: false
  },
  {
    id: "D-002",
    taskId: "AO-021",
    type: "需求基线确认",
    title: "确认工作台重构结构",
    summary: "三栏布局方案已整理，等待确认后进入开发。",
    question: "是否以固定左右栏、中间独立切换作为新工作台的需求基线？",
    options: [
      {
        id: "A",
        title: "固定三栏，中间视图切换",
        description: "左侧选择工作区，中间承载看板、详情和运行观测，右侧统一处理指令与决策。",
        impact: "信息架构清晰 · 需要调整页面容器"
      },
      {
        id: "B",
        title: "保留原结构，局部优化",
        description: "延续现有页面布局，仅调整看板组件及部分导航。",
        impact: "开发改动较小 · 原有结构问题可能保留"
      }
    ],
    recommended: "A",
    reason: "固定三栏可以确保用户在切换需求和工作区时，不丢失任务入口与审批上下文。",
    resolved: false
  },
  {
    id: "D-003",
    taskId: "ED-004",
    type: "成果验收",
    title: "验收画作生成接口",
    summary: "评审示意分数 8.4 / 10，等待最终验收。",
    question: "是否接受当前版本的画作生成接口交付成果？",
    options: [
      {
        id: "A",
        title: "通过验收",
        description: "接受当前交付成果，进入正式交付及归档。",
        impact: "结束本次需求流程"
      },
      {
        id: "B",
        title: "追加一次整改",
        description: "补充接口异常测试及相关使用文档后再次验收。",
        impact: "回到整改复验阶段"
      }
    ],
    recommended: "A",
    reason: "本示例中所有开发任务已完成，自测全部通过，独立评审分数达到预设目标。",
    resolved: false
  }
];

let activities = [
  {
    agent: "hermes",
    text: "已整理工作台重构需求基线",
    workspace: "office",
    time: "刚刚"
  },
  {
    agent: "claude",
    text: "完成锁屏进度组件的基础数据结构",
    workspace: "ease",
    time: "5 分钟前"
  },
  {
    agent: "codex",
    text: "画作生成接口评审完成 · 8.4 分",
    workspace: "ease",
    time: "12 分钟前"
  },
  {
    agent: "dsh",
    text: "执行器连接异常，任务已暂停",
    workspace: "ease",
    time: "18 分钟前"
  }
];

/* ==================================================
   11. UI 状态
   仅中间 main 随视图切换
   ================================================== */

const state = {
  view: "board",
  workspaceId: "ease",
  taskId: null,
  selectedStep: null,
  boardFilter: "all",
  decisionId: null,
  selectedOption: "A",
  drafts: {}
};

function getWorkspace(id = state.workspaceId) {
  return workspaces.find(w => w.id === id);
}

function getTask(id) {
  return tasks.find(t => t.id === id);
}

function getAgent(id) {
  return AGENTS.find(a => a.id === id) || AGENTS[0];
}

function getStatus(id) {
  return STATUSES.find(s => s.id === id) || STATUSES[0];
}

function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}

function avatar(id) {
  const a = getAgent(id);
  return `<span class="avatar ${a.id}"
                title="${escapeHTML(a.name)}">
            ${a.initials}
          </span>`;
}

function percentage(task) {
  return task.total
    ? Math.round(task.completed / task.total * 100)
    : 0;
}

function pendingDecisions() {
  return decisions.filter(d => !d.resolved);
}

function addActivity(agent, text, workspace) {
  activities.unshift({
    agent,
    text,
    workspace,
    time: "刚刚"
  });
}

function saveDraft() {
  state.drafts[state.workspaceId] =
    document.getElementById("requirementInput").value;
}

function switchWorkspace(id) {
  if (!getWorkspace(id)) return;

  saveDraft();

  state.workspaceId = id;
  state.view = "board";
  state.taskId = null;
  state.selectedStep = null;
  state.boardFilter = "all";

  document.getElementById("requirementInput").value =
    state.drafts[id] || "";

  renderAll();
}

function openOverview() {
  state.view = "overview";
  state.taskId = null;
  renderAll();
}

function openObservation() {
  state.view = "observation";
  state.taskId = null;
  renderAll();
}

function openTask(id) {
  const task = getTask(id);
  if (!task) return;

  if (task.workspace !== state.workspaceId) {
    saveDraft();
    state.workspaceId = task.workspace;
    document.getElementById("requirementInput").value =
      state.drafts[task.workspace] || "";
  }

  state.taskId = id;
  state.selectedStep = task.step - 1;
  state.view = "detail";
  renderAll();
}

function backToBoard() {
  state.view = "board";
  state.taskId = null;
  renderAll();
}

function setFilter(filter) {
  state.boardFilter = filter;
  renderMain();
}

function focusComposer() {
  document.getElementById("requirementInput").focus();
}

/* ==================================================
   12. 左栏渲染
   ================================================== */

function renderSidebar() {
  document.getElementById("workspaceNav").innerHTML =
    workspaces.map(w => {
      const count = tasks.filter(t =>
        t.workspace === w.id &&
        t.status !== "done"
      ).length;

      const active =
        state.workspaceId === w.id &&
        ["board","detail"].includes(state.view);

      return `
        <button class="nav-item ${active ? "active" : ""}"
                onclick="switchWorkspace('${w.id}')">
          <span class="
workspace-symbol ${w.theme}">
            ${escapeHTML(w.symbol)}
          </span>
          <span>${escapeHTML(w.name)}</span>
          <span class="count">${count}</span>
        </button>
      `;
    }).join("");

  document.getElementById("overviewNav")
    .classList.toggle("active",state.view === "overview");

  document.getElementById("observationNav")
    .classList.toggle("active",state.view === "observation");
}

/* ==================================================
   13. 看板渲染
   失败任务进入独立异常区域，而非第六列
   ================================================== */

function renderStats(list) {
  const running = list.filter(t =>
    t.status === "running" && !t.error).length;

  const waiting = list.filter(t =>
    ["decision","review"].includes(t.status) &&
    !t.error).length;

  const done = list.filter(t => t.status === "done").length;

  return `
    <div class="stat-grid">
      <div class="stat card">
        <div class="stat-label">全部需求</div>
        <div class="stat-value">${list.length}</div>
        <div class="stat-note">当前统计范围</div>
      </div>
      <div class="stat card">
        <div class="stat-label row">
          <span class="dot blue"></span>正在执行
        </div>
        <div class="stat-value">${running}</div>
        <div class="stat-note">不含暂停的异常任务</div>
      </div>
      <div class="stat card">
        <div class="stat-label row">
          <span class="dot amber"></span>等待确认
        </div>
        <div class="stat-value">${waiting}</div>
        <div class="stat-note">决策与成果验收</div>
      </div>
      <div class="stat card">
        <div class="stat-label row">
          <span class="dot green"></span>已完成
        </div>
        <div class="stat-value">${done}</div>
        <div class="stat-note">已进入正式交付</div>
      </div>
    </div>
  `;
}

function renderTaskCard(task) {
  const status = getStatus(task.status);
  const agent = getAgent(task.agent);

  let development = "";

  if (task.total > 0) {
    development = `
      <div class="progress">
        <span style="width:${percentage(task)}%;
          background:${task.status === "done"
            ? "var(--green)" : "var(--blue)"}"></span>
      </div>
      <div class="task-meta">
        开发 ${task.completed}/${task.total}
      </div>
    `;
  }

  return `
    <article class="task-card card"
             role="button"
             tabindex="0"
             onclick="openTask('${task.id}')"
             onkeydown="if(event.target===this &&
               (event.key==='Enter'||event.key===' ')){
                 event.preventDefault();
                 openTask('${task.id}');
               }">

      <div class="between">
        <span class="task-id">${task.id}</span>
        <span class="dot ${status.color}"></span>
      </div>

      <div class="task-title">
        ${escapeHTML(task.title)}
      </div>

      <div class="task-meta">
        ${task.status === "done"
          ? "九步流程已结束"
          : `第 ${task.step} 步 · ${
              WORKFLOW[task.step - 1].name
            }`}
      </div>

      ${development}

      ${task.status === "decision"
        ? `<div style="margin-top:10px">
             <span class="pill amber">需要确认</span>
           </div>`
        : ""}

      ${task.status === "review"
        ? `<div style="margin-top:10px">
             <span class="pill purple">
               评审 ${task.score ?? "未评分"}
             </span>
           </div>`
        : ""}

      <div class="task-footer row">
        ${avatar(task.agent)}
        <div class="task-meta">
          ${escapeHTML(agent.name)}
        </div>
      </div>

    </article>
  `;
}

function renderBoard() {
  const w = getWorkspace();
  const list = tasks.filter(t => t.workspace === w.id);

  const filtered = list.filter(t =>
    state.boardFilter === "all" ||
    (state.boardFilter === "mine" &&
      ["decision","review"].includes(t.status) &&
      !t.error)
  );

  const normal = filtered.filter(t => !t.error);
  const errors = list.filter(t => t.error);

  return `
    <div class="page">

      <div class="breadcrumb">
        工作区 ${icon("chevron")}
        ${escapeHTML(w.name)}
      </div>

      <div class="page-heading">
        <div>
          <div class="row">
            <span class="workspace-symbol ${w.theme}"
                  style="width:34px;height:34px;font-size:16px">
              ${escapeHTML(w.symbol)}
            </span>
            <h1>${escapeHTML(w.name)}</h1>
          </div>

          <p class="description">
            ${escapeHTML(w.type)} · 需求管理
          </p>
        </div>

        <button class="primary" onclick="focusComposer()">
          ${icon("plus")} 新需求
        </button>
      </div>

      <div class="row muted"
           style="font-size:12px;margin-bottom:20px;overflow-wrap:anywhere">
        ${icon("folder")}
        ${escapeHTML(w.path || "尚未配置文件夹")}
      </div>

      ${renderStats(list)}

      <div class="board-toolbar">
        <div class="row">
          <h2>需求看板</h2>
          <span class="small muted">示意数据</span>
        </div>

        <div class="segmented">
          <button
            class="${state.boardFilter === "all" ? "active" : ""}"
            onclick="setFilter('all')">
            全部
          </button>
          <button
            class="${state.boardFilter === "mine" ? "active" : ""}"
            onclick="setFilter('mine')">
            待我处理
          </button>
        </div>
      </div>

      ${list.length === 0
        ? `
          <div class="empty-state">
            <div class="empty-symbol">${icon("inbox")}</div>
            <h2>这个工作区还没有需求</h2>
            <p class="description">
              从右侧发起一个需求，开始你的第一项工作。<br>
              后续开发、评审和交付都将在这里展示。
            </p>
            <button class="primary" onclick="focusComposer()">
              ${icon("plus")} 发起第一个需求
            </button>
          </div>
        `
        : `
          <div class="board-scroll">
            <div class="board">
              ${STATUSES.map(s => {
                const cards = normal.filter(t => t.status === s.id);

                return `
                  <section class="column">
                    <div class="column-head">
                      <div class="row">
                        <span class="dot ${s.color}"></span>
                        ${s.label}
                      </div>
                      <span class="column-count">
                        ${cards.length}
                      </span>
                    </div>
                    <div class="column-cards">
                      ${cards.length
                        ? cards.map(renderTaskCard).join("")
                        : `<div class="empty-column">暂无需求</div>`}
                    </div>
                  </section>
                `;
              }).join("")}
            </div>
          </div>
        `
      }

      ${errors.length
        ? `
          <section class="exception-region">

            <div class="exception-header between">
              <div class="row">
                ${icon("alert")}
                <strong>异常与暂停</strong>
                <span class="pill red">${errors.length}</span>
              </div>
              <span class="small muted">独立于主流程状态</span>
            </div>

            ${errors.map(t => `
              <div class="exception-item"
                   role="button"
                   tabindex="0"
                   onclick="openTask('${t.id}')"
                   onkeydown="if(event.key==='Enter')
                     openTask('${t.id}')">
                <div class="between">
                  <strong>${escapeHTML(t.title)}</strong>
                  <span class="pill red">执行失败</span>
                </div>
                <p class="description" style="margin:8px 0">
                  ${escapeHTML(t.error)}
                </p>
                <div class="between">
                  <span class="small muted">
                    ${t.id} · 原状态：${getStatus(t.status).label}
                  </span>
                  <span class="small">查看异常 ${icon("arrow")}</span>
                </div>
              </div>
            `).join("")}

          </section>
        ` : ""
      }

      <p class="small muted" style="margin-top:18px;line-height:1.7">
        卡片进度仅代表已完成的开发子任务数量，
        不代表九步工作流的整体完成百分比。
      </p>

    </div>
  `;
}

/* ==================================================
   14. 需求详情
   流程进度、开发进度、测试进度独立计算
   ================================================== */

function selectStep(index) {
  state.selectedStep = index;
  renderMain(false);
}

function renderFlow(task) {
  const selected = state.selectedStep ?? task.step - 1;
  const step = WORKFLOW[selected];

  const labels = {
    done: "已完成",
    current: "执行中",
    waiting: "等待确认",
    pending: "未开始",
    failed: "执行异常"
  };

  const selectedState = task.stepStates[selected];

  return `
    <section class="flow-section card">
      <div class="between">
        <h2>九步工作流</h2>
        <span class="small muted">点击节点查看产物</span>
      </div>

      <div class="flow-scroll">
        <div class="flow-track">
          ${WORKFLOW.map((s,i) => `
            <button
              class="flow-node ${task.stepStates[i]}
                     ${selected === i ? "selected" : ""}"
              onclick="selectStep(${i})">
              <span class="step-circle">
                ${task.stepStates[i] === "done"
                  ? icon("check")
                  : String(i + 1).padStart(2,"0")}
              </span>
              <span class="flow-label">${s.name}</span>
              <span class="small muted">
                ${labels[task.stepStates[i]]}
              </span>
            </button>
          `).join("")}
        </div>
      </div>

      <div class="step-detail">
        <div class="between">
          <strong>
            ${String(selected + 1).padStart(2,"0")}
            · ${step.name}
          </strong>
          <span class="pill ${
            selectedState === "done" ? "green" :
            selectedState === "failed" ? "red" :
            selectedState === "waiting" ? "amber" : ""
          }">${labels[selectedState]}</span>
        </div>

        <p class="description">${step.description}</p>

        <div class="between">
          <span class="small muted">
            负责人：${step.owner}
          </span>
          ${selectedState === "done"
            ? `
              <button onclick="openArtifact('${task.id}',${selected})">
                ${icon("file")} 查看产物
              </button>
            `
            : `<span class="small muted">
                 产物尚未正式归档
               </span>`}
        </div>
      </div>
    </section>
  `;
}

function renderDetail() {
  const task = getTask(state.taskId);
  if (!task) return renderBoard();

  const w = getWorkspace(task.workspace);
  const s = getStatus(task.status);
  const doneSteps = task.stepStates.filter(x => x === "done").length;
  const relatedDecision = decisions.find(d =>
    d.taskId === task.id && !d.resolved);

  return `
    <div class="page">

      <div class="breadcrumb">
        <button class="ghost"
                style="padding:0;height:25px;font-size:12px"
                onclick="backToBoard()">
          ${icon("back")} 返回看板
        </button>
        ${icon("chevron")}
        ${escapeHTML(w.name)}
        ${icon("chevron")}
        ${task.id}
      </div>

      <div class="page-heading">
        <div>
          <div class="row" style="margin-bottom:10px">
            <span class="pill">${task.id}</span>
            <span class="pill ${s.color}">${s.label}</span>
            ${task.error
              ? `<span class="pill red">执行异常</span>`
              : ""}
          </div>

          <h1>${escapeHTML(task.title)}</h1>
          <p class="description">需求详情 · 示意数据</p>
        </div>

        ${relatedDecision
          ? `<button class="primary"
                     onclick="openDecision('${relatedDecision.id}')">
               处理决策
             </button>`
          : ""}
      </div>

      ${task.error
        ? `
          <div class="detail-alert">
            <div class="between">
              <strong class="row">
                ${icon("alert")} 执行已暂停
              </strong>
              <button onclick="openRetry('${task.id}')">
                处理异常
              </button>
            </div>
            <p style="margin-top:9px">
              ${escapeHTML(task.error)}
            </p>
            <p class="small" style="margin-top:5px">
              原主状态保留为「${s.label}」，
              当前不计入正常执行任务。
            </p>
          </div>
        ` : ""
      }

      <div class="detail-summary card">
        <h3>需求目标</h3>
        <p class="description">${escapeHTML(task.summary)}</p>

        <div class="row"
             style="margin-top:14px;flex-wrap:wrap;gap:18px">
          <div class="row">
            ${avatar(task.agent)}
            <div>
              <div>${getAgent(task.agent).name}</div>
              <div class="small muted" style="margin-top:3px">
                当前负责人
              </div>
            </div>
          </div>
          <div>
            <div>目标评分 ${task.targetScore.toFixed(1)} / 10</div>
            <div class="small muted" style="margin-top:3px">
              ${task.score !== null
                ? `当前评审分数 ${task.score.toFixed(1)}`
                : "尚未独立评审"}
            </div>
          </div>
        </div>
      </div>

      <div class="detail-grid">

        <div class="metric-card card">
          <div class="between">
            <h3>流程进度</h3>
            <span class="pill ${s.color}">${s.label}</span>
          </div>

          <div class="metric-number">
            ${task.status === "done"
              ? "流程已结束"
              : `第 ${task.step} / 9 步`}
          </div>

          <strong>
            ${WORKFLOW[task.step - 1].name}
          </strong>

          <p class="description">
            已结束 ${doneSteps} 个流程节点。
            此处不换算为百分比。
          </p>
        </div>

        <div class="metric-card card">
          <div class="between">
            <h3>开发进度</h3>
            <span class="small muted">按子任务统计</span>
          </div>

          <div class="metric-number">
            ${task.total
              ? `${percentage(task)}%`
              : "尚未拆解"}
          </div>

          ${task.total
            ? `
              <div class="progress">
                <span style="width:${percentage(task)}%"></span>
              </div>
              <p class="description">
                开发完成 ${task.completed}/${task.total}
                · 自测通过 ${task.tested}/${task.total}
              </p>
            `
            : `<p class="description">
                 确认需求并生成开发任务书后开始统计。
               </p>`}
        </div>

      </div>

      ${renderFlow(task)}

      <section class="content-section">
        <div class="between" style="margin-bottom:12px">
          <h2>开发子任务</h2>
          <span class="small muted">
            ${task.completed}/${task.total} 完成
          </span>
        </div>

        <div class="subtask-list card">
          ${task.subtasks.length
            ? task.subtasks.map(st => `
              <div class="subtask">
                <div class="row">
                  ${st.status === "done"
                    ? `<span style="color:var(--green)">
                         ${icon("check")}
                       </span>`
                    : `<span class="dot ${
                        st.status === "running"
                        ? "blue" : ""
                      }"></span>`}
                  <div>
                    <div class="subtask-name">
                      ${escapeHTML(st.name)}
                    </div>
                    <div class="small muted" style="margin-top:4px">
                      ${getAgent(task.agent).name}
                    </div>
                  </div>
                </div>

                <div class="row">
                  <span class="pill ${
                    st.status === "done" ? "green" :
                    st.status === "running" ? "blue" : ""
                  }">
                    ${st.status === "done"
                      ? "开发完成"
                      : st.status === "running"
                        ? "开发中" : "未开始"}
                  </span>

                  <span class="pill ${st.tested ? "green" : ""}">
                    ${st.tested ? "自测通过" : "未验证"}
                  </span>
                </div>
              </div>
            `).join("")
            : `
              <div style="padding:28px;text-align:center"
                   class="muted">
                尚未生成开发任务书，没有可统计的开发子任务。
              </div>
            `}
        </div>
      </section>

      <section class="content-section">
        <div class="between" style="margin-bottom:12px">
          <h2>交付物与过程文件</h2>
          <span class="small muted">${doneSteps} 份示意文件</span>
        </div>

        <div class="card" style="overflow:hidden">
          ${WORKFLOW.map((step,i) =>
            task.stepStates[i] === "done"
              ? `
                <div class="artifact"
                     role="button"
                     tabindex="0"
                     onclick="openArtifact('${task.id}',${i})"
                     onkeydown="if(event.key==='Enter')
                       openArtifact('${task.id}',${i})">

                  <div class="file-icon">${icon("file")}</div>

                  <div class="file-meta">
                    <strong>${step.output}</strong>
                    <p class="small muted">
                      第 ${i + 1} 步 · ${step.owner} · 示例文档
                    </p>
                  </div>

                  <span class="pill green">已归档</span>
                  ${icon("chevron")}
                </div>
              ` : ""
          ).join("") || `
            <div style="padding:24px;text-align:center"
                 class="muted">
              尚无已归档的交付物。
            </div>
          `}
        </div>
      </section>

      ${task.history.length
        ? `
          <section class="content-section">
            <h2>决策记录</h2>
            <div class="card">
              ${task.history.map(h => `
                <div class="subtask">
                  <div>
                    <strong>${escapeHTML(h.action)}</strong>
                    <p class="description" style="margin-top:5px">
                      ${escapeHTML(h.note)}
                    </p>
                  </div>
                  <span class="small muted">${h.time}</span>
                </div>
              `).join("")}
            </div>
          </section>
        ` : ""}

    </div>
  `;
}

/* ==================================================
   15. 全局工作概览
   ================================================== */

function renderOverview() {
  const list = tasks;
  const pending = pendingDecisions();

  return `
    <div class="page">

      <div class="breadcrumb">Office ${icon("chevron")} 工作概览</div>

      <div class="page-heading">
        <div>
          <h1>工作概览</h1>
          <p class="description">
            查看所有工作区的工作进展与待处理事项。
          </p>
        </div>
        <span class="pill amber">示意数据</span>
      </div>

      ${renderStats(list)}

      <section class="content-section">
        <h2>需要你关注</h2>
        <div class="stack">

          ${pending.map(d => {
            const t = getTask(d.taskId);
            return `
              <div class="card" style="padding:16px">
                <div class="between">
                  <div>
                    <div class="row">
                      <span class="pill amber">${d.type}</span>
                      <span class="small muted">
                        ${escapeHTML(getWorkspace(t.workspace).name)}
                      </span>
                    </div>
                    <h3 style="margin:10px 0 6px">
                      ${escapeHTML(d.title)}
                    </h3>
                    <p class="description">
                      ${escapeHTML}(d.summary)}
                    </p>
                  </div>

                  <button onclick="openDecision('${d.id}')">
                    处理 ${icon("arrow")}
                  </button>
                </div>
              </div>
            `;
          }).join("") || `
            <div class="card" style="padding:22px">
              当前没有需要你确认的事项。
            </div>
          `}

          ${tasks.filter(t => t.error).map(t => `
            <div class="card" style="padding:16px">
              <div class="between">
                <div>
                  <span class="pill red">执行异常</span>
                  <h3 style="margin:10px 0">
                    ${escapeHTML(t.title)}
                  </h3>
                  <p class="description">
                    ${escapeHTML(t.error)}
                  </p>
                </div>
                <button onclick="openTask('${t.id}')">查看</button>
              </div>
            </div>
          `).join("")}

        </div>
      </section>

      <section class="content-section">
        <h2>工作区</h2>
        <div class="stack">

          ${workspaces.map(w => {
            const list = tasks.filter(t => t.workspace === w.id);
            const done = list.filter(t => t.status === "done").length;
            const running = list.filter(t =>
              t.status === "running" && !t.error).length;

            return `
              <div class="card" style="padding:18px">
                <div class="between">
                  <div class="row">
                    <span class="workspace-symbol ${w.theme}">
                      ${escapeHTML(w.symbol)}
                    </span>
                    <div>
                      <h3>${escapeHTML(w.name)}</h3>
                      <p class="small muted" style="margin-top:5px">
                        ${escapeHTML(w.type)}
                      </p>
                    </div>
                  </div>
                  <button onclick="switchWorkspace('${w.id}')">
                    打开工作区 ${icon("arrow")}
                  </button>
                </div>

                <div class="row muted"
                     style="margin-top:16px;gap:20px;font-size:12px">
                  <span>${list.length} 个需求</span>
                  <span>${running} 个进行中</span>
                  <span>${done} 个已完成</span>
                </div>
              </div>
            `;
          }).join("")}

        </div>
      </section>

    </div>
  `;
}

/* ==================================================
   16. 运行观测
   Agent 转盘只负责观测，不替代需求管理
   ================================================== */

let selectedAgent = "hermes";

function selectAgent(id) {
  selectedAgent = id;
  renderMain(false);
}

function renderObservation() {
  const agent = getAgent(selectedAgent);

  const positions = [
    {left:50,top:14},
    {left:84,top:50},
    {left:50,top:86},
    {left:16,top:50}
  ];

  return `
    <div class="page">

      <div class="breadcrumb">
        Office ${icon("chevron")} 运行观测
      </div>

      <div class="page-heading">
        <div>
          <h1>运行观测</h1>
          <p class="description">
            查看 Agent 的连接状态、执行职责和当前工作。
          </p>
        </div>
        <span class="pill amber">模拟状态</span>
      </div>

      <div class="stat-grid" style="margin-bottom:18px">
        <div class="stat card">
          <div class="stat-label">Agent 总数</div>
          <div class="stat-value">4</div>
          <div class="stat-note">示意执行器</div>
        </div>
        <div class="stat card">
          <div class="stat-label row">
            <span class="dot green"></span>运行中
          </div>
          <div class="stat-value">2</div>
          <div class="stat-note">Hermes · Claude</div>
        </div>
        <div class="stat card">
          <div class="stat-label">待命</div>
          <div class="stat-value">1</div>
          <div class="stat-note">Codex</div>
        </div>
        <div class="stat card">
          <div class="stat-label row">
            <span class="dot red"></span>连接异常
          </div>
          <div class="stat-value" style="color:var(--red)">1</div>
          <div class="stat-note">DSH</div>
        </div>
      </div>

      <div class="observation-layout">

        <section class="radar-card card">
          <div class="between">
            <h2>Agent 协作转盘</h2>
            <span class="small muted">点击 Agent 查看详情</span>
          </div>

          <div class="radar">

            <svg viewBox="0 0 560 415"
                 preserveAspectRatio="none"
                 aria-hidden="true">
              <ellipse cx="280" cy="207.5" rx="190" ry="151"
                       fill="#fbfbfb"
                       stroke="#e3e3e3"
                       stroke-dasharray="5 5"/>
              <ellipse cx="280" cy="207.5" rx="115" ry="92"
                       fill="none"
                       stroke="#ededed"/>
              <path d="M280 57V357M90 207.5H470"
                    stroke="#d2d2d2"
                    stroke-width="1"
                    stroke-dasharray="4 5"/>
              <ellipse cx="280" cy="207.5" rx="155" ry="124"
                       fill="none"
                       stroke="#f1f1f1"/>
            </svg>

            <div class="radar-core">
              ${icon("layers")}
              Office
              <small>统一编排</small>
            </div>

            ${AGENTS.map((a,i) => `
              <button class="orbit-agent ${
                selectedAgent === a.id ? "active-agent" : ""
              }"
                      style="left:${positions[i].left}%;
                             top:${positions[i].top}%"
                      onclick="selectAgent('${a.id}')">
                ${avatar(a.id)}
                <strong>${a.name}</strong>
                <span class="row small muted">
                  <span class="dot ${a.color}"></span>
                  ${a.status}
                </span>
              </button>
            `).join("")}

          </div>

          <div class="card" style="padding:18px">
            <div class="between">
              <div class="row">
                ${avatar(agent.id)}
                <div>
                  <h3>${agent.name}</h3>
                  <p class="small muted" style="margin-top:4px">
                    ${agent.role}
                  </p>
                </div>
              </div>
              <span class="pill ${
                agent.color === "red" ? "red" :
                agent.color === "green" ? "green" : ""
              }">
                <span class="dot ${agent.color}"></span>
                ${agent.status}
              </span>
            </div>

            <p class="description" style="margin-top:14px">
              当前工作：${agent.task}
            </p>
            <p class="small muted" style="margin-top:6px">
              执行方式：${agent.engine}
            </p>
          </div>
        </section>

        <section>
          <h2 style="margin-bottom:12px">执行器列表</h2>

          <div class="agent-grid">
            ${AGENTS.map(a => `
              <div class="agent-info card"
                   role="button"
                   tabindex="0"
                   onclick="selectAgent('${a.id}')"
                   onkeydown="if(event.key==='Enter')
                     selectAgent('${a.id}')">

                <div class="between">
                  <div class="row">
                    ${avatar(a.id)}
                    <strong>${a.name}</strong>
                  </div>
                  <span class="dot ${a.color}"></span>
                </div>

                <p class="description">${a.role}</p>
                <p class="small muted">${a.task}</p>

              </div>
            `).join("")}
          </div>
        </section>

      </div>

      <p class="description" style="margin-top:20px">
        此页面仅展示模拟的 Agent 运行状态，
        不调用 CLI、不读取本机进程，也不执行任何真实任务。
      </p>

    </div>
  `;
}

/* ==================================================
   17. 右栏渲染
   发起需求跟随工作区，待办和动态保持全局
   ================================================== */

function renderInspector() {
  const w = getWorkspace();

  document.getElementById("composerWorkspace").textContent =
    w.name;

  document.getElementById("composerDestination").textContent =
    `归属：${w.name} · ${w.type}`;

  const list = pendingDecisions();

  document.getElementById("decisionCount").textContent =
    list.length;

  document.getElementById("decisionList").innerHTML =
    list.length ? list.map(d => {
      const t = getTask(d.taskId);
      const w = getWorkspace(t.workspace);

      return `
        <button class="decision-card"
                onclick="openDecision('${d.id}')">

          <div class="between">
            <span class="pill ${
              d.type === "成果验收" ? "purple" : "amber"
            }">${escapeHTML(d.type)}</span>
            <span class="small muted">${escapeHTML(w.name)}</span>
          </div>

          <h3>${escapeHTML(d.title)}</h3>
          <p>${escapeHTML(d.summary)}</p>

          <div class="between" style="margin-top:12px">
            <span class="small muted">${t.id}</span>
            <span style="font-size:12px">
              查看决策 ${icon("arrow")}
            </span>
          </div>
        </button>
      `;
    }).join("") : `
      <div style="padding:22px 5px;text-align:center">
        <span style="color:var(--green)">${icon("check")}</span>
        <p class="description" style="margin-top:9px">
          当前没有待处理事项
        </p>
      </div>
    `;

  document.getElementById("activityList").innerHTML =
    activities.slice(0,7).map(a => `
      <div class="activity">
        ${avatar(a.agent)}
        <div class="activity-body">
          <strong>${getAgent(a.agent).name}</strong>
          <div>${escapeHTML(a.text)}</div>
          <div class="activity-time">
            ${escapeHTML(getWorkspace(a.workspace)?.name || "Office")}
            · ${escapeHTML(a.time)}
          </div>
        </div>
      </div>
    `).join("");
}

/* ==================================================
   18. 发起需求
   实际新增前端任务，不伪造真实 Agent 执行
   ================================================== */

function submitRequirement() {
  const input = document.getElementById("requirementInput");
  const text = input.value.trim();

  if (!text) {
    showToast("请先描述你想完成的需求。");
    input.focus();
    return;
  }

  const w = getWorkspace();
  const prefix = w.id === "ease" ? "ED" :
                 w.id === "office" ? "AO" :
                 w.id === "visual" ? "VD" : "WS";

  const id = prefix + "-" + Date.now().toString(36).toUpperCase();
  const title = text.length > 30 ? text.slice(0,30) + "…" : text;

  const task = buildTask(
    id, w.id, title,
    "todo", 1, "hermes",
    0, 0, 0, text
  );

  tasks.unshift(task);

  addActivity(
    "hermes",
    "已登记新需求（前端演示）",
    w.id
  );

  input.value = "";
  state.drafts[w.id] = "";

  state.view = "board";
  state.boardFilter = "all";

  renderAll();
  showToast(`需求已添加至 ${w.name} · 待开始`);
}

/* ==================================================
   19. 浏览器语音输入
   依赖浏览器支持与麦克风授权
   ================================================== */

let recognition = null;

function startVoice() {
  const SpeechRecognition =
    window.SpeechRecognition ||
    window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    showToast("当前浏览器不支持语音识别，请使用文字输入。");
    return;
  }

  if (recognition) {
    recognition.stop();
    return;
  }

  const targetWorkspace = state.workspaceId;

  recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = false;
  recognition.continuous = false;

  recognition.onstart = () => {
    document.getElementById("voiceButton").style.color = "var(--red)";
    showToast("正在聆听，请说出你的需求。");
  };

  recognition.onresult = event => {
    const transcript = event.results[0][0].transcript;

    if (state.workspaceId === targetWorkspace) {
      const input = document.getElementById("requirementInput");
      input.value += (input.value ? "\n" : "") + transcript;
    } else {
      state.drafts[targetWorkspace] =
        (state.drafts[targetWorkspace] || "") + "\n" + transcript;
    }
  };

  recognition.onerror = () => {
    showToast("语音识别不可用，请检查麦克风权限或使用文字输入。");
  };

  recognition.onend = () => {
    document.getElementById("voiceButton").style.color = "";
    recognition = null;
  };

  try {
    recognition.start();
  } catch (error) {
    recognition = null;
    showToast("无法启动语音识别。");
  }
}

/* ==================================================
   20. 弹窗基础能力
   ================================================== */

let previousFocus = null;

function showModal(html) {
  const overlay = document.getElementById("overlay");

  if (!overlay.classList.contains("open")) {
    previousFocus = document.activeElement;
  }

  document.getElementById("modal").innerHTML = html;
  overlay.classList.add("open");

  requestAnimationFrame(() => {
    const first = document.querySelector(
      "#modal input, #modal textarea, #modal button"
    );
    first?.focus();
  });
}

function closeModal() {
  document.getElementById("overlay").classList.remove("open");
  state.decisionId = null;
  previousFocus?.focus();
}

document.addEventListener("keydown", event => {
  const overlay = document.getElementById("overlay");

  if (!overlay.classList.contains("open")) return;

  if (event.key === "Escape") {
    closeModal();
  }

  if (event.key === "Tab") {
    const elements = Array.from(
      document.querySelectorAll(
        "#modal button, #modal input, #modal textarea, #modal [tabindex='0']"
      )
    ).filter(el => !el.disabled);

    if (!elements.length) return;

    const first = elements[0];
    const last = elements[elements.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

/* ==================================================
   21. 决策弹窗
   A/B 方案 + 推荐理由 + 四种操作
   ================================================== */

function openDecision(id) {
  const d = decisions.find(d => d.id === id && !d.resolved);

  if (!d) {
    showToast("该事项已经处理。");
    return;
  }

  state.decisionId = id;
  state.selectedOption = d.recommended;

  renderDecisionModal();
}

function chooseOption(id) {
  state.selectedOption = id;

  document.querySelectorAll(".option-card").forEach(el => {
    const selected = el.dataset.option === id;
    el.classList.toggle("selected",selected);
    el.setAttribute("aria-checked",String(selected));
  });
}

function renderDecisionModal() {
  const d = decisions.find(d => d.id === state.decisionId);
  if (!d) return;

  const t = getTask(d.taskId);
  const w = getWorkspace(t.workspace);

  showModal(`
    <div class="modal-header">
      <div class="between">
        <div class="row">
          <span class="pill amber">${escapeHTML(d.type)}</span>
          <span class="small muted">需要你的决定</span>
        </div>
        <button class="ghost"
                aria-label="关闭"
                onclick="closeModal()">
          ${icon("close")}
        </button>
      </div>

      <h2 id="modalTitle">${escapeHTML(d.title)}</h2>

      <p class="description">
        ${escapeHTML(w.name)} / ${t.id}
        · ${escapeHTML(t.title)}
      </p>
    </div>

    <div class="modal-body">

      <h3>${escapeHTML(d.question)}</h3>

      <div role="radiogroup" aria-label="决策方案">

        ${d.options.map(o => `
          <div class="option-card ${
            state.selectedOption === o.id ? "selected" : ""
          }"
               data-option="${o.id}"
               role="radio"
               aria-checked="${state.selectedOption === o.id}"
               tabindex="0"
               onclick="chooseOption('${o.id}')"
               onkeydown="if(event.key==='Enter'||event.key===' '){
                 event.preventDefault();
                 chooseOption('${o.id}');
               }">

            <div class="option-radio"></div>

            <div class="option-content">
              <div class="between">
                <strong>方案 ${o.id} · ${escapeHTML(o.title)}</strong>

                ${o.id === d.recommended
                  ? `<span class="pill green">推荐</span>` : ""}
              </div>

              <p class="description">
                ${escapeHTML(o.description)}
              </p>

              <p class="small muted">
                ${escapeHTML(o.impact)}
              </p>
            </div>

          </div>
        `).join("")}

      </div>

      <div class="recommendation">
        <div class="row">
          ${icon("sparkle")}
          <strong>Hermes 推荐方案 ${d.recommended}</strong>
        </div>
        <p class="description" style="margin-top:8px">
          ${escapeHTML(d.reason)}
        </p>
      </div>

      <div style="margin-top:20px">
        <label for="decisionNote">
          <strong>补充说明（可选）</strong>
        </label>
        <textarea id="decisionNote"
                  style="min-height:72px;margin-top:9px"
                  placeholder="补充约束、修改意见或需要进一步确认的问题…"></textarea>
      </div>

      <p class="small muted" style="margin-top:14px">
        此处为决策交互演示，操作仅改变前端模拟状态。
      </p>

    </div>

    <div class="modal-footer">
      <button onclick="handleDecision('later')">稍后处理</button>
      <button onclick="handleDecision('more')">补充信息</button>
      <button class="danger"
              onclick="handleDecision('reject')">
        驳回重做
      </button>
      <button class="primary"
              onclick="handleDecision('approve')">
        确认所选方案
      </button>
    </div>
  `);
}

function handleDecision(action) {
  const d = decisions.find(d => d.id === state.decisionId);
  if (!d) return;

  const task = getTask(d.taskId);
  const note = document.getElementById("decisionNote").value.trim();
  const selected = d.options.find(o => o.id === state.selectedOption);

  if (action === "later") {
    closeModal();
    showToast("已保留该待办，稍后可以继续处理。");
    return;
  }

  if (["reject","more"].includes(action) && !note) {
    document.getElementById("decisionNote").focus();
    showToast(action === "reject"
      ? "请填写驳回原因，方便后续整改。"
      : "请填写需要补充的信息。");
    return;
  }

  if (action === "approve") {

    d.resolved = true;

    if (d.type === "成果验收") {
      if (selected.id === "A") {
        task.status = "done";
        task.step = 9;
        task.stepStates = WORKFLOW.map(() => "done");
        task.completed = task.total;
        task.tested = task.total;
      } else {
        task.status = "running";
        task.step = 7;
        task.stepStates = WORKFLOW.map((_,i) =>
          i < 6 ? "done" : i === 6 ? "current" : "pending"
        );
        task.agent = "claude";
      }
    } else {
      task.status = "running";
      task.step = 4;
      task.agent = "hermes";
      task.stepStates = WORKFLOW.map((_,i) =>
        i < 3 ? "done" : i === 3 ? "current" : "pending"
      );
    }

    task.history.unshift({
      action: `确认方案 ${selected.id}`,
      note: selected.title + (note ? "；" + note : ""),
      time: "刚刚"
    });

    addActivity(
      "hermes",
      `已记录决策：${selected.title}`,
      task.workspace
    );

    showToast("决策已确认，模拟工作流状态已更新。");

  } else if (action === "reject") {

    d.resolved = true;

    task.status = "running";
    task.step = d.type === "成果验收" ? 7 : 2;
    task.agent = d.type === "成果验收" ? "claude" : "hermes";

    task.stepStates = WORKFLOW.map((_,i) =>
      i < task.step - 1 ? "done" :
      i === task.step - 1 ? "current" : "pending"
    );

    task.history.unshift({
      action: "驳回重做",
      note,
      time: "刚刚"
    });

    addActivity(
      "hermes",
      `收到整改意见：${note}`,
      task.workspace
    );

    showToast("已记录整改意见，模拟流程已回退。");

  } else if (action === "more") {

    task.history.unshift({
      action: "请求补充信息",
      note,
      time: "刚刚"
 
   });

    d.summary = "已请求补充信息，当前待办仍保留。";

    addActivity(
      "hermes",
      `需要补充信息：${note}`,
      task.workspace
    );

    showToast("补充信息请求已记录，暂不推进流程。");
  }

  if (state.taskId === task.id) {
    state.selectedStep = task.step - 1;
  }

  closeModal();
  renderAll();
}

/* ==================================================
   22. 新建工作区
   ================================================== */

function openNewWorkspace() {
  showModal(`
    <div class="modal-header">
      <div class="between">
        <h2 id="modalTitle">新建工作区</h2>
        <button class="ghost" onclick="closeModal()">
          ${icon("close")}
        </button>
      </div>
      <p class="description">
        工作区用于组织项目、工作流和需求记录。
      </p>
    </div>

    <div class="modal-body stack">

      <div>
        <label for="workspaceName"><strong>工作区名称</strong></label>
        <input id="workspaceName"
               maxlength="40"
               style="margin-top:8px"
               placeholder="例如：个人网站">
      </div>

      <div>
        <label for="workspacePath"><strong>项目文件夹路径</strong></label>
        <input id="workspacePath"
               style="margin-top:8px"
               placeholder="D:/Projects/MyProject">
      </div>

      <div>
        <strong>工作流模板</strong>
        <div class="card" style="padding:15px;margin-top:8px">
          <div class="row">
            ${icon("code")}
            <strong>Coding 九步工作流</strong>
          </div>
          <p class="description" style="margin-top:8px">
            需求澄清、讨论确认、开发、自测、评审与交付。
          </p>
        </div>
      </div>

      <p class="small muted">
        原型仅记录路径字符串，不创建或读取本地文件夹。
      </p>

    </div>

    <div class="modal-footer">
      <button onclick="closeModal()">取消</button>
      <button class="primary" onclick="createWorkspace()">创建工作区</button>
    </div>
  `);
}

function createWorkspace() {
  const name = document.getElementById("workspaceName").value.trim();
  const path = document.getElementById("workspacePath").value.trim();

  if (!name) {
    showToast("请输入工作区名称。");
    document.getElementById("workspaceName").focus();
    return;
  }

  if (workspaces.some(w =>
    w.name.toLowerCase() === name.toLowerCase())) {
    showToast("已经存在同名工作区。");
    return;
  }

  const id = "workspace-" + Date.now();

  workspaces.push({
    id,
    name,
    path,
    symbol: name.slice(0,1).toUpperCase(),
    theme: "custom",
    type: "Coding 工作流"
  });

  closeModal();
  switchWorkspace(id);
  showToast("工作区已创建，可以发起第一个需求。");
}

/* ==================================================
   23. 产物预览
   提供可阅读的示例文档，而不是伪造文件路径
   ================================================== */

function openArtifact(taskId,index) {
  const task = getTask(taskId);
  const step = WORKFLOW[index];

  if (!task || !step) return;

  const content =
`# ${step.output.replace(".md","")}

【示意文档 · 非实际 Agent 交付物】

需求编号：${task.id}
所属工作区：${getWorkspace(task.workspace).name}
需求名称：${task.title}
工作流节点：${index + 1} · ${step.name}
负责人：${step.owner}

## 需求目标

${task.summary}

## 当前节点职责

${step.description}

## 执行记录

本文件用于展示 Agent Office 的过程文件归档方式。
实际系统接入后，应由对应执行器提交真实文件内容、
生成时间、版本号、执行日志及验收证据。

## 关联信息

开发子任务：${task.completed}/${task.total}
自测通过：${task.tested}/${task.total}
目标分数：${task.targetScore.toFixed(1)}
独立评审：${task.score ?? "尚未评分"}
`;

  showModal(`
    <div class="modal-header">
      <div class="between">
        <div class="row">
          ${icon("file")}
          <span class="pill">示例文档</span>
        </div>
        <button class="ghost" onclick="closeModal()">
          ${icon("close")}
        </button>
      </div>
      <h2 id="modalTitle">${step.output}</h2>
      <p class="description">${task.id} · ${step.name}</p>
    </div>

    <div class="modal-body">
      <pre>${escapeHTML(content)}</pre>
    </div>

    <div class="modal-footer">
      <button onclick="closeModal()">关闭</button>
      <button class="primary"
              onclick="downloadArtifact('${taskId}',${index})">
        下载示例文档
      </button>
    </div>
  `);

  window.currentArtifactContent = content;
}

function downloadArtifact(taskId,index) {
  const content = window.currentArtifactContent || "";
  const blob = new Blob([content], {
    type:"text/markdown;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = taskId + "-" + WORKFLOW[index].output;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url),1000);
  showToast("已发起示例文档下载。");
}

/* ==================================================
   24. 异常处理
   重试、改派、保留暂停，均为前端模拟
   ================================================== */

function openRetry(id) {
  const task = getTask(id);

  showModal(`
    <div class="modal-header">
      <div class="between">
        <span class="pill red">执行异常</span>
        <button class="ghost" onclick="closeModal()">
          ${icon("close")}
        </button>
      </div>
      <h2 id="modalTitle">${escapeHTML(task.title)}</h2>
      <p class="description">${task.id} · ${getAgent(task.agent).name}</p>
    </div>

    <div class="modal-body">
      <div class="detail-alert">
        ${escapeHTML(task.error)}
      </div>

      <h3>可采取的处理方式</h3>

      <div class="card" style="padding:15px;margin-top:12px">
        <strong>重新尝试</strong>
        <p class="description" style="margin-top:7px">
          模拟恢复原执行器上的当前步骤，
          不重置已经完成的子任务。
        </p>
      </div>

      <div class="card" style="padding:15px;margin-top:12px">
        <strong>改派 Claude Code</strong>
        <p class="description" style="margin-top:7px">
          保留已完成成果与任务记录，模拟将剩余工作交给 Claude Code。
        </p>
      </div>

      <p class="small muted" style="margin-top:15px">
        操作仅用于验证异常恢复交互，不会启动真实执行器。
      </p>
    </div>

    <div class="modal-footer">
      <button onclick="closeModal()">保持暂停</button>
      <button onclick="retryTask('${id}',false)">模拟重试</button>
      <button class="primary"
              onclick="retryTask('${id}',true)">
        模拟改派
      </button>
    </div>
  `);
}

function retryTask(id,reassign) {
  const task = getTask(id);
  if (!task) return;

  const oldError = task.error;

  task.error = null;
  task.status = "running";
  task.stepStates[task.step - 1] = "current";

  if (reassign) {
    task.agent = "claude";
  }

  const next = task.subtasks.find(s => s.status !== "done");
  if (next) next.status = "running";

  task.history.unshift({
    action: reassign ? "模拟改派" : "模拟重试",
    note: `原异常：${oldError}`,
    time: "刚刚"
  });

  addActivity(
    "hermes",
    reassign
      ? "已模拟改派任务给 Claude Code"
      : "已模拟恢复暂停任务",
    task.workspace
  );

  closeModal();
  renderAll();
  showToast("异常处理完成（仅前端模拟）。");
}

/* ==================================================
   25. 全局渲染与初始化
   ================================================== */

function renderMain(resetScroll = true) {
  const main = document.getElementById("main");
  const scroll = main.scrollTop;

  switch (state.view) {
    case "detail":
      main.innerHTML = renderDetail();
      break;
    case "overview":
      main.innerHTML = renderOverview();
      break;
    case "observation":
      main.innerHTML = renderObservation();
      break;
    default:
      main.innerHTML = renderBoard();
  }

  main.scrollTop = resetScroll ? 0 : scroll;
}

function renderFooter() {
  const running = tasks.filter(t =>
    t.status === "running" && !t.error).length;

  const errors = tasks.filter(t => t.error).length;

  document.getElementById("footerRunning").textContent =
    `${running} 个需求进行中`;

  document.getElementById("footerDecisions").textContent =
    `${pendingDecisions().length} 个待处理`;

  const errorEl = document.getElementById("footerErrors");

  errorEl.textContent = `${errors} 个异常`;
  errorEl.style.color = errors ? "var(--red)" : "";
}

function renderAll() {
  renderSidebar();
  renderMain();
  renderInspector();
  renderFooter();
}

let toastTimer;

function showToast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    el.classList.remove("show");
  },3000);
}

renderAll();

/*
  原型实现边界：

  1. 所有需求、评分、Agent 状态均为示意数据。
  2. 所有交互状态保存在当前页面内存，刷新后恢复初始状态。
  3. 未连接真实 Agent、数据库、CLI 或本地文件系统。
  4. 视觉设计工作区暂时复用 Coding 九步流程，
     初始为空，用于验证工作区空状态。
  5. 九步流程名称、四种决策操作及异常恢复方式
     为本次原型采用的具体交互定义。
  6. 语音输入依赖浏览器能力、运行环境和麦克风授权。
  7. 桌面端优先，窗口过窄时保留三栏结构并允许滚动。
  8. 本源码尚未经过实际浏览器运行测试。
*/

