// Testes das travas de seguranca: scanner de segredos e filtros do Modo Jarvis.
// Rodar com: npm test  (usa o test runner nativo do Node, sem dependencias)
import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDiff } from "../secrets.mjs";
import { checarResposta, checarMensagem } from "../jarvis.mjs";

// ------------------------------------------------------------ scanner de segredos

const diff = (file, ...linhas) => `+++ b/${file}\n${linhas.map((l) => `+${l}`).join("\n")}`;
const jwt = (payload) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.assinatura_falsa_123456`;

test("bloqueia chave da Anthropic e mostra so as pontas", () => {
  const r = scanDiff(diff("src/ia.ts", `const k = "sk-ant-${"a".repeat(40)}";`));
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].rule, "anthropic-key");
  assert.ok(!r.blocking[0].excerpt.includes("a".repeat(40)), "nunca expoe o segredo inteiro");
});

test("bloqueia arquivo .env, mas deixa passar .env.example", () => {
  assert.equal(scanDiff(diff(".env.local", "X=1")).blocking[0].rule, "sensitive-file");
  assert.equal(scanDiff(diff(".env.example", "X=")).blocking.length, 0);
});

test("JWT do Supabase: bloqueia service_role, ignora anon", () => {
  assert.equal(scanDiff(diff("a.ts", jwt({ role: "service_role" }))).blocking.length, 1);
  assert.equal(scanDiff(diff("a.ts", jwt({ role: "anon" }))).blocking.length, 0);
});

test("connection string do Postgres com senha e bloqueada", () => {
  const r = scanDiff(diff("db.ts", `postgres://user:senha@host:5432/db`));
  assert.equal(r.blocking[0].rule, "postgres-url");
});

test("so olha linhas adicionadas, nao as removidas", () => {
  const d = `+++ b/a.ts\n-const k = "sk-ant-${"b".repeat(40)}";`;
  assert.equal(scanDiff(d).blocking.length, 0);
});

// ------------------------------------------------------------ Modo Jarvis

const GRUPO = "123@g.us";
function estado() {
  return {
    config: { groupJid: GRUPO, startTime: null, stopTime: null, timezone: "America/Sao_Paulo" },
    cycle: 3,
    demands: [{ id: "D1", status: "done", commit: "abc123", proof: "conferido no app publicado" }],
    perguntas: [{ id: "P1", text: "o botao de exportar ja voltou" }],
    aguardandoTime: false,
    respostaAutorizada: null,
    currentPlan: null,
    history: [],
  };
}
const responder = (texto, s = estado()) => checarResposta(s, { texto, perguntaId: "P1", demandaId: "D1" });

test("resposta curta, ancorada em demanda concluida, e autorizada", () => {
  assert.equal(responder("Voltou sim, ja esta no ar com a correcao do filtro.").autorizado, true);
});

test("nunca promete prazo ou preco", () => {
  assert.equal(responder("Entrego amanha").autorizado, false);
  assert.equal(responder("O valor fica o mesmo").autorizado, false);
});

test("barra cara de robo: saudacao, formula pronta, emoji, exclamacao", () => {
  for (const t of ["Bom dia, voltou sim", "Claro, ja voltou", "Voltou 🚀", "Voltou sim!"]) {
    assert.equal(responder(t).autorizado, false, t);
  }
});

test("sem prova nao responde: demanda aberta vira rascunho pro humano", () => {
  const s = estado();
  s.demands[0].status = "open";
  assert.equal(responder("Voltou sim", s).autorizado, false);
});

test("nunca duas respostas seguidas sem alguem do time falar", () => {
  const s = estado();
  s.aguardandoTime = true;
  assert.equal(responder("Voltou sim", s).autorizado, false);
});

test("portao de saida recusa qualquer grupo que nao seja o do projeto", () => {
  const r = checarMensagem(estado(), { text: "Vamos ajustar", jid: "outro@g.us" });
  assert.equal(r.autorizado, false);
});
