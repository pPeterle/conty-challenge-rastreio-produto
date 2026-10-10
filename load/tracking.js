// Carga sobre o ponto crítico: o mesmo evento chegando muitas vezes, fora de
// ordem e por dois caminhos (webhook e polling) ao mesmo tempo.
import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3105";
const AGG_URL = __ENV.AGG_URL || "http://localhost:3115";
const SECRET = __ENV.WEBHOOK_SECRET || "segredo-local";
const FORGED_ONLY = http.expectedStatuses(401);
// 4xx é resposta esperada para os payloads inválidos; os checks conferem o status exato de cada caso.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 499 }));

function signed(body) {
  return {
    "content-type": "application/json",
    "x-aggregator-signature": "sha256=" + crypto.hmac("sha256", SECRET, body, "hex"),
  };
}

export const options = {
  scenarios: {
    eventos_repetidos: {
      executor: "ramping-vus",
      startVUs: 5,
      stages: [
        { duration: "5s", target: 50 },
        { duration: "20s", target: 50 },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const list = http.get(`${BASE_URL}/shipments?limit=200`).json("shipments");
  return list.map((s) => ({ id: s.id, tracker: http.get(`${AGG_URL}/v1/trackers/${s.aggregator_ref}`).json("tracker") }));
}

function shuffled(items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

// Payloads que um cliente quebrado ou mal-intencionado mandaria. Todos assinados, para chegar na validação.
function invalidWebhookBody(target) {
  const t = target.tracker;
  const options = [
    "",
    "{",
    "null",
    "[]",
    '"texto solto"',
    JSON.stringify({ tracker: Object.assign({}, t, { checkpoints: "x" }) }),
    JSON.stringify({ tracker: Object.assign({}, t, { id: 123 }) }),
    JSON.stringify({ tracker: Object.assign({}, t, { checkpoints: [{ carrier_status: "delivered", checkpoint_time: "1" }] }) }),
    JSON.stringify({ tracker: Object.assign({}, t, { checkpoints: [{ carrier_status: "   ", checkpoint_time: "2026-10-01T10:00:00Z" }] }) }),
    JSON.stringify({ tracker: Object.assign({}, t, { checkpoints: [{ carrier_status: "Objeto entregue ao destinatário", checkpoint_time: "2026-10-01T10:00:00" }] }) }),
  ];
  return options[Math.floor(Math.random() * options.length)];
}

const INVALID_SHIPMENTS = ["", "{", "[]", '{"tracking_code": 1}', '{"tracking_code": "QB 1", "carrier": "correios"}', '{"carrier": {}}'];

export default function (shipments) {
  const target = shipments[Math.floor(Math.random() * shipments.length)];
  const roll = Math.random();

  if (roll < 0.1) {
    let res;
    if (Math.random() < 0.7) {
      const body = invalidWebhookBody(target);
      res = http.post(`${BASE_URL}/webhooks/aggregator`, body, { headers: signed(body), tags: { name: "invalido" } });
    } else {
      const body = INVALID_SHIPMENTS[Math.floor(Math.random() * INVALID_SHIPMENTS.length)];
      res = http.post(`${BASE_URL}/shipments`, body, { headers: { "content-type": "application/json" }, tags: { name: "invalido" } });
    }
    check(res, { "payload inválido 400": (r) => r.status === 400 });
  } else if (roll < 0.65) {
    // Subconjunto embaralhado, com o primeiro evento repetido no fim.
    const subset = shuffled(target.tracker.checkpoints).slice(0, 1 + Math.floor(Math.random() * 3));
    subset.push(subset[0]);
    const body = JSON.stringify({ tracker: Object.assign({}, target.tracker, { checkpoints: subset }) });
    const res = http.post(`${BASE_URL}/webhooks/aggregator`, body, { headers: signed(body), tags: { name: "webhook" } });
    check(res, { "webhook 200": (r) => r.status === 200 });
  } else if (roll < 0.7) {
    // Webhook forjado dizendo "entregue", com assinatura de outro segredo: tem que ser recusado.
    const forged = { checkpoint_id: "forjado-" + Math.random(), carrier_status: "delivered", checkpoint_time: new Date().toISOString() };
    const body = JSON.stringify({ tracker: Object.assign({}, target.tracker, { checkpoints: [forged] }) });
    const headers = signed(body);
    headers["x-aggregator-signature"] = "sha256=" + crypto.hmac("sha256", "segredo-errado", body, "hex");
    const res = http.post(`${BASE_URL}/webhooks/aggregator`, body, {
      headers,
      tags: { name: "webhook-forjado" },
      responseCallback: FORGED_ONLY,
    });
    check(res, { "webhook forjado 401": (r) => r.status === 401 });
  } else if (roll < 0.95) {
    const res = http.post(`${BASE_URL}/shipments/${target.id}/refresh`, null, { tags: { name: "refresh" } });
    check(res, { "refresh 200": (r) => r.status === 200 });
  } else {
    const res = http.post(`${BASE_URL}/jobs/check-delays`, null, { tags: { name: "check-delays" } });
    check(res, { "check-delays 200": (r) => r.status === 200 });
  }
}
