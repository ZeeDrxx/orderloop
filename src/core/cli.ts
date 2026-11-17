// node src/core/cli.ts migrate | sync [entity…] | probe
import { closePool, getPool, migrate } from "./db.ts";
import { ENTITIES } from "./entities.ts";
import { probe } from "./probe.ts";
import { sapConfigFromEnv, syncAll } from "./sync.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "migrate") {
    const applied = await migrate();
    console.log(applied.length ? `applied ${applied.join(", ")}` : "database is up to date");
  } else if (command === "sync") {
    const entities = args.length ? ENTITIES.filter((e) => args.includes(e.name)) : ENTITIES;
    const results = await syncAll(getPool(), sapConfigFromEnv(), "cli", entities);
    for (const r of results) console.log(`${r.status === "ok" ? "✓" : "✗"} ${r.entity.padEnd(18)} fetched ${r.fetched}, upserted ${r.upserted}${r.error ? ` (${r.error})` : ""}`);
    process.exitCode = results.every((r) => r.status === "ok") ? 0 : 1;
  } else if (command === "probe") {
    process.exitCode = (await probe(sapConfigFromEnv())) ? 0 : 1;
  } else {
    console.error("usage: cli.ts migrate | sync [entity…] | probe");
    process.exitCode = 2;
  }
} finally {
  await closePool();
}
