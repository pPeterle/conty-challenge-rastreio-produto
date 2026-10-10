import { serve } from "@hono/node-server";
import { createFakeAggregatorApp } from "./app.ts";

const port = Number(process.env.FAKE_AGGREGATOR_PORT ?? 3115);
const webhookUrl = process.env.WEBHOOK_URL;
const secret = process.env.AGGREGATOR_WEBHOOK_SECRET ?? "segredo-local";
const app = createFakeAggregatorApp(
  webhookUrl
    ? { webhook: { secret, send: (body, headers) => fetch(webhookUrl, { method: "POST", headers, body }) } }
    : {},
);
serve({ fetch: app.fetch, port }, () => {
  console.log(`agregador fictício em http://localhost:${port}`);
});
