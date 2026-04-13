import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin/pin";
import { checkAnomalies } from "@/lib/admin/anomaly";

function verifyPin(req: NextRequest): boolean {
  return isAdminRequest(req);
}

export async function POST(req: NextRequest) {
  if (!verifyPin(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await checkAnomalies();
  return NextResponse.json({ results });
}
