// Soda Office Agent 客户端 SDK（Task 2.2）。
// 给真实 Agent（Claude Code / Codex 等）用的 HTTP 封装 —— Agent 一律走 API，
// 不许直连数据库（GPT 评审硬要求：编排侧数据只能经服务收口）。
//
// 核心职责：
//   注册 → 领任务（claimNext）→ 持有期间心跳续约（startHeartbeat）→ 提交（submit）。
//
// 所有权口径（整个文件最重要的一件事）：
//   claim_token 是本回合任务的唯一凭证。续约返回 409（token_mismatch /
//   lease_expired / not_active / not_found）= 所有权已丢 —— 立即 lostOwnership=true
//   并回调 onLostOwnership，此后 submit 拒发请求。这对应 GPT 评审的
//   「锁丢失后，原执行者必须立即停止新的动作」。
//   网络失败（超时 / 连不上）不算丢所有权：请求没到服务端，服务端的判定没变，
//   误杀只会造成无谓的停手；它只把 heartbeatHealthy() 打成 false 供上层观察。

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** 续约失败的哪些 reason 表示"所有权真丢了"（与服务端 renew 的 409 reason 对齐）。 */
const OWNERSHIP_LOST_REASONS = new Set(['token_mismatch', 'lease_expired', 'not_active', 'not_found']);

