import { serve } from "@hono/node-server";
import { createFakeAggregatorApp } from "./app.ts";

const port = Number(process.env.FAKE_AGGREGATOR_PORT ?? 3115);
serve({ fetch: createFakeAggregatorApp().fetch, port }, () => {
  console.log(`agregador fictício em http://localhost:${port}`);
});
