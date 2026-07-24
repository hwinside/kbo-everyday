import { NextRequest, NextResponse } from "next/server";
import { resolveGameVenue } from "@/lib/venue-stories/venue-resolve";
import {
  VENUE_GEOFENCE_DEFAULT_RADIUS_M,
  type VenueInfo,
} from "@/lib/venue-stories/types";

export const maxDuration = 15;

// GET: 클라 지오펜스 프리체크·업로드 게이트용 구장 정보
export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) {
    return NextResponse.json({ error: "gameId 필요" }, { status: 400 });
  }

  const venue = await resolveGameVenue(gameId);
  const info: VenueInfo = {
    gameId,
    stadiumName: venue.coord?.name ?? venue.stadiumName ?? null,
    lat: venue.coord?.lat ?? null,
    lng: venue.coord?.lng ?? null,
    radiusM: venue.coord?.radiusM ?? VENUE_GEOFENCE_DEFAULT_RADIUS_M,
    uploadOpen: venue.uploadOpen,
    reason: venue.reason,
    cancelled: venue.cancelled,
    gateKind: venue.gateKind,
  };
  return NextResponse.json(info);
}
