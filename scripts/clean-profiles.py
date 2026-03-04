#!/usr/bin/env python3
"""
enriched-profiles.json 정제 스크립트
1. 네비게이션/메타 텍스트 제거
2. bio 앞부분 정리 (선수 기본정보만)
3. 부정적 내용 필터
4. 동명이인 감지
"""

import json, re

INPUT = "/tmp/enriched-profiles.json"
OUTPUT = "/tmp/cleaned-profiles.json"

# 제거할 라인 패턴
SKIP_PATTERNS = [
    r"^최근 (변경|수정|토론)",
    r"^편집[ ]?(요청|보호)?",
    r"^토론$",
    r"^역사$",
    r"^분류",
    r"^\d+\.$",
    r"^→|^←",
    r"^펼치기|^접기",
    r"^더 보기",
    r"^문서를 참고",
    r"^각주",
    r"^상위 문서",
    r"^틀:|^파일:",
    r"^나무위키",
    r"^로그인",
    r"^특수 기능",
    r"등번호 \d+번$",
    r"^\(.+\)$",  # (2022~) 같은 것
    r"^현역$",
    r"^임시 결번$",
    r"^\d{4} 시즌",
    r"^No\.\d+",
    r"^\d+$",  # 숫자만
    r"^ACL 탭",
    r"^문서의 ACL",
    r"^이 문서는",
]

SKIP_COMPILED = [re.compile(p) for p in SKIP_PATTERNS]

NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작"]

def should_skip(line):
    line = line.strip()
    if len(line) < 2:
        return True
    for pat in SKIP_COMPILED:
        if pat.search(line):
            return True
    if any(kw in line for kw in NEGATIVE_KW):
        return True
    return False

def clean_section(text):
    """섹션 텍스트 정제"""
    if not text:
        return ""
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        line = line.strip()
        if should_skip(line):
            continue
        # HTML 엔티티 정리
        line = line.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
        # [숫자] 각주 제거
        line = re.sub(r'\[\d+\]', '', line)
        # 빈 괄호 제거
        line = re.sub(r'\(\s*\)', '', line).strip()
        if line:
            cleaned.append(line)
    return "\n".join(cleaned)

def detect_wrong_person(name, bio):
    """동명이인/잘못된 문서 감지"""
    # 야구 관련 키워드 없으면 의심
    baseball_kw = ["KBO", "프로야구", "타자", "투수", "포수", "내야수", "외야수",
                   "드래프트", "입단", "트윈스", "자이언츠", "라이온즈", "베어스",
                   "위즈", "랜더스", "다이노스", "타이거즈", "이글스", "히어로즈",
                   "야구", "홈런", "타율", "방어율", "세이브", "안타"]
    
    if not any(kw in bio for kw in baseball_kw):
        return True
    
    # 동명이인 페이지 감지
    if "동명이인" in bio[:200] or "동음이의" in bio[:200]:
        return True
    
    return False

def extract_basic_info(bio_text):
    """bio에서 기본 인적사항 추출 및 정리"""
    lines = bio_text.split("\n")
    
    # 선수 이름 찾기 (한글이름 + 한자/영문)
    name_line = ""
    info_lines = []
    
    for line in lines:
        # 생년월일
        if re.search(r"\d{4}년.*\d{1,2}월.*\d{1,2}일", line) or "출생" in line:
            info_lines.append(line)
        # 신체
        elif re.search(r"\d{2,3}cm", line) or re.search(r"\d{2,3}kg", line):
            info_lines.append(line)
        # 학력
        elif any(kw in line for kw in ["학력", "출신학교", "초-", "초등", "중학", "고등", "대학"]):
            info_lines.append(line)
        # 입단/드래프트
        elif any(kw in line for kw in ["입단", "드래프트", "신인", "지명", "라운드", "순위"]):
            info_lines.append(line)
        # 포지션
        elif any(kw in line for kw in ["투수", "포수", "내야수", "외야수", "타자", "우투", "좌투"]):
            info_lines.append(line)
        # 소속팀
        elif any(kw in line for kw in ["소속", "현소속", "트윈스", "자이언츠", "라이온즈", "베어스", "위즈", "랜더스", "다이노스", "타이거즈", "이글스", "히어로즈"]):
            info_lines.append(line)
    
    return info_lines

def main():
    with open(INPUT) as f:
        raw = json.load(f)
    
    print(f"Input: {len(raw)} players")
    
    cleaned = {}
    wrong_person = []
    too_short = []
    
    for name, profile in raw.items():
        bio = clean_section(profile.get("bio", ""))
        career = clean_section(profile.get("career", ""))
        tmi = clean_section(profile.get("tmi", ""))
        
        # 동명이인 감지
        if detect_wrong_person(name, bio):
            wrong_person.append(name)
            continue
        
        # 너무 짧으면 스킵
        if len(bio) < 30:
            too_short.append(name)
            continue
        
        cleaned[name] = {
            "bio": bio,
            "career": career,
            "tmi": tmi,
        }
    
    # 저장
    with open(OUTPUT, "w") as f:
        json.dump(cleaned, f, ensure_ascii=False, indent=2)
    
    print(f"\nResults:")
    print(f"  ✅ Cleaned: {len(cleaned)}")
    print(f"  ❌ Wrong person: {len(wrong_person)} → {wrong_person}")
    print(f"  ⚠️ Too short: {len(too_short)} → {too_short}")
    
    # 통계
    total_bio = sum(len(p["bio"]) for p in cleaned.values())
    total_career = sum(len(p["career"]) for p in cleaned.values())
    total_tmi = sum(len(p["tmi"]) for p in cleaned.values())
    avg = (total_bio + total_career + total_tmi) / len(cleaned) if cleaned else 0
    
    print(f"\n📊 Stats:")
    print(f"  Avg per player: {avg:.0f} chars")
    print(f"  Total bio: {total_bio:,} chars")
    print(f"  Total career: {total_career:,} chars")
    print(f"  Total tmi: {total_tmi:,} chars")
    print(f"  Grand total: {total_bio+total_career+total_tmi:,} chars")

if __name__ == "__main__":
    main()
