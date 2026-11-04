#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { git } from "./git.mjs";
import { scanDiff } from "./secrets.mjs";
import { loadConfig, discover, resolveProject, inspect } from "./projects.mjs";
import {
  frases, chaveProjeto, loadState, saveState, agora, fase, tick,
  registrarDemanda, concluirDemanda, bloquearDemanda, avisoPendente, liberacaoPendente,
  addPendencia, resolvePendencia, addPergunta, resolvePergunta,
  checarResposta, autorizarResposta, marcarRespostaEnviada, timeFalou,
  bloqueadores, checarMensagem, marcarEnviada, ativo,
} from "./jarvis.mjs";

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..");

let config = await loadConfig(PLUGIN_ROOT);
let projects = await discover(config);

async function refresh() {
  config = await loadConfig(PLUGIN_ROOT);
  projects = await discover(config);
}

// ---------------------------------------------------------------- formatacao

function fmtFindings(findings, title) {
  if (!findings.length) return "";
  const lines = findings.map((f) => `  - [${f.rule}] ${f.label} em ${f.file ?? "?"}: ${f.excerpt}`);
  return `\n${title}\n${lines.join("\n")}`;
}

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

// ---------------------------------------------------------------- operacoes

/**
 * Commita e sobe um projeto, com as travas do modo conservador:
 * so no branch padrao, sem force-push, rebase antes do push, e aborta se achar segredo.
 */
