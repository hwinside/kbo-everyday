import { NextRequest, NextResponse } from "next/server";
import { isAdminAuthedRequest } from "@/lib/admin/pin";
import { checkAnomalies } from "@/lib/admin/anomaly";

async function verifyPin(req: NextRequest): Promise<boolean> {
  return isAdminAuthedRequest(req);
}

export async function POST(req: NextRequest) {
  if (!(await verifyPin(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results = await checkAnomalies();
  return NextResponse.json({ results });
}
