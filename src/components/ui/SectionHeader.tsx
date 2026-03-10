import Link from "next/link";
import { ChevronRight } from "lucide-react";

/** Section heading: 18/26/600 — 절대 변경 금지 (design-tokens-v0.md 참고) */
export default function SectionHeader({ title, href, icon }: { title: string; href?: string; icon?: string }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg leading-[26px] font-semibold text-text-primary">
        {icon && <span>{icon}</span>} {title}
      </h2>
      {href && (
        <Link
          href={href}
          className="flex items-center text-xs text-text-tertiary hover:text-text-primary transition-colors"
        >
          전체보기 <ChevronRight size={20} />
        </Link>
      )}
    </div>
  );
}
