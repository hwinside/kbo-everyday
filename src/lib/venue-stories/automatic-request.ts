/** Per-section in-flight sharing only. No completed response cache or TTL. */
export function createAutomaticStoryRequest() {
  let epoch = 0;
  const flights = new Map<string, Promise<Response>>();
  return {
    // Capture before awaiting auth. A manual refresh separates even late auth completions.
    epoch: () => epoch,
    invalidate: () => ++epoch,
    async load(url: string, token: string | undefined, requestEpoch: number): Promise<Response> {
      const key = JSON.stringify([requestEpoch, url, token ?? null]);
      let flight = flights.get(key);
      if (!flight) {
        flight = fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
        flights.set(key, flight);
        const pending = flight;
        const release = () => { if (flights.get(key) === pending) flights.delete(key); };
        void flight.then(release, release);
      }
      // Each caller consumes its own body. Keep the section's existing generation fence.
      return (await flight).clone();
    },
  };
}
