#!/usr/bin/env python3
"""선수 프로필 enrichment v6 — 18개 피드백 반영"""

import json, re, urllib.request, urllib.parse, os, time

PROFILES_TS = "src/lib/constants/player-profiles.ts"
CHECKPOINT = "/tmp/enrich-v6-checkpoint.json"
OUTPUT = "/tmp/enrich-v6-output.json"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))
SLEEP = 1.5

NEGATIVE_KW = ["논란", "징계", "폭행", "음주운전", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작", "사건 사고"]

# 피드백 #16: 부적절 TMI
INAPPROPRIATE_KW = ["조부상", "부고", "장례", "별세", "사망", "숨졌", "영결식"]

SKIP_SECTIONS = {"관련 문서", "둘러보기", "같이 보기", "외부 링크", "각주", "틀", "둘러보기 틀",
                 "논란 및 사건 사고", "사건 사고", "논란", "미디어 활동"}

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
            return html, suffix
        except:
            continue
    return None, ""

def fetch_sub_page(name, suffix, sub):
    """하위문서 크롤링 (피드백 #5: 선수명/여담, 선수명/플레이 스타일)"""
    search = f"{name}{suffix}/{sub}"
    url = f"https://namu.wiki/w/{urllib.parse.quote(search)}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        })
        html = urllib.request.urlopen(req, timeout=10).read().decode("utf-8")
        if "해당 문서를 찾을 수 없습니다" in html:
            return None
        return html
    except:
        return None

def clean_text(text):
    """피드백 #2,10,16,14,18: 텍스트 정제 강화"""
    # HTML 엔티티 (#2)
    text = text.replace('&quot;', '"').replace('&apos;', "'").replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&nbsp;', ' ').replace('&amp;', '&')
    text = text.replace('&#91;', '[').replace('&#93;', ']')
    text = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))) if int(m.group(1)) < 65536 else '', text)
    # 잘린 HTML 태그 (#10)
    text = re.sub(r'<[^>]*$', '', text)  # 닫히지 않은 태그
    text = re.sub(r'^[^<]*>', '', text)  # 열리지 않은 닫는 태그
    text = re.sub(r'<[^>]+>', ' ', text)  # 남은 태그
    # [편집], [숫자] 각주
    text = re.sub(r'\[편집\]', '', text)
    text = re.sub(r'\[\d+\]', '', text)
    # #해시태그 (#16)
    text = re.sub(r'#\S+', '', text)
    # 다중 공백
    text = re.sub(r'  +', ' ', text)
    return text

def html_to_text(fragment):
    text = re.sub(r'<br\s*/?>', '\n', fragment)
    text = re.sub(r'</?(div|p|li|ul|ol|h\d|tr|td|th|table|section|article)[^>]*>', '\n', text)
    text = clean_text(text)
    lines = [l.strip() for l in text.split('\n') if l.strip() and len(l.strip()) > 1]
    return '\n'.join(lines)

def should_skip_line(line):
    """피드백 #6,11,12,14,17,18: 불필요한 줄 필터링"""
    line = line.strip()
    if len(line) < 3: return True
    # #6: VS 패턴
    if re.match(r'^.+\s+VS\s+.+$', line, re.IGNORECASE): return True
    # #11: 날짜+기록만 (vs XX)
    if re.match(r'^\d{4}년\s+\d{1,2}월\s+\d{1,2}일\s*\(vs', line): return True
    # #12: 이미지 캡션
    if len(line) < 40 and any(kw in line for kw in ['캐릭터', '짤방', '짤', '이미지를', '사진을', '그리는', '그린']): return True
    # #14: [매체명] 기사 제목
    if re.match(r'^\[.{2,10}\]', line): return True
    # URL 포함
    if re.search(r'https?://', line): return True
    # #17: 넘버링만 있는 줄
    if re.match(r'^\d+\.\d+\.?\s*\S{1,10}$', line): return True
    # 부적절 TMI (#16)
    if any(kw in line for kw in INAPPROPRIATE_KW): return True
    # 부정적 (#기존)
    if any(kw in line for kw in NEGATIVE_KW): return True
    return False

def filter_lines(text):
    """줄 단위 필터링 + 넘버링 제거"""
    lines = []
    for line in text.split('\n'):
        line = line.strip()
        if should_skip_line(line):
            continue
        # #8: N.N. 위키 넘버링 제거 (소제목 텍스트는 유지)
        line = re.sub(r'^\d+\.\d+\.?\s*', '', line).strip()
        if line and len(line) > 2:
            lines.append(line)
    return '\n'.join(lines)

