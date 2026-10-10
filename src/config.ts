const HOUR = 3_600_000;

/** Lê a configuração do ambiente. O padrão de 7 dias é arbitrário, ajuste por DELAY_LIMIT_HOURS. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const limitHours = Number(env.DELAY_LIMIT_HOURS ?? 168);
  if (!Number.isFinite(limitHours) || limitHours <= 0) {
    throw new Error("DELAY_LIMIT_HOURS precisa ser um número positivo");
  }
  return {
    port: Number(env.PORT ?? 3105),
    dbPath: env.DB_PATH ?? "rastreio.db",
    aggregatorUrl: env.AGGREGATOR_URL ?? "http://localhost:3115",
    startFakeAggregator: (env.START_FAKE_AGGREGATOR ?? "true") === "true",
    fakeAggregatorPort: Number(env.FAKE_AGGREGATOR_PORT ?? 3115),
    tracking: { delayLimitMs: limitHours * HOUR },
  };
}
