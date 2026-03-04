#!/usr/bin/env python3
"""
선수 프로필 enrichment 배치 스크립트 v2
- 1명씩 처리 + 체크포인트
- JSON 파일로 관리
- 중단돼도 이어서 재개
"""

import json, re, time, urllib.request, urllib.parse, os, sys
import websocket

PROFILES_TS = "src/lib/constants/player-profiles.ts"
CHECKPOINT_FILE = "/tmp/enrich-checkpoint.json"
OUTPUT_FILE = "/tmp/enriched-profiles.json"
CHROME_PORT = 19222
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))
SLEEP_BETWEEN = 3

# 부정적 키워드
NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출"]

def load_checkpoint():
    if os.path.exists(CHECKPOINT_FILE):
        with open(CHECKPOINT_FILE) as f:
            return json.load(f)
    return {"done": [], "failed": []}

def save_checkpoint(cp):
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump(cp, f, ensure_ascii=False, indent=2)

def load_enriched():
    if os.path.exists(OUTPUT_FILE):
        with open(OUTPUT_FILE) as f:
            return json.load(f)
    return {}

def save_enriched(data):
    with open(OUTPUT_FILE, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_all_players():
    with open(PROFILES_TS) as f:
        content = f.read()
    
    players = []
    for m in re.finditer(
        r'"([가-힣a-zA-Z\s]+)":\s*\{\s*\n?\s*bio:',
        content
    ):
        players.append(m.group(1))
    return players

def crawl_namuwiki(name):
    """Namuwiki CDP 크롤링"""
    # 먼저 이름 그대로, 안 되면 (야구선수) 시도
    for suffix in ["", "(야구선수)"]:
        search_name = f"{name}{suffix}"
        url = f"https://namu.wiki/w/{urllib.parse.quote(search_name)}"
        
        try:
            req = urllib.request.Request(
                f"http://localhost:{CHROME_PORT}/json/new?{urllib.parse.quote(url)}",
                method="PUT"
            )
            resp = urllib.request.urlopen(req)
            tab = json.loads(resp.read())
        except Exception as e:
            continue
        
        time.sleep(4)
        
        try:
            ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=15)
            ws.send(json.dumps({
                "id": 1,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": "document.querySelector('#app')?.innerText?.substring(0, 12000) || ''",
                    "returnByValue": True
                }
            }))
            
            result = json.loads(ws.recv())
            text = result.get("result", {}).get("result", {}).get("value", "")
            ws.close()
        except:
            text = ""
        
        # 탭 닫기
        try:
            req2 = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/close/{tab['id']}", method="PUT")
            urllib.request.urlopen(req2)
        except:
            pass
        
        # 야구 관련인지 확인
        if text and len(text) > 200 and any(kw in text for kw in ["KBO", "프로야구", "입단", "드래프트", "트윈스", "자이언츠", "라이온즈", "베어스", "위즈", "랜더스", "다이노스", "타이거즈", "이글스", "히어로즈"]):
            return text
    
    return None

def parse_profile(raw_text):
    """텍스트에서 프로필 추출 — bio/career/tmi 모두 풍성하게"""
    lines = [l.strip() for l in raw_text.split("\n") if l.strip()]
    
    bio_parts = []
    career_parts = []
    tmi_parts = []
    style_parts = []  # 플레이 스타일
    
    section = "bio"
    skip_nav = ["최근 변경", "최근 토론", "특수 기능", "편집 요청", "더 보기",
                "펼치기", "접기", "문서를 참고", "각주", "분류", "상위 문서",
                "틀:", "파일:", "나무위키", "로그인"]
    
    for line in lines:
        # 네비게이션/메타 스킵
        if any(kw in line for kw in skip_nav):
            continue
        if len(line) < 3 or line.startswith("[") or line.isdigit():
            continue
        if line.startswith("→") or line.startswith("←"):
            continue
        # 부정적 라인 스킵
        if any(kw in line for kw in NEGATIVE_KW):
            continue
        
        # 섹션 감지
        if any(kw in line for kw in ["선수 경력", "시즌 성적", "수상 이력", "수상 경력", "커리어", "주요 기록", "년도별 성적"]):
            section = "career"
            continue
        elif any(kw in line for kw in ["플레이 스타일", "구종", "타격 스타일", "투구 스타일", "장점"]):
            section = "style"
            continue
        elif any(kw in line for kw in ["여담", "에피소드", "기타 이야기", "이야깃거리", "비하인드", "별명"]):
            section = "tmi"
            continue
        elif any(kw in line for kw in ["응원가", "등장곡", "응원 가사"]):
            section = "tmi"
            tmi_parts.append(f"🎵 {line}")
            continue
        
        if section == "bio" and len("\n".join(bio_parts)) < 2000:
            bio_parts.append(line)
        elif section == "career" and len("\n".join(career_parts)) < 1500:
            career_parts.append(line)
        elif section == "style" and len("\n".join(style_parts)) < 1000:
            style_parts.append(line)
        elif section == "tmi" and len("\n".join(tmi_parts)) < 1500:
            if not any(kw in line for kw in NEGATIVE_KW):
                tmi_parts.append(line)
    
    if len(bio_parts) < 3:
        return None
    
    # 플레이 스타일을 bio에 합치기
    bio = "\n".join(bio_parts)
    if style_parts:
        bio += "\n\n⚾ 플레이 스타일:\n" + "\n".join(f"• {p}" for p in style_parts)
    
    career = ""
    if career_parts:
        career = "🏆 주요 기록:\n" + "\n".join(f"• {p}" for p in career_parts)
    
    tmi = ""
    if tmi_parts:
        tmi = "💡 TMI:\n" + "\n".join(f"• {p}" for p in tmi_parts)
    
    return {"bio": bio, "career": career, "tmi": tmi}

def main():
    print("=" * 50)
    print(f"선수 프로필 Enrichment v2 (batch={BATCH_SIZE})")
    print("=" * 50)
    
    cp = load_checkpoint()
    enriched = load_enriched()
    
    all_thin = get_all_players()
    remaining = [n for n in all_thin if n not in cp["done"] and n not in cp["failed"]]
    
    print(f"Total: {len(all_thin)} | Done: {len(cp['done'])} | Failed: {len(cp['failed'])} | Remaining: {len(remaining)}")
    print()
    
    batch = remaining[:BATCH_SIZE]
    success = fail = 0
    
    for i, name in enumerate(batch):
        print(f"[{i+1}/{len(batch)}] {name}...", end=" ", flush=True)
        
        try:
            raw = crawl_namuwiki(name)
            if raw:
                profile = parse_profile(raw)
                if profile and len(profile["bio"]) > 50:
                    enriched[name] = profile
                    cp["done"].append(name)
                    save_enriched(enriched)
                    save_checkpoint(cp)
                    print(f"✅ (bio:{len(profile['bio'])} career:{len(profile['career'])} tmi:{len(profile['tmi'])})")
                    success += 1
                else:
                    cp["failed"].append(name)
                    save_checkpoint(cp)
                    print("⚠️ (too short)")
                    fail += 1
            else:
                cp["failed"].append(name)
                save_checkpoint(cp)
                print("❌ (not found)")
                fail += 1
        except Exception as e:
            cp["failed"].append(name)
            save_checkpoint(cp)
            print(f"❌ ({e})")
            fail += 1
        
        time.sleep(SLEEP_BETWEEN)
    
    print(f"\n✅ {success} / ❌ {fail} | 누적: {len(cp['done'])} done, {len(cp['failed'])} failed | 남은: {len(remaining) - len(batch)}")

if __name__ == "__main__":
    main()
