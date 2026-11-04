import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";

/**
 * Estado do modo Jarvis: leitura de um grupo de WhatsApp a cada 30 min,
 * com as duas unicas frases permitidas e os prazos que decidem quando manda-las.
 *
 * O estado vive em disco porque cada ciclo do loop e um contexto novo -- o modelo
 * nao lembra do ciclo anterior, entao quem lembra e este arquivo.
 */

export const FRASE_AJUSTE_PADRAO = "Vamos ajustar";
export const FRASE_LIBERA_PADRAO = "Sistema já atualizado com as mudanças";

const CICLOS_ATE_AVISO = 2;      // 1 hora a 30 min: "Vamos ajustar"
const CICLOS_ATE_LIBERACAO = 4;  // 2 horas: "Sistema já atualizado com as mudanças"
const CICLOS_ENTRE_ENVIOS = 2;   // nunca duas mensagens juntas: 1 hora de silencio entre elas

/** As duas frases em vigor. Configuraveis pra corrigir texto sem mexer em codigo. */
export const frases = (state) => ({
  ajuste: state.config.fraseAjuste || FRASE_AJUSTE_PADRAO,
  libera: state.config.fraseLiberacao || FRASE_LIBERA_PADRAO,
});

/**
 * Cada conversa do Claude e um projeto, entao cada projeto tem o seu grupo, os seus
 * contadores e o seu estado. A chave sai do repo em que a sessao esta rodando --
 * assim funciona igual no servidor e no hook, sem depender da lista da frota.
 */
export function chaveProjeto(cwd = process.cwd()) {
  const inicio = resolve(cwd);
  let dir = inicio;
  let achou = false;
  for (let i = 0; i < 30; i++) {
    if (existsSync(join(dir, ".git"))) { achou = true; break; }
    const pai = dirname(dir);
    if (pai === dir) break;
    dir = pai;
  }
  const nome = basename(achou ? dir : inicio);
  const slug = nome.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sem-projeto";
  return { nome, slug, raiz: achou ? dir : inicio };
}

const VAZIO = {
  projeto: null,
  config: {
    groupName: null,
    groupJid: null,
    // Cliente e QUEM MANDA A DEMANDA -- nao ha lista de clientes. Aqui ficam so os
    // nomes do time, cujas mensagens nunca contam como demanda.
    team: (process.env.JARVIS_TEAM || "").split(",").map((s) => s.trim()).filter(Boolean), // ex.: JARVIS_TEAM="Ana,Bruno"
    startTime: null,
    stopTime: "18:00",
    timezone: "America/Sao_Paulo",
    fraseAjuste: FRASE_AJUSTE_PADRAO,
    fraseLiberacao: FRASE_LIBERA_PADRAO,
    enabled: false,
  },
  janelaDia: null,    // dia (DD/MM/AAAA) em que a janela foi ligada -- janela de ontem nao vale hoje
  cycle: 0,
  lastTickAt: null,
  nextDemandId: 1,
  nextPendenciaId: 1,
  nextPerguntaId: 1,
  demands: [],
  pendencias: [],
  perguntas: [],       // pergunta do cliente sem resposta -- trava QUALQUER mensagem
  respostaAutorizada: null, // { cycle, texto, perguntaId, demandaId } liberada pelo checarResposta
  aguardandoTime: false,    // ja respondeu o cliente; so responde de novo depois que alguem do time falar
  lastSentCycle: null,
  currentPlan: null,   // { cycle, action } -- o que o tick autorizou AGORA
  history: [],
  recon: null,         // resultado do reconhecimento inicial
};

function statePath(pluginRoot, projeto) {
  return join(pluginRoot, "jarvis-state", `${projeto.slug}.json`);
}

export async function loadState(pluginRoot, projeto) {
  const vazio = { ...structuredClone(VAZIO), projeto: projeto.nome };
  const path = statePath(pluginRoot, projeto);
  if (!existsSync(path)) return vazio;
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    // merge raso com o default: campo novo em versao nova nao quebra estado antigo
    return { ...vazio, ...raw, projeto: projeto.nome, config: { ...VAZIO.config, ...(raw.config ?? {}) } };
  } catch (err) {
    process.stderr.write(`[jarvis] estado de ${projeto.nome} ilegivel (${err.message}), comecando do zero\n`);
    return vazio;
  }
}

