---
description: Mostra a frota Lovable e sobe o que estiver pendente
---

Sincronize os projetos Lovable com o GitHub.

1. Rode `git -C <projeto> status --short` nos projetos de `./projetos` (ou use `mcp__lovable__list_projects` do MCP oficial pra visão geral da nuvem) e mostre quem tem pendência.
2. Para cada projeto com mudança, rode `git -C <projeto> diff HEAD` (`--stat` se for grande) para entender o que mudou de fato.
3. Chame `commit_push` **por projeto**, com uma mensagem de commit específica que descreva aquelas mudanças — nunca uma mensagem genérica igual para todos.
4. Se algum abortar (segredo detectado, branch fora do padrão, conflito de rebase), reporte o motivo e **não** contorne com `allow_secrets` ou `allow_branch` sem me perguntar antes.
5. Push **não** publica. Pra o cliente ver, chame `mcp__lovable__deploy_project` do MCP oficial depois.

Argumento opcional: $ARGUMENTS — se vier um nome de projeto, faça só ele.
