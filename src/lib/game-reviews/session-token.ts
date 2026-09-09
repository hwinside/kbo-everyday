type Session = { access_token: string; expires_at?: number; user: { id: string } } | null;

/** Component-scoped only. Auth events invalidate pending reads as well as cached tokens. */
export function createReviewTokenReader(userId: string | null, readSession: () => Promise<Session>) {
  let session: Session = null;
  let generation = 0;
  let pending: Promise<string | null> | null = null;
  const usable = () => session?.user.id === userId && (session?.expires_at ?? 0) * 1000 > Date.now() + 60_000;
  return {
    update(next: Session) { generation++; session = next; pending = null; },
    async read(): Promise<string | null> {
      if (!userId) return null;
      if (usable()) return session!.access_token;
      if (pending) return pending;
      const started = generation;
      const flight = (async () => {
        const next = await readSession();
        if (started === generation) session = next;
        // Never silently turn a signed-in read/write into an anonymous request.
        if (session?.user.id !== userId || (session.expires_at ?? 0) * 1000 <= Date.now()) {
          throw new Error("로그인 상태가 바뀌었어요. 다시 로그인해 주세요");
        }
        return session.access_token;
      })();
      pending = flight;
      try { return await flight; }
      finally { if (pending === flight) pending = null; }
    },
  };
}
