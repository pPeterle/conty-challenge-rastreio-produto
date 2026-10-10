# Regras e decisões em detalhe

O README resume cada regra. Aqui fica o porquê de cada uma e os casos de borda.

## Status derivado do conjunto de eventos

`deriveState` (`src/domain/status.ts`) recalcula o status a partir de todos os eventos da remessa a cada polling ou webhook. O resultado é o mesmo em qualquer ordem de chegada, e um teste unitário confere isso com todas as permutações de um histórico.

1. Eventos de progresso têm rank: `postado` 1, `em_transito` 2, `saiu_para_entrega` 3, `entregue` 4. O status é o maior rank já visto, então um evento antigo que chega depois não faz o status regredir.
2. Uma leitura mais nova de etapa menor (o pacote saiu para entrega e depois aparece "em trânsito") também não rebaixa o status. É uma decisão consciente. Para quem acompanha a campanha importa a etapa mais avançada já alcançada, e um status que vai e volta a cada leitura interna da transportadora só gera ruído. Quando algo dá errado de fato, a transportadora manda uma exceção, e esse é o único caminho que tira o status da etapa alcançada.
3. `entregue` é terminal. Uma exceção posterior fica no histórico, mas o status continua `entregue`.
4. `excecao` vale enquanto nenhum evento de progresso tiver horário estritamente posterior à exceção mais recente. Um avanço posterior resolve a exceção, e o status volta ao maior rank já alcançado. Uma exceção antiga chegando atrasada não derruba um avanço mais novo. No empate de horário a exceção prevalece, por ser o lado mais conservador.
5. Eventos `desconhecido` e eventos com `ignored_reason` ficam fora do cálculo e ligam `needs_review`.

Pular etapas é permitido porque transportadoras às vezes não reportam todas.

## Status que a transportadora inventou

Texto ou código fora da tabela vira `desconhecido`. Ele fica no histórico com o texto original e liga `needs_review: true`, mas não muda o status nem inicia o relógio de trânsito.

Pensei em tratar desconhecido como `excecao` e desisti: transportadora muda texto o tempo todo, e cada variação nova pareceria problema no pacote. Também não tento adivinhar. "Objeto entregue ao destinatário errado" e o código Jadlog `ENTREGUE PARCIAL` contêm a palavra "entregue" e viram `desconhecido`. Errar para `entregue` seria o pior caso, porque o prazo de conteúdo do criador começaria a contar sem o produto na mão dele. O custo é que alguém precisa olhar as remessas com `needs_review` e acrescentar o texto na tabela.

O casamento é exato depois de normalizar (sem acento, sem diferenciar maiúsculas, espaços colapsados, sem ponto final). Com prefixo, "Objeto saiu para entrega - cancelada" casaria com uma etapa que não aconteceu. As tabelas são `Map`, não objeto literal, para que textos como `constructor` ou `__proto__` não encontrem propriedades herdadas de `Object.prototype`.

A tradução é refeita a cada recálculo a partir do `raw_code` guardado, com a tabela atual do adaptador (`TrackingAggregator.mapStatus`). Quando a tabela ganha um texto, o próximo polling ou webhook da remessa, mesmo sem evento novo, passa a contar aqueles eventos e desliga `needs_review` se não sobrar nada pendente. O histórico não perde nada: muda só a coluna `status` do evento, e o texto original continua lá.

## Evento com data no futuro

Um evento datado mais de 10 minutos (`FUTURE_TOLERANCE_MINUTES`) depois do instante em que chegou entra no histórico com `ignored_reason: "data_no_futuro"`, fica fora do status e do relógio de trânsito e liga `needs_review`. Preferi guardar a recusar porque o evento pode ser verdadeiro com fuso trocado, e alguém precisa ver isso. A decisão é tomada na chegada e fica gravada. Se o mesmo evento for reenviado depois, ele cai no dedupe e continua ignorado.

## Deduplicação e identidade

O agregador fictício manda `checkpoint_id`, e esse é o id do evento. Sem ele (ou com id vazio), a chave é um hash de horário em UTC, código bruto e local. A tabela `tracking_events` tem `UNIQUE (shipment_id, event_key)` e o insert usa `ON CONFLICT DO NOTHING`. Consultar de novo, receber o mesmo webhook várias vezes ou receber o mesmo evento por polling e por webhook grava o evento uma vez só.

