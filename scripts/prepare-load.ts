/**
 * Prepara o teste de carga: cadastra remessas na API e registra no agregador
 * fictício a linha do tempo de cada uma. Grava o resultado esperado em JSON
 * para o verify-load.ts comparar depois.
 */
import { writeFileSync } from "node:fs";

const API = process.env.API_URL ?? "http://localhost:3105";
const AGG = process.env.AGG_URL ?? "http://localhost:3115";
const OUT = process.env.EXPECTED_FILE ?? ".load-tmp/expected.json";
const COUNT = Number(process.env.SHIPMENTS ?? 40);
const HOUR = 3_600_000;

interface Plan {
  carrier: string;
  expected: { status: string; alerts: number; needsReview: boolean };
  timeline: Array<[code: string, hoursAgo: number, location: string]>;
}

// Limite do teste de carga: 72 h (DELAY_LIMIT_HOURS no load.sh).
const PLANS: Record<string, Plan> = {
  entrega_normal: {
    carrier: "correios",
    expected: { status: "entregue", alerts: 0, needsReview: false },
    timeline: [
      ["Objeto postado", 30, "São Paulo/SP"],
      ["Objeto em trânsito - por favor aguarde", 20, "Cajamar/SP"],
      ["Objeto saiu para entrega ao destinatário", 5, "Curitiba/PR"],
      ["Objeto entregue ao destinatário", 2, "Curitiba/PR"],
    ],
  },
  atrasado_com_status_inventado: {
    carrier: "jadlog",
    expected: { status: "em_transito", alerts: 1, needsReview: true },
    timeline: [
      ["EMISSAO", 240, "Recife/PE"],
      ["TRANSFERENCIA", 216, "Salvador/BA"],
      ["TRANSFERENCIA", 120, "Belo Horizonte/MG"],
      ["RETIDO PARA CONFERENCIA ESPECIAL", 100, "Belo Horizonte/MG"],
    ],
  },
  excecao_resolvida: {
    carrier: "loggi",
    expected: { status: "saiu_para_entrega", alerts: 0, needsReview: false },
    timeline: [
      ["picked_up", 40, "Porto Alegre/RS"],
      ["in_transit", 30, "Porto Alegre/RS"],
      ["delivery_failed", 10, "Florianópolis/SC"],
      ["out_for_delivery", 3, "Florianópolis/SC"],
    ],
  },
  excecao_aberta: {
    carrier: "loggi",
    expected: { status: "excecao", alerts: 1, needsReview: false },
    timeline: [
      ["picked_up", 100, "Campinas/SP"],
      ["delivery_failed", 4, "Rio de Janeiro/RJ"],
    ],
  },
};

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} respondeu ${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

const kinds = Object.keys(PLANS);
const now = Date.now();
const expected: Record<string, Plan["expected"] & { kind: string; events: number }> = {};

for (let i = 0; i < COUNT; i++) {
  const kind = kinds[i % kinds.length];
  const plan = PLANS[kind];
  const shipment = await post(`${API}/shipments`, { tracking_code: `LOAD${String(i).padStart(5, "0")}BR`, carrier: plan.carrier });
  for (const [code, hoursAgo, location] of plan.timeline) {
    await post(`${AGG}/v1/trackers/${shipment.aggregator_ref}/checkpoints`, {
      carrier_status: code,
      location,
      checkpoint_time: new Date(now - hoursAgo * HOUR).toISOString(),
    });
  }
  expected[shipment.id] = { ...plan.expected, kind, events: plan.timeline.length };
}

writeFileSync(OUT, JSON.stringify(expected, null, 2));
console.log(`preparadas ${COUNT} remessas em ${kinds.length} cenários; esperado em ${OUT}`);
