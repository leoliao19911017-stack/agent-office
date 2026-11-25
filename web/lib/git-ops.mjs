// git-ops.mjs — TASK-COMPANY-D0-R2 worktree 并发隔离的 git 薄封装。
//
// 原则（任务书 §5 铁律④⑤）：
//   ① 只用 spawnSync 调真 git，不引库不模拟；参数走数组，不吃 shell 拼接；
//   ② git 失败必须把 stderr 原样带出来（GitError.stderr / message），不许吞、不许静默降级；
//   ③ 不做任何「兜底在项目根跑」的降级路径——worktree 建不出来就是失败。
// 调用方（web/lib/company.mjs）负责把这些错误翻译成带 statusCode 的业务错误。

import { spawnSync } from 'node:child_process';

/** git 命令失败：status / stdout / stderr 原样保留，message 里带上 stderr 便于直接回报。 */
export class GitError extends Error {
  constructor(args, result) {
    const stderr = String(result.stderr ?? '').trim();
    const stdout = String(result.stdout ?? '').trim();
    super(`git ${args.join(' ')} 失败（exit ${result.status}）：${stderr || stdout || '无输出'}`);
    this.name = 'GitError';
    this.args = args;
    this.status = result.status;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/**
 * 在 repoPath 里跑一条 git 命令，成功返回 stdout（去尾换行）。
 * 统一带 `-c core.longpaths=true`：worktree 嵌在 <root>/.worktrees/<wid>/<eid>/ 下，
 * 仓库里再有点深路径（docs/runs/...、shots/...）就会撞 Windows 260 字符上限，
 * checkout 直接 "Filename too long"。只对本封装生效，不改仓库 / 全局配置。
 * @param {string} repoPath git 仓库根（-C 参数）
 * @param {string[]} args git 参数（不含 'git' 与 '-C repoPath'）
 */
export function runGit(repoPath, args) {
  const r = spawnSync('git', ['-c', 'core.longpaths=true', '-C', repoPath, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) {
    // git 都起不来（没装 / PATH 坏）——也是失败，不许降级
    const err = new Error(`无法启动 git：${r.error.message}`);
    err.name = 'GitError';
    err.stderr = '';
    throw err;
  }
  if (r.status !== 0) throw new GitError(args, r);
  return String(r.stdout ?? '').trim();
}

/** 当前分支名；处于 detached HEAD 时返回 commit sha（base_ref 两样都能吃）。 */
export function currentBranch(repoPath) {
  const ref = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (ref === 'HEAD') return runGit(repoPath, ['rev-parse', 'HEAD']);
  return ref;
}

/**
 * §3.3 ⑧：git worktree add <path> -b <branch> <baseRef>。
 * 失败抛 GitError（stderr 原样），由调用方翻译成 500 WORKTREE_CREATE_FAILED。
 */
export function worktreeAdd(repoPath, worktreePath, branchName, baseRef) {
  return runGit(repoPath, ['worktree', 'add', worktreePath, '-b', branchName, baseRef]);
}

/**
 * §3.4 ①②③：worktree 里 add -A → 有改动才 commit → 返回新 commit sha（没改动返回 ''）。
 * commit 带 --no-verify：执行链路是机器提交，不该触发仓库 core.hooksPath（scripts/hooks）
 * 的 G07 人工门禁——那套回归要跑几分钟，会把 finish 请求拖到超时。
 * merge 不走 pre-commit 钩子，无需同样处理。
 */
export function commitAllIfDirty(worktreePath, message) {
  runGit(worktreePath, ['add', '-A']);
  const dirty = runGit(worktreePath, ['status', '--porcelain']);
  if (!dirty) return '';
  runGit(worktreePath, ['commit', '--no-verify', '-m', message]);
  return runGit(worktreePath, ['rev-parse', 'HEAD']);
}

/** §3.6：git merge --no-ff <branch>（在项目根执行）。冲突 / 失败抛 GitError。 */
export function mergeNoFf(repoPath, branchName) {
  return runGit(repoPath, ['merge', '--no-ff', branchName]);
}

/** §3.6 合并成功后的清理：移除 worktree（--force）+ 删执行分支。 */
export function removeWorktree(repoPath, worktreePath) {
  return runGit(repoPath, ['worktree', 'remove', worktreePath, '--force']);
}

/** 清掉「目录已经不在了」的 worktree 注册项（remove 半途失败后的兜底配套）。 */
export function pruneWorktrees(repoPath) {
  return runGit(repoPath, ['worktree', 'prune']);
}

export function deleteBranch(repoPath, branchName) {
  return runGit(repoPath, ['branch', '-D', branchName]);
}
