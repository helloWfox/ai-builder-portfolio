/**
 * Scanner de segredos sobre o diff staged.
 * `block` = alta confianca, aborta o commit. `warn` = suspeito, so reporta.
 */

const RULES = [
  { id: "anthropic-key",   level: "block", re: /sk-ant-[A-Za-z0-9_-]{20,}/,                        label: "chave da Anthropic" },
  { id: "openai-key",      level: "block", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/,                  label: "chave da OpenAI" },
  { id: "github-token",    level: "block", re: /\bgh[posur]_[A-Za-z0-9]{36,}/,                     label: "token do GitHub" },
  { id: "aws-key",         level: "block", re: /\bAKIA[0-9A-Z]{16}\b/,                             label: "access key da AWS" },
  { id: "private-key",     level: "block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, label: "chave privada" },
  { id: "slack-token",     level: "block", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/,                   label: "token do Slack" },
  { id: "google-key",      level: "block", re: /\bAIza[0-9A-Za-z_-]{35}\b/,                        label: "API key do Google" },
  { id: "stripe-key",      level: "block", re: /\b[rs]k_live_[A-Za-z0-9]{20,}/,                    label: "chave live do Stripe" },
  { id: "postgres-url",    level: "block", re: /\bpostgres(?:ql)?:\/\/[^\s:@'"]+:[^\s@'"]+@/,      label: "connection string do Postgres com senha" },
  { id: "generic-assign",  level: "warn",  re: /\b(?:api[_-]?key|secret|passwd|password|token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{16,}["']/i, label: "atribuicao com cara de credencial" },
];

/** JWT do Supabase com role service_role -- so bloqueia se o payload confirmar. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{16,})\.[A-Za-z0-9_-]{16,}/g;

const SENSITIVE_FILES = [
  /(^|\/)\.env(\.|$)/i,          // .env, .env.local, .env.production
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|pfx|p12|keystore|jks)$/i,
  /(^|\/)service[-_]?account.*\.json$/i,
  /(^|\/)credentials\.json$/i,
];

// .env.example / .env.sample sao templates, nao segredo
const SENSITIVE_EXCEPTIONS = [/\.env\.(example|sample|template)$/i];

function isServiceRoleJwt(payloadB64) {
  try {
    const json = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    return json.role === "service_role";
  } catch {
    return false;
  }
}

/**
 * @param {string} diff  saida de `git diff --cached`
 * @returns {{blocking: Array, warnings: Array}}
 */
export function scanDiff(diff) {
  const findings = [];
  let file = null;

  for (const line of diff.split("\n")) {
    const header = line.match(/^\+\+\+ b\/(.+)$/);
    if (header) {
      file = header[1];
      if (file !== "/dev/null" && !SENSITIVE_EXCEPTIONS.some((re) => re.test(file))) {
        const hit = SENSITIVE_FILES.find((re) => re.test(file));
        if (hit) findings.push({ level: "block", file, line: null, rule: "sensitive-file", label: "arquivo sensivel sendo versionado", excerpt: file });
      }
      continue;
    }
    // so linhas adicionadas
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const content = line.slice(1);

    for (const rule of RULES) {
      const m = content.match(rule.re);
      if (m) findings.push({ level: rule.level, file, rule: rule.id, label: rule.label, excerpt: redact(m[0]) });
    }

    for (const m of content.matchAll(JWT_RE)) {
      if (isServiceRoleJwt(m[1])) {
        findings.push({ level: "block", file, rule: "supabase-service-role", label: "JWT service_role do Supabase", excerpt: redact(m[0]) });
      }
    }
  }

  // dedup por (file, rule, excerpt)
  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = `${f.file}|${f.rule}|${f.excerpt}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    blocking: unique.filter((f) => f.level === "block"),
    warnings: unique.filter((f) => f.level === "warn"),
  };
}

/** Mostra so as pontas do segredo, nunca o valor inteiro. */
function redact(s) {
  if (s.length <= 12) return `${s.slice(0, 4)}...`;
  return `${s.slice(0, 8)}...${s.slice(-4)} (${s.length} chars)`;
}
