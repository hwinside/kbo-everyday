import { acquireChunkNetworkRetry } from "@/lib/chunk-network-retry";
import { isChunkLoadError } from "@/lib/client-error-report";

/** Retry the script request before the runtime caches a rejection.
 * Non-DOM loaders still get one import retry; exhausted failures reach the boundary.
 * Never retry module evaluation / ordinary application errors.
 */
export async function retryChunkImport<T>(load: () => Promise<T>): Promise<T> {
  const release = acquireChunkNetworkRetry();
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof Error) || !isChunkLoadError(error.message)) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    return await load();
  } finally {
    release();
  }
}
