// Soda Office Runner（Task 2.2）：轮询领任务 → 调真实 CLI 执行 → 提交结果。
//
// 编排的关键时序（顺序不许倒）：
//   claimNext → startHeartbeat → spawn CLI → ……心跳在后台持续续约…… → 提交。
//   Claude Code 跑一单可能 5-15 分钟，租约只有 90s —— 心跳必须先于 spawn 启动，
//   否则任务执行到一半就因租约过期进 suspect 列表。
//
// 丢所有权的硬动作：onLostOwnership → AbortController.abort → 执行器 kill 子进程
// → 不提交状态（只留一条 note 事件）。旧进程不杀干净，新执行者也在改文件，
// 工作区就被两边写花了 —— 所以"停手"必须包含 kill，不是只设标志位。
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentClient } from './agent-client.js';

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000; // CLI 单次执行上限 15 分钟

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 杀整棵进程树。
 * Windows：我们的 CLI 经 cmd.exe 间接启动（npm 全局 bin 是 .cmd，直接 spawn 会
 * EINVAL），kill cmd.exe 不会带走孙进程，必须 taskkill /T 按树杀；
 * POSIX：kill 父进程即可（子进程随进程组 / 自行退出）。
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return; // 已退，不重复杀
  if (process.platform === 'win32') {
    if (child.pid) {
      spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true, stdio: 'ignore' });
    }
  } else {
    try {
      child.kill('SIGTERM');
    } catch {
      // 进程恰好已退出 —— 目的已达成
    }
  }
}

/**
 * Windows 下判断一个命令是否必须经 cmd.exe 启动，并返回可执行的命令名。
 *
 * .cmd / .bat 是批处理脚本，Node 不能直接执行；.exe 才能直接 spawn。
 * 用 where 解析真实路径再判断扩展名，避免靠名字猜（codex 是 .cmd，claude 是 .exe）。
 *
 * 坑：`where codex` 会返回两行 —— 第一行是无扩展名的 Unix shell 脚本
 * （npm 全局装包时一并生成的），Windows 上 spawn 它会 ENOENT；第二行才是 .cmd。
 * 所以不能取第一个命中，要挑出第一个能在 Windows 上执行的（.exe 优先，其次 .cmd/.bat）。
 */
