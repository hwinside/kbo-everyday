export type CsDraftKind = "feedback" | "dm" | "store_review";

const STORE_CS_ID = /^store:(apple|google):[^:]+:[a-f0-9]{12}$/;

export function parseCsDraftKind(value: unknown): CsDraftKind | "" {
  return value === "feedback" || value === "dm" || value === "store_review" ? value : "";
}

export function storePlatformFromCsId(csId: string): "apple" | "google" | null {
  const match = STORE_CS_ID.exec(csId);
  return match ? (match[1] as "apple" | "google") : null;
}

export function validateStoreDraftBody(csId: string, body: string): boolean {
  const platform = storePlatformFromCsId(csId);
  if (!platform || !body.trim()) return false;
  const maxChars = platform === "google" ? 350 : 5000;
  return Array.from(body.trim()).length <= maxChars;
}