Se o agregador corrigir um evento mantendo o mesmo `checkpoint_id`, a correção é ignorada e vale a primeira versão. Não sei como um agregador real sinalizaria correções, e sobrescrever em silêncio deixaria o histórico mudar depois de usado.

Polling e webhook conferem se a referência, a transportadora e o código de rastreio devolvidos são os da remessa. A tradução depende do dialeto da transportadora, e um evento de outra remessa não pode entrar nesta. No polling a divergência é 502 (o agregador errou); no webhook é 400.

## Atraso

`isDelayed` (`src/domain/delay.ts`) considera atraso quando o pacote não está `entregue`, o relógio de trânsito já começou (o início é o evento conhecido mais antigo, normalmente o `postado`) e `agora - início` passa estritamente do limite. O limite é `DELAY_LIMIT_HOURS`, ou `DELAY_LIMIT_HOURS_<TRANSPORTADORA>` quando existe.

O "agora" vem do `Clock` injetado, então os testes controlam a data. No limite exato ainda não é atraso, e um milissegundo depois já é. Entrega normal não vira atraso porque `entregue` sai da conta, por mais tempo que passe depois. Uma `excecao` em aberto continua contando, já que o pacote ainda não chegou.

`POST /jobs/check-delays` percorre as remessas em trânsito:

- Antes de criar um alerta novo, reconsulta o agregador para aquela remessa, porque o webhook da entrega pode ter se perdido. Se a reconsulta mostrar a entrega, não há alerta.
- Se a reconsulta falhar, o alerta é criado com `stale: true`, porque a informação pode estar desatualizada.
- Remessa que já tem alerta não é reconsultada.
- As reconsultas são feitas uma remessa por vez. A rodada do job custa uma chamada ao agregador (até 5 s de timeout) para cada remessa atrasada que ainda não tem alerta; com muitas nessa situação, a rodada demora proporcionalmente. Com volume maior eu limitaria a concorrência dessas chamadas ou levaria a reconsulta para uma fila.
- Os alertas ficam em `alerts`, com `UNIQUE (shipment_id, kind)`. Rodar de novo, ou em paralelo, não duplica o alerta.
- Quando a remessa é entregue depois do alerta, ele ganha `resolved_at` e sai da lista padrão de `GET /alerts`, mas continua registrado.

A tabela `alerts` serve como outbox para quem for mandar e-mail ou mensagem. Esse envio não está implementado.

## Prazo do conteúdo

A remessa entregue devolve `content_due_at`, o prazo do conteúdo do criador contado a partir da entrega (`CONTENT_DUE_DAYS`, padrão 7 dias, valor que escolhi sem base em dado real). Antes da entrega o campo é `null`, porque o prazo só faz sentido com o produto na mão.

## Autenticação do webhook

O agregador assina o corpo bruto com HMAC-SHA256 e manda `x-aggregator-signature: sha256=<hex>`. O cliente valida o formato do header, compara com `crypto.timingSafeEqual` e só então faz o parse do JSON e passa o schema. Sem header ou com assinatura que não confere, a resposta é 401 e nada é gravado. A verificação fica no adaptador porque nome do header e esquema de assinatura variam de agregador para agregador.

## Erros e validação

| status | quando |
|---|---|
| 400 | validação ou webhook malformado; `details` traz caminho e motivo de cada campo |
| 401 | assinatura do webhook ausente ou errada |
| 404 | rota, método, remessa ou referência desconhecida |
| 413 | corpo acima de 256 KB |
| 415 | `POST /shipments` sem `content-type: application/json` |
| 502 `agregador_indisponivel` | agregador fora do ar ou respondendo erro HTTP |
| 502 `agregador_resposta_invalida` | resposta inutilizável no cadastro ou no polling (HTML, formato errado, dados de outra remessa) |
| 500 | erro inesperado, com mensagem genérica; o detalhe vai só para o log |

Tudo que entra passa por schema zod. Os da API estão em `src/schemas.ts`, ligados com `@hono/zod-validator` e um hook único de erro. Os do formato do agregador e do header de assinatura estão em `src/aggregator/fake/schemas.ts`, dentro do adaptador. Campos extras são ignorados. Webhook com mais de 500 eventos, texto longo demais, data sem fuso, fuso impossível (`+24:00`, `+23:60`) ou data inexistente (30 de fevereiro) é recusado sem gravar nada; a mesma coisa na resposta do polling vira 502. O cadastro não recebe datas. Os casos estão em `test/integration/payloads-invalidos.test.ts`.