/** Grava atomico: tmp + rename, pra nao deixar o estado pela metade se morrer no meio. */
export async function saveState(pluginRoot, projeto, state) {
  const path = statePath(pluginRoot, projeto);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------- tempo

/** Agora no fuso configurado (padrao America/Sao_Paulo). Nunca UTC. */
export function agora(timezone = "America/Sao_Paulo") {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return {
    hhmm: `${p.hour}:${p.minute}`,
    data: `${p.day}/${p.month}/${p.year}`,
    completo: `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`,
    timezone,
  };
}

/** "aguardar" antes da hora de comecar, "encerrar" depois da de parar, null dentro da janela. */
export function fase(state) {
  const { startTime, stopTime, timezone } = state.config;
  const h = agora(timezone).hhmm;
  if (stopTime && h > stopTime) return "encerrar";
  if (startTime && h < startTime) return "aguardar";
  return null;
}

/**
 * O modo esta REALMENTE ativo? `config.enabled` sozinho nao basta: ele fica ligado no arquivo
 * ate alguem desligar, e ja aconteceu de sobrar ligado depois da janela (11/09/2026) -- o que
 * mantinha a guarda barrando WhatsApp fora do horario. Aqui o horario manda:
 *   - passou do stopTime de hoje  -> inativo
 *   - a janela foi ligada em outro dia -> inativo (nao herda o dia anterior)
 */
export function ativo(state) {
  if (!state.config.enabled) return false;
  if (fase(state) === "encerrar") return false;
  if (state.janelaDia && state.janelaDia !== agora(state.config.timezone).data) return false;
  return true;
}

// ---------------------------------------------------------------- prazos das duas frases

/**
 * Os dois prazos sao DERIVADOS das demandas, nao guardados em contador a parte --
 * assim uma demanda nunca e anunciada no ciclo em que foi encontrada, e o relogio
 * nao desacerta se um ciclo falhar.
 *
 * Aviso: vence 2 leituras (1h) depois da demanda mais antiga ainda nao avisada.
 * Liberacao: vence 4 leituras (2h) depois da demanda mais antiga ainda em aberto no lote.
 * Nos dois casos todas as demandas do lote saem numa mensagem so.
 */
export function avisoPendente(state) {
  const naoAvisadas = state.demands.filter((d) => !d.announced);
  if (!naoAvisadas.length) return null;
  const dueAtCycle = Math.min(...naoAvisadas.map((d) => d.foundAtCycle)) + CICLOS_ATE_AVISO;
  return { demandIds: naoAvisadas.map((d) => d.id), dueAtCycle, due: state.cycle >= dueAtCycle };
}

export function liberacaoPendente(state) {
  if (!state.demands.length) return null;
  const dueAtCycle = Math.min(...state.demands.map((d) => d.foundAtCycle)) + CICLOS_ATE_LIBERACAO;
  return {
    demandIds: state.demands.map((d) => d.id),
    dueAtCycle,
    due: state.cycle >= dueAtCycle,
  };
}

// ---------------------------------------------------------------- demandas

export function registrarDemanda(state, { from, summary, sourceMessage, jaResolvidaPor }) {
  if (!summary?.trim()) throw new Error("summary e obrigatorio -- descreva a demanda em uma linha");
  const id = `d${state.nextDemandId++}`;
  state.demands.push({
    id,
    from: from ?? null,
    summary: summary.trim(),
    sourceMessage: sourceMessage ?? null,
    status: "open",
    announced: false,
    foundAtCycle: state.cycle,
    jaResolvidaPor: jaResolvidaPor ?? null, // ex: "colega", quando o recon achou pronto
    rootCause: null, change: null, proof: null, commit: null,
    completedAtCycle: null, blockedReason: null,
    createdAt: new Date().toISOString(),
  });
  const aviso = avisoPendente(state);
  const lib = liberacaoPendente(state);
  return { id, avisoNoCiclo: aviso.dueAtCycle, liberacaoNoCiclo: lib.dueAtCycle, loteCom: aviso.demandIds.length };
}

export function concluirDemanda(state, { id, rootCause, change, proof, commit }) {
  const d = state.demands.find((x) => x.id === id);
  if (!d) throw new Error(`demanda "${id}" nao existe`);
  if (d.status === "done") throw new Error(`demanda "${id}" ja estava concluida`);

  // "Esta no codigo" nao e "esta feito": sem prova e sem commit, nao conclui.
  const faltando = Object.entries({ rootCause, change, proof, commit })
    .filter(([, v]) => !v?.trim())
    .map(([k]) => k);
  if (faltando.length) {
    throw new Error(`nao da pra concluir sem: ${faltando.join(", ")}. ATENCAO: commit e push sincronizam o CODIGO no Lovable, nao publicam -- o que esta no ar so muda depois de publicar. Prova = conferir no app publicado DEPOIS da publicacao.`);
  }

  Object.assign(d, {
    status: "done",
    rootCause: rootCause.trim(), change: change.trim(),
    proof: proof.trim(), commit: commit.trim(),
    completedAtCycle: state.cycle,
  });
  const lib = liberacaoPendente(state);
  return {
    concluidas: state.demands.filter((x) => x.status === "done").length,
    total: state.demands.length,
    liberacaoNoCiclo: lib?.dueAtCycle ?? null,
  };
}

export function bloquearDemanda(state, { id, reason }) {
  const d = state.demands.find((x) => x.id === id);
  if (!d) throw new Error(`demanda "${id}" nao existe`);
  if (!reason?.trim()) throw new Error("reason e obrigatorio");
  d.status = "blocked";
  d.blockedReason = reason.trim();
  return d;
}

// ---------------------------------------------------------------- pendencias

export function addPendencia(state, texto) {
  if (!texto?.trim()) throw new Error("texto e obrigatorio");
  const p = { id: `p${state.nextPendenciaId++}`, text: texto.trim(), createdAt: new Date().toISOString() };
  state.pendencias.push(p);
  return p;
}

export function resolvePendencia(state, id) {
  const i = state.pendencias.findIndex((p) => p.id === id);
  if (i === -1) throw new Error(`pendencia "${id}" nao existe`);
  return state.pendencias.splice(i, 1)[0];
}

// ---------------------------------------------------------------- perguntas do cliente

/**
 * Pergunta do cliente sem resposta trava QUALQUER mensagem no grupo -- inclusive o
 * "Vamos ajustar". Mandar uma frase por cima de uma duvida em aberto escancara que
 * ninguem leu o que ele perguntou.
 */
export function addPergunta(state, { texto, from }) {
  if (!texto?.trim()) throw new Error("texto e obrigatorio -- qual foi a pergunta");
  const q = { id: `q${state.nextPerguntaId++}`, text: texto.trim(), from: from ?? null, createdAt: new Date().toISOString() };
  state.perguntas.push(q);
  return q;
}

export function resolvePergunta(state, id) {
  const i = state.perguntas.findIndex((q) => q.id === id);
  if (i === -1) throw new Error(`pergunta "${id}" nao existe`);
  return state.perguntas.splice(i, 1)[0];
}

/** Tudo que impede a frase de liberacao. */
export function bloqueadores(state) {
  const f = frases(state);
  const b = [];
  for (const d of state.demands.filter((x) => x.status === "open")) b.push(`demanda ${d.id} ainda aberta: ${d.summary}`);
  for (const d of state.demands.filter((x) => x.status === "blocked")) b.push(`demanda ${d.id} travada: ${d.blockedReason}`);
  for (const p of state.pendencias) b.push(`pendencia ${p.id}: ${p.text}`);
  for (const q of state.perguntas) b.push(`pergunta ${q.id} do cliente sem resposta: ${q.text}`);
  const aviso = avisoPendente(state);
  if (aviso) b.push(`"${f.ajuste}" ainda nao enviado para ${aviso.demandIds.join(", ")} (ciclo ${aviso.dueAtCycle})`);
  return b;
}

// ---------------------------------------------------------------- ciclo

/**
 * Avanca um ciclo de leitura e decide o que pode ir pro grupo.
 * Chamar UMA vez por leitura -- e a chamada que move o relogio interno.
 */
export function tick(state) {
  state.cycle += 1;
  state.lastTickAt = new Date().toISOString();
  const t = agora(state.config.timezone);
  const f = frases(state);
  const janela = fase(state);
  const aviso = avisoPendente(state);
  const lib = liberacaoPendente(state);

  let acao = "nenhuma";
  let motivo;

  if (janela === "encerrar") {
    // desliga de verdade: so avisar nao bastava, o estado ficava ligado ate alguem lembrar
    state.config.enabled = false;
    motivo = `Passou das ${state.config.stopTime} (agora ${t.hhmm}, Brasilia). **Modo Jarvis DESLIGADO automaticamente.** Cancele o agendamento e avise o responsável. Nao mande nada no grupo.`;
  } else if (janela === "aguardar") {
    motivo = `A janela comeca as ${state.config.startTime} (agora ${t.hhmm}, Brasilia). Nao leia nem mande nada ainda.`;
  } else if (state.perguntas.length) {
    // Trava tudo, inclusive o aviso: frase por cima de duvida em aberto escancara que ninguem leu.
    const lista = state.perguntas.map((q) => `  - ${q.id}${q.from ? ` (${q.from})` : ""}: ${q.text}`).join("\n");
    motivo = [
      "Nenhuma FRASE sai -- ha pergunta do cliente sem resposta:",
      lista,
      state.aguardandoTime
        ? "Voce ja respondeu uma vez e ninguem do time falou desde entao: esta escala pro responsável, faca rascunho."
        : "Se der pra responder com fato que voce PROVA (demanda concluida, com commit e prova), use jarvis_answer. Senao, rascunho pro responsável.",
      "Respondida ou resolvida a pergunta, as frases represadas saem sozinhas.",
    ].join("\n");
  } else if (state.lastSentCycle !== null && state.cycle - state.lastSentCycle < CICLOS_ENTRE_ENVIOS) {
    // Nunca duas mensagens juntas.
    const faltam = CICLOS_ENTRE_ENVIOS - (state.cycle - state.lastSentCycle);
    motivo = `Ja foi mandada mensagem no ciclo ${state.lastSentCycle}. Segura mais ${faltam} leitura(s) antes da proxima -- o grupo nao pode receber duas seguidas.`;
  } else if (aviso?.due) {
    // Prioridade sobre a liberacao: nao faz sentido avisar de ajuste e dizer que ja atualizou no mesmo ciclo.
    acao = "vamos_ajustar";
    motivo = `Lote de ${aviso.demandIds.length} demanda(s) (${aviso.demandIds.join(", ")}) completou 1 hora. Mande "${f.ajuste}" UMA vez, pro lote inteiro, e chame jarvis_mark_sent.`;
  } else if (lib?.due) {
    const b = bloqueadores(state);
    if (b.length === 0) {
      acao = "liberacao";
      motivo = `Passaram as 2 horas e as ${lib.demandIds.length} demanda(s) do lote estao implementadas, publicadas e conferidas. Mande "${f.libera}" e chame jarvis_mark_sent.`;
    } else {
      motivo = `As 2 horas venceram, mas a frase NAO pode sair -- ha pendencia:\n${b.map((x) => `  - ${x}`).join("\n")}\nExplique isso ao responsável e nao mande nada no grupo. Sai sozinho quando limpar.`;
    }
  } else if (aviso) {
    motivo = `"${f.ajuste}" sai no ciclo ${aviso.dueAtCycle} (faltam ${aviso.dueAtCycle - state.cycle}). Nao mande nada agora -- use o tempo pra resolver as demandas.`;
  } else if (lib) {
    motivo = `"${f.libera}" sai no ciclo ${lib.dueAtCycle} (faltam ${lib.dueAtCycle - state.cycle}). Nao mande nada agora -- termine e publique o que falta.`;
  } else {
    motivo = 'Nada em aberto. Se nao houver mensagem nova, responda so "sem novidade no grupo".';
  }

  state.currentPlan = { cycle: state.cycle, action: acao };
  return {
    ciclo: state.cycle,
    horaBrasilia: t.completo,
    janela,
    acao,
    frase: acao === "vamos_ajustar" ? f.ajuste : acao === "liberacao" ? f.libera : null,
    motivo,
    abertas: state.demands.filter((d) => d.status === "open").length,
    travadas: state.demands.filter((d) => d.status === "blocked").length,
    concluidas: state.demands.filter((d) => d.status === "done").length,
    pendencias: state.pendencias.length,
    perguntas: state.perguntas.length,
  };
}

// ---------------------------------------------------------------- resposta livre ao cliente

const MAX_CHARS_RESPOSTA = 220;
const MAX_FRASES_RESPOSTA = 2;

/**
 * O que denuncia automacao numa mensagem de WhatsApp. Nao e estilo: sao padroes que
 * um humano com pressa nao escreve, e que um modelo simpatico escreve sempre.
 */
const PROIBIDOS = [
  { re: /\p{Extended_Pictographic}/u, motivo: "tem emoji" },
  { re: /^\s*(oi|ol[áa]|bom dia|boa tarde|boa noite|e a[íi]|fala|prezad|sr\.|sra\.)/i, motivo: "abre com saudacao -- va direto ao ponto" },
  { re: /\b(claro|perfeito|com certeza|sem problemas?|fico [àa] disposi[çc][ãa]o|estamos [àa] disposi[çc][ãa]o|qualquer d[úu]vida|estamos verificando|vamos verificar|retornaremos|retorno em breve|pe[çc]o desculpas|desculpe|lamento|espero ter ajudado|agradecemos|obrigado pelo contato)\b/i, motivo: "usa formula pronta de atendimento automatico" },
  { re: /(^|\n)\s*([-*•]|\d+[.)])\s/, motivo: "tem lista -- resposta de WhatsApp e texto corrido" },
  { re: /\b(prazo|at[ée] amanh[ãa]|at[ée] hoje|amanh[ãa]|semana que vem|posso fazer|d[áa] pra fazer|vou fazer|consigo entregar|entrego|or[çc]amento|valor|pre[çc]o|custo|sem custo|de gra[çc]a)\b/i, motivo: "compromete prazo, escopo ou preco -- isso e decisao do responsável" },
  { re: /\?/, motivo: "pergunta de volta -- se precisa perguntar, vira rascunho pro responsável" },
  // pedido de confirmacao sem ponto de interrogacao e pergunta do mesmo jeito
  { re: /\b(voc[êe] quer dizer|quer dizer o|pode confirmar|confirma pra mim|seria (isso|esse)|[ée] isso mesmo|se eu entendi)\b/i, motivo: "pede confirmacao ao cliente -- e pergunta, vira rascunho pro responsável" },
  { re: /!/, motivo: "tem exclamacao" },
];

