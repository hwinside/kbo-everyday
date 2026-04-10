import Link from "next/link";

interface LegalPageLayoutProps {
  title: string;
  effectiveDate: string;
  updatedAt?: string;
  children: React.ReactNode;
}

export default function LegalPageLayout({
  title,
  effectiveDate,
  updatedAt,
  children,
}: LegalPageLayoutProps) {
  return (
    <div className="min-h-screen bg-bg-primary text-text-primary">
      <div className="mx-auto max-w-3xl px-5 py-10 sm:px-6 sm:py-12">
        <div className="mb-8 rounded-3xl border border-border bg-bg-secondary/80 p-6 shadow-sm backdrop-blur">
          <p className="text-sm font-semibold text-accent">크보팬 정책 문서</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight">{title}</h1>
          <div className="mt-4 space-y-1 text-sm text-text-secondary">
            <p>시행일: {effectiveDate}</p>
            {updatedAt ? <p>최종 수정일: {updatedAt}</p> : null}
          </div>
          <div className="mt-5 flex flex-wrap gap-3 text-sm">
            <Link href="/terms" className="rounded-full bg-bg-tertiary px-4 py-2 text-text-secondary transition-colors hover:text-text-primary">
              이용약관
            </Link>
            <Link href="/privacy" className="rounded-full bg-bg-tertiary px-4 py-2 text-text-secondary transition-colors hover:text-text-primary">
              개인정보처리방침
            </Link>
            <Link href="/" className="rounded-full bg-bg-tertiary px-4 py-2 text-text-secondary transition-colors hover:text-text-primary">
              홈으로
            </Link>
          </div>
        </div>

        <article className="space-y-8 rounded-3xl border border-border bg-bg-secondary/60 p-6 shadow-sm sm:p-8">
          {children}
        </article>
      </div>
    </div>
  );
}
