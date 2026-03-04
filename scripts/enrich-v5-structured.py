#!/usr/bin/env python3
"""선수 프로필 enrichment v5 — 구조화된 항목 (curl HTML)"""

import json, re, urllib.request, urllib.parse, os, time

PROFILES_TS = "src/lib/constants/player-profiles.ts"
CHECKPOINT = "/tmp/enrich-v5-checkpoint.json"
OUTPUT = "/tmp/enrich-v5-output.json"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))
SLEEP = 1.5

NEGATIVE_KW = ["논란", "징계", "폭행", "음주", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작", "사건 사고"]

SKIP_SECTIONS = {"관련 문서", "둘러보기", "같이 보기", "외부 링크", "각주", "틀", "둘러보기 틀",
                 "논란 및 사건 사고", "사건 사고", "논란"}

def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f: return json.load(f)
    return default

def save_json(path, data):
    with open(path, "w") as f: json.dump(data, f, ensure_ascii=False, indent=2)

def get_players(team=None):
    with open("src/lib/constants/players-roster.json") as f:
        roster = json.load(f)
    if team:
        return [p['name'] for p in roster if p.get('team') == team]
    return [p['name'] for p in roster]

def fetch_html(name):
    for suffix in ["(야구선수)", "", "(야구)"]:
        search = f"{name}{suffix}"
        url = f"https://namu.wiki/w/{urllib.parse.quote(search)}"
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            })
            html = urllib.request.urlopen(req, timeout=10).read().decode("utf-8")

            if not any(kw in html for kw in ["KBO", "프로야구", "야구선수", "트윈스", "자이언츠",
                       "라이온즈", "베어스", "위즈", "랜더스", "다이노스", "타이거즈", "이글스", "히어로즈"]):
                continue

            if suffix == "":
                h2_first = re.search(r'<h2[^>]*>(.*?)</h2>', html[:10000], re.DOTALL)
                if h2_first:
                    h2_text = re.sub(r'<[^>]+>', '', h2_first.group(1))
                    if any(kw in h2_text for kw in ["인명", "실존인물", "실존 인물", "동명이인"]):
                        continue
                if "동명이인" in html[:5000]:
                    continue

            return html
        except:
            continue
    return None

def html_to_text(fragment):
    text = re.sub(r'<br\s*/?>', '\n', fragment)
    text = re.sub(r'</?(div|p|li|ul|ol|h\d|tr|td|th|table|section|article)[^>]*>', '\n', text)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&')
    text = text.replace('&#91;', '[').replace('&#93;', ']')
    text = re.sub(r'&#\d+;', '', text)
    text = re.sub(r'\[편집\]', '', text)
    text = re.sub(r'\[\d+\]', '', text)
    # 다중 공백 정리
    text = re.sub(r'  +', ' ', text)
    lines = [l.strip() for l in text.split('\n') if l.strip() and len(l.strip()) > 1]
    return '\n'.join(lines)

def filter_neg(text):
    return '\n'.join(l for l in text.split('\n') if not any(kw in l for kw in NEGATIVE_KW))

def parse_infobox(html):
    h2_idx = html.find("<h2")
    if h2_idx < 0:
        return {}

    raw = html[:h2_idx]
    text = re.sub(r'<[^>]+>', '\n', raw)
    text = text.replace('&nbsp;', ' ').replace('&#91;', '[').replace('&#93;', ']')
    text = re.sub(r'&#\d+;', '', text)
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    info = {}

    kv_keys = {
        "출생": "birth", "국적": "nationality", "학력": "education",
        "신체": "physique", "포지션": "position", "투타": "bat_throw",
        "프로 입단": "draft", "소속팀": "team", "연봉": "salary",
        "소속사": "agency", "등장곡": "walk_up_song", "응원가": "cheer_song",
        "MBTI": "mbti", "병역": "military", "본관": "clan",
        "가족": "family", "종교": "religion", "후원사": "sponsor",
        "계약": "contract",
    }

    all_kv_labels = set(kv_keys.keys())

    for i, line in enumerate(lines):
        line_clean = line.strip()
        if line_clean in kv_keys:
            key = kv_keys[line_clean]
            vals = []
            for j in range(i + 1, min(i + 5, len(lines))):
                next_line = lines[j].strip()
                # 다음 key면 중단
                if next_line in all_kv_labels:
                    break
                # 메타/네비 스킵
                if next_line.startswith('[') or next_line == '|' or next_line.startswith('.'):
                    break
                if re.match(r'^\d+\.\s', next_line):
                    break
                if next_line and len(next_line) > 1:
                    vals.append(next_line)
            if vals:
                info[key] = ' '.join(vals)

    # 이름 (한자 | 영문)
    for line in lines:
        if '|' in line and len(line) < 80:
            if any(ord(c) > 0x4E00 and ord(c) < 0x9FFF for c in line) or re.search(r'[A-Z][a-z]', line):
                info['name_full'] = line.strip()
                break

    # 국제대회 (카테고리에서 추출)
    intl = []
    for line in lines:
        if any(kw in line for kw in ['월드 베이스볼 클래식', 'WBC', '아시안 게임', '프리미어 12', 'WBSC']):
            clean = re.sub(r'(참가 선수|메달리스트|대한민국의)', '', line).strip()
            if clean and len(clean) > 4 and clean not in intl:
                intl.append(clean)
    if intl:
        info['international'] = intl

    # 주요 수상 (카테고리에서)
    awards = []
    for line in lines:
        if any(kw in line for kw in ['골든글러브', 'MVP', '올스타', '신인왕', '도루왕', '안타왕',
                                      '타격왕', '홈런왕', '다승왕', '세이브왕', '방어율왕']):
            clean = line.strip()
            if clean and len(clean) > 3 and clean not in awards:
                awards.append(clean)
    if awards:
        info['awards_cat'] = awards

    return info

