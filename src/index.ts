import { serve } from "@hono/node-server";
import { FakeAggregatorClient } from "./aggregator/fake/client.ts";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createFakeAggregatorApp } from "./fake-aggregator/app.ts";
import { createLogger, flushOnShutdown } from "./logger.ts";

const logger = createLogger();
const config = loadConfig();
const servers: Array<{ close(): unknown }> = [];

if (config.startFakeAggregator) {
  const aggregatorLogger = logger.child({ servico: "agregador-ficticio" });
  const fakeAggregator = createFakeAggregatorApp({
    webhook: {
      secret: config.webhookSecret,
      send: (body, headers) =>
        fetch(`http://localhost:${config.port}/webhooks/aggregator`, { method: "POST", headers, body }),
    },
    logger: aggregatorLogger,
  });
  servers.push(
    serve({ fetch: fakeAggregator.fetch, port: config.fakeAggregatorPort }, () => {
      aggregatorLogger.info({ port: config.fakeAggregatorPort }, `agregador fictício em http://localhost:${config.fakeAggregatorPort}`);
    }),
  );
}

const app = createApp({
  db: new Db(config.dbPath),
  clock: systemClock,
  aggregator: new FakeAggregatorClient({ baseUrl: config.aggregatorUrl, webhookSecret: config.webhookSecret }),
  config: config.tracking,
  logger,
});

servers.push(
  serve({ fetch: app.fetch, port: config.port }, () => {
    logger.info({ port: config.port }, `API de rastreio em http://localhost:${config.port}`);
  }),
);
flushOnShutdown(logger, () => servers.forEach((s) => s.close()));
