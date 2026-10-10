import { serve } from "@hono/node-server";
import { FakeAggregatorClient } from "./aggregator/fake/client.ts";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { createFakeAggregatorApp } from "./fake-aggregator/app.ts";

const config = loadConfig();

if (config.startFakeAggregator) {
  serve({ fetch: createFakeAggregatorApp().fetch, port: config.fakeAggregatorPort }, () => {
    console.log(`agregador fictício em http://localhost:${config.fakeAggregatorPort}`);
  });
}

const app = createApp({
  db: new Db(config.dbPath),
  clock: systemClock,
  aggregator: new FakeAggregatorClient({ baseUrl: config.aggregatorUrl }),
  config: config.tracking,
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`API de rastreio em http://localhost:${config.port}`);
});
