import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { pin } = await req.json();
  const adminPin = process.env.ADMIN_PIN;

  if (!adminPin) {
    return NextResponse.json({ error: "ADMIN_PIN not configured" }, { status: 500 });
  }

  if (pin === adminPin) {
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid PIN" }, { status: 401 });
}
