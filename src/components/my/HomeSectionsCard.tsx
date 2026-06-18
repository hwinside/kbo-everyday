"use client";

import { useEffect, useState } from "react";
import { LayoutDashboard, GripVertical, Lock } from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import GlassCard from "@/components/ui/GlassCard";
import {
  getAllSectionVisibility,
  getSectionOrder,
  HOME_SECTIONS,
  HOME_SECTIONS_PREF_EVENT,
  setSectionOrder,
  setSectionVisible,
  ALL_VISIBLE,
  HOME_SECTION_KEYS,
  type HomeSectionKey,
  type HomeSectionVisibility,
} from "@/lib/store/home-sections-pref";

const SECTION_BY_KEY = Object.fromEntries(
  HOME_SECTIONS.map((s) => [s.key, s]),
) as Record<HomeSectionKey, (typeof HOME_SECTIONS)[number]>;

// 토글 스위치 (드래그와 무관하게 동작).
function Toggle({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative w-12 h-7 rounded-full transition-colors flex-shrink-0 ${on ? "bg-accent" : "bg-bg-tertiary"}`}
      aria-label={`${label} ${on ? "숨기기" : "표시"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0"}`}
      />
    </button>
  );
}

// 드래그 가능한 섹션 행: 핸들(≡) + 라벨/설명 + 토글. 핸들에만 listeners를 달아
// 세로 스크롤과의 충돌을 막는다.
function SortableSectionRow({
  sectionKey,
  on,
  onToggle,
}: {
  sectionKey: HomeSectionKey;
  on: boolean;
  onToggle: () => void;
}) {
  const def = SECTION_BY_KEY[sectionKey];
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: sectionKey });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
    zIndex: isDragging ? 10 : undefined,
    position: "relative",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 py-3 first:pt-0 last:pb-0 ${
        isDragging ? "bg-bg-secondary rounded-xl" : ""
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="flex-shrink-0 touch-none cursor-grab active:cursor-grabbing text-text-tertiary p-1 -ml-1"
        aria-label={`${def.label} 순서 이동`}
      >
        <GripVertical size={18} />
      </button>
      <div className="flex-1 text-left">
        <span className="text-[15px] text-text-primary">{def.label}</span>
        <p className="text-xs text-text-tertiary mt-0.5">{def.desc}</p>
      </div>
      <Toggle on={on} label={def.label} onClick={onToggle} />
    </div>
  );
}

// 홈 화면 섹션별 on/off + 순서 조정 (기기 로컬 설정).
export default function HomeSectionsCard() {
  const [visibility, setVisibility] = useState<HomeSectionVisibility>(ALL_VISIBLE);
  const [order, setOrder] = useState<HomeSectionKey[]>(HOME_SECTION_KEYS);

  useEffect(() => {
    const sync = () => {
      setVisibility(getAllSectionVisibility());
      setOrder(getSectionOrder());
    };
    sync();
    window.addEventListener(HOME_SECTIONS_PREF_EVENT, sync);
    return () => window.removeEventListener(HOME_SECTIONS_PREF_EVENT, sync);
  }, []);

  // 모바일 터치: 살짝 눌러야 드래그 시작(탭/스크롤과 구분).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIndex = order.indexOf(active.id as HomeSectionKey);
    const newIndex = order.indexOf(over.id as HomeSectionKey);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = arrayMove(order, oldIndex, newIndex);
    setOrder(next);
    setSectionOrder(next);
  };

  return (
    <GlassCard className="p-5">
      <div className="flex items-center gap-4 mb-4">
        <LayoutDashboard size={22} className="text-text-secondary" />
        <div className="text-left">
          <span className="text-base text-text-primary">홈 화면 구성</span>
          <p className="text-xs text-text-tertiary mt-0.5">섹션을 켜고 끄거나, 핸들(≡)을 끌어 순서를 바꿀 수 있어요</p>
        </div>
      </div>

      <div className="flex flex-col divide-y divide-border/40">
        {/* 내 팀 카드 — 항상 최상단 고정 (드래그·토글 불가) */}
        <div className="flex items-center gap-3 py-3 first:pt-0 opacity-90">
          <span className="flex-shrink-0 text-text-tertiary p-1 -ml-1">
            <Lock size={16} />
          </span>
          <div className="flex-1 text-left">
            <span className="text-[15px] text-text-primary">내 팀 카드</span>
            <p className="text-xs text-text-tertiary mt-0.5">항상 맨 위에 고정돼요</p>
          </div>
        </div>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            {order.map((key) => (
              <SortableSectionRow
                key={key}
                sectionKey={key}
                on={visibility[key]}
                onToggle={() => setSectionVisible(key, !visibility[key])}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </GlassCard>
  );
}
