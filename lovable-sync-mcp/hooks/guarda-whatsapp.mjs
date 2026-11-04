#!/usr/bin/env node
/**
 * Hook PreToolUse opcional: trava de verdade o envio de WhatsApp no modo Jarvis.
 *
 * A tool jarvis_check_message é o portão, mas nada obriga o modelo a passar por ela.
 * Este hook obriga: intercepta whatsapp_send_message e nega tudo que não for uma das
 * duas frases exatas, autorizada pelo tick do ciclo atual, no jid do grupo.
 *
 * Só age quando o modo Jarvis está LIGADO (config.enabled). Desligado, não atrapalha
 * o uso normal do WhatsApp.
 *
 * Instalar em ~/.claude/settings.json:
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "mcp__evolution-whatsapp__whatsapp_send_message",
 *       "hooks": [{ "type": "command", "command": "node \"/caminho/para/lovable-sync-mcp/hooks/guarda-whatsapp.mjs\"" }]
 *     }]
 *   }
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, checarMensagem, chaveProjeto, ativo } from "../server/jarvis.mjs";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const entrada = await new Promise((resolve) => {
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { buf += c; });
  process.stdin.on("end", () => resolve(buf));
});

const permitir = () => process.exit(0);

let payload;
try {
  payload = JSON.parse(entrada);
} catch {
  permitir(); // não é papel do hook derrubar a sessão por payload estranho
}

// estado e por projeto, igual no servidor -- a sessao diz qual
const state = await loadState(PLUGIN_ROOT, chaveProjeto(payload.cwd ?? process.cwd()));
if (!ativo(state)) permitir(); // desligado OU fora da janela

const args = payload.tool_input ?? {};
const texto = args.message ?? args.text ?? "";
const jid = args.jid ?? args.number ?? args.to ?? null;

const r = checarMensagem(state, { text: texto, jid });
if (r.autorizado) permitir();

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason:
      `[modo Jarvis] Envio bloqueado: ${r.motivo}\n${r.orientacao}`,
  },
}));
process.exit(0);
