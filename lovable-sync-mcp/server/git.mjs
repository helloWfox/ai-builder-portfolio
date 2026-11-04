import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

/** Roda um comando git no repo. Nunca lanca por exit code != 0 -- devolve {ok, stdout, stderr, code}. */
export async function git(cwd, args, { timeout = 120_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  try {
    const { stdout, stderr } = await pexec("git", args, { cwd, timeout, maxBuffer, windowsHide: true });
    return { ok: true, code: 0, stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (err) {
    return {
      ok: false,
      code: typeof err.code === "number" ? err.code : 1,
      stdout: (err.stdout ?? "").toString(),
      stderr: (err.stderr ?? err.message ?? "").toString(),
    };
  }
}

/** Igual a git(), mas lanca com uma mensagem util quando falha. */
export async function gitOrThrow(cwd, args, opts) {
  const r = await git(cwd, args, opts);
  if (!r.ok) throw new Error(`git ${args.join(" ")} falhou (code ${r.code}):\n${r.stderr || r.stdout}`);
  return r.stdout;
}

export async function currentBranch(cwd) {
  const r = await git(cwd, ["branch", "--show-current"]);
  return r.stdout.trim() || null; // vazio = detached HEAD
}

/**
 * Branch padrao do remote. Tenta origin/HEAD; se o repo nunca rodou `set-head`,
 * pergunta ao remote; por ultimo cai em main/master conforme o que existir.
 */
export async function defaultBranch(cwd) {
  const sym = await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (sym.ok && sym.stdout.trim()) return sym.stdout.trim().replace("refs/remotes/origin/", "");

  const remote = await git(cwd, ["ls-remote", "--symref", "origin", "HEAD"], { timeout: 30_000 });
  const m = remote.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
  if (m) return m[1];

  for (const guess of ["main", "master"]) {
    const has = await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${guess}`]);
    if (has.ok) return guess;
  }
  return null;
}

export async function remoteUrl(cwd) {
  const r = await git(cwd, ["remote", "get-url", "origin"]);
  return r.ok ? r.stdout.trim() : null;
}

/** Arquivos alterados no working tree, em formato porcelain v1 parseado. */
export async function workingChanges(cwd) {
  const r = await git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const xy = line.slice(0, 2);
      let path = line.slice(3);
      // renomeados vem como "antigo -> novo"; guardamos o destino
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) path = path.slice(arrow + 4);
      return { xy, status: xy.trim(), path: path.replace(/^"|"$/g, "") };
    });
}

/** Quantos commits o local esta a frente/atras do upstream. null se nao ha upstream. */
export async function aheadBehind(cwd, branch) {
  const up = await git(cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  if (!up.ok) return null;
  const counts = await git(cwd, ["rev-list", "--left-right", "--count", `${branch}...${branch}@{upstream}`]);
  if (!counts.ok) return null;
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  return { upstream: up.stdout.trim(), ahead, behind };
}

export async function lastCommit(cwd) {
  const r = await git(cwd, ["log", "-1", "--pretty=%h|%an|%ar|%s"]);
  if (!r.ok || !r.stdout.trim()) return null;
  const [hash, author, when, ...rest] = r.stdout.trim().split("|");
  return { hash, author, when, subject: rest.join("|") };
}

/** True se o repo esta no meio de um rebase/merge/cherry-pick. */
export async function midOperation(cwd) {
  const dir = await git(cwd, ["rev-parse", "--git-path", "rebase-merge"]);
  const applyDir = await git(cwd, ["rev-parse", "--git-path", "rebase-apply"]);
  const mergeHead = await git(cwd, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]);
  const { existsSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const has = (p) => p.ok && p.stdout.trim() && existsSync(resolve(cwd, p.stdout.trim()));
  if (has(dir) || has(applyDir)) return "rebase";
  if (mergeHead.ok && mergeHead.stdout.trim()) return "merge";
  return null;
}
