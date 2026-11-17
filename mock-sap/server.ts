// Mock SAP S/4HANA OData server on http://localhost:4004/sap/opu/odata/sap/…
//   MOCK_TODAY=2026-11-17  pins the simulated date (default: real today)
//   POST /mock/advance?days=7  moves the simulated date forward: new orders, deliveries, payments appear
import { createServer } from "node:http";

import { makeFixtures } from "./generate.ts";
import { handle } from "./handler.ts";

const port = Number(process.env.PORT ?? 4004);
let today = process.env.MOCK_TODAY ? new Date(process.env.MOCK_TODAY) : new Date();
let fixtures = makeFixtures(today);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/mock/advance") {
    today = new Date(today.getTime() + Number(url.searchParams.get("days") ?? 1) * 86_400_000);
    fixtures = makeFixtures(today);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ today: today.toISOString() }));
    return;
  }
  if (url.pathname === "/health") {
    res.writeHead(200).end("ok");
    return;
  }
  const response = handle(url, fixtures);
  res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
}).listen(port, () => {
  const counts = Object.entries(fixtures).map(([k, v]) => `${k}=${v.length}`).join(" ");
  console.log(`mock SAP on :${port}, today ${today.toISOString().slice(0, 10)} (${counts})`);
});
