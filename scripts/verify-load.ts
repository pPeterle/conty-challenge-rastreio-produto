/**
 * Confere as invariantes depois da carga. Sai com código 1 se alguma quebrou:
 * evento duplicado, status final errado, status que andou para trás ou alerta duplicado.
 */
import { readFileSync } from "node:fs";
import { progressRank, type ShipmentStatus } from "../src/domain/status.ts";

const API = process.env.API_URL ?? "http://localhost:3105";
const expected = JSON.parse(readFileSync(process.env.EXPECTED_FILE ?? ".load-tmp/expected.json", "utf8")) as Record<
  string,
  { kind: string; status: string; alerts: number; needsReview: boolean; events: number }
>;

// Uma rodada final do job garante que todo atrasado teve chance de alertar.
await fetch(`${API}/jobs/check-delays`, { method: "POST" });

const failures: string[] = [];
let totalEvents = 0;

for (const [id, exp] of Object.entries(expected)) {
  const s = (await (await fetch(`${API}/shipments/${id}`)).json()) as any;
  const tag = `${id} (${exp.kind})`;
  totalEvents += s.events.length;

  if (s.events.length !== exp.events) failures.push(`${tag}: ${s.events.length} eventos, esperado ${exp.events}`);
  const identities = new Set(s.events.map((e: any) => `${e.occurred_at}|${e.raw_code}|${e.location}`));
  if (identities.size !== s.events.length) failures.push(`${tag}: histórico com evento duplicado`);
  if (s.status !== exp.status) failures.push(`${tag}: status ${s.status}, esperado ${exp.status}`);
  if (s.needs_review !== exp.needsReview) failures.push(`${tag}: needs_review ${s.needs_review}, esperado ${exp.needsReview}`);
  if (s.alerts.length !== exp.alerts) failures.push(`${tag}: ${s.alerts.length} alertas, esperado ${exp.alerts}`);

  let maxRank = 0;
  let delivered = false;
  for (const change of s.status_changes as Array<{ from: ShipmentStatus | null; to: ShipmentStatus }>) {
    if (delivered) failures.push(`${tag}: status mudou para ${change.to} depois de entregue`);
    const rank = progressRank(change.to);
    if (rank !== null && rank < maxRank) failures.push(`${tag}: status regrediu para ${change.to}`);
    if (rank !== null) maxRank = Math.max(maxRank, rank);
    if (change.to === "entregue") delivered = true;
  }
}

const alerts = ((await (await fetch(`${API}/alerts?include_resolved=true&limit=200`)).json()) as any).alerts as Array<{ shipment_id: string; kind: string }>;
const alertKeys = new Set(alerts.map((a) => `${a.shipment_id}|${a.kind}`));
if (alertKeys.size !== alerts.length) failures.push("existe alerta duplicado para a mesma remessa");

if (failures.length > 0) {
  console.error(`verificação FALHOU (${failures.length} problemas):`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `verificação ok: ${Object.keys(expected).length} remessas, ${totalEvents} eventos únicos, ${alerts.length} alertas, nenhum status regrediu`,
);
