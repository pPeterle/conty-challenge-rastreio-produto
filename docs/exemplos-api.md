# Exemplos reais com curl

Gerei estes exemplos com a API rodando localmente (`AGGREGATOR_WEBHOOK_SECRET=segredo-local DELAY_LIMIT_HOURS=72 npm start`) em 2026-10-10, por volta de 04:17 UTC. Os ids mudam a cada execução.

## Cadastro

```bash
curl -s -X POST localhost:3105/shipments -H 'content-type: application/json' \
  -d '{"tracking_code":"QB123456789BR","carrier":"correios"}'
```

```json
{"id":"shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4","carrier":"correios","tracking_code":"QB123456789BR","aggregator_ref":"trk_1","status":null,"status_since":null,"transit_started_at":null,"delivered_at":null,"delayed":false,"needs_review":false,"events":[],"status_changes":[],"alerts":[]}
```

Repetir o mesmo cadastro devolve 200 com a mesma remessa.

## Simular a transportadora

O agregador fictício registra o checkpoint, assina e manda o webhook para a API na hora:

```bash
curl -s -X POST localhost:3115/v1/trackers/trk_1/checkpoints -H 'content-type: application/json' \
  -d '{"carrier_status":"Objeto postado","location":"São Paulo/SP","checkpoint_time":"2026-10-06T16:40:00-03:00"}'
```

```json
{"checkpoint":{"checkpoint_id":"cp_2","carrier_status":"Objeto postado","message":null,"location":"São Paulo/SP","checkpoint_time":"2026-10-06T16:40:00-03:00"}}
```

Depois de três checkpoints (trânsito, postagem e um texto que a tabela não conhece), `POST /shipments/:id/refresh` respondeu `new_events: 0`: os webhooks já tinham trazido tudo, e o histórico continuou com 3 eventos. O `GET /shipments/:id` dessa remessa está no README.

## Webhook assinado à mão

Reenviando um evento antigo que já existe:

```bash
BODY='{"tracker":{"id":"trk_1","tracking_number":"QB123456789BR","carrier":"correios","checkpoints":[{"checkpoint_id":"cp_2","carrier_status":"Objeto postado","location":"São Paulo/SP","checkpoint_time":"2026-10-06T16:40:00-03:00"}]}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac segredo-local | awk '{print $NF}')"
curl -s -X POST localhost:3105/webhooks/aggregator -H 'content-type: application/json' \
  -H "x-aggregator-signature: $SIG" -d "$BODY"
```

```json
{"new_events":0,"shipment_id":"shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4","status":"em_transito"}
```

Webhook forjado dizendo "entregue", primeiro sem assinatura e depois com a assinatura de outro corpo (os dois respondem 401):

```json
{"error":{"code":"assinatura_invalida","message":"header x-aggregator-signature ausente"}}
{"error":{"code":"assinatura_invalida","message":"assinatura do header x-aggregator-signature não confere com o corpo"}}
```

## Job de atraso

Duas vezes seguidas:

```bash
curl -s -X POST localhost:3105/jobs/check-delays
```

```json
{"checked":1,"delayed":["shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4"],"alerts_created":["shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4"]}
{"checked":1,"delayed":["shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4"],"alerts_created":[]}
```

```bash
curl -s localhost:3105/alerts
```

```json
{"limit":50,"offset":0,"alerts":[{"id":1,"shipment_id":"shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4","kind":"atraso","details":{"status":"em_transito","needs_review":true,"transit_started_at":"2026-10-06T19:40:00.000Z","elapsed_hours":80.6,"limit_hours":72},"created_at":"2026-10-10T04:17:52.336Z"}]}
```

## Listagem

```bash
curl -s 'localhost:3105/shipments?limit=1'
```

```json
{"limit":1,"offset":0,"shipments":[{"id":"shp_9d725a1c-b419-47b4-9142-f2c068c2bcb4","carrier":"correios","tracking_code":"QB123456789BR","aggregator_ref":"trk_1","status":"em_transito","status_since":"2026-10-08T12:12:00.000Z","transit_started_at":"2026-10-06T19:40:00.000Z","delivered_at":null,"delayed":true,"needs_review":true}]}
```

## Validação

`POST /shipments` com `{"tracking_code":"x"}`:

```json
{"error":{"code":"validacao","message":"tracking_code: precisa ter de 4 a 40 letras, números ou hífen (e mais 1 problema(s))","details":[{"path":"tracking_code","message":"precisa ter de 4 a 40 letras, números ou hífen"},{"path":"carrier","message":"campo obrigatório"}]}}
```