def parse_sections(html):
    sections = {}
    h2_pattern = r'<h2[^>]*>(.*?)</h2>'
    h2_matches = list(re.finditer(h2_pattern, html, re.DOTALL))

    if not h2_matches:
        return None

    for i, match in enumerate(h2_matches):
        title = re.sub(r'<[^>]+>', '', match.group(1)).strip()
        title = title.replace('&#91;', '[').replace('&#93;', ']')
        title = title.replace('[편집]', '').strip()
        title = re.sub(r'^\d+\.\s*', '', title).strip()

        if title in SKIP_SECTIONS:
            continue

        start = match.end()
        end = h2_matches[i + 1].start() if i + 1 < len(h2_matches) else start + 20000
        sections[title] = html_to_text(html[start:min(end, start + 20000)])

    return sections

def build_structured_profile(info, sections):
    # === BIO ===
    bio_parts = []

    # 📌 기본정보
    basic = []
    if info.get('name_full'):
        basic.append(f"이름: {info['name_full']}")
    if info.get('birth'):
        basic.append(f"생년월일: {info['birth']}")
    if info.get('physique'):
        basic.append(f"신체: {info['physique']}")
    if info.get('position'):
        basic.append(f"포지션: {info['position']}")
    if info.get('bat_throw'):
        basic.append(f"투타: {info['bat_throw']}")
    if basic:
        bio_parts.append("📌 기본정보\n" + "\n".join(f"  • {b}" for b in basic))

    # 📌 학력
    if info.get('education'):
        bio_parts.append(f"📌 학력\n  • {info['education']}")

    # 📌 프로입단
    pro = []
    if info.get('draft'):
        pro.append(f"입단: {info['draft']}")
    if info.get('team'):
        pro.append(f"소속팀: {info['team']}")
    if info.get('salary'):
        pro.append(f"연봉: {info['salary']}")
    if pro:
        bio_parts.append("📌 프로입단\n" + "\n".join(f"  • {p}" for p in pro))

    # 📌 기타
    etc = []
    if info.get('military'):
        etc.append(f"병역: {info['military']}")
    if info.get('mbti'):
        etc.append(f"MBTI: {info['mbti']}")
    if info.get('agency'):
        etc.append(f"소속사: {info['agency']}")
    if info.get('family'):
        etc.append(f"가족: {info['family']}")
    if info.get('religion') and info['religion'] not in ['무종교', '무교']:
        etc.append(f"종교: {info['religion']}")
    if etc:
        bio_parts.append("📌 기타\n" + "\n".join(f"  • {e}" for e in etc))

    # ⚾ 플레이 스타일
    style = sections.get('플레이 스타일', '')
    first_line = style.split('\n')[0] if style else ''
    if style and '문서를 참고' not in first_line:
        bio_parts.append("⚾ 플레이 스타일\n" + filter_neg(style[:2000]))

    bio = "\n\n".join(bio_parts)

    # === CAREER ===
    career_parts = []

    # 📌 소속팀 히스토리
    if info.get('team'):
        career_parts.append(f"📌 소속팀 히스토리\n  • {info['team']}")

    # 📌 계약 정보
    contract = []
    if info.get('contract'):
        contract.append(info['contract'])
    if info.get('salary') and 'FA' in info.get('salary', ''):
        contract.append(f"연봉: {info['salary']}")
    if contract:
        career_parts.append("📌 계약 정보\n" + "\n".join(f"  • {c}" for c in contract))

    # 📌 국제대회
    if info.get('international'):
        career_parts.append("📌 국제대회\n" + "\n".join(f"  • {i}" for i in info['international'][:5]))

    # 📌 주요 수상/타이틀
    awards = []
    if info.get('awards_cat'):
        awards.extend(info['awards_cat'][:10])
    # 선수 경력에서 수상 관련 문장 추출
    career_raw = sections.get('선수 경력', '')
    for line in career_raw.split('\n'):
        if any(kw in line for kw in ['골든글러브', 'MVP', '올스타', '신인왕', '도루왕', '안타왕',
                                      '타격왕', '홈런왕', '다승왕', '세이브왕', '방어율왕',
                                      '최우수', '감투상', '수상']):
            if len(line) > 8 and line.strip() not in awards:
                awards.append(line.strip())
    if awards:
        career_parts.append("📌 주요 수상/타이틀\n" + "\n".join(f"  • {a}" for a in awards[:10]))

    # 📌 평가 (있는 선수만)
    evaluation = sections.get('평가', '')
    if evaluation and '문서를 참고' not in evaluation.split('\n')[0]:
        career_parts.append("📌 평가\n" + filter_neg(evaluation[:1500]))

    # 📌 커리어 하이라이트
    if career_raw:
        meaningful = []
        for line in career_raw.split('\n'):
            line = line.strip()
            if re.match(r'^\d{4}년?$', line): continue
            if '통합 선수 경력' in line: continue
            if '문서를 참고' in line: continue
            if '아마추어 시절' in line: continue
            if len(line) < 15: continue
            if any(kw in line for kw in NEGATIVE_KW): continue
            # 실제 내용이 있는 줄만
            if any(kw in line for kw in ['경기', '이닝', '타율', '홈런', '안타', '승', '패',
                                          '세이브', '방어율', '출루율', '장타율', '도루',
                                          '기록', '선발', '데뷔', '시즌', '활약', '성적',
                                          '계약', '이적', '트레이드', 'FA', '복귀', '부상']):
                meaningful.append(line)
        if meaningful:
            career_parts.append("📌 커리어 하이라이트\n" + "\n".join(meaningful[:25]))

    career = "\n\n".join(career_parts)

    # === TMI ===
    tmi_parts = []

    if info.get('walk_up_song'):
        tmi_parts.append(f"🎵 등장곡: {info['walk_up_song']}")
    if info.get('cheer_song'):
        tmi_parts.append(f"🎶 응원가: {info['cheer_song']}")

    # 여담
    yedam = sections.get('여담', '')
    first_line = yedam.split('\n')[0] if yedam else ''
    if yedam and '문서를 참고' not in first_line:
        for line in filter_neg(yedam).split('\n'):
            if len(line.strip()) > 5:
                tmi_parts.append(f"• {line.strip()}")

    # 별명 섹션
    nickname = sections.get('별명', '')
    if nickname and '문서를 참고' not in nickname.split('\n')[0]:
        tmi_parts.insert(0, f"🏷️ 별명: {nickname[:200]}")

    # 선행 섹션
    good_deeds = sections.get('선행', '')
    if good_deeds and '문서를 참고' not in good_deeds.split('\n')[0]:
        tmi_parts.append(f"🤝 선행:\n{filter_neg(good_deeds[:500])}")

    # 응원가 섹션
    cheer = sections.get('응원가', '')
    if cheer and '문서를 참고' not in cheer.split('\n')[0]:
        tmi_parts.append(f"🎶 응원가 정보:\n{cheer[:300]}")

    tmi = "\n".join(tmi_parts)

    return {"bio": bio, "career": career, "tmi": tmi}

def process_player(name):
    html = fetch_html(name)
    if not html:
        return None
    info = parse_infobox(html)
    sections = parse_sections(html)
    if not sections:
        return None
    return build_structured_profile(info, sections)

def main():
    team = os.environ.get("TEAM", None)
    print("=" * 50)
    print(f"선수 프로필 Enrichment v5 (team={team}, batch={BATCH_SIZE})")
    print("=" * 50)

    cp = load_json(CHECKPOINT, {"done": [], "failed": []})
    output = load_json(OUTPUT, {})

    players = get_players(team)
    remaining = [n for n in players if n not in cp["done"] and n not in cp["failed"]]

    print(f"Total: {len(players)} | Done: {len(cp['done'])} | Failed: {len(cp['failed'])} | Remaining: {len(remaining)}")

    batch = remaining[:BATCH_SIZE]
    success = fail = 0

    for i, name in enumerate(batch):
        print(f"[{i+1}/{len(batch)}] {name}...", end=" ", flush=True)
        try:
            profile = process_player(name)
            if profile and len(profile['bio']) > 20:
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
                print("⚠️ insufficient data")
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
