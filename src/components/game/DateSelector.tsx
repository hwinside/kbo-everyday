"use client";

import { PRESEASON_DATES } from "@/lib/constants/preseason-schedule";

import { useRef, useEffect } from "react";
import { motion } from "framer-motion";
import { getKSTDateRange } from "@/lib/utils/date-kst";

interface DateSelectorProps {
  selectedDate: string; // YYYY-MM-DD
  onDateChange: (date: string) => void;
}

export default function DateSelector({ selectedDate, onDateChange }: DateSelectorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dates = getKSTDateRange();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const selected = el.querySelector(`[data-date="${selectedDate}"]`) as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ inline: "center", behavior: "smooth" });
    }
  }, []);

  return (
    <div
      ref={scrollRef}
      className="flex gap-1 overflow-x-auto hide-scrollbar py-2 px-3"
    >
      {dates.map((d) => {
        const isSelected = d.key === selectedDate;
        const isSunday = d.weekday === "일";
        const isSaturday = d.weekday === "토";
        return (
          <button
            key={d.key}
            data-date={d.key}
            onClick={() => onDateChange(d.key)}
            className={`relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-2 min-w-[44px] transition-all ${
              isSelected
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-bg-tertiary"
            }`}
          >
            <span className={`text-xs font-medium ${
              !isSelected && isSunday ? "text-red-400" : 
              !isSelected && isSaturday ? "text-blue-400" : ""
            }`}>
              {d.weekday}
            </span>
            <span className={`text-base font-bold ${isSelected ? "text-white" : ""}`}>
              {d.day}
            </span>
            {d.isToday && !isSelected && (
              <div className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-accent" />
            )}
            {!d.isToday && !isSelected && PRESEASON_DATES.includes(d.key) && (
              <div className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-text-tertiary" />
            )}
          </button>
        );
      })}
    </div>
  );
}