def cut_at_sentence(text, max_chars):
    """피드백 #15: 문장 단위로 잘라내기"""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    # 마지막 문장 끝 찾기
    for end in ['다.', '있다.', '했다.', '이다.', '된다.', '한다.', '는다.', '였다.', '. ']:
        idx = cut.rfind(end)
        if idx > max_chars * 0.5:
            return cut[:idx + len(end)]
    # 마지막 . 찾기
    idx = cut.rfind('.')
    if idx > max_chars * 0.5:
        return cut[:idx + 1]
    return cut

def filter_neg(text):
    return '\n'.join(l for l in text.split('\n') if not any(kw in l for kw in NEGATIVE_KW))

def parse_infobox(html):
    h2_idx = html.find("<h2")
    if h2_idx < 0: return {}
    raw = html[:h2_idx]
    text = re.sub(r'<[^>]+>', '\n', raw)
    text = clean_text(text)
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
        lc = line.strip()
        if lc in kv_keys:
            key = kv_keys[lc]
            vals = []
            for j in range(i + 1, min(i + 5, len(lines))):
                nl = lines[j].strip()
                if nl in all_kv_labels or nl.startswith('[') or nl == '|' or nl.startswith('.') or re.match(r'^\d+\.\s', nl):
                    break
                if nl and len(nl) > 1:
                    vals.append(nl)
            if vals:
                info[key] = ' '.join(vals)
    # 이름
    for line in lines:
        if '|' in line and len(line) < 80:
            if any(ord(c) > 0x4E00 and ord(c) < 0x9FFF for c in line) or re.search(r'[A-Z][a-z]', line):
                info['name_full'] = line.strip()
                break
    # 국제대회
    intl = []
    for line in lines:
        if any(kw in line for kw in ['월드 베이스볼 클래식', 'WBC', '아시안 게임', '프리미어 12', 'WBSC']):
            clean = re.sub(r'(참가 선수|메달리스트|대한민국의)', '', line).strip()
            if clean and len(clean) > 4 and clean not in intl:
                intl.append(clean)
    if intl: info['international'] = intl
    return info

def parse_sections(html):
    sections = {}
    h2_pattern = r'<h2[^>]*>(.*?)</h2>'
    h2_matches = list(re.finditer(h2_pattern, html, re.DOTALL))
    if not h2_matches: return None
    for i, match in enumerate(h2_matches):
        title = re.sub(r'<[^>]+>', '', match.group(1)).strip()
        title = clean_text(title).replace('[편집]', '').strip()
        title = re.sub(r'^\d+\.\s*', '', title).strip()
        if title in SKIP_SECTIONS: continue
        start = match.end()
        end = h2_matches[i + 1].start() if i + 1 < len(h2_matches) else start + 20000
        sections[title] = html_to_text(html[start:min(end, start + 20000)])
    return sections

def extract_pitches(style_text):
    """피드백 #7: 투수 구종 목록 분리"""
    lines = style_text.split('\n')
    pitches = []
    body_lines = []
    for line in lines:
        line = line.strip()
        # 구종 패턴: 짧은 줄 + km/h 또는 구종 이름
        pitch_names = ['패스트볼', '포심', '투심', '싱커', '커터', '슬라이더', '커브', '체인지업',
                       '스플리터', '너클', '포크볼', '직구', '변화구', '구종']
        if len(line) < 50 and any(p in line for p in pitch_names):
            pitches.append(line)
        elif re.match(r'^\d{2,3}(\.\d)?km/h', line):
            if pitches:
                pitches[-1] += f' ({line})'
            else:
                pitches.append(line)
        else:
            body_lines.append(line)
    return pitches, '\n'.join(body_lines)

def extract_evaluation_from_tmi(tmi_lines):
    """피드백 #4: TMI에서 선수 평가성 내용을 커리어 핵심요약으로 분리"""
    eval_kw = ['평가', '수준', '가능성', '레전드', '대표적', '통산', '역대', '최고의', '손꼽히',
               '인정받', '명실상부', '간판', '에이스', '프랜차이즈', '핵심', '주축']
    eval_lines = []
    tmi_remaining = []
    for line in tmi_lines:
        if any(kw in line for kw in eval_kw) and len(line) > 30:
            eval_lines.append(line)
        else:
            tmi_remaining.append(line)
    return eval_lines, tmi_remaining

