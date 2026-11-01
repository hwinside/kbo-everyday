"use client";

import { Component, Suspense, type ReactNode } from "react";
import { reportClientError } from "@/lib/client-error-report";

/** Optional home content must not replace the score/home shell on load failure.
 * Suspense handles pending imports, not rejected imports. Do not auto-reload:
 * a failed optional section is not a reason to interrupt the rest of the page.
 */
export default class HomeSectionBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    reportClientError({
      message: error.message,
      stack: error.stack,
      source: "error-boundary",
      digest: "home-section-isolated-v1",
    });
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="rounded-2xl bg-bg-secondary p-4 text-sm text-text-secondary">
          <p>이 영역을 불러오지 못했어요.</p>
          <button
            type="button"
            className="mt-2 underline"
            onClick={() => window.location.reload()}
          >
            페이지 새로고침
          </button>
        </div>
      );
    }
    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}
