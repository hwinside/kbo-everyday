export interface RequestToken {
  key: string;
  generation: number;
}

type RequestResult<T> =
  | { status: "current"; value: T }
  | { status: "stale" };

/** 대상 전환 stale fence + 같은 대상 요청 single-flight를 함께 보장한다. */
export function createRequestCoordinator<T>() {
  let generation = 0;
  let current: RequestToken | null = null;
  let inFlight: {
    token: RequestToken;
    controller: AbortController;
    promise: Promise<RequestResult<T>>;
  } | null = null;

  const matches = (token: RequestToken) =>
    current?.generation === token.generation && current.key === token.key;

  return {
    switchTarget(key: string): RequestToken {
      if (current?.key === key) return current;
      generation += 1;
      inFlight?.controller.abort();
      current = { key, generation };
      return current;
    },

    currentToken(): RequestToken | null {
      return current;
    },

    isCurrent(token: RequestToken): boolean {
      return matches(token);
    },

    run(token: RequestToken, task: (signal: AbortSignal) => Promise<T>): Promise<RequestResult<T>> {
      if (!matches(token)) return Promise.resolve({ status: "stale" });
      if (inFlight?.token.generation === token.generation && inFlight.token.key === token.key) {
        return inFlight.promise;
      }

      inFlight?.controller.abort();
      const controller = new AbortController();
      const request = {
        token,
        controller,
        promise: Promise.resolve({ status: "stale" } as RequestResult<T>),
      };
      request.promise = task(controller.signal)
        .then((value): RequestResult<T> => matches(token) ? { status: "current", value } : { status: "stale" })
        .catch((error): RequestResult<T> => {
          if (!matches(token) || controller.signal.aborted) return { status: "stale" };
          throw error;
        })
        .finally(() => {
          if (inFlight === request) inFlight = null;
        });
      inFlight = request;
      return request.promise;
    },

    dispose(): void {
      generation += 1;
      current = null;
      inFlight?.controller.abort();
      inFlight = null;
    },
  };
}
