/** Older last-good data may fill an empty screen but never roll back a newer one. */
export function shouldAcceptRelaySnapshot(previous: string | null, incoming: string | undefined): boolean {
  if (!previous) return true;
  const oldTime = Date.parse(previous);
  const newTime = incoming ? Date.parse(incoming) : NaN;
  return !Number.isFinite(oldTime) || (Number.isFinite(newTime) && newTime >= oldTime);
}
