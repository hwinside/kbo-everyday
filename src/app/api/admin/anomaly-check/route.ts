import { NextRequest, NextResponse } from "next/server";
import { checkAnomalies } from "@/lib/admin/anomaly";

function verifyPin(req: NextRequest): boolean {
  const pin = req.headers.get("x-admin-pin");
  return pin === process.env.ADMIN_PIN;
}

export async function POST(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await checkAnomalies();
  return NextResponse.json({ results });
}
