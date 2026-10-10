// Carga sobre o ponto crítico: o mesmo evento chegando muitas vezes, fora de
// ordem e por dois caminhos (webhook e polling) ao mesmo tempo.
import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3105";
const AGG_URL = __ENV.AGG_URL || "http://localhost:3115";
const JSON_HEADERS = { headers: { "content-type": "application/json" } };

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
    http_req_duration: ["p(95)<250"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const list = http.get(`${BASE_URL}/shipments`).json("shipments");
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

export default function (shipments) {
  const target = shipments[Math.floor(Math.random() * shipments.length)];
  const roll = Math.random();

  if (roll < 0.7) {
    // Subconjunto embaralhado, com o primeiro evento repetido no fim.
    const subset = shuffled(target.tracker.checkpoints).slice(0, 1 + Math.floor(Math.random() * 3));
    subset.push(subset[0]);
    const body = JSON.stringify({ tracker: Object.assign({}, target.tracker, { checkpoints: subset }) });
    const res = http.post(`${BASE_URL}/webhooks/aggregator`, body, Object.assign({ tags: { name: "webhook" } }, JSON_HEADERS));
    check(res, { "webhook 200": (r) => r.status === 200 });
  } else if (roll < 0.95) {
    const res = http.post(`${BASE_URL}/shipments/${target.id}/refresh`, null, { tags: { name: "refresh" } });
    check(res, { "refresh 200": (r) => r.status === 200 });
  } else {
    const res = http.post(`${BASE_URL}/jobs/check-delays`, null, { tags: { name: "check-delays" } });
    check(res, { "check-delays 200": (r) => r.status === 200 });
  }
}
