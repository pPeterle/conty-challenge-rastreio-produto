const HOUR = 3_600_000;

/** Lê a configuração do ambiente. O padrão de 7 dias é arbitrário, ajuste por DELAY_LIMIT_HOURS. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const limitHours = Number(env.DELAY_LIMIT_HOURS ?? 168);
  if (!Number.isFinite(limitHours) || limitHours <= 0) {
    throw new Error("DELAY_LIMIT_HOURS precisa ser um número positivo");
  }
  // DELAY_LIMIT_HOURS_CORREIOS=72 sobrescreve o limite global só para os Correios.
  const delayLimitByCarrierMs = new Map<string, number>();
  for (const [key, value] of Object.entries(env)) {
    const match = /^DELAY_LIMIT_HOURS_([A-Z0-9_]+)$/.exec(key);
    if (!match) continue;
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) throw new Error(`${key} precisa ser um número positivo`);
    delayLimitByCarrierMs.set(match[1].toLowerCase(), hours * HOUR);
  }
  const toleranceMinutes = Number(env.FUTURE_TOLERANCE_MINUTES ?? 10);
  if (!Number.isFinite(toleranceMinutes) || toleranceMinutes < 0) {
    throw new Error("FUTURE_TOLERANCE_MINUTES precisa ser um número maior ou igual a zero");
  }
  const webhookSecret = env.AGGREGATOR_WEBHOOK_SECRET ?? "";
  if (webhookSecret === "" && env.NODE_ENV === "production") {
    throw new Error("AGGREGATOR_WEBHOOK_SECRET é obrigatório em produção");
  }
  return {
    // Fora de produção há um segredo padrão só para facilitar o uso local.
    webhookSecret: webhookSecret || "segredo-local",
    port: Number(env.PORT ?? 3105),
    dbPath: env.DB_PATH ?? "rastreio.db",
    aggregatorUrl: env.AGGREGATOR_URL ?? "http://localhost:3115",
    startFakeAggregator: (env.START_FAKE_AGGREGATOR ?? "true") === "true",
    fakeAggregatorPort: Number(env.FAKE_AGGREGATOR_PORT ?? 3115),
    tracking: {
      delayLimitMs: limitHours * HOUR,
      delayLimitByCarrierMs,
      futureToleranceMs: toleranceMinutes * 60_000,
    },
  };
}
