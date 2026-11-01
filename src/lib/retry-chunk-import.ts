import { isChunkLoadError } from "@/lib/client-error-report";

/** Retry before React.lazy caches a rejection. Some loaders cache failures too;
 * a second rejection deliberately reaches the boundary's guarded reload path.
 * Never retry module evaluation / ordinary application errors.
 */
export async function retryChunkImport<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!(error instanceof Error) || !isChunkLoadError(error.message)) throw error;
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    return load();
  }
}
