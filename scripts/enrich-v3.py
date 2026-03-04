#!/usr/bin/env python3
"""
선수 프로필 enrichment v3 — 섹션 기반 파싱
- 인포박스에서 기본정보 추출
- 본문은 h2 제목으로 split
- 관련 문서/둘러보기 등 불필요 섹션 제거
"""

import json, re, time, urllib.request, urllib.parse, os
import websocket

PROFILES_TS = "src/lib/constants/player-profiles.ts"
CHECKPOINT = "/tmp/enrich-v3-checkpoint.json"
OUTPUT = "/tmp/enrich-v3-output.json"
CHROME_PORT = 19222
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))
SLEEP = 3

NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작"]

PLAYER_SUFFIXES = {
    "김도영": "(야구선수)", "류현진": "(야구선수)", "문동주": "(야구선수)", "손아섭": "(야구선수)",
    "노시환": "(야구선수)", "김민수": "(야구선수)", "이민호": "(야구선수)", "박지성": "(야구선수)",
    "김정민": "(야구선수)", "박진": "(야구선수)", "김건": "(야구선수)", "장민호": "(야구선수)",
    "김진수": "(야구선수)", "김종수": "(야구선수)", "김준수": "(야구선수)", "박성빈": "(야구선수)",
    "이병준": "(야구선수)", "조민석": "(야구선수)", "김상범": "(야구선수)", "양진혁": "(야구선수)",
    "오혜성": "(야구선수)", "이서준": "(야구선수)", "손민석": "(야구선수)", "한준희": "(야구선수)",
    "김서준": "(야구선수)", "강승구": "(야구선수)", "소이현": "(야구선수)", "이기석": "(야구선수)",
    "조재우": "(야구선수)", "신민우": "(야구선수)", "조건희": "(야구선수)", "박정현": "(야구선수)",
    "양재훈": "(야구선수)", "김준상": "(야구선수)", "장창훈": "(야구선수)", "김영우": "(야구선수)",
    "강백호": "(야구선수)", "오영수": "(야구선수)", "임종성": "(야구선수)", "강민균": "(야구선수)",
}

def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default

