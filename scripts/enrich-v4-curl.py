#!/usr/bin/env python3
"""
선수 프로필 enrichment v4 — curl HTML 파싱
Chrome 불필요! SSR HTML에서 H2 섹션 기반 추출
"""

import json, re, time, urllib.request, urllib.parse, os

PROFILES_TS = "src/lib/constants/player-profiles.ts"
CHECKPOINT = "/tmp/enrich-v4-checkpoint.json"
OUTPUT = "/tmp/enrich-v4-output.json"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))
SLEEP = 1  # curl은 빠르니까 1초면 충분

NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작"]

SKIP_SECTIONS = {"관련 문서", "둘러보기", "같이 보기", "외부 링크", "각주", "틀", "둘러보기 틀"}

def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f: return json.load(f)
    return default

def save_json(path, data):
    with open(path, "w") as f: json.dump(data, f, ensure_ascii=False, indent=2)

def get_all_players():
    with open(PROFILES_TS) as f: content = f.read()
    return re.findall(r'"([가-힣a-zA-Z\s]+)":\s*\{\s*\n?\s*bio:', content)

def fetch_html(name):
    """나무위키 HTML 가져오기"""
    suffixes = ["(야구선수)", "", "(야구)"]
    
    for suffix in suffixes:
        search = f"{name}{suffix}"
        url = f"https://namu.wiki/w/{urllib.parse.quote(search)}"
        
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            })
            resp = urllib.request.urlopen(req, timeout=10)
            html = resp.read().decode("utf-8")
            
            # 야구 관련 확인
            if any(kw in html for kw in ["KBO", "프로야구", "야구선수", "트윈스", "자이언츠", "라이온즈"]):
                # 동명이인 체크
                if suffix == "" and ("동명이인" in html[:5000] or re.search(r"<h2[^>]*>.*?(인명|실존인물|실존 인물).*?</h2>", html[:10000], re.DOTALL)):
                    continue
                return html
        except:
            continue
    
    return None

def html_to_text(html_fragment):
    """HTML → 텍스트"""
    text = re.sub(r'<br\s*/?>', '\n', html_fragment)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&')
    text = text.replace('&#91;', '[').replace('&#93;', ']')
    text = re.sub(r'&#\d+;', '', text)
    text = re.sub(r'\[편집\]', '', text)
    text = re.sub(r'\[\d+\]', '', text)  # 각주
    text = re.sub(r'\n{3,}', '\n\n', text)
    
    lines = []
    for line in text.split('\n'):
        line = line.strip()
        if line and len(line) > 1:
            lines.append(line)
    return '\n'.join(lines)

def parse_html(html):
    """HTML에서 섹션별 추출"""
    sections = {}
    
    # H2 기반 split
    h2_pattern = r'<h2[^>]*>(.*?)</h2>'
    h2_matches = list(re.finditer(h2_pattern, html, re.DOTALL))
    
    if not h2_matches:
        return None
    
    for i, match in enumerate(h2_matches):
        title = re.sub(r'<[^>]+>', '', match.group(1)).strip()
        title = title.replace('[편집]', '').replace('&#91;편집&#93;', '').strip()
        title = re.sub(r'^\d+\.\s*', '', title).strip()
        
        if title in SKIP_SECTIONS:
            continue
        
        start = match.end()
        end = h2_matches[i + 1].start() if i + 1 < len(h2_matches) else start + 20000
        
        section_html = html[start:min(end, start + 20000)]
        sections[title] = html_to_text(section_html)
    
    # 인포박스: 첫 h2 이전, 마지막 부분
    infobox_html = html[max(0, h2_matches[0].start() - 10000):h2_matches[0].start()]
    infobox_text = html_to_text(infobox_html)
    # 인포박스는 뒤쪽에 있으니 마지막 50줄
    infobox_lines = infobox_text.split('\n')[-60:]
    sections['__infobox__'] = '\n'.join(infobox_lines)
    
    return sections

def parse_infobox(text):
    """인포박스에서 key-value 추출"""
    info = {}
    lines = text.split('\n')
    
    kv_keys = ["출생", "국적", "학력", "신체", "포지션", "투타", "프로 입단", "소속팀",
               "연봉", "소속사", "등장곡", "MBTI"]
    
    for i, line in enumerate(lines):
        line = line.strip()
        for key in kv_keys:
            if line == key and i + 1 < len(lines):
                # 다음 줄들을 값으로 (다음 key까지)
                vals = []
                for j in range(i + 1, min(i + 4, len(lines))):
                    next_line = lines[j].strip()
                    if next_line in kv_keys:
                        break
                    if next_line:
                        vals.append(next_line)
                if vals:
                    info[key] = ' '.join(vals)
    
    # 이름 (한자|영문)
    for line in lines:
        if '|' in line and len(line) < 100:
            info['name_full'] = line.strip()
            break
    
    return info

def filter_negative(text):
    lines = text.split('\n')
    return '\n'.join(l for l in lines if not any(kw in l for kw in NEGATIVE_KW))

def build_profile(sections):
    """섹션 → bio/career/tmi"""
    infobox = sections.get('__infobox__', '')
    info = parse_infobox(infobox)
    
    # Bio: 인포박스 + 개요
    bio_parts = []
    if info.get('name_full'):
        bio_parts.append(info['name_full'])
    for key in ['출생', '국적', '학력', '신체', '포지션', '투타', '프로 입단', '소속팀', '연봉']:
        if key in info:
            bio_parts.append(f"{key}: {info[key]}")
    
    overview = sections.get('개요', '')
    if overview:
        bio_parts.append('')
        bio_parts.append(filter_negative(overview[:2000]))
    
    # 플레이 스타일도 bio에
    style = sections.get('플레이 스타일', '')
    if style:
        bio_parts.append('')
        bio_parts.append('⚾ 플레이 스타일:')
        bio_parts.append(filter_negative(style[:1500]))
    
    # Career: 선수 경력 + 수상
    career_parts = []
    for key in ['선수 경력', '시즌별 성적', '통산 성적', '수상 기록', '기록', '주요 기록']:
        if key in sections and sections[key]:
            career_parts.append(filter_negative(sections[key][:2000]))
    
    # TMI: 여담 + 등장곡
    tmi_parts = []
    if info.get('등장곡'):
        tmi_parts.append(f"🎵 등장곡: {info['등장곡']}")
    if info.get('MBTI'):
        tmi_parts.append(f"MBTI: {info['MBTI']}")
    
    for key in ['여담', '에피소드', '이야깃거리', '비하인드']:
        if key in sections and sections[key]:
            tmi_parts.append(filter_negative(sections[key][:2000]))
    
    bio = '\n'.join(bio_parts)
    career = '\n'.join(career_parts) if career_parts else ''
    tmi = '\n'.join(tmi_parts) if tmi_parts else ''
    
    if len(bio) < 20:
        return None
    
    return {'bio': bio, 'career': career, 'tmi': tmi}

def main():
    print("=" * 50)
    print(f"선수 프로필 Enrichment v4 — curl (batch={BATCH_SIZE})")
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
            html = fetch_html(name)
            if html:
                sections = parse_html(html)
                if sections:
                    profile = build_profile(sections)
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
                        print("⚠️ build failed")
                        fail += 1
                else:
                    cp["failed"].append(name)
                    save_json(CHECKPOINT, cp)
                    print("⚠️ no sections")
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
