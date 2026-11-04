# AI Builder Portfolio: Ronan Dias

Sou estudante de Sistemas de Informação na UFU e líder da equipe operacional da **Imperius Tech**. Construo soluções com IA para clientes reais: assistentes de atendimento no WhatsApp, agentes autônomos, sistemas web feitos com vibe coding e integrações via **MCP (Model Context Protocol)**.

Este repositório reúne o que eu posso mostrar publicamente. O código dos clientes é privado. Aqui está a **infraestrutura que eu criei para operar esses sistemas com IA**, sem nenhum dado de cliente.

---

## 1. `lovable-sync-mcp`: servidor MCP para operar uma frota de apps com IA

**Problema:** a equipe mantém cerca de 19 aplicações web de clientes construídas no Lovable. O Lovable não tem API de escrita: a única forma de levar código para dentro de um projeto é o sync com o GitHub. Fazer isso na mão, projeto por projeto, era lento e arriscado. Um `git add -A` descuidado sobe um `.env` com a chave do banco do cliente.

**O que eu construí:** um servidor MCP em Node.js que dá ao Claude ferramentas para operar a frota com segurança.

- **Publicação segura** (`commit_push`): só mexe no branch padrão, nunca usa force-push e faz `pull --rebase` antes.
- **Scanner de segredos** ([`server/secrets.mjs`](lovable-sync-mcp/server/secrets.mjs)): analisa o diff antes de cada commit e **bloqueia** chaves de Anthropic, OpenAI, GitHub, AWS, Google e Stripe, chaves privadas, connection strings com senha e arquivos `.env`. Ele decodifica JWTs do Supabase e só barra os de `service_role`, os perigosos. No relatório, mostra apenas as pontas do segredo, nunca o valor inteiro.

## 2. Modo Jarvis: agente que atende o cliente enquanto eu não estou

**Problema:** os clientes mandam pedidos de ajuste no grupo de WhatsApp a qualquer hora. Um grupo sem resposta passa descaso. Já uma IA respondendo sozinha pode prometer prazo, preço ou escopo, e promessa feita ao cliente não se desfaz.

**O que eu construí:** um modo autônomo ([`server/jarvis.mjs`](lovable-sync-mcp/server/jarvis.mjs) e [`commands/jarvis.md`](lovable-sync-mcp/commands/jarvis.md)) em que o agente, durante uma janela de horário:

1. Lê o grupo a cada 30 minutos e registra cada pedido como uma demanda.
2. **Cruza as demandas com os commits do time** para não refazer o que um colega já resolveu.
3. Implementa, publica e **confere no app que está no ar** antes de considerar a demanda pronta.
4. Avisa o cliente com mensagens curtas e no tempo certo: "Vamos ajustar" depois de 1h e "Sistema já atualizado" depois de 2h.

**O ponto central são as travas, escritas em código e não em prompt:**

| Trava | Por quê |
|---|---|
| Só responde o que consegue **provar**: demanda concluída, com commit e evidência | A IA não inventa status |
| Prazo, preço, escopo e opinião **nunca** saem, viram rascunho para um humano | Compromisso com cliente é decisão humana |
| Bloqueia saudação, "Claro!", emoji, exclamação, lista e pergunta de volta | Esses são os sinais que denunciam um robô |
| Pergunta do cliente sem resposta **trava todas as mensagens** | Mandar frase pronta por cima de uma dúvida mostra que ninguém leu |
| Nunca duas mensagens seguidas, nem duas respostas sem alguém do time falar | Mantém o ritmo de uma conversa humana |
| Desliga sozinho no fim da janela e não herda a janela do dia anterior | O agente não pode ficar ligado por esquecimento |

Além disso, um **hook `PreToolUse`** ([`hooks/guarda-whatsapp.mjs`](lovable-sync-mcp/hooks/guarda-whatsapp.mjs)) intercepta toda tentativa de envio pelo WhatsApp e barra o que não passou pelo portão de saída. Mesmo que o modelo "decida" mandar, a mensagem não sai.

### Testes

```bash
cd lovable-sync-mcp/server
npm test
```

São 11 testes ([`test/guardrails.test.mjs`](lovable-sync-mcp/server/test/guardrails.test.mjs)) cobrindo o scanner de segredos e as travas do Jarvis.

## 3. Assistentes de IA de atendimento para clínicas (código privado)

Implantados para clientes da área de saúde e estética. O assistente conversa com os pacientes pelo WhatsApp, agenda horários sozinho e envia à equipe um **relatório diário** de conversas atendidas, novos contatos e horários marcados. Quando a conversa é delicada, por exemplo um paciente com consulta próxima, ele **não responde e avisa a equipe** com o link da conversa.

## 4. Integrações de agentes via MCP

Conectei o Claude a **WhatsApp** (Evolution API, com transcrição automática de áudio), **Google Drive e Calendar** e **Microsoft Teams**. Também portei todo o ambiente (servidores MCP, skills e a trava do WhatsApp) para um segundo agente, o **Google Antigravity**.

## 5. Dados e pesquisa

- **Iniciação Científica em Estatística (UFU):** análise multivariada (FAMD, HCPC e ACM em R) dos fatores associados às doenças crônicas em Minas Gerais, com microdados da PNS 2019/IBGE e da SES-MG.
- **Detecção de anomalias com Isolation Forest:** ferramenta genérica para CSVs numéricos, testada em fraude de cartão e em tráfego de rede (CICIDS2017). [Repositório](https://github.com/arthurlelles/Analise-de-Anomalias-com-Isolation-Forest/), feito em dupla.

---

**Stack:** Claude e Claude Code · MCP · Node.js · Lovable · Supabase/PostgreSQL · Evolution API · Python · R · Git

**Contato:** ronand448@gmail.com · Monte Carmelo, MG
