import { app } from "@azure/functions";

import { runSync } from "./handlers.ts";

// Every hour by default (NCRONTAB, six fields). Override with the SYNC_SCHEDULE app setting.
app.timer("scheduledSync", {
  schedule: "%SYNC_SCHEDULE%",
  runOnStartup: false,
  handler: async (timer, context) => {
    if (timer.isPastDue) context.warn("timer is past due: the previous run may have overrun");
    await runSync("schedule", context);
  },
});

// POST /api/syncNow?code=<function key>: run a sync on demand.
app.http("syncNow", {
  methods: ["POST"],
  authLevel: "function",
  handler: async (_request, context) => {
    const results = await runSync("manual", context);
    const ok = results.every((r) => r.status === "ok");
    return { status: ok ? 200 : 207, jsonBody: { ok, results } };
  },
});
