export class DeadlineExceededError extends Error {
  constructor() {
    super("deadline_exceeded");
    this.name = "DeadlineExceededError";
  }
}

/**
 * Start and await one async operation only inside an absolute wall-clock deadline.
 * AbortSignal remains the first-line cancellation mechanism for fetch/PostgREST;
 * this race is the completion backstop for clients that ignore or cannot accept it.
 */
export async function runBeforeDeadline<T>(
  task: () => PromiseLike<T>,
  deadlineAtMs?: number,
  now: () => number = Date.now,
): Promise<T> {
  if (deadlineAtMs == null) return await task();

  const remainingMs = deadlineAtMs - now();
  if (remainingMs <= 0) throw new DeadlineExceededError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new DeadlineExceededError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function isDeadlineExceeded(error: unknown): boolean {
  return error instanceof DeadlineExceededError
    || (error instanceof Error && error.message === "deadline_exceeded");
}