def save_json(path, data):
    with open(path, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def get_all_players():
    with open(PROFILES_TS) as f:
        content = f.read()
    return re.findall(r'"([가-힣a-zA-Z\s]+)":\s*\{\s*\n?\s*bio:', content)

def crawl_page(name):
    suffix = PLAYER_SUFFIXES.get(name, "")
    search_name = f"{name}{suffix}"
    url = f"https://namu.wiki/w/{urllib.parse.quote(search_name)}"
    
    try:
        req = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/new?{urllib.parse.quote(url)}", method="PUT")
        resp = urllib.request.urlopen(req)
        tab = json.loads(resp.read())
    except:
        return None
    
    time.sleep(4)
    
    try:
        ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=15)
        ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": """
                    (() => {
                        const fullText = document.body.innerText;
                        const startIdx = fullText.indexOf('1. 개요');
                        if (startIdx === -1) return JSON.stringify({error: 'no_overview', text: fullText.substring(0, 500)});
                        
                        const infobox = fullText.substring(Math.max(0, startIdx - 3000), startIdx);
                        const body = fullText.substring(startIdx, startIdx + 15000);
                        
                        return JSON.stringify({infobox: infobox, body: body});
                    })()
                """,
                "returnByValue": True
            }
        }))
        result = json.loads(ws.recv())
        data = json.loads(result.get("result", {}).get("result", {}).get("value", "{}"))
        ws.close()
    except:
        data = None
    
    try:
        req2 = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/close/{tab['id']}", method="PUT")
        urllib.request.urlopen(req2)
    except:
        pass
    
    if not data or "error" in data:
        # (야구선수) 접미사가 없었으면 시도
        if not suffix:
            for s in ["(야구선수)", "(야구)"]:
                url2 = f"https://namu.wiki/w/{urllib.parse.quote(name + s)}"
                try:
                    req = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/new?{urllib.parse.quote(url2)}", method="PUT")
                    resp = urllib.request.urlopen(req)
                    tab = json.loads(resp.read())
                    time.sleep(4)
                    ws = websocket.create_connection(tab["webSocketDebuggerUrl"], timeout=15)
                    ws.send(json.dumps({
                        "id": 1,
                        "method": "Runtime.evaluate",
                        "params": {
                            "expression": """
                                (() => {
                                    const fullText = document.body.innerText;
                                    const startIdx = fullText.indexOf('1. 개요');
                                    if (startIdx === -1) return JSON.stringify({error: 'no_overview'});
                                    return JSON.stringify({
                                        infobox: fullText.substring(Math.max(0, startIdx - 3000), startIdx),
                                        body: fullText.substring(startIdx, startIdx + 15000)
                                    });
                                })()
                            """,
                            "returnByValue": True
                        }
                    }))
                    result = json.loads(ws.recv())
                    data = json.loads(result.get("result", {}).get("result", {}).get("value", "{}"))
                    ws.close()
                    req2 = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/close/{tab['id']}", method="PUT")
                    urllib.request.urlopen(req2)
                    if data and "error" not in data:
                        PLAYER_SUFFIXES[name] = s
                        break
                except:
                    try:
                        req2 = urllib.request.Request(f"http://localhost:{CHROME_PORT}/json/close/{tab['id']}", method="PUT")
                        urllib.request.urlopen(req2)
                    except:
                        pass
    
    return data if data and "error" not in data else None

def parse_infobox(text):
    """인포박스에서 key-value 추출"""
    info = {}
    lines = text.split("\n")
    
    kv_keys = ["출생", "국적", "학력", "신체", "포지션", "투타", "프로 입단", "소속팀", 
               "연봉", "소속사", "등장곡", "병역"]
    
    for i, line in enumerate(lines):
        line = line.strip()
        for key in kv_keys:
            if line == key and i + 1 < len(lines):
                val = lines[i + 1].strip()
                if val and len(val) > 1:
                    info[key] = val
    
    # 이름 + 한자/영문
    for line in lines:
        if "|" in line and ("Kim" in line or "Lee" in line or "Park" in line or "Choi" in line or "Jung" in line or "Kang" in line or any(ord(c) > 0x4E00 for c in line)):
            info["name_full"] = line.strip()
            break
    
    return info

def parse_body_sections(text):
    """본문을 섹션별로 split"""
    sections = {}
    
    # 목차 제거 (첫 번째 "1. 개요\n[편집]" 까지)
    edit_start = text.find("[편집]")
    if edit_start > 0:
        text = text[edit_start + 4:]
    
    # 섹션 분리: "N. 제목\n[편집]" 패턴
    parts = re.split(r'\n\d+\.\s+(.*?)\n\[편집\]', text)
    
    # parts[0] = 개요 내용, parts[1] = 다음 섹션명, parts[2] = 그 내용, ...
    if parts:
        sections["개요"] = parts[0].strip()
    
    for i in range(1, len(parts) - 1, 2):
        section_name = parts[i].strip()
        section_text = parts[i + 1].strip() if i + 1 < len(parts) else ""
        sections[section_name] = section_text
    
    return sections

def filter_negative(text):
    lines = text.split("\n")
    return "\n".join(l for l in lines if not any(kw in l for kw in NEGATIVE_KW))

def build_profile(infobox_text, body_text):
    """인포박스 + 본문 → bio/career/tmi"""
    info = parse_infobox(infobox_text)
    sections = parse_body_sections(body_text)
    
    # Bio: 인포박스 기본정보 + 개요
    bio_parts = []
    if info.get("name_full"):
        bio_parts.append(info["name_full"])
    for key in ["출생", "국적", "학력", "신체", "포지션", "투타", "프로 입단", "소속팀", "연봉"]:
        if key in info:
            bio_parts.append(f"{key}: {info[key]}")
    
    overview = sections.get("개요", "")
    if overview:
        bio_parts.append("")
        bio_parts.append(overview[:1500])
    
    # Career: 선수 경력 + 플레이 스타일
    career_parts = []
    for key in ["선수 경력", "시즌별 성적", "통산 성적", "수상 기록", "기록"]:
        if key in sections and sections[key]:
            career_parts.append(filter_negative(sections[key][:1500]))
    
    style = sections.get("플레이 스타일", "")
    if style:
        career_parts.append("⚾ 플레이 스타일:\n" + filter_negative(style[:1000]))
    
    # TMI: 여담
    tmi_parts = []
    for key in ["여담", "에피소드", "이야깃거리", "비하인드"]:
        if key in sections and sections[key]:
            tmi_parts.append(filter_negative(sections[key][:1500]))
    
    if info.get("등장곡"):
        tmi_parts.insert(0, f"🎵 등장곡: {info['등장곡']}")
    
    bio = "\n".join(bio_parts)
    career = "\n".join(career_parts) if career_parts else ""
    tmi = "\n".join(tmi_parts) if tmi_parts else ""
    
    if len(bio) < 30:
        return None
    
    return {"bio": bio, "career": career, "tmi": tmi}

def main():
    print("=" * 50)
    print(f"선수 프로필 Enrichment v3 (batch={BATCH_SIZE})")
    print("=" * 50)
    
    cp = load_json(CHECKPOINT, {"done": [], "failed": []})
    output = load_json(OUTPUT, {})
    
    all_players = get_all_players()
    remaining = [n for n in all_players if n not in cp["done"] and n not in cp["failed"]]
    
    print(f"Total: {len(all_players)} | Done: {len(cp['done'])} | Failed: {len(cp['failed'])} | Remaining: {len(remaining)}")
    
    batch = remaining[:BATCH_SIZE]
    success = fail = 0
    
    for i, name in enumerate(batch):
        print(f"[{i+1}/{len(batch)}] {name}...", end=" ", flush=True)
        
        try:
            data = crawl_page(name)
            if data:
                profile = build_profile(data.get("infobox", ""), data.get("body", ""))
                if profile:
                    output[name] = profile
                    cp["done"].append(name)
                    save_json(OUTPUT, output)
                    save_json(CHECKPOINT, cp)
                    total = len(profile["bio"]) + len(profile["career"]) + len(profile["tmi"])
                    print(f"✅ ({total} chars)")
                    success += 1
                else:
                    cp["failed"].append(name)
                    save_json(CHECKPOINT, cp)
                    print("⚠️ parse failed")
                    fail += 1
            else:
                cp["failed"].append(name)
                save_json(CHECKPOINT, cp)
                print("❌ not found")
                fail += 1
        except Exception as e:
            cp["failed"].append(name)
            save_json(CHECKPOINT, cp)
            print(f"❌ {e}")
            fail += 1
        
        time.sleep(SLEEP)
    
    print(f"\n✅ {success} / ❌ {fail} | 누적: {len(cp['done'])} done, {len(cp['failed'])} failed | 남은: {len(remaining) - len(batch)}")

if __name__ == "__main__":
    main()