/**
 * Autoriza (ou nao) uma resposta livre ao cliente. Escopo deliberadamente estreito:
 * so responde o que da pra PROVAR por uma demanda concluida, com commit e prova.
 * Julgamento, promessa e opiniao viram rascunho pro responsável.
 */
export function checarResposta(state, { texto, perguntaId, demandaId }) {
  const t = (texto ?? "").trim();
  const negar = (motivo) => ({
    autorizado: false,
    motivo,
    orientacao: "Nao mande. Escreva como rascunho pro responsável enviar.",
  });

  const janela = fase(state);
  if (janela) return negar(janela === "encerrar" ? "a janela de trabalho ja encerrou" : "a janela de trabalho ainda nao abriu");

  if (state.aguardandoTime) {
    return negar("voce ja respondeu o cliente e ninguem do time falou no grupo desde entao. Nunca duas respostas suas seguidas -- esta escala pro responsável.");
  }

  const q = state.perguntas.find((x) => x.id === perguntaId);
  if (!q) return negar(`nao ha pergunta aberta "${perguntaId}". So se responde pergunta registrada com jarvis_pergunta.`);

  const d = state.demands.find((x) => x.id === demandaId);
  if (!d) return negar(`demanda "${demandaId}" nao existe. A resposta precisa estar ancorada num fato provado.`);
  if (d.status !== "done") return negar(`demanda ${d.id} nao esta concluida, entao nao ha fato provado pra responder. Termine, publique, confira -- ou faca rascunho pro responsável.`);
  if (!d.commit?.trim() || !d.proof?.trim()) return negar(`demanda ${d.id} nao tem commit e prova registrados.`);

  if (!t) return negar("texto vazio");
  if (t.length > MAX_CHARS_RESPOSTA) return negar(`${t.length} caracteres; o limite e ${MAX_CHARS_RESPOSTA}. Corte.`);
  const nFrases = t.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length;
  if (nFrases > MAX_FRASES_RESPOSTA) return negar(`${nFrases} frases; o limite e ${MAX_FRASES_RESPOSTA}.`);
  for (const p of PROIBIDOS) if (p.re.test(t)) return negar(p.motivo);

  return { autorizado: true, texto: t, perguntaId, demandaId, ancora: d };
}

