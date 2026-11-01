"use client";

import { Component, Suspense, type ReactNode } from "react";
import { isChunkLoadError, maybeReloadForChunkError, reportClientError } from "@/lib/client-error-report";

import { installForegroundTask } from "@/lib/foreground-task";

/** Optional home content must not replace the score/home shell on load failure.
 * Suspense handles pending imports, not rejected imports. Only exhausted chunk
 * failures use the existing guarded reload; other render errors stay isolated.
 */
export default class HomeSectionBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  private cancelRecovery?: () => void;

  componentWillUnmount() {
    this.cancelRecovery?.();
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    if (isChunkLoadError(error.message)) {
      this.cancelRecovery?.();
      this.cancelRecovery = installForegroundTask(() => {
        // One attempt per boundary, even when the shared reload guard denies it.
        this.cancelRecovery?.();
        maybeReloadForChunkError(error.message);
      });
    }
    reportClientError({
      message: error.message,
      stack: error.stack,
      source: "error-boundary",
      digest: "home-section-isolated-v1",
    });
  }

  render() {
    if (this.state.failed) return null;
    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}
