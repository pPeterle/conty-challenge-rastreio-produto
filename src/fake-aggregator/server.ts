import { serve } from "@hono/node-server";
import { createLogger, flushOnShutdown } from "../logger.ts";
import { createFakeAggregatorApp } from "./app.ts";

const logger = createLogger().child({ servico: "agregador-ficticio" });

const port = Number(process.env.FAKE_AGGREGATOR_PORT ?? 3115);
const webhookUrl = process.env.WEBHOOK_URL;
const secret = process.env.AGGREGATOR_WEBHOOK_SECRET ?? "segredo-local";
const app = createFakeAggregatorApp(
  webhookUrl
    ? { webhook: { secret, send: (body, headers) => fetch(webhookUrl, { method: "POST", headers, body }) }, logger }
    : { logger },
);
const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, `agregador fictício em http://localhost:${port}`);
});
flushOnShutdown(logger, () => server.close());