export function autorizarResposta(state, r) {
  state.respostaAutorizada = { cycle: state.cycle, texto: r.texto, perguntaId: r.perguntaId, demandaId: r.demandaId };
}

export function marcarRespostaEnviada(state, texto) {
  const a = state.respostaAutorizada;
  const t = (texto ?? "").trim();
  if (!a || a.cycle !== state.cycle || a.texto !== t) {
    throw new Error("essa resposta nao foi autorizada neste ciclo -- rode jarvis_answer check antes");
  }
  resolvePergunta(state, a.perguntaId);
  state.respostaAutorizada = null;
  state.aguardandoTime = true;   // proxima resposta so depois que alguem do time falar
  state.lastSentCycle = state.cycle;
  state.history.push({
    cycle: state.cycle, kind: "resposta", text: a.texto,
    perguntaId: a.perguntaId, demandaId: a.demandaId,
    sentAt: new Date().toISOString(), hora: agora(state.config.timezone).completo,
  });
  return { texto: a.texto, perguntaId: a.perguntaId };
}

/** Alguem do time falou no grupo: destrava a possibilidade de responder de novo. */
export function timeFalou(state) {
  const estava = state.aguardandoTime;
  state.aguardandoTime = false;
  return estava;
}

// ---------------------------------------------------------------- portao de saida

