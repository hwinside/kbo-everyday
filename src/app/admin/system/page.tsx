"use client";

import { Globe, Gauge, Database, Rocket } from "lucide-react";

function EmptyState({
  icon: Icon,
  title,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
}) {
  return (
    <div className="glass-card p-8">
      <div className="flex items-center gap-2 mb-6">
        <Icon className="w-5 h-5 text-[#6366F1]" />
        <h2 className="text-lg font-semibold">{title}</h2>
      </div>
      <div className="flex flex-col items-center justify-center py-8 text-[#636366]">
        <Icon className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">수집 준비 중</p>
      </div>
    </div>
  );
}

export default function AdminSystemPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">시스템 모니터링</h1>
      <EmptyState icon={Globe} title="API 호출량 (일간)" />
      <EmptyState icon={Gauge} title="성능 모니터링 (Web Vitals)" />
      <EmptyState icon={Database} title="Supabase 사용량" />
      <EmptyState icon={Rocket} title="배포 히스토리" />
    </div>
  );
}