def prioritize_family_tmi(tmi_lines):
    """피드백 #13: 가족 관련 TMI 가중치"""
    family_kw = ['아들', '딸', '자녀', '아이', '아기', '부인', '아내', '결혼', '아버지', '어머니', '형', '동생', '누나']
    family = []
    others = []
    for line in tmi_lines:
        if any(kw in line for kw in family_kw):
            family.append(line)
        else:
            others.append(line)
    return family + others  # 가족 먼저

def build_structured_profile(info, sections, sub_sections=None):
    if sub_sections is None: sub_sections = {}

    # === BIO ===
    bio_parts = []
    basic = []
    if info.get('name_full'): basic.append(f"이름: {info['name_full']}")
    if info.get('birth'): basic.append(f"생년월일: {info['birth']}")
    if info.get('physique'): basic.append(f"신체: {info['physique']}")
    if info.get('position'): basic.append(f"포지션: {info['position']}")
    if info.get('bat_throw'): basic.append(f"투타: {info['bat_throw']}")
    if basic: bio_parts.append("📌 기본정보\n" + "\n".join(f"  • {b}" for b in basic))
    if info.get('education'): bio_parts.append(f"📌 학력\n  • {info['education']}")
    pro = []
    if info.get('draft'): pro.append(f"입단: {info['draft']}")
    if info.get('team'): pro.append(f"소속팀: {info['team']}")
    if info.get('salary'): pro.append(f"연봉: {info['salary']}")
    if pro: bio_parts.append("📌 프로입단\n" + "\n".join(f"  • {p}" for p in pro))
    etc = []
    if info.get('military'): etc.append(f"병역: {info['military']}")
    if info.get('mbti'): etc.append(f"MBTI: {info['mbti']}")
    if info.get('agency'): etc.append(f"소속사: {info['agency']}")
    if info.get('family'): etc.append(f"가족: {info['family']}")
    if info.get('religion') and info['religion'] not in ['무종교', '무교']: etc.append(f"종교: {info['religion']}")
    if etc: bio_parts.append("📌 기타\n" + "\n".join(f"  • {e}" for e in etc))

    # 플레이 스타일 (피드백 #1,3,7)
    style = sections.get('플레이 스타일', '') or sections.get('타격', '') or sections.get('수비', '') or sections.get('특징', '')
    # 하위문서 (#5)
    if not style or ('문서를 참고' in style.split('\n')[0] if style else True):
        style = sub_sections.get('플레이 스타일', '') or ''
    
    style = filter_lines(filter_neg(style))
    if style and '문서를 참고' not in style.split('\n')[0]:
        pitches, style_body = extract_pitches(style)
        if pitches:
            bio_parts.append("🎯 주력 구종\n" + "\n".join(f"  • {p}" for p in pitches[:6]))
        # 피드백 #1: 500~800자 제한, 문장 단위
        style_body = cut_at_sentence(style_body, 800)
        if style_body:
            bio_parts.append("⚾ 플레이 스타일\n" + style_body)

    bio = "\n\n".join(bio_parts)

    # === CAREER ===
    career_parts = []
    if info.get('team'): career_parts.append(f"📌 소속팀 히스토리\n  • {info['team']}")
    contract = []
    if info.get('contract'): contract.append(info['contract'])
    if info.get('salary') and 'FA' in info.get('salary', ''): contract.append(f"연봉: {info['salary']}")
    if contract: career_parts.append("📌 계약 정보\n" + "\n".join(f"  • {c}" for c in contract))
    if info.get('international'):
        career_parts.append("📌 국제대회\n" + "\n".join(f"  • {i}" for i in info['international'][:5]))

    # 수상
    awards = []
    career_raw = sections.get('선수 경력', '')
    for line in career_raw.split('\n'):
        if any(kw in line for kw in ['골든글러브', 'MVP', '올스타', '신인왕', '도루왕', '안타왕',
                                      '타격왕', '홈런왕', '다승왕', '세이브왕', '방어율왕', '최우수', '감투상']):
            if len(line) > 8 and line.strip() not in awards and not should_skip_line(line):
                awards.append(line.strip())
    if awards: career_parts.append("📌 주요 수상/타이틀\n" + "\n".join(f"  • {a}" for a in awards[:10]))

    # 평가 섹션
    evaluation = sections.get('평가', '')
    if evaluation and '문서를 참고' not in evaluation.split('\n')[0]:
        eval_clean = cut_at_sentence(filter_lines(filter_neg(evaluation)), 500)
        if eval_clean: career_parts.append("📌 평가\n" + eval_clean)

    # 커리어 하이라이트
    if career_raw:
        meaningful = []
        for line in filter_lines(filter_neg(career_raw)).split('\n'):
            line = line.strip()
            if re.match(r'^\d{4}년?$', line): continue
            if '통합 선수 경력' in line: continue
            if '문서를 참고' in line: continue
            if '아마추어 시절' in line: continue
            if len(line) < 15: continue
            if any(kw in line for kw in ['경기', '이닝', '타율', '홈런', '안타', '승', '패',
                                          '세이브', '방어율', '출루율', '장타율', '도루',
                                          '기록', '선발', '데뷔', '시즌', '활약', '성적',
                                          '계약', '이적', '트레이드', 'FA', '복귀', '부상']):
                meaningful.append(line)
        if meaningful:
            highlight_text = '\n'.join(meaningful[:25])
            highlight_text = cut_at_sentence(highlight_text, 1500)
            career_parts.append("📌 커리어 하이라이트\n" + highlight_text)

    # 피드백 #4: TMI에서 핵심 요약 추출 (여기서 미리 계산)
    yedam = sections.get('여담', '')
    if not yedam or ('문서를 참고' in yedam.split('\n')[0] if yedam else True):
        yedam = sub_sections.get('여담', '') or ''
    
    yedam_lines = [l.strip() for l in filter_lines(filter_neg(yedam)).split('\n') if l.strip() and len(l.strip()) > 5]
    eval_from_tmi, yedam_lines = extract_evaluation_from_tmi(yedam_lines)
    if eval_from_tmi:
        eval_text = cut_at_sentence('\n'.join(eval_from_tmi), 500)
        career_parts.append("📌 핵심 요약\n" + eval_text)

    career = "\n\n".join(career_parts)

    # === TMI ===
    tmi_parts = []
    if info.get('walk_up_song'): tmi_parts.append(f"🎵 등장곡: {info['walk_up_song']}")
    if info.get('cheer_song'): tmi_parts.append(f"🎶 응원가: {info['cheer_song']}")

    # 별명
    nickname = sections.get('별명', '')
    if nickname and '문서를 참고' not in nickname.split('\n')[0]:
        tmi_parts.insert(0, f"🏷️ 별명: {filter_lines(nickname)[:200]}")

    # 선행
    good_deeds = sections.get('선행', '')
    if good_deeds and '문서를 참고' not in good_deeds.split('\n')[0]:
        tmi_parts.append(f"🤝 선행:\n{cut_at_sentence(filter_lines(filter_neg(good_deeds)), 300)}")

    # 여담 (평가성 제거 후)
    yedam_lines = prioritize_family_tmi(yedam_lines)  # #13: 가족 우선
    for line in yedam_lines:
        if not should_skip_line(line):
            tmi_parts.append(f"• {line}")

    tmi = cut_at_sentence('\n'.join(tmi_parts), 3000)

    # 출처 (#9)
    bio += "\n\n📎 출처: 나무위키"

    return {"bio": bio, "career": career, "tmi": tmi}

def process_player(name):
    html, suffix = fetch_html(name)
    if not html: return None
    info = parse_infobox(html)
    sections = parse_sections(html)
    if not sections: return None

    # 피드백 #5: 하위문서 크롤링 (여담, 플레이 스타일)
    sub_sections = {}
    for sub_name in ['여담', '플레이 스타일']:
        section_content = sections.get(sub_name, '')
        if section_content and '문서를 참고' in section_content.split('\n')[0]:
            sub_html = fetch_sub_page(name, suffix, sub_name)
            if sub_html:
                sub_secs = parse_sections(sub_html)
                if sub_secs:
                    # 하위문서의 모든 섹션 내용을 합침
                    all_text = '\n'.join(v for k, v in sub_secs.items() if k not in SKIP_SECTIONS)
                    sub_sections[sub_name] = all_text
                    time.sleep(0.5)

    return build_structured_profile(info, sections, sub_sections)

def main():
    team = os.environ.get("TEAM", None)
    print("=" * 50)
    print(f"선수 프로필 Enrichment v6 (team={team}, batch={BATCH_SIZE})")
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
