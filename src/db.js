// Soda Office 数据库层。
// 驱动用 Node 22 内置的 node:sqlite（真 SQLite C 库，零依赖）。
// 换掉 node-sqlite3-wasm 的原因：WASM 版不支持多进程共享同一个 db 文件，
// 8 进程真并发时随机抛 "disk I/O error"（详见 docs/DB-技术选型问题.md）。
//
// 约定：
// - 时间戳一律存 Unix epoch 毫秒（INTEGER），比较大小即比较先后；
// - JSON 字段（capabilities / payload）以字符串落库，读取方自行 parse；
// - 查询函数返回原始行，查无返回 null / 空数组，不编数据。
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Agent 工作状态，口径对齐 soda-agent-workspace（其客户端 sync 也只认这四个） */
export const AGENT_STATUSES = ['working', 'idle', 'blocked', 'done'];

/** 实时事件类型，口径对齐 soda-agent-workspace 第六节（start/step/cmd/end/blocked/error/note） */
export const EVENT_TYPES = ['start', 'step', 'cmd', 'end', 'blocked', 'error', 'note'];

/** 任务状态机，对齐 office_adapter 的设计：queued → claimed → running → done/failed/cancelled/blocked */
export const TASK_STATUSES = ['queued', 'claimed', 'running', 'done', 'failed', 'cancelled', 'blocked'];

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'unknown',
  status         TEXT NOT NULL DEFAULT 'idle',
  last_heartbeat INTEGER,
  capabilities   TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee    TEXT REFERENCES agents(id),
  status      TEXT NOT NULL DEFAULT 'queued',
  claimed_at  INTEGER,
  created_at  INTEGER NOT NULL,
  result_path TEXT,
  claim_token    TEXT,
  lease_expires_at INTEGER,
  attempt        INTEGER NOT NULL DEFAULT 0,
  current_run_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT REFERENCES tasks(id),
  agent_id   TEXT REFERENCES agents(id),
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_events_task_id   ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_id  ON events(agent_id);
`;

/**
 * 默认租约时长（毫秒）。领取即生效，Agent 须在到期前 renewLease 续约。
 * 90s 的量级：远大于正常一次心跳间隔，又短于"任务卡死后等人来查"的可忍受时长。
 */
export const DEFAULT_LEASE_MS = 90_000;

/** 并发写冲突时 SQLite 的退避等待上限（毫秒），跨进程场景必需 */
export const BUSY_TIMEOUT_MS = 5_000;

/**
 * Task 2.1 迁移：老库（Task 1.x 建的 tasks 表，无租约四列）→ 新 schema。
 * 列定义顺序与 SCHEMA 中一致，保证新库 / 迁移库的 table_info 列序相同。
 */
const TASK_LEASE_COLUMNS = [
  { name: 'claim_token', def: 'claim_token TEXT' },
  { name: 'lease_expires_at', def: 'lease_expires_at INTEGER' },
  { name: 'attempt', def: 'attempt INTEGER NOT NULL DEFAULT 0' },
  { name: 'current_run_id', def: 'current_run_id TEXT' },
];

/**
 * 把租约四列补进老 tasks 表，幂等（已有列跳过，重复调用无副作用）。
 *
 * 存量 claimed/running 任务补一条"从领取时刻起算"的租约：它们的 claimed_at
 * 早于迁移时刻，租约随即过期、自然进入 listSuspectTasks —— 这正是 P0 要救的
 * "抢到后崩溃、永远卡在 claimed" 的存量任务，不能迁移完还隐身。
 * queued/done 等状态不碰：没被领走的任务谈不上租约。
 *
 * 注意只补 lease_expires_at、不凭空生成 claim_token：造一个没人持有的 token
 * 只会造成"有凭证但无人可续"的假象；token 留 NULL，updateTaskStatusWithToken
 * 的 WHERE claim_token = ? 天然匹配不上，不会误授权。
 */
export function migrateDatabase(db) {
  const existing = new Set(db.all('PRAGMA table_info(tasks)').map((c) => c.name));
  const pending = TASK_LEASE_COLUMNS.filter((col) => !existing.has(col.name));
  for (const col of pending) {
    db.run(`ALTER TABLE tasks ADD COLUMN ${col.def}`);
  }
  if (pending.length > 0) {
    db.run(
      "UPDATE tasks SET lease_expires_at = COALESCE(claimed_at, created_at) + ? " +
        "WHERE status IN ('claimed','running') AND lease_expires_at IS NULL",
      [DEFAULT_LEASE_MS],
    );
  }
}

/**
 * 薄适配层：把 node:sqlite 的 prepare 式 API 包装成业务代码习惯的
 * db.run / db.get / db.all（与 better-sqlite3、node-sqlite3-wasm 同形）。
 *
 * 为什么要有这层：两种驱动的差异集中在「怎么执行语句」——
 *   node-sqlite3-wasm: db.run(sql, params) / db.get(...) / db.all(...)
 *   node:sqlite:       db.prepare(sql).run(...) / .get(...) / .all(...)
 * 业务代码和测试都按第一种写，这里统一转换，换驱动时只改这一个函数。
 *
 * 返回形状约定（与旧驱动一致，业务侧不用改）：
 *   run → { changes: number, lastInsertRowid: number }
 */
function wrapDatabase(db) {
  return {
    /** 执行多条 SQL（建表 / PRAGMA），无返回值 */
    exec(sql) {
      return db.exec(sql);
    },
    /** 执行单条写语句，返回受影响行数与自增主键 */
    run(sql, params = []) {
      const result = db.prepare(sql).run(...params);
      return {
        changes: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    /** 取一行，查无返回 undefined（调用方用 ?? null 归一） */
    get(sql, params = []) {
      return db.prepare(sql).get(...params);
    },
    /** 取多行，查无返回空数组 */
    all(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
    /** 关闭连接 */
    close() {
      return db.close();
    },
    /** 暴露原始句柄，给需要事务控制的地方（BEGIN IMMEDIATE / COMMIT）用 */
    get raw() {
      return db;
    },
  };
}

/** 打开数据库连接并启用外键约束（SQLite 默认不启用） */
export function openDatabase(path = ':memory:') {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  // 多进程并发写：SQLite 默认 busy 时立刻抛 "database is locked"。
  // 设 busy_timeout 让它退避重试，抢不到的进程等一会儿而不是崩掉。
  // 这是跨进程场景的关键 —— 进程内测试发现不了。
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // WAL 让读写不互斥，多进程下吞吐更好。只在文件库上设（内存库不支持）。
  if (path !== ':memory:') {
    try {
      raw.exec('PRAGMA journal_mode = WAL');
    } catch {
      // 并发初始化时可能撞锁，不是致命问题 —— 主库仍是安全的 rollback journal
    }
  }
  return wrapDatabase(raw);
}

/**
 * 打开、建表并迁移到当前 schema。幂等（IF NOT EXISTS + migrateDatabase 按列查缺），
 * 重复调用安全；老库文件（Task 1.x 建的）在此补齐租约四列，数据不动。
 */
export function initializeDatabase(path = ':memory:') {
  const db = openDatabase(path);
  db.exec(SCHEMA);
  migrateDatabase(db); // 全新建的库四列都在，此处为 no-op
  return db;
}

export function closeDatabase(db) {
  if (db) db.close();
}

/**
 * 注册一个 Agent，返回落库后的完整行（capabilities 已序列化为 JSON 字符串）。
 * 入参用 camelCase（lastHeartbeat），落库转 snake_case。
 */
export function insertAgent(db, agent) {
  if (!agent || typeof agent !== 'object') throw new TypeError('agent 必须是对象');
  const { name, type, status, capabilities, lastHeartbeat } = agent;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('agent.name 必须是非空字符串');
  }
  if (type !== undefined && typeof type !== 'string') throw new TypeError('agent.type 必须是字符串');
  if (status !== undefined && !AGENT_STATUSES.includes(status)) {
    throw new RangeError(`agent.status 必须是 ${AGENT_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    throw new TypeError('agent.capabilities 必须是数组');
  }
  if (lastHeartbeat !== undefined && typeof lastHeartbeat !== 'number') {
    throw new TypeError('agent.lastHeartbeat 必须是数字（epoch 毫秒）');
  }

  const row = {
    id: typeof agent.id === 'string' && agent.id ? agent.id : randomUUID(),
    name: name.trim(),
    type: type ?? 'unknown',
    status: status ?? 'idle',
    last_heartbeat: lastHeartbeat ?? null,
    capabilities: JSON.stringify(capabilities ?? []),
    created_at: Date.now(),
  };
  db.run(
    'INSERT INTO agents (id, name, type, status, last_heartbeat, capabilities, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.name, row.type, row.status, row.last_heartbeat, row.capabilities, row.created_at],
  );
  return row;
}

