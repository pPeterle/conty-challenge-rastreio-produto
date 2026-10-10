# Concorrência, idempotência e teste de carga

## Restrições que garantem idempotência

Tudo se apoia no sqlite:

- `UNIQUE (carrier, tracking_code)` e `UNIQUE (aggregator_ref)` em `shipments`: cadastros simultâneos do mesmo código criam uma remessa só. O agregador fictício também é idempotente no cadastro.
- `UNIQUE (shipment_id, event_key)` em `tracking_events`, com `ON CONFLICT DO NOTHING`.
- `UNIQUE (shipment_id, kind)` em `alerts`.
- A aplicação de eventos roda em `BEGIN IMMEDIATE`. Inserir os novos, reler o histórico, derivar o status e gravar acontecem sob o lock de escrita, então duas entregas simultâneas não sobrescrevem o status uma da outra.
- O banco de arquivo usa `journal_mode = WAL` e `busy_timeout = 5000`. Há índices para o histórico por remessa, para a listagem por data de criação e para as remessas em trânsito que o job de atraso percorre.

`test/integration/concurrency.test.ts` dispara 80 webhooks e polls ao mesmo tempo, com eventos repetidos e embaralhados, e confere que o histórico termina sem duplicatas, com o status certo e sem nenhuma mudança de status para trás.

## Caminho com várias instâncias

Com mais de um processo, eu trocaria o sqlite por Postgres com as mesmas restrições UNIQUE e faria o recálculo com `SELECT ... FOR UPDATE` na linha da remessa (ou um advisory lock por remessa). O job de atraso continuaria idempotente pela UNIQUE de `alerts`. Lock distribuído só entraria se o alerta passasse a disparar algo externo dentro do mesmo fluxo, e mesmo nesse caso eu preferiria um worker lendo a tabela `alerts` como outbox.

## Teste de carga

`npm run load` (`scripts/load.sh`):

1. Sobe API e agregador fictício nas portas 3105 e 3115, com banco temporário, limite de atraso de 72 h e um segredo de webhook próprio. Recusa rodar se alguma das portas já estiver ocupada.
2. `scripts/prepare-load.ts` cadastra 40 remessas em 4 cenários e registra a linha do tempo de cada uma no agregador. Os cenários são entrega normal, atrasada com status inventado, exceção resolvida e exceção em aberto. O resultado esperado de cada remessa vai para um JSON temporário.
3. O k6 (`load/tracking.js`, imagem `grafana/k6:0.54.0` no Docker) roda por 30 s com até 50 VUs. Cada iteração escolhe uma remessa e sorteia uma ação:

   | fração | ação | resposta esperada |
   |---|---|---|
   | 10% | payload inválido assinado (JSON quebrado, tipos errados, data sem fuso) no webhook, ou corpo inválido no cadastro | 400 |
   | 55% | webhook assinado com um subconjunto embaralhado dos eventos e um evento repetido | 200 |
   | 5% | webhook forjado dizendo "entregue", assinado com outro segredo | 401 |
   | 25% | polling (`POST /shipments/:id/refresh`) | 200 |
   | 5% | job de atraso | 200 |

   Para o k6, 4xx conta como resposta esperada (`http.setResponseCallback`), e os checks conferem o status exato de cada ação. Os thresholds são p95 < 500 ms, taxa de erro < 1% e checks > 99%. O teto de latência é folgado para a carga passar em máquinas mais lentas; o que reprova a rodada de verdade são os checks, a taxa de erro e a verificação do passo 4.
4. `scripts/verify-load.ts` roda o job de atraso uma última vez e confere, para cada remessa, a quantidade de eventos, a ausência de duplicatas, o status final, `needs_review`, a quantidade de alertas e se alguma mudança de status andou para trás. Se algo quebrar, sai com código 1.
5. Encerra o servidor e apaga o banco temporário.

### Resultado

Última execução real, nesta máquina (macOS, k6 0.54.0 no Docker, 2026-10-10):

```
     ✓ webhook 200
     ✓ refresh 200
     ✓ payload inválido 400
     ✓ check-delays 200
     ✓ webhook forjado 401
   ✓ checks.........................: 100.00% 129945 out of 129945
   ✓ http_req_duration..............: avg=9.63ms  min=92.46µs  med=6.32ms max=64.23ms p(90)=23.63ms p(95)=27.01ms
   ✓ http_req_failed................: 0.00%   0 out of 129986
     http_reqs......................: 129986  4327.309506/s
verificação ok: 40 remessas, 140 eventos únicos, 20 alertas, nenhum status regrediu
```

Os números variam bastante entre execuções na mesma máquina. Nas rodadas que fiz ao longo do desenvolvimento (as primeiras ainda sem payloads inválidos no cenário), a vazão ficou entre 1594 e 4731 req/s e o p95 entre 23,91 ms e 85,01 ms.