async function commitAndPush(project, { message, files, dryRun = false, allowSecrets = false, allowBranch = false }) {
  const cwd = project.path;
  const s = await inspect(project);
  const out = [`## ${project.name}  (${s.repo ?? cwd})`];

  if (s.midOperation) {
    return { ok: false, report: `${out[0]}\nABORTADO: ha um ${s.midOperation} em andamento. Resolva no repo antes.` };
  }
  if (!s.hasUpstream) {
    return { ok: false, report: `${out[0]}\nABORTADO: branch "${s.branch}" nao tem upstream. Rode: git push -u origin ${s.branch}` };
  }
  if (!s.onDefaultBranch && !allowBranch) {
    return {
      ok: false,
      report: `${out[0]}\nABORTADO: voce esta em "${s.branch}", mas o branch padrao e "${s.defaultBranch}". O Lovable so sincroniza o padrao. Passe allow_branch=true se for intencional.`,
    };
  }

  // Guarda se o index ja tinha algo staged, pra saber se posso desfazer o `add` num abort.
  const preStaged = await git(cwd, ["diff", "--cached", "--name-only"]);
  const indexEraLimpo = preStaged.ok && !preStaged.stdout.trim();

  const addArgs = files?.length ? ["add", "--", ...files] : ["add", "-A"];
  const added = await git(cwd, addArgs);
  if (!added.ok) return { ok: false, report: `${out[0]}\nABORTADO: falha no git add:\n${added.stderr}` };

  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  const stagedFiles = staged.stdout.split("\n").filter(Boolean);

  const desfazerAdd = async () => {
    if (indexEraLimpo) await git(cwd, ["reset"]);
  };

  if (!stagedFiles.length) {
    await desfazerAdd();
    if (s.ahead > 0) {
      if (dryRun) return { ok: true, report: `${out[0]}\n[dry-run] Nada novo pra commitar, mas ha ${s.ahead} commit(s) pra subir.` };
      const pushed = await pushOnly(cwd, s);
      return { ok: pushed.ok, report: `${out[0]}\n${pushed.report}` };
    }
    return { ok: true, skipped: true, report: `${out[0]}\nNada a fazer -- sem mudancas e nada pra subir.` };
  }

  // --- scan de segredos no que vai subir
  const diff = await git(cwd, ["diff", "--cached", "--unified=0"]);
  const { blocking, warnings } = scanDiff(diff.stdout);

  if (blocking.length && !allowSecrets) {
    await desfazerAdd();
    return {
      ok: false,
      report:
        `${out[0]}\nABORTADO: possivel segredo no diff.` +
        fmtFindings(blocking, "Bloqueando:") +
        fmtFindings(warnings, "Avisos:") +
        `\n\nTire do commit (ou coloque no .gitignore) e tente de novo. Se for falso positivo, passe allow_secrets=true.`,
    };
  }

  out.push(`Arquivos: ${stagedFiles.length}`);
  out.push(stagedFiles.slice(0, 20).map((f) => `  ${f}`).join("\n") + (stagedFiles.length > 20 ? `\n  ... +${stagedFiles.length - 20}` : ""));
  if (warnings.length) out.push(fmtFindings(warnings, "Avisos (nao bloqueiam):").trim());

  if (dryRun) {
    await desfazerAdd();
    out.push(`\n[dry-run] Commitaria com "${message}" e daria push em origin/${s.branch}. Nada foi alterado.`);
    return { ok: true, report: out.join("\n") };
  }

  const committed = await git(cwd, ["commit", "-m", message]);
  if (!committed.ok) return { ok: false, report: `${out.join("\n")}\nABORTADO: git commit falhou:\n${committed.stderr || committed.stdout}` };
  const sha = (await git(cwd, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  out.push(`Commit ${sha} criado.`);

  const pushed = await pushOnly(cwd, s);
  out.push(pushed.report);
  return { ok: pushed.ok, report: out.join("\n") };
}

/** pull --rebase seguido de push. Nunca faz force. */
async function pushOnly(cwd, s) {
  const rebased = await git(cwd, ["pull", "--rebase", "--autostash", "origin", s.branch], { timeout: 180_000 });
  if (!rebased.ok) {
    await git(cwd, ["rebase", "--abort"]);
    return {
      ok: false,
      report: `ABORTADO no rebase: conflito com o que ja esta no GitHub (provavelmente o proprio Lovable commitou). Rebase revertido, seu commit continua local.\n${rebased.stderr.trim().split("\n").slice(0, 8).join("\n")}`,
    };
  }

  const pushed = await git(cwd, ["push", "origin", s.branch], { timeout: 180_000 });
  if (!pushed.ok) return { ok: false, report: `ABORTADO no push:\n${pushed.stderr.trim().split("\n").slice(0, 8).join("\n")}` };

  return { ok: true, report: `Push feito em origin/${s.branch}. O Lovable deve puxar a mudanca em alguns segundos.` };
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  {
    name: "commit_push",
    description:
      "Commita as mudancas de UM projeto e da push no branch padrao, fazendo o Lovable puxar a atualizacao pelo GitHub sync. Modo conservador: nunca faz force-push, roda pull --rebase antes, recusa branch fora do padrao e aborta se achar segredo no diff.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Nome do projeto ou caminho." },
        message: { type: "string", description: "Mensagem do commit. Escreva descrevendo o que mudou de fato -- rode `git diff` antes." },
        files: { type: "array", items: { type: "string" }, description: "Caminhos especificos a commitar. Omitido = tudo (git add -A)." },
        dry_run: { type: "boolean", description: "So mostra o que faria, sem commitar nem subir." },
        allow_secrets: { type: "boolean", description: "Ignora o bloqueio do scanner de segredos. So use se confirmou que e falso positivo." },
        allow_branch: { type: "boolean", description: "Permite commitar num branch diferente do padrao (o Lovable nao sincroniza esses)." },
      },
      required: ["project", "message"],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------- modo jarvis

/**
 * Cada conversa do Claude e um projeto: o estado do Jarvis e por projeto, derivado
 * do repo em que a sessao esta rodando. Dois projetos diferentes nunca dividem contador.
 */
const PROJETO = chaveProjeto(process.cwd());

/** Carrega o estado do Jarvis deste projeto, roda fn e persiste. */
async function comEstado(fn) {
  const state = await loadState(PLUGIN_ROOT, PROJETO);
  const out = await fn(state);
  await saveState(PLUGIN_ROOT, PROJETO, state);
  return out;
}

function exigeConfig(state) {
  if (!state.config.groupJid) {
    throw new Error(`modo Jarvis nao configurado para o projeto "${PROJETO.nome}" -- falta o groupJid. Ache o grupo com whatsapp_list_chats e rode jarvis_configure.`);
  }
}

const JARVIS_TOOLS = [
  {
    name: "jarvis_configure",
    description:
      "Liga o modo Jarvis DESTE projeto: grupo e JANELA de trabalho (das X as Y, horario de Brasilia). Cada conversa do Claude e um projeto, entao a config e o estado sao por projeto -- configurar aqui nao mexe nos outros. E a primeira coisa a chamar quando o responsável diz \"ligue o jarvis das 14h as 18h\". Campos omitidos ficam como estao; reset=true zera ciclo, demandas e pendencias.",
    inputSchema: {
      type: "object",
      properties: {
        group_name: { type: "string", description: "Nome do grupo, so pra relatorio." },
        group_jid: { type: "string", description: "JID do grupo (ex: 12036...@g.us). E o unico destino que o portao de saida aceita." },
        team: { type: "array", items: { type: "string" }, description: "Nomes do TIME, cujas mensagens nunca sao demanda (definido em JARVIS_TEAM ou na config). Nao existe lista de clientes -- cliente e quem manda a demanda." },
        start_time: { type: "string", description: "Hora de comecar em HH:MM, Brasilia. Antes disso o tick manda aguardar." },
        stop_time: { type: "string", description: "Hora de encerrar em HH:MM, Brasilia. Depois disso o tick manda cancelar o agendamento." },
        frase_ajuste: { type: "string", description: "Texto exato da 1a frase. Padrao: \"Vamos ajustar\"." },
        frase_liberacao: { type: "string", description: "Texto exato da 2a frase. Padrao: \"Sistema já atualizado com as mudanças\"." },
        enabled: { type: "boolean", description: "Liga/desliga o modo. Tambem e o que ativa o hook de trava do WhatsApp." },
        reset: { type: "boolean", description: "Zera ciclo, demandas e pendencias. Nao mexe na config." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_recon",
    description:
      "RECONHECIMENTO DO AMBIENTE -- rode antes de mexer em qualquer coisa, sempre que o Jarvis liga. Faz fetch da frota, puxa (rebase) o que estiver atrasado e lista os commits recentes por autor, pra voce ver o que um colega (ou outra pessoa) ja resolveu e publicou antes de voce comecar. Nao commita nada.",
    inputSchema: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Janela de commits a olhar, em horas (padrao 12)." },
        pull: { type: "boolean", description: "Puxar o que estiver atrasado (padrao true)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_state",
    description:
      "Estado atual do modo Jarvis sem avancar o ciclo: config, ciclo, demandas abertas/travadas/concluidas, contador ate a liberacao, aviso armado, pendencias e hora de Brasilia. Use pra consultar; use jarvis_tick pra rodar uma leitura.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "jarvis_tick",
    description:
      "Avanca UM ciclo de leitura (chame exatamente uma vez por leitura, no comeco) e devolve o que pode ir pro grupo neste ciclo: nada, a frase de ajuste (1h depois da demanda) ou a de liberacao (2h depois). Ja aplica a janela de horario de Brasilia e as travas que seguram a liberacao.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "jarvis_register_demand",
    description:
      "Registra uma demanda achada no grupo. Cliente e QUEM MANDA A DEMANDA: qualquer pessoa do grupo que peca algo, sem lista previa -- so as mensagens do time (jarvis_state mostra quem) nunca contam. Comeca os dois relogios: frase de ajuste em 2 leituras (1h), frase de liberacao em 4 (2h). Demanda que chega no meio entra no MESMO lote sem empurrar os prazos -- uma mensagem por lote, nunca uma por demanda.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "A demanda em uma linha." },
        from: { type: "string", description: "Quem mandou." },
        source_message: { type: "string", description: "Texto original da mensagem." },
        ja_resolvida_por: { type: "string", description: "Se o recon mostrou que alguem (ex: colega) ja resolveu e publicou. Registre assim e conclua na sequencia, citando o commit dele." },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_complete_demand",
    description:
      "Marca uma demanda como concluida. Exige causa raiz, o que mudou, a PROVA e o commit -- recusa se faltar qualquer um, porque \"esta no codigo\" nao e \"esta feito\". ATENCAO: o commit_push sincroniza o codigo no Lovable mas NAO publica; o que o cliente ve so muda depois de publicar com a tool deploy_project, do MCP oficial da Lovable. So conclua depois de publicar e conferir no ar.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Id da demanda (ex: d3)." },
        root_cause: { type: "string", description: "A causa raiz encontrada." },
        change: { type: "string", description: "O que foi mudado." },
        proof: { type: "string", description: "Como voce provou: o que conferiu no app NO AR depois de PUBLICAR o projeto no Lovable. Push sozinho nao publica." },
        commit: { type: "string", description: "Sha do commit publicado (o seu, ou o de um colega se ele resolveu antes)." },
      },
      required: ["id", "root_cause", "change", "proof", "commit"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_block_demand",
    description: "Marca uma demanda como travada por impedimento tecnico concreto. Segura a liberacao ate resolver.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, reason: { type: "string", description: "O impedimento, concreto." } },
      required: ["id", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_pendencia",
    description:
      "Pendencias suas que seguram a frase de liberacao: prova que nao saiu, publicacao nao conferida, autorizacao pendente do responsável. Para pergunta do CLIENTE use jarvis_pergunta -- aquela trava tudo, essa so a liberacao.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "resolve", "list"] },
        text: { type: "string", description: "Para add: a pendencia." },
        id: { type: "string", description: "Para resolve: o id (ex: p7)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_pergunta",
    description:
      "Pergunta do cliente no grupo que ainda nao foi respondida. Enquanto houver uma, NENHUMA mensagem sai -- nem a de ajuste, nem a de liberacao -- porque mandar frase por cima de uma duvida em aberto escancara que ninguem leu o que ele perguntou. Registre a pergunta, escreva o rascunho da resposta pro responsável mandar, e resolva quando ele tiver respondido. As frases represadas saem sozinhas depois.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "resolve", "list"] },
        text: { type: "string", description: "Para add: a pergunta, como ela foi feita." },
        from: { type: "string", description: "Para add: quem perguntou." },
        id: { type: "string", description: "Para resolve: o id (ex: q2)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_answer",
    description:
      "Responde o cliente no grupo com texto livre -- o unico caso alem das duas frases. ESCOPO ESTREITO DE PROPOSITO: so passa o que da pra PROVAR por uma demanda ja concluida (com commit e prova). Prazo, preco, escopo, viabilidade, opiniao e pergunta de volta NUNCA passam -- viram rascunho pro responsável. Antes de escrever, leia as mensagens anteriores do responsável neste grupo e escreva como ELE escreveria: curto, direto, sem saudacao, sem emoji, sem formula de atendimento, no maximo 2 frases. action=check valida o rascunho e autoriza; action=sent registra depois do whatsapp_send_message dar certo; action=time_falou destrava quando o responsável ou alguem do time falar no grupo.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["check", "sent", "time_falou"] },
        text: { type: "string", description: "Para check e sent: o texto exato da resposta." },
        pergunta_id: { type: "string", description: "Para check: a pergunta aberta que ela responde (ex: q3)." },
        demanda_id: { type: "string", description: "Para check: a demanda CONCLUIDA que prova o que voce esta afirmando (ex: d2)." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_check_message",
    description:
      "PORTAO DE SAIDA -- obrigatorio antes de qualquer whatsapp_send_message no modo Jarvis. Autoriza as duas frases exatas (se o tick deste ciclo tiver autorizado) e uma resposta livre ja aprovada por jarvis_answer neste ciclo, sempre no jid do grupo deste projeto. Qualquer outra coisa vira rascunho pro responsável mandar.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "O texto que voce pretende enviar." },
        jid: { type: "string", description: "Destino pretendido." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "jarvis_mark_sent",
    description:
      "Registra que a frase foi realmente enviada. So chame DEPOIS do whatsapp_send_message dar certo. \"Vamos ajustar\" limpa o lote; \"Podem seguir com os testes\" zera o contador de 4.",
    inputSchema: {
      type: "object",
      properties: { phrase: { type: "string", description: "A frase enviada, exata." } },
      required: ["phrase"],
      additionalProperties: false,
    },
  },
];

function fmtJarvisState(s) {
  const t = agora(s.config.timezone);
  const abertas = s.demands.filter((d) => d.status === "open");
  const travadas = s.demands.filter((d) => d.status === "blocked");
  const feitas = s.demands.filter((d) => d.status === "done");
  const b = bloqueadores(s);
  const f = frases(s);
  const aviso = avisoPendente(s);
  const lib = liberacaoPendente(s);
  const janela = fase(s);

  const linhas = [
    `## Modo Jarvis -- projeto ${s.projeto} ${
      ativo(s) ? "(ligado)"
      : s.config.enabled ? `(inativo -- ${fase(s) === "encerrar" ? `passou das ${s.config.stopTime}` : `janela e do dia ${s.janelaDia}`})`
      : "(desligado)"}`,
    `Agora:    ${t.completo} (Brasilia)`,
    `Grupo:    ${s.config.groupName ?? "?"} ${s.config.groupJid ? `<${s.config.groupJid}>` : "-- JID NAO CONFIGURADO"}`,
    `Time:     ${s.config.team?.join(", ") || "(vazio)"} -- mensagem deles nao e demanda; cliente e qualquer outro que peca algo`,
    `Janela:   ${s.config.startTime ?? "(sem inicio)"} as ${s.config.stopTime}${janela ? `  -- ${janela === "aguardar" ? "AINDA NAO COMECOU" : "JA ENCERROU"}` : "  -- dentro da janela"}`,
    `Ciclo:    ${s.cycle}`,
    `Recon:    ${s.recon ? `${s.recon.quando} -- ${s.recon.resumo}` : "nao rodado"}`,
    `Ultimo envio: ${s.lastSentCycle !== null ? `ciclo ${s.lastSentCycle} ("${s.history.at(-1)?.phrase ?? s.history.at(-1)?.text}")` : "nenhum"}`,
    s.aguardandoTime ? "AGUARDANDO O TIME: voce ja respondeu o cliente; so responde de novo quando o responsável (ou alguem do time) falar no grupo." : null,
    "",
    aviso
      ? `"${f.ajuste}" no ciclo ${aviso.dueAtCycle} (lote ${aviso.demandIds.join(", ")}${aviso.due ? " -- VENCIDO, sai neste ciclo" : `, faltam ${aviso.dueAtCycle - s.cycle}`})`
      : `"${f.ajuste}": nada armado`,
    lib
      ? `"${f.libera}" no ciclo ${lib.dueAtCycle} (lote ${lib.demandIds.join(", ")}${lib.due ? " -- VENCIDO" : `, faltam ${lib.dueAtCycle - s.cycle}`})`
      : `"${f.libera}": nada armado`,
    "",
    abertas.length ? `Abertas (${abertas.length}):` : "Nenhuma demanda aberta.",
    ...abertas.map((d) => `  ${d.id}  ${d.summary}${d.from ? ` -- ${d.from}` : ""}`),
    ...(travadas.length ? [`Travadas (${travadas.length}):`, ...travadas.map((d) => `  ${d.id}  ${d.summary} -- ${d.blockedReason}`)] : []),
    ...(feitas.length ? [`Concluidas (${feitas.length}):`, ...feitas.map((d) => `  ${d.id}  ${d.summary} -- ${d.commit}`)] : []),
    ...(s.pendencias.length ? ["", `Pendencias (${s.pendencias.length}):`, ...s.pendencias.map((p) => `  ${p.id}  ${p.text}`)] : []),
    ...(s.perguntas.length
      ? ["", `GRUPO TRAVADO -- pergunta(s) do cliente sem resposta (${s.perguntas.length}):`,
         ...s.perguntas.map((q) => `  ${q.id}  ${q.from ? `${q.from}: ` : ""}${q.text}`)]
      : []),
    "",
    b.length ? `"${f.libera}" BLOQUEADA por:\n${b.map((x) => `  - ${x}`).join("\n")}` : `Nada bloqueia "${f.libera}".`,
  ];
  return linhas.filter((l) => l !== null).join("\n");
}

/** Valida um rascunho de resposta ao cliente e, passando, autoriza o envio neste ciclo. */
async function respostaCheck(args) {
  return await comEstado((s) => {
    exigeConfig(s);
    const r = checarResposta(s, { texto: args.text, perguntaId: args.pergunta_id, demandaId: args.demanda_id });
    if (!r.autorizado) return fail(`NAO AUTORIZADO: ${r.motivo}\n${r.orientacao}`);
    autorizarResposta(s, r);
    return text([
      `AUTORIZADO responder ${r.perguntaId} com:`,
      `  "${r.texto}"`,
      `Ancorada em ${r.demandaId} (${r.ancora.summary}) -- commit ${r.ancora.commit}.`,
      `Mande com whatsapp_send_message no jid ${s.config.groupJid} e depois chame jarvis_answer sent.`,
      "Depois disso voce so responde de novo quando alguem do time falar no grupo.",
    ].join("\n"));
  });
}

/** Registra que a resposta saiu: resolve a pergunta e entra em silencio ate o time falar. */
async function respostaSent(args) {
  return text(await comEstado((s) => {
    const r = marcarRespostaEnviada(s, args.text);
    const restam = s.perguntas.length;
    return [
      `Registrado: resposta a ${r.perguntaId} enviada no ciclo ${s.cycle}.`,
      restam ? `Ainda ha ${restam} pergunta(s) em aberto -- as frases seguem travadas.` : "Nao ha mais pergunta em aberto.",
      "Voce esta em silencio ate alguem do time falar no grupo (jarvis_answer time_falou).",
    ].join("\n");
  }));
}

// ---------------------------------------------------------------- handlers

const server = new Server(
  { name: "lovable-sync", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...TOOLS, ...JARVIS_TOOLS] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    await refresh();

    if (name === "commit_push") {
      const p = resolveProject(projects, config, args.project);
      const r = await commitAndPush(p, {
        message: args.message,
        files: args.files,
        dryRun: args.dry_run,
        allowSecrets: args.allow_secrets,
        allowBranch: args.allow_branch,
      });
      return r.ok ? text(r.report) : fail(r.report);
    }

    // ------------------------------------------------------------ jarvis

    if (name === "jarvis_configure") {
      return text(await comEstado((s) => {
        if (args.group_name !== undefined) s.config.groupName = args.group_name;
        if (args.group_jid !== undefined) s.config.groupJid = args.group_jid;
        if (args.team !== undefined) s.config.team = args.team;
        for (const [arg, campo] of [["start_time", "startTime"], ["stop_time", "stopTime"]]) {
          if (args[arg] === undefined) continue;
          if (args[arg] !== null && !/^\d{2}:\d{2}$/.test(args[arg])) throw new Error(`${arg} deve ser HH:MM (ex: 08:30)`);
          s.config[campo] = args[arg];
        }
        if (s.config.startTime && s.config.stopTime && s.config.startTime >= s.config.stopTime) {
          throw new Error(`janela invalida: comeca as ${s.config.startTime} e encerra as ${s.config.stopTime}`);
        }
        if (args.frase_ajuste !== undefined) s.config.fraseAjuste = args.frase_ajuste;
        if (args.frase_liberacao !== undefined) s.config.fraseLiberacao = args.frase_liberacao;
        if (args.enabled !== undefined) {
          s.config.enabled = args.enabled;
          // carimba o dia: janela ligada ontem nao continua valendo hoje
          s.janelaDia = args.enabled ? agora(s.config.timezone).data : null;
        }
        if (args.reset) {
          Object.assign(s, {
            cycle: 0, nextDemandId: 1, nextPendenciaId: 1, nextPerguntaId: 1,
            demands: [], pendencias: [], perguntas: [],
            respostaAutorizada: null, aguardandoTime: false,
            lastSentCycle: null, currentPlan: null, history: [], recon: null,
          });
        }
        return `${args.reset ? "Estado zerado.\n\n" : ""}${fmtJarvisState(s)}`;
      }));
    }

    if (name === "jarvis_state") {
      const s = await loadState(PLUGIN_ROOT, PROJETO);
      return text(fmtJarvisState(s));
    }

    if (name === "jarvis_recon") {
      const horas = args.hours ?? 12;
      const puxar = args.pull !== false;

      // fetch da frota em paralelo -- sequencial em 19 repos estoura o tempo da chamada
      await Promise.all(projects.map((p) => git(p.path, ["fetch", "origin"], { timeout: 60_000 })));

      const linhas = [];
      const autores = new Map();
      let mexidos = 0, conflitos = 0;

      for (const p of projects) {
        const s = await inspect(p);
        if (!s.hasUpstream) { linhas.push(`${p.name}: sem upstream, pulado`); continue; }
        if (s.midOperation) { linhas.push(`${p.name}: ${s.midOperation} em andamento, pulado`); continue; }

        const log = await git(p.path, ["log", `--since=${horas} hours ago`, "--pretty=%h|%an|%ar|%s", `origin/${s.branch}`]);
        const commits = log.stdout.split("\n").filter(Boolean).map((l) => l.split("|"));

        let acao = "ja atualizado";
        if (s.behind > 0) {
          if (puxar) {
            const r = await git(p.path, ["pull", "--rebase", "--autostash", "origin", s.branch], { timeout: 180_000 });
            if (r.ok) {
              acao = `puxado ${s.behind} commit(s)`;
            } else {
              await git(p.path, ["rebase", "--abort"]);
              acao = `CONFLITO ao puxar -- ${r.stderr.trim().split("\n")[0]}`;
              conflitos++;
            }
          } else {
            acao = `${s.behind} commit(s) atras, nao puxado`;
          }
        }

        const sujo = s.dirty ? `  -- ${s.changes.length} arquivo(s) alterado(s) local` : "";
        if (commits.length) {
          mexidos++;
          linhas.push(`\n${p.name} [${acao}]${sujo}`);
          for (const [h, autor, quando, ...resto] of commits) {
            autores.set(autor, (autores.get(autor) ?? 0) + 1);
            linhas.push(`   ${h}  ${autor} (${quando}): ${resto.join("|")}`);
          }
        } else if (s.dirty || conflitos) {
          linhas.push(`\n${p.name} [${acao}]${sujo}`);
        }
      }

      const porAutor = [...autores.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a} (${n})`).join(", ");
      const resumo = `${mexidos} projeto(s) com commit nas ultimas ${horas}h${porAutor ? ` -- ${porAutor}` : ""}${conflitos ? `, ${conflitos} CONFLITO(S)` : ""}`;
      await comEstado((s) => { s.recon = { quando: agora(s.config.timezone).completo, resumo, horas }; });

      return text([
        `## Reconhecimento do ambiente -- ${agora().completo} (Brasilia)`,
        `Projeto desta sessao: ${PROJETO.nome}`,
        resumo,
        conflitos ? "\nATENCAO: conflito ao puxar. Resolva antes de comecar a trabalhar." : null,
        linhas.length ? linhas.join("\n") : "\nNenhum movimento na frota.",
        "\nAntes de mexer em qualquer coisa: para cada demanda do grupo, confira nesses commits se alguem ja resolveu e publicou. Se sim, registre com ja_resolvida_por e conclua citando o commit dele -- nao refaca o trabalho.",
      ].filter(Boolean).join("\n"));
    }

    if (name === "jarvis_tick") {
      return await comEstado((s) => {
        exigeConfig(s);
        if (!s.recon) throw new Error("rode jarvis_recon antes do primeiro tick -- e preciso saber o que ja foi feito e publicado antes de comecar.");
        const p = tick(s);
        const corpo = [
          `Ciclo ${p.ciclo} -- ${p.horaBrasilia} (Brasilia)`,
          `Abertas: ${p.abertas} | Travadas: ${p.travadas} | Concluidas: ${p.concluidas} | Pendencias: ${p.pendencias} | Perguntas do cliente: ${p.perguntas}`,
          "",
          p.janela === "encerrar" ? "ENCERRAR: cancele o agendamento e avise o responsável." : null,
          p.janela === "aguardar" ? "AGUARDAR: a janela ainda nao abriu." : null,
          `Acao no grupo: ${p.frase ? `mandar "${p.frase}"` : "nenhuma"}`,
          p.motivo,
        ].filter(Boolean).join("\n");
        // fora da janela vira "erro" de proposito: forca o modelo a nao seguir em frente
        return p.janela ? fail(corpo) : text(corpo);
      });
    }

    if (name === "jarvis_register_demand") {
      return text(await comEstado((s) => {
        exigeConfig(s);
        const f = frases(s);
        const r = registrarDemanda(s, {
          summary: args.summary, from: args.from,
          sourceMessage: args.source_message, jaResolvidaPor: args.ja_resolvida_por,
        });
        return [
          `Demanda ${r.id} registrada${args.ja_resolvida_por ? ` (ja resolvida por ${args.ja_resolvida_por} -- conclua citando o commit dele)` : ""}.`,
          `"${f.ajuste}" sai no ciclo ${r.avisoNoCiclo}, num lote de ${r.loteCom} demanda(s).`,
          `"${f.libera}" sai no ciclo ${r.liberacaoNoCiclo}, se ate la estiver tudo publicado e conferido.`,
          "Nao mande nada no grupo agora.",
        ].join("\n");
      }));
    }

    if (name === "jarvis_complete_demand") {
      return text(await comEstado((s) => {
        const r = concluirDemanda(s, {
          id: args.id, rootCause: args.root_cause, change: args.change,
          proof: args.proof, commit: args.commit,
        });
        const f = frases(s);
        const b = bloqueadores(s);
        const extra = b.length
          ? `\n"${f.libera}" ainda segurada por:\n${b.map((x) => `  - ${x}`).join("\n")}`
          : `\nNada mais segura: "${f.libera}" sai no ciclo ${r.liberacaoNoCiclo}.`;
        return `Demanda ${args.id} concluida. Lote: ${r.concluidas}/${r.total} pronta(s).${extra}`;
      }));
    }

    if (name === "jarvis_block_demand") {
      return text(await comEstado((s) => {
        const d = bloquearDemanda(s, { id: args.id, reason: args.reason });
        return `Demanda ${d.id} travada: ${d.blockedReason}\nSegura a liberacao ate resolver.`;
      }));
    }

    if (name === "jarvis_pendencia") {
      return text(await comEstado((s) => {
        if (args.action === "add") {
          const p = addPendencia(s, args.text);
          return `Pendencia ${p.id} anotada: ${p.text}\nSegura a liberacao ate resolver.`;
        }
        if (args.action === "resolve") {
          const p = resolvePendencia(s, args.id);
          return `Pendencia ${p.id} resolvida: ${p.text}`;
        }
        return s.pendencias.length
          ? s.pendencias.map((p) => `${p.id}  ${p.text}`).join("\n")
          : "Nenhuma pendencia.";
      }));
    }

    if (name === "jarvis_pergunta") {
      return text(await comEstado((s) => {
        if (args.action === "add") {
          const q = addPergunta(s, { texto: args.text, from: args.from });
          return `Pergunta ${q.id} anotada${q.from ? ` (${q.from})` : ""}: ${q.text}\nEnquanto ela estiver aberta NENHUMA mensagem sai no grupo. Escreva o rascunho da resposta pro responsável mandar.`;
        }
        if (args.action === "resolve") {
          const q = resolvePergunta(s, args.id);
          const resta = s.perguntas.length;
          return `Pergunta ${q.id} respondida: ${q.text}\n${resta ? `Ainda ha ${resta} pergunta(s) em aberto -- o grupo segue travado.` : "Nao ha mais pergunta em aberto; as frases represadas voltam a poder sair."}`;
        }
        return s.perguntas.length
          ? s.perguntas.map((q) => `${q.id}  ${q.from ? `${q.from}: ` : ""}${q.text}`).join("\n")
          : "Nenhuma pergunta em aberto.";
      }));
    }

    if (name === "jarvis_answer") {
      if (args.action === "time_falou") {
        return text(await comEstado((s) => {
          const estava = timeFalou(s);
          return estava
            ? "Destravado -- alguem do time falou no grupo, entao voce pode responder o cliente de novo se houver fato provado."
            : "Nao havia trava; voce ja podia responder.";
        }));
      }
      if (args.action === "check") return await respostaCheck(args);
      if (args.action === "sent") return await respostaSent(args);
      return fail(`action "${args.action}" invalida`);
    }

    if (name === "jarvis_check_message") {
      const s = await loadState(PLUGIN_ROOT, PROJETO);
      const r = checarMensagem(s, { text: args.text, jid: args.jid });
      return r.autorizado
        ? text(`AUTORIZADO: enviar "${r.frase}" para ${r.jid}.\n${r.motivo}\nDepois que o envio der certo, chame jarvis_mark_sent.`)
        : fail(`NAO AUTORIZADO: ${r.motivo}\n${r.orientacao}`);
    }

    if (name === "jarvis_mark_sent") {
      return text(await comEstado((s) => {
        const r = marcarEnviada(s, args.phrase);
        return `Registrado: "${r.registrado}" enviada no ciclo ${r.ciclo}.\n\n${fmtJarvisState(s)}`;
      }));
    }

    return fail(`Tool desconhecida: ${name}`);
  } catch (err) {
    return fail(`Erro em ${name}: ${err.message}`);
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(`[lovable-sync] pronto -- ${projects.length} projeto(s) em ${config.roots.join(", ")}; jarvis no projeto "${PROJETO.nome}"\n`);