/** 按 id 查 Agent，查无返回 null。 */
export function getAgentById(db, id) {
  return db.get('SELECT * FROM agents WHERE id = ?', [id]) ?? null;
}

/** Agent 全量列表，按注册先后排序（created_at 同毫秒时按 rowid 决胜，保证插入序稳定）。 */
export function listAgents(db) {
  return db.all('SELECT * FROM agents ORDER BY created_at, rowid');
}

/** 按名字精确查 Agent（注册查重用），查无返回 null。 */
export function findAgentByName(db, name) {
  return db.get('SELECT * FROM agents WHERE name = ?', [name]) ?? null;
}

/**
 * 更新 Agent 状态，并把 last_heartbeat 刷到当前时刻（口径：状态更新即心跳，不可省）。
 * 返回更新后的完整行；Agent 不存在时不写入、返回 null。
 */
export function updateAgentStatus(db, id, status) {
  if (!AGENT_STATUSES.includes(status)) {
    throw new RangeError(`status 必须是 ${AGENT_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  db.run('UPDATE agents SET status = ?, last_heartbeat = ? WHERE id = ?', [status, Date.now(), id]);
  return getAgentById(db, id); // UPDATE 命中 0 行时这里自然返回 null，不用看 changes 计数
}

// ---------------------------------------------------------------------------
// 任务（tasks）
// ---------------------------------------------------------------------------

/**
 * 建任务，返回落库后的完整行。
 * title 必须非空字符串；status 默认 queued；assignee 可为 null（未指派），
 * 指派时必须是已存在的 agent id —— 由外键兜底（openDatabase 已开 PRAGMA foreign_keys），
 * 违反时 SQLite 直接抛约束错误，不静默落库。
 */
export function insertTask(db, task) {
  if (!task || typeof task !== 'object') throw new TypeError('task 必须是对象');
  const { title, description, assignee, status } = task;
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TypeError('task.title 必须是非空字符串');
  }
  if (status !== undefined && !TASK_STATUSES.includes(status)) {
    throw new RangeError(`task.status 必须是 ${TASK_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  if (description !== undefined && typeof description !== 'string') {
    throw new TypeError('task.description 必须是字符串');
  }
  if (assignee !== undefined && assignee !== null && typeof assignee !== 'string') {
    throw new TypeError('task.assignee 必须是字符串（agent id）或 null');
  }

  const row = {
    id: typeof task.id === 'string' && task.id ? task.id : randomUUID(),
    title: title.trim(),
    description: description ?? '',
    assignee: assignee ?? null,
    status: status ?? 'queued',
    claimed_at: null,
    created_at: Date.now(),
    result_path: null,
  };
  db.run(
    'INSERT INTO tasks (id, title, description, assignee, status, claimed_at, created_at, result_path) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [row.id, row.title, row.description, row.assignee, row.status, row.claimed_at, row.created_at, row.result_path],
  );
  return row;
}

/** 按 id 查任务，查无返回 null。 */
export function getTaskById(db, id) {
  return db.get('SELECT * FROM tasks WHERE id = ?', [id]) ?? null;
}

/** 任务列表，可按状态筛（不传返回全部）；created_at 倒序（新任务在前），同毫秒按 rowid 决胜。 */
export function listTasks(db, { status } = {}) {
  if (status !== undefined) {
    if (!TASK_STATUSES.includes(status)) {
      throw new RangeError(`status 必须是 ${TASK_STATUSES.join(' / ')} 之一，收到：${status}`);
    }
    return db.all('SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC, rowid DESC', [status]);
  }
  return db.all('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC');
}

/**
 * 原子领取任务 —— 全项目并发正确性的关键点（Task 2.1 起附带租约与凭证）。
 *
 * 绝不"先 SELECT 看 status 再 UPDATE"：两步之间有竞态窗口，并发下会双双成功。
 * 而是把"判断 + 占有"压进一条 UPDATE：
 *   UPDATE tasks SET status='claimed', assignee=?, claimed_at=?,
 *     claim_token=?, lease_expires_at=?, attempt=attempt+1, current_run_id=?
 *   WHERE id=? AND status='queued'
 * WHERE 同时卡 id 与 queued，SQLite 的写互斥保证同一行只有一个调用能命中（changes=1），
 * 抢输的命中 0 行（changes=0）。哪怕将来换成真并发的驱动，这个语义也不变。
 *
 * Task 2.1 新增的一次性写入：
 * - claim_token：本回合的领取凭证（randomUUID，不可预测）。此后所有写操作
 *   （续约 / 状态更新）都要带它，靠 SQL WHERE 校验 —— 失去凭证就失去任务；
 * - lease_expires_at：租约到期时刻（now + leaseMs）。到期≠进程已死，只进可疑列表；
 * - attempt = attempt + 1：第几次被领取（含被 requeue 后重新排队再领），SQL 内
 *   原子自增，并发下不会丢计数；
 * - current_run_id：本回合执行批次标识（randomUUID），供事件流对齐"哪一回合"。
 *
 * 已实验确认 node-sqlite3-wasm 的 db.run() 返回 { changes, lastInsertRowid }，
 * changes 即受影响行数，据此判定输赢 —— 不靠猜。
 *
 * 返回：抢到 { ok: true, task, claim_token }（token 同时也在 task 行里，
 * 顶层再给一份是让调用方少一层解构）；没抢到 { ok: false, reason: 'not_queued' }。
 */
export function claimTask(db, taskId, agentId, leaseMs = DEFAULT_LEASE_MS) {
  if (typeof agentId !== 'string' || agentId === '') {
    throw new TypeError('claimTask 的 agentId 必须是非空字符串');
  }
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new TypeError(`claimTask 的 leaseMs 必须是正数（毫秒），收到：${leaseMs}`);
  }
  const now = Date.now(); // claimed_at 与租约起点必须是同一时刻
  const claimToken = randomUUID();
  const runId = randomUUID();
  const { changes } = db.run(
    "UPDATE tasks SET status = 'claimed', assignee = ?, claimed_at = ?, claim_token = ?, " +
      'lease_expires_at = ?, attempt = attempt + 1, current_run_id = ? ' +
      "WHERE id = ? AND status = 'queued'",
    [agentId, now, claimToken, now + leaseMs, runId, taskId],
  );
  if (changes !== 1) return { ok: false, reason: 'not_queued' };
  return { ok: true, task: getTaskById(db, taskId), claim_token: claimToken };
}

/**
 * 更新任务状态；extras 可带 result_path（如 done 时附产物路径）。
 * 返回更新后的完整行；任务不存在时不写入、返回 null。
 */
export function updateTaskStatus(db, taskId, status, extras = {}) {
  if (!TASK_STATUSES.includes(status)) {
    throw new RangeError(`status 必须是 ${TASK_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  const { result_path } = extras ?? {};
  if (result_path !== undefined && typeof result_path !== 'string') {
    throw new TypeError('extras.result_path 必须是字符串');
  }
  if (result_path !== undefined) {
    db.run('UPDATE tasks SET status = ?, result_path = ? WHERE id = ?', [status, result_path, taskId]);
  } else {
    db.run('UPDATE tasks SET status = ? WHERE id = ?', [status, taskId]);
  }
  return getTaskById(db, taskId); // 命中 0 行自然返回 null
}

// ---------------------------------------------------------------------------
// 租约与所有权（Task 2.1）
// ---------------------------------------------------------------------------

/** claimToken / leaseMs 的公共入参校验，错误口径与文件内其他函数一致。 */
function assertToken(token, who) {
  if (typeof token !== 'string' || token === '') {
    throw new TypeError(`${who} 的 claimToken 必须是非空字符串`);
  }
}

function assertLeaseMs(leaseMs, who) {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new TypeError(`${who} 的 leaseMs 必须是正数（毫秒），收到：${leaseMs}`);
  }
}

/**
 * 续约：把租约延长到 now + leaseMs。只有"仍持有本回合凭证且任务未结束"才允许。
 *
 * 校验全在 SQL WHERE 里（claim_token + 活跃状态），靠 changes 判定成败；
 * 失败后的 SELECT 只做归因（区分 token 不对 / 任务不在活跃态），不参与判定 ——
 * 与 claimTask 的口径一致。token 不校验的后果是：旧执行者能把已被接管的任务
 * 的租约无限续下去，所以 WHERE 必须卡 claim_token。
 *
 * 返回：
 * - { ok: true, lease_expires_at }            续约成功
 * - { ok: false, reason: 'not_found' }        任务不存在
 * - { ok: false, reason: 'token_mismatch' }   凭证不对（含任务从未走过带凭证领取的 NULL）
 * - { ok: false, reason: 'not_active' }       凭证对，但任务已 done/failed/cancelled/blocked/queued
 */
export function renewLease(db, taskId, claimToken, leaseMs = DEFAULT_LEASE_MS) {
  assertToken(claimToken, 'renewLease');
  assertLeaseMs(leaseMs, 'renewLease');
  const nowMs = Date.now();
  const leaseExpiresAt = nowMs + leaseMs;
  // 租约未过期才许续：否则一个卡死但还活着的进程能把自己的过期租约无限续回来，
  // 任务被永久锁死 —— 那租约就等于不存在。租约一旦过期，所有权进入"待确认"，
  // 只有 requeue 重新派发（换新 token）才能恢复执行权。
  const { changes } = db.run(
    'UPDATE tasks SET lease_expires_at = ? ' +
      "WHERE id = ? AND claim_token = ? AND status IN ('claimed','running') " +
      'AND lease_expires_at IS NOT NULL AND lease_expires_at > ?',
    [leaseExpiresAt, taskId, claimToken, nowMs],
  );
  if (changes === 1) return { ok: true, lease_expires_at: leaseExpiresAt };
  const row = getTaskById(db, taskId); // 定局后的归因查询，不参与判定
  if (row === null) return { ok: false, reason: 'not_found' };
  if (row.claim_token !== claimToken) return { ok: false, reason: 'token_mismatch' };
  if (row.lease_expires_at !== null && row.lease_expires_at <= nowMs) {
    return { ok: false, reason: 'lease_expired' };
  }
  return { ok: false, reason: 'not_active' };
}

/**
 * 带 token 校验的状态更新 —— 防止"旧执行者失去所有权后覆盖新结果"的关键闸门。
 *
 * 与 updateTaskStatus 的差别只在 WHERE 多卡 claim_token：凭证不对就命中 0 行，
 * 一行都不写（不存在"先查再改"的竞态窗口）。典型场景：A 的租约过期、任务被
 * requeue 后 B 领走，A 拿旧 token 提交结果 → WHERE 匹配不上 → 拒绝，B 的数据不受污染。
 *
 * 到终态（done/failed 等）后 claim_token 故意不清空：留着无害（活跃态校验会挡住
 * 续约），审计上还能看出"这回合是谁做完的"；requeue 才清空（见 resolveSuspectTask）。
 *
 * 返回：
 * - { ok: true, task }                         更新成功（读回真实行）
 * - { ok: false, reason: 'not_found' }         任务不存在
 * - { ok: false, reason: 'token_mismatch' }    凭证不对，一行未写
 */
export function updateTaskStatusWithToken(db, taskId, claimToken, status, extras = {}) {
  assertToken(claimToken, 'updateTaskStatusWithToken');
  if (!TASK_STATUSES.includes(status)) {
    throw new RangeError(`status 必须是 ${TASK_STATUSES.join(' / ')} 之一，收到：${status}`);
  }
  const { result_path } = extras ?? {};
  if (result_path !== undefined && typeof result_path !== 'string') {
    throw new TypeError('extras.result_path 必须是字符串');
  }
  const nowMs = Date.now();
  // 三道闸一起压在 WHERE 里（命中 0 行就一行不写，无"先查再改"窗口）：
  //   1. claim_token  —— 只认当前所有者
  //   2. 租约未过期   —— 过期即失去写权，否则租约形同虚设
  //   3. 非终态       —— done/failed/cancelled 不可被翻案回活跃态
  const guard =
    ' AND claim_token = ? AND lease_expires_at IS NOT NULL AND lease_expires_at > ? ' +
    "AND status NOT IN ('done','failed','cancelled')";
  const sql =
    result_path !== undefined
      ? `UPDATE tasks SET status = ?, result_path = ? WHERE id = ?${guard}`
      : `UPDATE tasks SET status = ? WHERE id = ?${guard}`;
  const params =
    result_path !== undefined
      ? [status, result_path, taskId, claimToken, nowMs]
      : [status, taskId, claimToken, nowMs];
  const { changes } = db.run(sql, params);
  if (changes === 1) return { ok: true, task: getTaskById(db, taskId) };
  const row = getTaskById(db, taskId); // 归因，不参与判定
  if (row === null) return { ok: false, reason: 'not_found' };
  if (row.claim_token !== claimToken) return { ok: false, reason: 'token_mismatch' };
  if (['done', 'failed', 'cancelled'].includes(row.status)) return { ok: false, reason: 'terminal' };
  if (row.lease_expires_at !== null && row.lease_expires_at <= nowMs) {
    return { ok: false, reason: 'lease_expired' };
  }
  return { ok: false, reason: 'not_active' };
}

/**
 * 可疑任务列表：claimed/running 且租约已过期（lease_expires_at < nowMs）。
 * 过期最久的排前面（最需要先处置的先看到）。lease_expires_at 为 NULL 的行
 * （未跑迁移的老数据）不会被 `NULL < ?` 命中，不进列表。
 *
 * 刻意只"列出"不"处置"：心跳/租约超时不能证明旧进程已死（系统睡眠、进程暂停、
 * 网络抖动都会造成假超时，GPT 评审原话），所以这里没有也不许有自动回收 ——
 * 处置必须走 resolveSuspectTask，由人工或明确策略调用。
 */
export function listSuspectTasks(db, nowMs = Date.now()) {
  return db.all(
    "SELECT * FROM tasks WHERE status IN ('claimed','running') AND lease_expires_at < ? " +
      'ORDER BY lease_expires_at ASC, rowid ASC',
    [nowMs],
  );
}

/** resolveSuspectTask 允许的处置动作。 */
export const RESOLVE_ACTIONS = ['requeue', 'block', 'fail'];

/**
 * 处置一个可疑任务（必须真的可疑：活跃态 + 租约已过期，WHERE 全卡死，
 * 正常任务调用直接命中 0 行被拒，不存在"顺手改掉健康任务"的口子）。
 *
 * - 'requeue'：放回队列。status='queued'，清空 claim_token / assignee /
 *   claimed_at / lease_expires_at / current_run_id（回到与新建任务相同的形状），
 *   唯独保留 attempt 计数 —— 它记录"这任务被领过几回"，是重试成本的账。
 *   清 claim_token 是安全关键：旧执行者的凭证随之作废，renew / 带token更新
 *   全部失配；下一个领取者会写入全新 token。
 * - 'block'：标记 blocked（人工介入）。assignee / claim_token / 租约等现场
 *   全部保留，方便排查"卡在哪一回合"。
 * - 'fail'：标记 failed。现场同样保留。
 *
 * opts.nowMs 可注入"现在"（测试用未来时刻模拟过期，免 sleep）；默认 Date.now()。
 *
 * 返回：
 * - { ok: true, task }                        处置成功（读回真实行）
 * - { ok: false, reason: 'not_found' }        任务不存在
 * - { ok: false, reason: 'not_suspect' }      任务在，但不是可疑状态（健康或已终态）
 */
export function resolveSuspectTask(db, taskId, action, opts = {}) {
  if (!RESOLVE_ACTIONS.includes(action)) {
    throw new RangeError(`action 必须是 ${RESOLVE_ACTIONS.join(' / ')} 之一，收到：${action}`);
  }
  const nowMs = opts?.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError(`opts.nowMs 必须是数字（epoch 毫秒），收到：${nowMs}`);
  }

  // 三种动作共用同一个"必须是可疑任务"的 WHERE，只是 SET 的内容不同
  const SUSPECT_WHERE =
    "id = ? AND status IN ('claimed','running') AND lease_expires_at < ?";
  let sql;
  if (action === 'requeue') {
    sql =
      "UPDATE tasks SET status = 'queued', assignee = NULL, claimed_at = NULL, " +
      `claim_token = NULL, lease_expires_at = NULL, current_run_id = NULL WHERE ${SUSPECT_WHERE}`;
  } else {
    // block / fail：只改状态，现场保留
    sql = `UPDATE tasks SET status = '${action === 'block' ? 'blocked' : 'failed'}' WHERE ${SUSPECT_WHERE}`;
  }
  const { changes } = db.run(sql, [taskId, nowMs]);
  if (changes === 1) return { ok: true, task: getTaskById(db, taskId) };
  if (getTaskById(db, taskId) === null) return { ok: false, reason: 'not_found' }; // 归因，不参与判定
  return { ok: false, reason: 'not_suspect' };
}

// ---------------------------------------------------------------------------
// 事件（events）
// ---------------------------------------------------------------------------

/**
 * limit 归一（事件查询共用）：undefined → def；非整数 / 小于 1 → def（回落默认）；
 * 超过 max 静默截到 max（任务书口径：不报错）。上限 1000 对两个查询统一生效。
 */
function normalizeLimit(limit, def, max = 1000) {
  if (limit === undefined) return def;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return def;
  return Math.min(limit, max);
}

/**
 * 写入一条事件，返回落库后的完整行（读回真实行，payload 是 JSON 字符串，API 层负责还原）。
 * type 必须在 EVENT_TYPES 里，否则 RangeError；payload 是任意对象（数组也收，JSON 往返无损），
 * 默认 {}；task_id / agent_id 可为 null（有些事件不绑定任务或 Agent，如系统级 note）。
 * 引用存在性由外键兜底，但 API 层会先验存在再落库，给出更准的 404。
 */
export function insertEvent(db, event) {
  if (!event || typeof event !== 'object') throw new TypeError('event 必须是对象');
  const { task_id, agent_id, type, payload } = event;
  if (!EVENT_TYPES.includes(type)) {
    throw new RangeError(`event.type 必须是 ${EVENT_TYPES.join(' / ')} 之一，收到：${type}`);
  }
  if (payload !== undefined && (typeof payload !== 'object' || payload === null)) {
    throw new TypeError('event.payload 必须是对象');
  }
  const { lastInsertRowid } = db.run(
    'INSERT INTO events (task_id, agent_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    [task_id ?? null, agent_id ?? null, type, JSON.stringify(payload ?? {}), Date.now()],
  );
  return getEventById(db, lastInsertRowid);
}

/** 按主键查事件，查无返回 null。 */
export function getEventById(db, id) {
  return db.get('SELECT * FROM events WHERE id = ?', [id]) ?? null;
}

/**
 * 某任务的事件流，created_at 升序（事件流要看时间顺序）。
 * 同毫秒按 rowid 决胜，保持插入序（AUTOINCREMENT 单调递增，见 schema.md）。
 * limit 默认 100、最大 1000（超过静默截断）。
 */
export function listEventsByTask(db, taskId, { limit } = {}) {
  const n = normalizeLimit(limit, 100);
  return db.all('SELECT * FROM events WHERE task_id = ? ORDER BY created_at, rowid LIMIT ?', [taskId, n]);
}

/** 全量最近事件，created_at 倒序（新的在前），同毫秒按 rowid 倒序决胜。limit 默认 50、最大 1000。 */
export function listRecentEvents(db, { limit } = {}) {
  const n = normalizeLimit(limit, 50);
  return db.all('SELECT * FROM events ORDER BY created_at DESC, rowid DESC LIMIT ?', [n]);
}