/**
 * Unico caminho autorizado pro WhatsApp. Recusa qualquer coisa que nao seja
 * uma das duas frases exatas, autorizada pelo tick do ciclo ATUAL, no jid certo.
 */
export function checarMensagem(state, { text, jid }) {
  const f = frases(state);
  const t = (text ?? "").trim();
  const negar = (motivo) => ({
    autorizado: false,
    motivo,
    orientacao: "Nao mande. Escreva como rascunho pro responsável enviar: curta, direta, sem lista, sem cara de IA.",
  });

  if (jid && state.config.groupJid && jid !== state.config.groupJid) {
    return negar(`jid "${jid}" nao e o grupo deste projeto (${state.config.groupJid}). O modo Jarvis nao manda mensagem pra mais ninguem.`);
  }

  // resposta livre ao cliente, ja aprovada pelo checarResposta neste ciclo
  const aut = state.respostaAutorizada;
  if (aut && aut.cycle === state.cycle && aut.texto === t) {
    return { autorizado: true, frase: t, tipo: "resposta", jid: state.config.groupJid,
      motivo: `Resposta a ${aut.perguntaId}, ancorada na demanda ${aut.demandaId}, autorizada no ciclo ${state.cycle}.` };
  }

  if (t !== f.ajuste && t !== f.libera) {
    return negar(`"${t}" nao e uma das duas frases ("${f.ajuste}" / "${f.libera}") nem uma resposta autorizada por jarvis_answer neste ciclo.`);
  }
  if (!state.currentPlan || state.currentPlan.cycle !== state.cycle) {
    return negar("nenhum tick foi rodado neste ciclo. Rode jarvis_tick antes de cogitar enviar.");
  }

  const esperado = state.currentPlan.action === "vamos_ajustar" ? f.ajuste
    : state.currentPlan.action === "liberacao" ? f.libera : null;
  if (esperado !== t) {
    return negar(esperado === null
      ? `o tick do ciclo ${state.cycle} nao autorizou mensagem nenhuma.`
      : `o tick deste ciclo autorizou "${esperado}", nao "${t}".`);
  }

  return { autorizado: true, frase: t, jid: state.config.groupJid, motivo: `Autorizado pelo tick do ciclo ${state.cycle}.` };
}

export function marcarEnviada(state, frase) {
  const f = frases(state);
  const t = (frase ?? "").trim();
  if (t !== f.ajuste && t !== f.libera) throw new Error(`"${t}" nao e uma das duas frases`);

  if (t === f.ajuste) {
    if (!avisoPendente(state)) throw new Error(`nao havia "${f.ajuste}" armado`);
    for (const d of state.demands) d.announced = true; // um aviso cobre o lote inteiro
  } else {
    if (!state.demands.length) throw new Error(`nao havia lote pra liberar`);
    // o lote foi entregue: sai da lista ativa e o relogio recomeca na proxima demanda
    state.demands = state.demands.filter((d) => d.status !== "done");
  }
  state.currentPlan = { cycle: state.cycle, action: "nenhuma" }; // uma frase por ciclo
  state.lastSentCycle = state.cycle;                             // e nao duas seguidas
  state.history.push({ cycle: state.cycle, phrase: t, sentAt: new Date().toISOString(), hora: agora(state.config.timezone).completo });
  return { registrado: t, ciclo: state.cycle };
}