export class AgentClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl           Office 服务地址，如 'http://127.0.0.1:3100'
   * @param {string} opts.name              Agent 名字（唯一；重名注册 409 视为已注册并复用）
   * @param {string} [opts.type]            类型标识，如 'claude-code' / 'codex'
   * @param {string[]} [opts.capabilities]  能力标签
   * @param {number} [opts.heartbeatIntervalMs] 心跳间隔，默认 15s（远小于 90s 租约）
   * @param {number} [opts.requestTimeoutMs]    单个 HTTP 请求超时，默认 10s
   * @param {(reason: string) => void} [opts.onLostOwnership] 丢所有权回调（会被 Runner 覆盖挂接）
   */
  constructor({
    baseUrl,
    name,
    type = 'unknown',
    capabilities = [],
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    onLostOwnership = null,
  } = {}) {
    if (typeof baseUrl !== 'string' || baseUrl === '') throw new TypeError('baseUrl 必须是非空字符串');
    if (typeof name !== 'string' || name.trim() === '') throw new TypeError('name 必须是非空字符串');
    this.baseUrl = baseUrl.replace(/\/+$/, ''); // 去尾斜杠，拼接路径不用再操心
    this.name = name.trim();
    this.type = type;
    this.capabilities = capabilities;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.requestTimeoutMs = requestTimeoutMs;
    // 挂在实例上（而不是闭包里），Runner 可以在运行期换成自己的处理器
    this.onLostOwnership = onLostOwnership;

    this.agentId = null; // register() 之后有值
    this.task = null; // 当前持有的任务（claimNext 抢到后设置）
    this.#claimToken = null;
    this.#lostOwnership = false;
    this.#lostReason = null;
    this.#hbTimer = null;
    this.#lastHeartbeatOk = null; // true/false；null = 还没跳过（刚领到任务，租约新鲜）
  }

  // 私有状态（用 # 前缀字段，getter 只暴露只读视图）
  #claimToken;
  #lostOwnership;
  #lostReason;
  #hbTimer;
  #lastHeartbeatOk;

  get lostOwnership() {
    return this.#lostOwnership;
  }

  get lostReason() {
    return this.#lostReason;
  }

  /**
   * 心跳健康状态。心跳没跳过（null）视为健康 —— 领取那一刻租约就是新的。
   * lostOwnership=true 时恒为 false。
   */
  heartbeatHealthy() {
    return !this.#lostOwnership && this.#lastHeartbeatOk !== false;
  }

  /** 单个 API 请求：统一 JSON 头 + 超时。返回 { status, body }（body 已 parse，非 JSON 为 null）。 */
  async #request(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // 非 JSON 响应体（理论上不会出现，保底不炸）
    }
    return { status: res.status, body: json };
  }

  /**
   * 注册。201 拿到 agentId；409（同名已注册）视为已注册 —— 从列表找回同名 Agent
   * 复用其 id，不报错（Runner 重启是常态，不能卡在注册上）。
   */
  async register() {
    const { status, body } = await this.#request('POST', '/api/agents/register', {
      name: this.name,
      type: this.type,
      capabilities: this.capabilities,
    });
    if (status === 201) {
      this.agentId = body.id;
      return this.agentId;
    }
    if (status === 409) {
      const list = await this.#request('GET', '/api/agents');
      const me = (list.body?.agents ?? []).find((a) => a.name === this.name);
      if (!me) throw new Error(`注册返回 409，但列表里找不到同名 Agent：${this.name}`);
      this.agentId = me.id;
      return this.agentId;
    }
    throw new Error(`注册失败：HTTP ${status} ${JSON.stringify(body)}`);
  }

  /**
   * 领一个 queued 任务：拉列表逐个尝试 claim，抢到即持有（task + claim_token），
   * 列表空或全被抢走返回 null。新一轮领取重置所有权状态 —— 新 token 新回合。
   */
  async claimNext() {
    if (!this.agentId) throw new Error('先 register() 再 claimNext()');
    const { status, body } = await this.#request('GET', '/api/tasks?status=queued');
    if (status !== 200) throw new Error(`拉任务列表失败：HTTP ${status}`);
    for (const t of body.tasks ?? []) {
      const r = await this.#request('POST', `/api/tasks/${t.id}/claim`, { agent_id: this.agentId });
      if (r.status === 200 && r.body?.ok) {
        this.task = r.body.task;
        this.#claimToken = r.body.claim_token;
        this.#lostOwnership = false;
        this.#lostReason = null;
        this.#lastHeartbeatOk = null;
        return this.task;
      }
      // 409 not_queued = 被别人抢先，试下一个；其他错误码也不炸 —— 领任务要的是"尽力拿到一个"
    }
    return null;
  }

  /**
   * 启动后台心跳：每 intervalMs 续约一次租约。定时器 unref()，不阻止进程退出。
   * 必须在执行长任务【之前】调用 —— CLI 一跑可能 15 分钟，租约只有 90s，
   * 不续约任务会被判 suspect。
   */
  startHeartbeat(intervalMs = this.heartbeatIntervalMs) {
    if (!this.task || !this.#claimToken) {
      throw new Error('没有持有任务，无法心跳（先 claimNext）');
    }
    this.stopHeartbeat();
    const tick = async () => {
      const taskId = this.task?.id; // tick 期间任务可能已被置换，取当下值
      const token = this.#claimToken;
      if (!taskId || !token) return;
      try {
        const r = await this.#request('POST', `/api/tasks/${taskId}/renew`, { claim_token: token });
        if (r.status === 200 && r.body?.ok) {
          this.#lastHeartbeatOk = true;
          return;
        }
        const reason = r.body?.reason ?? `http_${r.status}`;
        if (OWNERSHIP_LOST_REASONS.has(reason)) {
          this.#markLost(reason); // 服务端明确说了不认这个 token —— 真丢了
        } else {
          this.#lastHeartbeatOk = false; // 意外响应，先观察不判死
        }
      } catch {
        // 网络/超时错误：请求没到服务端，服务端判定没变，不判丢所有权
        this.#lastHeartbeatOk = false;
      }
    };
    this.#hbTimer = setInterval(() => {
      void tick(); // 异步执行，定时器回调本身不同步等它
    }, intervalMs);
    this.#hbTimer.unref(); // 只持有心跳的进程（如手动 SDK 调用）不该被它拖住不退出
  }

  /** 停心跳。幂等。 */
  stopHeartbeat() {
    if (this.#hbTimer !== null) {
      clearInterval(this.#hbTimer);
      this.#hbTimer = null;
    }
  }

  /** 置丢所有权 + 停心跳 + 回调。只在服务端明确拒绝后调用。 */
  #markLost(reason) {
    if (this.#lostOwnership) return; // 只触发一次回调
    this.#lostOwnership = true;
    this.#lostReason = reason;
    this.stopHeartbeat();
    try {
      this.onLostOwnership?.(reason);
    } catch (err) {
      // 回调抛错不影响状态机本身；吞掉但留痕（SDK 不能被使用方的回调炸掉）
      console.error('[agent-client] onLostOwnership 回调抛错：', err);
    }
  }

  /**
   * 提交任务状态（带 claim_token 走所有权校验路径）。
   * 已丢所有权：直接抛错，一个 HTTP 请求都不发 —— 丢了所有权就不许再提交。
   * 服务端拒绝（409）：同样视为丢所有权（token 失配 / 租约恰好过期），抛错带 reason。
   */
  async submit(status, { resultPath } = {}) {
    if (this.#lostOwnership) {
      throw new Error(`任务所有权已丢失（${this.#lostReason}），拒绝提交`);
    }
    if (!this.task || !this.#claimToken) throw new Error('没有持有任务，无法提交');
    const body = { status, claim_token: this.#claimToken };
    if (resultPath !== undefined) body.result_path = resultPath;
    const r = await this.#request('PATCH', `/api/tasks/${this.task.id}/status`, body);
    if (r.status === 200) return r.body;
    const reason = r.body?.reason ?? `http_${r.status}`;
    if (r.status === 409) this.#markLost(reason); // 提交被拒 = 服务端不再认我们
    throw Object.assign(new Error(`提交 ${status} 被拒：${reason}`), { reason });
  }

  /**
   * 上报事件（start/step/cmd/end/blocked/error/note）。
   * 事件接口不校验 claim_token —— 所以丢了所有权也允许上报
   * （留一条"我停手了"的审计痕迹），这不算"提交任务"。
   */
  async reportEvent(type, payload = {}) {
    const r = await this.#request('POST', '/api/events', {
      task_id: this.task?.id ?? null,
      agent_id: this.agentId,
      type,
      payload,
    });
    if (r.status !== 201) throw new Error(`上报事件 ${type} 失败：HTTP ${r.status}`);
    return r.body;
  }
}
