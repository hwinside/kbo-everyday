#!/usr/bin/env python3
"""프로필 정제 v2 — 사이드바/네비게이션 완전 제거"""

import json, re

INPUT = "/tmp/enriched-profiles.json"
OUTPUT = "/tmp/cleaned-profiles-v2.json"

NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작"]

# 제거할 라인 패턴 (대폭 강화)
SKIP_PATTERNS = [
    r"^최근 (변경|수정|토론)",
    r"^편집",
    r"^토론$",
    r"^역사$",
    r"^분류",
    r"^\d+\.\s*$",          # "1." 만 있는 줄
    r"^\d+\.\s*(개요|개요2|소개|선수 소개|관련 문서|둘러보기|여담|외부 링크|같이 보기)",
    r"^→|^←",
    r"^펼치기|^접기",
    r"^더 보기",
    r"^각주",
    r"^상위 문서",
    r"^틀:|^파일:",
    r"^나무위키",
    r"^로그인",
    r"^특수 기능",
    r"등번호 \d+번$",
    r"^\(.+~?\)$",           # (2022~) 같은 것
    r"^현역$",
    r"^임시 결번$",
    r"^\d{4} 시즌",
    r"^No\.\d+",
    r"^\d+$",                # 숫자만
    r"^ACL",
    r"^문서의",
    r"^이 문서는",
    # 시간 패턴 (사이드바)
    r"^\d+초 전$",
    r"^\d+분 전$",
    r"^\d+시간 전$",
    r"^방금 전$",
    r"^어제$",
    # 나무위키 네비게이션
    r"^관련 문서$",
    r"^둘러보기$",
    r"^외부 링크$",
    r"^같이 보기$",
    r"^목차$",
    r"^문서 정보$",
    r"^기여 내역$",
    r"^문서 이동$",
    r"^되돌리기$",
    # 뉴스 제목 패턴
    r"\(종합\d*보?\)",
    r"\[.*이슈\]",
    r"^'.*'.*,\s*",          # 뉴스 인용 스타일
    # 영문만 (게임/음악 제목)
    r"^[A-Za-z\s\-\.,]+$",  # 영문만 있는 줄
    # 기타 메타
    r"^MBTI$",
    r"^ESTJ|^ISFP|^INFP|^ENFP|^INTJ|^ENTP|^ISTP|^ESTP|^ISTJ|^ESFJ|^ENFJ|^INFJ|^INTP|^ISFJ|^ESFP|^ENTJ",
    r"^\[ 펼치기",
    r"^수정 시각",
    r"^문서 ACL",
    r"^편집 보호",
    r"^\d{4}-\d{2}-\d{2}",  # 날짜만
    # 목차 패턴
    r"^\d+\.\s*\S+$",       # "1. 개요", "5. 관련 문서" 등
    # MBTI
    r"^[A-Z]{4}$",            # ESTJ, INFP 등
    r"^MBTI",
    # 음악/영화 제목 패턴
    r"[〈〉《》]",              # 음악 제목 꺾쇠
    r"^Connor|^Zensery|^Price",
    # "N초 전" 등 (• 제거 후)
    r"^\d+(초|분|시간)\s*전$",
]

SKIP_COMPILED = [re.compile(p, re.IGNORECASE) for p in SKIP_PATTERNS]

def should_skip(line):
    line = line.strip()
    if len(line) < 3:
        return True
    # 패턴 매칭
    for pat in SKIP_COMPILED:
        if pat.search(line):
            return True
    # 부정적 키워드
    if any(kw in line for kw in NEGATIVE_KW):
        return True
    # 너무 짧고 야구와 무관
    if len(line) < 8 and not any(kw in line for kw in ["투수", "타자", "포수", "내야", "외야", "KBO", "야구"]):
        # 짧은 줄이면서 한글+영문 혼재 (제목류)
        if re.match(r'^[가-힣a-zA-Z\s/\-]+$', line) and "/" in line:
            return True
    return False

def clean_section(text):
    if not text:
        return ""
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        line = line.strip()
        # "• " 접두사 제거 후 검사
        check_line = line.lstrip("•🏆💡🎵 ").strip()
        if should_skip(check_line):
            continue
        if should_skip(line):
            continue
        # [숫자] 각주 제거
        line = re.sub(r'\[\d+\]', '', line)
        # HTML 엔티티
        line = line.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        # 빈 괄호
        line = re.sub(r'\(\s*\)', '', line).strip()
        if line and len(line) >= 3:
            cleaned.append(line)
    return "\n".join(cleaned)

def detect_wrong_person(name, bio):
    baseball_kw = ["KBO", "프로야구", "타자", "투수", "포수", "내야수", "외야수",
                   "드래프트", "입단", "트윈스", "자이언츠", "라이온즈", "베어스",
                   "위즈", "랜더스", "다이노스", "타이거즈", "이글스", "히어로즈",
                   "야구", "홈런", "타율", "방어율", "세이브", "안타"]
    if not any(kw in bio for kw in baseball_kw):
        return True
    if "동명이인" in bio[:300] or "동음이의" in bio[:300]:
        return True
    return False

def main():
    with open(INPUT) as f:
        raw = json.load(f)
    
    print(f"Input: {len(raw)} players")
    
    cleaned = {}
    wrong = []
    
    for name, profile in raw.items():
        bio = clean_section(profile.get("bio", ""))
        career = clean_section(profile.get("career", ""))
        tmi = clean_section(profile.get("tmi", ""))
        
        if detect_wrong_person(name, bio):
            wrong.append(name)
            continue
        
        if len(bio) < 30:
            wrong.append(name)
            continue
        
        cleaned[name] = {"bio": bio, "career": career, "tmi": tmi}
    
    with open(OUTPUT, "w") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    
    total = sum(len(p["bio"])+len(p["career"])+len(p["tmi"]) for p in cleaned.values())
    avg = total / len(cleaned) if cleaned else 0
    
    print(f"✅ Cleaned: {len(cleaned)} | ❌ Excluded: {len(wrong)}")
    print(f"📊 Avg: {avg:.0f} chars | Total: {total:,} chars")
    
    # 김영우 확인
    if "김영우" in cleaned:
        t = cleaned["김영우"]["tmi"]
        print(f"\n김영우 TMI preview:\n{t[:300]}")

main()
