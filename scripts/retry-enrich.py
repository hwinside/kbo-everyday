#!/usr/bin/env python3
"""66명 재크롤링 — 동명이인 해결"""

import json, re, time, urllib.request, urllib.parse, os
import websocket

CHROME_PORT = 19222
SLEEP = 4
OUTPUT = "/tmp/enriched-profiles.json"

NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작"]

SKIP_PATTERNS = [
    r"^최근 (변경|수정|토론)", r"^편집", r"^토론$", r"^역사$", r"^분류",
    r"^\d+\.$", r"^→|^←", r"^펼치기|^접기", r"^더 보기", r"^각주",
    r"등번호 \d+번$", r"^\(.+\)$", r"^현역$", r"^임시 결번$",
    r"^\d{4} 시즌", r"^No\.\d+", r"^\d+$", r"^ACL", r"^문서의",
    r"^특수 기능", r"^나무위키", r"^로그인",
]
SKIP_COMPILED = [re.compile(p) for p in SKIP_PATTERNS]

# 선수별 팀 매핑 (주요 선수)
PLAYER_TEAMS = {
    "김도영": "KIA", "류현진": "한화", "문동주": "두산", "손아섭": "NC",
    "노시환": "한화", "김민수": "NC", "이민호": "LG", "박지성": "키움",
}

def crawl(name, suffixes=None):
    if suffixes is None:
        team = PLAYER_TEAMS.get(name, "")
        suffixes = [
            f"(야구선수)",
            f"({team} 야구선수)" if team else None,
            f"(야구)",
            "",
        ]
        suffixes = [s for s in suffixes if s is not None]
    
    for suffix in suffixes:
        search = f"{name}{suffix}"
        url = f"https://namu.wiki/w/{urllib.parse.quote(search)}"
        
        try:
            req = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/new?{urllib.parse.quote(url)}", method="PUT")
            resp = urllib.request.urlopen(req)
            tab = json.loads(resp.read())
        except:
            continue
        
        time.sleep(SLEEP)
        
        try:
            ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=15)
            ws.send(json.dumps({
                "id": 1, "method": "Runtime.evaluate",
                "params": {"expression": "document.querySelector('#app')?.innerText?.substring(0, 12000) || ''", "returnByValue": True}
            }))
            result = json.loads(ws.recv())
            text = result.get("result", {}).get("result", {}).get("value", "")
            ws.close()
        except:
            text = ""
        
        try:
            req2 = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/close/{tab['id']}", method="PUT")
            urllib.request.urlopen(req2)
        except:
            pass
        
        baseball_kw = ["KBO", "프로야구", "타자", "투수", "포수", "내야수", "외야수",
                       "드래프트", "입단", "홈런", "타율", "방어율", "야구"]
        
        if text and len(text) > 200 and any(kw in text for kw in baseball_kw):
            if "동명이인" not in text[:300] and "동음이의" not in text[:300]:
                return text
    
    return None

def clean(text):
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        line = line.strip()
        if len(line) < 2:
            continue
        if any(p.search(line) for p in SKIP_COMPILED):
            continue
        if any(kw in line for kw in NEGATIVE_KW):
            continue
        line = re.sub(r'\[\d+\]', '', line).strip()
        if line:
            cleaned.append(line)
    return cleaned

def parse(text):
    lines = clean(text)
    bio, career, tmi = [], [], []
    section = "bio"
    
    for line in lines:
        if any(kw in line for kw in ["선수 경력", "수상 이력", "수상 경력", "주요 기록"]):
            section = "career"; continue
        elif any(kw in line for kw in ["플레이 스타일", "구종", "타격", "투구"]):
            section = "style"; continue
        elif any(kw in line for kw in ["여담", "에피소드", "이야깃거리", "별명", "응원가"]):
            section = "tmi"; continue
        
        if section == "bio" and len("\n".join(bio)) < 2000:
            bio.append(line)
        elif section in ("career", "style") and len("\n".join(career)) < 1500:
            career.append(line)
        elif section == "tmi" and len("\n".join(tmi)) < 1500:
            tmi.append(line)
    
    if len(bio) < 3:
        return None
    
    return {
        "bio": "\n".join(bio),
        "career": "🏆 주요 기록:\n" + "\n".join(f"• {p}" for p in career) if career else "",
        "tmi": "💡 TMI:\n" + "\n".join(f"• {p}" for p in tmi) if tmi else "",
    }

def main():
    with open("/tmp/retry-players.json") as f:
        players = json.load(f)
    
    with open(OUTPUT) as f:
        enriched = json.load(f)
    
    print(f"Retrying {len(players)} players...")
    success = fail = 0
    
    for i, name in enumerate(players):
        print(f"[{i+1}/{len(players)}] {name}...", end=" ", flush=True)
        
        try:
            raw = crawl(name)
            if raw:
                profile = parse(raw)
                if profile and len(profile["bio"]) > 50:
                    enriched[name] = profile
                    print(f"✅ ({len(profile['bio'])+len(profile['career'])+len(profile['tmi'])} chars)")
                    success += 1
                else:
                    print("⚠️ too short")
                    fail += 1
            else:
                print("❌ not found")
                fail += 1
        except Exception as e:
            print(f"❌ {e}")
            fail += 1
        
        time.sleep(2)
    
    with open(OUTPUT, "w") as f:
        json.dump(enriched, f, ensure_ascii=False, indent=2)
    
    print(f"\n✅ {success} / ❌ {fail}")

if __name__ == "__main__":
    main()
