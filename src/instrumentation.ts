// Runs once when the server starts: bring the schema up to date, then (optionally) a first sync.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.env.DATABASE_URL) return;
  const { getPool, migrate } = await import("./core/db.ts");
  const applied = await migrate(getPool());
  if (applied.length) console.log(`migrations applied: ${applied.join(", ")}`);
  if (process.env.SYNC_ON_START === "1") {
    const { sapConfigFromEnv, syncAll } = await import("./core/sync.ts");
    syncAll(getPool(), sapConfigFromEnv(), "startup").then((results) =>
      console.log("startup sync:", results.map((r) => `${r.entity}=${r.status}(${r.upserted})`).join(" ")));
  }
}