function resolveWindowsCommand(command) {
  if (process.platform !== 'win32') return { cmd: command, shell: false };
  if (/\.exe$/i.test(command)) return { cmd: command, shell: false };
  if (/\.(cmd|bat)$/i.test(command)) return { cmd: command, shell: true };

  try {
    const r = spawnSync('where', [command], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return { cmd: command, shell: true }; // 找不到交给 shell 报错，信息更友好
    const hits = String(r.stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    // .exe 优先（可直接 spawn），没有再退到 .cmd/.bat（需 cmd.exe）
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe) return { cmd: exe, shell: false };
    const script = hits.find((h) => /\.(cmd|bat)$/i.test(h));
    if (script) return { cmd: script, shell: true };
    return { cmd: command, shell: true };
  } catch {
    return { cmd: command, shell: true };
  }
}

/**
 * 通用的"跑一个 CLI"底座，claude / codex 执行器共用。
 *
 * - spawn 而不是 exec：长输出不会爆 buffer（chunk 流式收集）；
 * - 任务文本一律走 stdin：Windows 下经 cmd.exe 启动，命令行参数不转义，
 *   prompt 塞命令行会被空格/引号切碎，stdin 从根上绕开转义与注入；
 * - 超时 kill、外部 abort（signal）kill，两者都把结果标记出来；
 * - 永不 reject：执行失败也是"结果"，由 Runner 决定怎么提交。
 *
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string,
 *                    timedOut: boolean, aborted: boolean, spawnError: Error|null}>}
 */
function spawnCli(command, args, { cwd, stdinText, timeoutMs, signal, env }) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    // Windows：.cmd/.bat 必须经 cmd.exe（绝对路径，避免再被 PATH 解析成无扩展名脚本）；
    // .exe 直接 spawn，少一层中间进程，后台/无控制台场景下 stdin 也更可靠。
    const resolved = resolveWindowsCommand(command);
    const spawnCmd = resolved.shell ? 'cmd.exe' : resolved.cmd;
    const spawnArgs = resolved.shell ? ['/d', '/s', '/c', resolved.cmd, ...args] : args;
    const child = spawn(spawnCmd, spawnArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let aborted = false;
    let spawnError = null;
    child.stdout.on('data', (c) => outChunks.push(c));
    child.stderr.on('data', (c) => errChunks.push(c));

    const finish = () =>
      resolve({
        ok: child.exitCode === 0 && !timedOut && !aborted && spawnError === null,
        code: child.exitCode,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
        aborted,
        spawnError,
      });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.(); // 测试进程不该被残留的定时器拖住不退出

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    if (stdinText != null) child.stdin.write(stdinText);
    child.stdin.end(); // 写完就关：CLI 靠 stdin EOF 判断输入结束

    child.on('error', (err) => {
      // spawn 本身失败（命令不存在等）：close 不会再触发，这里收尾
      spawnError = err;
      clearTimeout(timer);
      finish();
    });
    child.on('close', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/** CLI 的运行环境：去掉嵌套标记 —— 从 Claude Code / Codex 里再拉起同名 CLI 时，
 *  客户端会因检测到自己已被嵌套而行为异常，删掉这些变量让子进程当"第一次启动"。 */
function cliEnv() {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

/** 任务 → 给 CLI 的 prompt：标题 + 描述，明确"只做这件事"。 */
function buildPrompt(task) {
  return [
    `任务标题：${task.title}`,
    `任务描述：${task.description || '（无补充描述）'}`,
    '',
    '请在当前工作目录中完成上述任务。完成后停止，不要做任务之外的任何事。',
  ].join('\n');
}

/**
 * 执行结果统一形状：{ ok, output, durationMs, killed? }。
 * output 是 CLI 的原始 stdout（claude --output-format json / codex --json），
 * 原样落盘 output.log，事后可查。
 */
function toResult(r, t0) {
  const durationMs = Date.now() - t0;
  const parts = [];
  if (r.spawnError) parts.push(`spawn 失败：${r.spawnError.message}`);
  if (r.timedOut) parts.push('执行超时被 kill');
  if (r.aborted) parts.push('因所有权丢失被 kill');
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`);
  parts.push(`--- stdout ---\n${r.stdout}`);
  return { ok: r.ok, output: parts.join('\n'), durationMs, killed: r.aborted || r.timedOut };
}

/** 构造 Claude Code 执行器。timeoutMs / command 可按需覆盖（测试或镜像源）。 */
export function createClaudeExecutor({ timeoutMs = DEFAULT_TIMEOUT_MS, command = 'claude' } = {}) {
  return async ({ task, workdir, signal }) => {
    const t0 = Date.now();
    const r = await spawnCli(
      command,
      ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'json'],
      { cwd: workdir, stdinText: buildPrompt(task), timeoutMs, signal, env: cliEnv() },
    );
    return toResult(r, t0);
  };
}

/**
 * 构造 Codex 执行器。prompt 用 `-` 从 stdin 读（与 claude 同理，避开命令行转义）。
 *
 * `--skip-git-repo-check` 是必须的：Codex 默认拒绝在非 git 仓库目录里执行
 * （"Not inside a trusted directory"），而 Agent 工作区不一定是 git 仓库。
 * `--dangerously-bypass-approvals-and-sandbox` 让它在无人值守场景下真能写文件 ——
 * 这个开关有风险，所以只在显式传入 allowUnsafe 时才加。
 */
export function createCodexExecutor({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  command = 'codex',
  allowUnsafe = true,
} = {}) {
  return async ({ task, workdir, signal }) => {
    const t0 = Date.now();
    const args = ['exec', '--cd', workdir, '-', '--json', '--skip-git-repo-check'];
    if (allowUnsafe) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    }
    const r = await spawnCli(command, args, {
      cwd: workdir,
      stdinText: buildPrompt(task),
      timeoutMs,
      signal,
      env: cliEnv(),
    });
    return toResult(r, t0);
  };
}

/** 默认配置的执行器，拿来即用（Runner 采用依赖注入，这两个只是预组装的 convenience）。 */
export const claudeExecutor = createClaudeExecutor();
export const codexExecutor = createCodexExecutor();

/**
 * Runner：领任务 → 心跳 → 执行 → 落盘 → 提交，循环往复。
 *
 *   const runner = new Runner({ client, workdir, executor: claudeExecutor });
 *   await runner.start();   // 后台循环开始
 *   await runner.stop();    // 停轮询 + 杀在跑的执行 + 停心跳
 */
export class Runner {
  /**
   * @param {object} opts
   * @param {AgentClient} opts.client        已配置好的 AgentClient
   * @param {string} opts.workdir            CLI 的工作目录（输出落在 <workdir>/runs/<task_id>/）
   * @param {Function} opts.executor         async ({task, workdir, signal}) => {ok, output, durationMs}
   * @param {number} [opts.pollIntervalMs]   没活儿时的轮询间隔，默认 3s
   * @param {object} [opts.logger]           有 log/warn 方法即可，默认 console
   */
  constructor({ client, workdir, executor, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, logger = console } = {}) {
    if (!(client instanceof AgentClient)) throw new TypeError('client 必须是 AgentClient 实例');
    if (typeof executor !== 'function') throw new TypeError('executor 必须是函数');
    this.#client = client;
    this.#workdir = workdir;
    this.#executor = executor;
    this.#pollIntervalMs = pollIntervalMs;
    this.#logger = logger;
  }

  #client;
  #workdir;
  #executor;
  #pollIntervalMs;
  #logger;
  #running = false;
  #loopPromise = null;
  #currentAbort = null; // 正在执行的那单任务的 AbortController
  #wakeUp = null; // 轮询等待的唤醒函数（stop() 用来立刻打断 sleep）

  /** 是否已 start 且循环还在跑。 */
  get running() {
    return this.#running;
  }

  /** 是否正在执行一单任务（测试 / 外部观察用）。 */
  get busy() {
    return this.#currentAbort !== null;
  }

  /** 注册 + 挂丢所有权钩子 + 启动后台循环。重复调用直接返回。 */
  async start() {
    if (this.#running) return;
    await this.#client.register();
    // 丢所有权：abort 当前执行（执行器负责 kill 子进程），本回合不再提交。
    // 钩子挂在 client 实例属性上，随 client 状态机实时触发。
    this.#client.onLostOwnership = (reason) => {
      this.#logger.warn(`[runner] 任务所有权丢失（${reason}），停手`);
      this.#currentAbort?.abort(new Error(`任务所有权已丢失：${reason}`));
    };
    this.#running = true;
    this.#loopPromise = this.#loop();
  }

  /**
   * 停止：不再领新任务；在跑的这单被 abort（执行器 kill 子进程）；停心跳。
   * 等 loop 真正退出后返回。
   */
  async stop() {
    this.#running = false;
    this.#currentAbort?.abort(new Error('runner 已停止'));
    this.#client.stopHeartbeat();
    this.#wakeUp?.(); // 立刻打断轮询等待，stop() 不用干等一个 poll 周期
    if (this.#loopPromise) await this.#loopPromise;
    this.#loopPromise = null;
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this.#wakeUp = () => {
        this.#wakeUp = null;
        resolve();
      };
      setTimeout(() => {
        if (this.#wakeUp) {
          this.#wakeUp = null;
          resolve();
        }
      }, ms);
    });
  }

  async #loop() {
    while (this.#running) {
      let task = null;
      try {
        task = await this.#client.claimNext();
      } catch (err) {
        this.#logger.warn(`[runner] 领任务失败：${err.message}`);
      }
      if (task === null) {
        if (this.#running) await this.#sleep(this.#pollIntervalMs);
        continue;
      }
      try {
        await this.#runOne(task);
      } catch (err) {
        // runOne 内部已兜执行器异常；到这里的是框架级错误，记下但循环不能死
        this.#logger.warn(`[runner] 执行任务 ${task.id} 出错：${err?.stack ?? err}`);
      }
    }
  }

  /** 执行一单任务的完整回合：心跳 → running → 执行 → 落盘 → 提交。 */
  async #runOne(task) {
    const log = (msg) => this.#logger.log(`[runner] 任务 ${task.id}（${task.title}）：${msg}`);
    const runDir = join(this.#workdir, 'runs', task.id);
    const logPath = join(runDir, 'output.log');
    const t0 = Date.now();

    // 心跳先于一切执行动作：spawn 可能跑十几分钟，租约只有 90s
    this.#client.startHeartbeat();

    const ac = new AbortController();
    this.#currentAbort = ac;
    let gaveUpBeforeRun = false;
    let result = null;
    try {
      await mkdir(runDir, { recursive: true });
      try {
        await this.#client.submit('running'); // 带 token 置 running；丢所有权会抛
      } catch (err) {
        // 还没开跑就丢了（token 已被换 / 租约恰好过期）：不再执行，不留半成品
        gaveUpBeforeRun = true;
        log(`置 running 失败，放弃执行：${err.message}`);
      }
      if (!gaveUpBeforeRun) {
        try {
          await this.#client.reportEvent('start', { workdir: this.#workdir, title: task.title });
        } catch {
          // 事件失败不拦执行 —— 事件是观测面，不是控制面
        }
        log('开始执行');
        try {
          result = await this.#executor({ task, workdir: this.#workdir, signal: ac.signal });
        } catch (err) {
          // 执行器抛异常也算结果：提交 failed，不能丢下任务不管
          result = {
            ok: false,
            output: `执行器抛异常：\n${err?.stack ?? err}`,
            durationMs: Date.now() - t0,
          };
        }
      }
    } finally {
      // 无论成败，现场必须落盘 —— 出了问题全靠这份日志查
      try {
        const verdict = this.#client.lostOwnership
          ? 'lost-ownership（不提交）'
          : gaveUpBeforeRun
            ? 'not-started（开跑前丢所有权）'
            : result?.ok
              ? 'done'
              : 'failed';
        const content = [
          `任务 ${task.id}：${task.title}`,
          `开始 ${new Date(t0).toISOString()}，耗时 ${Date.now() - t0}ms`,
          `判定：${verdict}`,
          '',
          result?.output ?? '（未执行）',
        ].join('\n');
        await mkdir(runDir, { recursive: true });
        await writeFile(logPath, content, 'utf8');
      } catch (err) {
        this.#logger.warn(`[runner] 写 output.log 失败：${err.message}`);
      }
      this.#currentAbort = null;
      this.#client.stopHeartbeat();
    }

    // 提交阶段：丢了所有权一个请求都不许发（submit 内部还会再挡一道）
    if (this.#client.lostOwnership) {
      try {
        await this.#client.reportEvent('note', {
          note: '所有权丢失，已停手，不提交结果',
          reason: this.#client.lostReason,
          result_path: logPath,
        });
      } catch {
        // 连事件都发不出去（网络断了）——现场已在 output.log，不再挣扎
      }
      log(`所有权丢失（${this.#client.lostReason}），已停手`);
      return;
    }
    if (gaveUpBeforeRun) return;

    const status = result.ok ? 'done' : 'failed';
    try {
      await this.#client.submit(status, { resultPath: logPath });
      log(`已提交 ${status}，结果在 ${logPath}`);
      await this.#client.reportEvent(status === 'done' ? 'end' : 'error', {
        result_path: logPath,
        duration_ms: result.durationMs,
      });
    } catch (err) {
      // 提交被拒（租约恰好过期瞬间完成等）：任务留在 running 会被 suspect 流程处置
      this.#logger.warn(`[runner] 任务 ${task.id} 提交 ${status} 被拒：${err.message}`);
    }
  }
}
