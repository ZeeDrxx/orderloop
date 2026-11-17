import { getPool } from "@/core/db.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await getPool().query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch {
    return Response.json({ status: "database unavailable" }, { status: 503 });
  }
}
