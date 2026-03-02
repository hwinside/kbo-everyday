"use client";

import Link from "next/link";
import { MapPin, Users, Clock, Shield, ChevronRight } from "lucide-react";

interface StadiumInfoProps {
  name: string;
  location: string;
  capacity: string;
  gameTime: string;
  attendance: string;
  stadiumId?: string;
  umpires: { role: string; name: string }[];
}

export default function StadiumInfo({ name, location, capacity, gameTime, attendance, stadiumId, umpires }: StadiumInfoProps) {
  const nameContent = (
    <div className="flex items-center gap-1">
      <p className="text-sm font-medium text-text-primary">{name}</p>
      {stadiumId && <ChevronRight size={14} className="text-accent" />}
    </div>
  );

  return (
    <div className="glass-card p-4">
      <h3 className="text-sm font-bold text-text-tertiary mb-3">경기 정보</h3>
      
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <MapPin size={16} className="text-text-tertiary flex-shrink-0" />
          <div>
            {stadiumId ? (
              <Link href={`/stadiums/${stadiumId}`} className="block">
                {nameContent}
              </Link>
            ) : nameContent}
            <p className="text-xs text-text-tertiary">{location} · 수용 {capacity}</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <Users size={16} className="text-text-tertiary flex-shrink-0" />
          <span className="text-sm text-text-secondary">관중 {attendance}명</span>
        </div>

        <div className="flex items-center gap-3">
          <Clock size={16} className="text-text-tertiary flex-shrink-0" />
          <span className="text-sm text-text-secondary">경기시간 {gameTime}</span>
        </div>

        <div className="flex items-start gap-3">
          <Shield size={16} className="text-text-tertiary flex-shrink-0 mt-0.5" />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {umpires.map((u) => (
              <span key={u.role} className="text-xs text-text-tertiary">
                <span className="text-text-secondary">{u.role}</span> {u.name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
