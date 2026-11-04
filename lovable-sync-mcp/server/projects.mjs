import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { remoteUrl, currentBranch, defaultBranch, workingChanges, aheadBehind, lastCommit, midOperation } from "./git.mjs";

const CONFIG_NAME = "lovable.config.json";

/** Le lovable.config.json do root do plugin, se existir. */
export async function loadConfig(pluginRoot) {
  const path = join(pluginRoot, CONFIG_NAME);
  const base = {
    roots: [process.env.LOVABLE_MCP_ROOT || "./projetos"],
    ignore: ["node_modules", "dist", "build", ".next", "plugin", "lovable-sync"],
    projects: {}, // nome -> { lovableUrl?, alias?, skip? }
  };
  if (!existsSync(path)) return base;
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return {
      roots: raw.roots?.length ? raw.roots : base.roots,
      ignore: raw.ignore ?? base.ignore,
      projects: raw.projects ?? {},
    };
  } catch (err) {
    // config quebrado nao pode derrubar o server -- segue no default e avisa no log
    process.stderr.write(`[lovable-mcp] ${CONFIG_NAME} invalido, usando defaults: ${err.message}\n`);
    return base;
  }
}

/** Varre os roots e devolve todo diretorio de primeiro nivel que seja um repo git. */
export async function discover(config) {
  const found = [];
  for (const root of config.roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // root inexistente (drive desconectado, etc) -- ignora
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (config.ignore.includes(e.name)) continue;
      const dir = join(root, e.name);
      if (!existsSync(join(dir, ".git"))) continue;
      const meta = config.projects[e.name] ?? {};
      if (meta.skip) continue;
      found.push({ name: e.name, path: resolve(dir), lovableUrl: meta.lovableUrl ?? null });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

/** Resolve um identificador (nome exato, alias, prefixo case-insensitive ou caminho) para um projeto. */
export function resolveProject(projects, config, query) {
  if (!query) throw new Error("informe o projeto");
  const q = query.trim();

  const exact = projects.find((p) => p.name === q);
  if (exact) return exact;

  const alias = Object.entries(config.projects).find(([, v]) => v.alias === q)?.[0];
  if (alias) {
    const p = projects.find((x) => x.name === alias);
    if (p) return p;
  }

  const byPath = projects.find((p) => resolve(p.path) === resolve(q));
  if (byPath) return byPath;

  const lower = q.toLowerCase();
  const partial = projects.filter((p) => p.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new Error(`"${q}" e ambiguo: ${partial.map((p) => p.name).join(", ")}. Use o nome exato.`);
  }
  throw new Error(`projeto "${q}" nao encontrado. Rode list_projects para ver os disponiveis.`);
}

/** Snapshot completo do estado de um projeto. */
export async function inspect(project) {
  const cwd = project.path;
  const [url, branch, def, changes, last, op] = await Promise.all([
    remoteUrl(cwd),
    currentBranch(cwd),
    defaultBranch(cwd),
    workingChanges(cwd),
    lastCommit(cwd),
    midOperation(cwd),
  ]);
  const sync = branch ? await aheadBehind(cwd, branch) : null;

  return {
    ...project,
    remote: url,
    repo: url ? url.replace(/^.*github\.com[/:]/, "").replace(/\.git$/, "") : null,
    branch,
    defaultBranch: def,
    onDefaultBranch: Boolean(branch && def && branch === def),
    dirty: changes.length > 0,
    changes,
    ahead: sync?.ahead ?? 0,
    behind: sync?.behind ?? 0,
    hasUpstream: sync !== null,
    lastCommit: last,
    midOperation: op,
  };
}
