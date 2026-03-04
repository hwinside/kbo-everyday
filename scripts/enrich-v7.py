#!/usr/bin/env python3
"""선수 프로필 enrichment v7 — 30+ 피드백 반영 (전체 선수)"""

import json, re, urllib.request, urllib.parse, os, time

CHECKPOINT = "/tmp/enrich-v7-checkpoint.json"
OUTPUT = "/tmp/enrich-v7-output.json"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "50"))
SLEEP = 1.2

NEGATIVE_KW = ["논란", "징계", "폭행", "음주운전", "도박", "불법", "사생활", "고소", "피소", "전과",
               "파문", "물의", "적발", "처벌", "벌금", "정직", "출장정지", "방출", "퇴출",
               "성추행", "성폭력", "사기", "횡령", "마약", "대마", "승부조작", "사건 사고"]
INAPPROPRIATE_KW = ["조부상", "부고", "장례", "별세", "사망", "숨졌", "영결식", "부친상", "모친상"]
SKIP_SECTIONS = {"관련 문서", "둘러보기", "같이 보기", "외부 링크", "각주", "틀", "둘러보기 틀",
                 "논란 및 사건 사고", "사건 사고", "논란", "미디어 활동", "역대 기록"}
META_PATTERNS = ["정리해 놓은 문서", "정리한 문서", "서술한 문서", "기술한 문서",
    "문서를 참고", "문서를 참조", "문서에서 다룬다", "추가되었다", "풀어보자면",
    "정리하자면", "다음과 같다", "서술되어 있다", "작성되었다", "후술한다",
    "플레이 스타일을 정리한", "여담을 정리"]

def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f: return json.load(f)
    return default
def save_json(path, data):
    with open(path, "w") as f: json.dump(data, f, ensure_ascii=False, indent=2)
def get_players(team=None):
    with open("src/lib/constants/players-roster.json") as f: roster = json.load(f)
    if team: return [(p['name'], p.get('team','')) for p in roster if p.get('team') == team]
    return [(p['name'], p.get('team','')) for p in roster]
def fetch_url(url):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        return urllib.request.urlopen(req, timeout=10).read().decode("utf-8")
    except: return None
def fetch_html(name):
    for suffix in ["(야구선수)", "", "(야구)"]:
        search = f"{name}{suffix}"
        url = f"https://namu.wiki/w/{urllib.parse.quote(search)}"
        html = fetch_url(url)
        if not html: continue
        if not any(kw in html for kw in ["KBO","프로야구","야구선수","트윈스","자이언츠","라이온즈","베어스","위즈","랜더스","다이노스","타이거즈","이글스","히어로즈"]): continue
        if suffix == "":
            h2f = re.search(r'<h2[^>]*>(.*?)</h2>', html[:10000], re.DOTALL)
            if h2f:
                h2t = re.sub(r'<[^>]+>', '', h2f.group(1))
                if any(kw in h2t for kw in ["인명","실존인물","실존 인물","동명이인"]): continue
            if "동명이인" in html[:5000]: continue
        return html, suffix
    return None, ""
def fetch_sub_page(name, suffix, sub):
    search = f"{name}{suffix}/{sub}"
    url = f"https://namu.wiki/w/{urllib.parse.quote(search)}"
    html = fetch_url(url)
    if html and "해당 문서를 찾을 수 없습니다" not in html: return html
    return None
def clean_text(text):
    text = text.replace('&quot;','"').replace('&apos;',"'")
    text = text.replace('&lt;','＜').replace('&gt;','＞')
    text = text.replace('&nbsp;',' ').replace('&amp;','&')
    text = text.replace('&#91;','[').replace('&#93;',']')
    text = re.sub(r'&#(\d+);', lambda m: chr(int(m.group(1))) if 31<int(m.group(1))<65536 else '', text)
    text = re.sub(r'<[^>]*$', '', text)
    text = re.sub(r'^[^<]*>', '', text)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = text.replace('＜','<').replace('＞','>')
    text = re.sub(r'\[편집\]', '', text)
    text = re.sub(r'\[\d+\]', '', text)
    text = re.sub(r'#\S+', '', text)
    text = re.sub(r'  +', ' ', text)
    return text
def html_to_text(fragment):
    text = re.sub(r'<br\s*/?>', '\n', fragment)
    text = re.sub(r'</?(div|p|li|ul|ol|h\d|tr|td|th|table|section|article)[^>]*>', '\n', text)
    text = clean_text(text)
    return '\n'.join(l.strip() for l in text.split('\n') if l.strip() and len(l.strip()) > 1)
def should_skip_line(line):
    line = line.strip()
    if len(line) < 3: return True
    if re.match(r'^.+\s+VS\s+.+$', line, re.IGNORECASE): return True
    if re.match(r'^\d{4}년\s+\d{1,2}월\s+\d{1,2}일\s*\(vs', line): return True
    if re.match(r'^\d{1,2}월\s+\d{1,2}일$', line): return True
    if len(line) < 40 and any(kw in line for kw in ['캐릭터','짤방','짤','이미지를','사진을','그리는','그린','의 모습']): return True
    if re.match(r'^\[.{2,10}\]', line): return True
    if re.search(r'https?://', line): return True
    if re.match(r'^\d+(\.\d+)*\.?\s*\S{1,15}$', line): return True
    if any(kw in line for kw in INAPPROPRIATE_KW): return True
    if any(kw in line for kw in NEGATIVE_KW): return True
    if any(p in line for p in META_PATTERNS): return True
    if re.match(r'^\d{4}년\s*《.+》\s*$', line): return True
    if len(line) < 25 and not any(e in line for e in ['다.','다!','다?','했','있','된','는','을','를','이다','한다','이며','으며']): return True
    if len(line) < 15 and line.endswith(('경력','활동','출연','기록','목록')): return True
    return False
def filter_lines(text):
    lines = []
    for line in text.split('\n'):
        line = line.strip()
        if should_skip_line(line): continue
        line = re.sub(r'^\d+(\.\d+)+\.?\s*', '', line).strip()  # 목차만 제거 (1.2.3), 연도(2019) 보호
        line = re.sub(r'(\S{2,})\s+\1\s*$', r'\1', line)
        if line and len(line) > 2: lines.append(line)
    return '\n'.join(lines)
def cut_at_sentence(text, max_chars):
    if len(text) <= max_chars: return text
    cut = text[:max_chars]
    for end in ['다.','있다.','했다.','이다.','된다.','한다.','는다.','였다.','왔다.','냈다.','줬다.','보인다.','싶다.']:
        idx = cut.rfind(end)
        if idx > max_chars * 0.4: return cut[:idx+len(end)]
    idx = cut.rfind('.')
    if idx > max_chars * 0.4: return cut[:idx+1]
    return cut
def parse_infobox(html):
    h2_idx = html.find("<h2")
    if h2_idx < 0: return {}
    raw = html[:h2_idx]
    text = re.sub(r'<[^>]+>', '\n', raw)
    text = clean_text(text)
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    info = {}
    kv_keys = {"출생":"birth","국적":"nationality","학력":"education","신체":"physique","포지션":"position",
        "투타":"bat_throw","프로 입단":"draft","소속팀":"team","연봉":"salary","소속사":"agency",
        "등장곡":"walk_up_song","응원가":"cheer_song","MBTI":"mbti","병역":"military","본관":"clan",
        "가족":"family","종교":"religion","후원사":"sponsor","계약":"contract"}
    all_labels = set(kv_keys.keys())
    for i, line in enumerate(lines):
        lc = line.strip()
        if lc in kv_keys:
            key = kv_keys[lc]; vals = []
            for j in range(i+1, min(i+5, len(lines))):
                nl = lines[j].strip()
                if nl in all_labels or nl.startswith('[') or nl=='|' or nl.startswith('.') or re.match(r'^\d+\.\s', nl): break
                nl = re.sub(r'정보 더 보기.*$', '', nl).strip()
                if nl.startswith('차량 ') and key != 'family':
                    if 'vehicle' not in info: info['vehicle'] = nl[3:].strip()
                    break
                if nl and len(nl) > 1: vals.append(nl)
            if vals: info[key] = ' '.join(vals)
    for line in lines:
        if '|' in line and len(line) < 80:
            if any(ord(c)>0x4E00 and ord(c)<0x9FFF for c in line) or re.search(r'[A-Z][a-z]', line):
                info['name_full'] = line.strip(); break
    intl = []
    for line in lines:
        if any(kw in line for kw in ['월드 베이스볼 클래식','WBC','아시안 게임','프리미어 12','WBSC']):
            clean = re.sub(r'(참가 선수|메달리스트|대한민국의)', '', line).strip()
            if clean and len(clean)>4 and clean not in intl: intl.append(clean)
    if intl: info['international'] = intl
    awards = []
    award_kw = ['골든글러브','MVP','올스타','신인왕','도루왕','안타왕','타격왕','홈런왕','다승왕','세이브왕','방어율왕','최다승','최다홀드','홀드왕']
    for line in lines:
        if any(kw in line for kw in award_kw):
            cl = line.strip()
            if cl and len(cl)>3 and cl not in awards and '소속사' not in cl: awards.append(cl)
    if awards: info['awards_cat'] = awards
    return info
def parse_sections(html):
    sections = {}
    h2_matches = list(re.finditer(r'<h2[^>]*>(.*?)</h2>', html, re.DOTALL))
    if not h2_matches: return None
    h3_pattern = r'<h3[^>]*>(.*?)</h3>'
    for i, match in enumerate(h2_matches):
        title = re.sub(r'<[^>]+>', '', match.group(1)).strip()
        title = clean_text(title).replace('[편집]','').strip()
        title = re.sub(r'^\d+\.\s*', '', title).strip()
        if title in SKIP_SECTIONS: continue
        start = match.end()
        end = h2_matches[i+1].start() if i+1<len(h2_matches) else start+20000
        section_html = html[start:min(end, start+20000)]
        h3_matches = list(re.finditer(h3_pattern, section_html, re.DOTALL))
        if h3_matches and title in ['플레이 스타일','선수 경력']:
            parts = []
            for j, h3m in enumerate(h3_matches):
                h3_title = re.sub(r'<[^>]+>', '', h3m.group(1)).strip()
                h3_title = re.sub(r'^\d+(\.\d+)*\.?\s*', '', h3_title).strip().replace('[편집]','').strip()
                h3_start = h3m.end()
                h3_end = h3_matches[j+1].start() if j+1<len(h3_matches) else len(section_html)
                h3_text = html_to_text(section_html[h3_start:h3_end])
                if h3_title and h3_text: parts.append(f"[{h3_title}]\n{h3_text}")
            sections[title] = '\n\n'.join(parts) if parts else html_to_text(section_html)
        else:
            sections[title] = html_to_text(section_html)
    return sections
def extract_pitches(style_text):
    lines = style_text.split('\n'); pitches = []; body = []
    pn = ['패스트볼','포심','투심','싱커','커터','슬라이더','커브','체인지업','스플리터','너클','포크볼','직구','변화구']
    for line in lines:
        line = line.strip()
        if len(line)<50 and any(p in line for p in pn) and not any(e in line for e in ['다.','했다','있다']):
            pitches.append(line)
        elif re.match(r'^\d{2,3}(\.\d)?km/?h', line):
            if pitches: pitches[-1] += f' ({line})'
            else: pitches.append(line)
        else: body.append(line)
    return pitches, '\n'.join(body)
def extract_evaluation_from_tmi(tmi_lines):
    eval_kw = ['최고의','레전드','대표적','통산','역대','손꼽히','인정받','명실상부','간판','에이스','프랜차이즈','핵심 선수','주축 선수','대표하는','꼽히는','평가받','평가를 받','선수로서','능력을','장점은','강점은','약점은','특징은','스타일은','유형의','타입의','잘하는','뛰어난','우수한','최상위','리그 최고','리그를 대표','KBO를 대표','한국 야구','의 상징','를 대표하는']
    not_eval = ['일화','시트콤','부친상','모친상','조부상','방송','유튜브','인스타']
    ev = []; rest = []
    for l in tmi_lines:
        if any(kw in l for kw in eval_kw) and len(l)>30 and not any(kw in l for kw in not_eval): ev.append(l)
        else: rest.append(l)
    return ev, rest
def prioritize_family_tmi(lines):
    fk = ['아들','딸','자녀','아이','아기','부인','아내','결혼','아버지','어머니','형','동생','누나']
    return [l for l in lines if any(k in l for k in fk)] + [l for l in lines if not any(k in l for k in fk)]
def dedup_intl(items):
    dated = [i for i in items if re.search(r'\d{4}', i)]
    undated = [i for i in items if not re.search(r'\d{4}', i)]
    result = list(dated)
    for u in undated:
        if not any(u in d for d in dated): result.append(u)
    return result

def build_structured_profile(info, sections, sub_sections=None):
    if sub_sections is None: sub_sections = {}
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
    if info.get('draft'):
        d = info['draft']
        if '(' in d and ')' not in d: d += ')'
        pro.append(f"입단: {d}")
    if info.get('team'): pro.append(f"소속팀: {info['team']}")
    if info.get('salary'): pro.append(f"연봉: {info['salary']}")
    if pro: bio_parts.append("📌 프로입단\n" + "\n".join(f"  • {p}" for p in pro))
    etc = []
    if info.get('military'): etc.append(f"병역: {info['military']}")
    if info.get('mbti'): etc.append(f"MBTI: {info['mbti']}")
    if info.get('agency'): etc.append(f"소속사: {info['agency']}")
    if info.get('family'): etc.append(f"가족: {info['family']}")
    if info.get('religion') and info['religion'] not in ['무종교','무교']: etc.append(f"종교: {info['religion']}")
    if info.get('vehicle'): etc.append(f"차량: {info['vehicle']}")
    if etc: bio_parts.append("📌 기타\n" + "\n".join(f"  • {e}" for e in etc))
    style = ''
    for sn in ['플레이 스타일','타격','수비','특징','투구 스타일','구종','타격 스타일']:
        if sn in sections:
            s = sections[sn]
            if s and '문서를 참고' not in s.split('\n')[0]: style = s if not style else style+'\n\n'+s
    if not style or ('문서를 참고' in style.split('\n')[0] if style else True):
        style = sub_sections.get('플레이 스타일', '') or style
    style = filter_lines(style)
    if style:
        pitches, style_body = extract_pitches(style)
        if pitches: bio_parts.append("🎯 주력 구종\n" + "\n".join(f"  • {p}" for p in pitches[:6]))
        style_body = cut_at_sentence(style_body, 800)
        if style_body and len(style_body)>20: bio_parts.append("⚾ 플레이 스타일\n" + style_body)
    bio = "\n\n".join(bio_parts)
    career_parts = []
    if info.get('team'): career_parts.append(f"📌 소속팀 히스토리\n  • {info['team']}")
    contract = []
    if info.get('contract'): contract.append(info['contract'])
    if info.get('salary') and 'FA' in info.get('salary',''): contract.append(f"연봉: {info['salary']}")
    if contract: career_parts.append("📌 계약 정보\n" + "\n".join(f"  • {c}" for c in contract))
    if info.get('international'):
        dd = dedup_intl(info['international'])
        career_parts.append("📌 국제대회\n" + "\n".join(f"  • {i}" for i in dd[:5]))
    awards = list(info.get('awards_cat', []))
    for sn in ['선수 경력','주요 기록','수상 기록','수상 경력','수상']:
        st = sections.get(sn, '')
        for line in st.split('\n'):
            if any(kw in line for kw in ['골든글러브','MVP','올스타','신인왕','도루왕','안타왕','타격왕','홈런왕','다승왕','세이브왕','방어율왕','최우수','감투상','홀드왕','최다승','최다홀드']):
                cl = line.strip()
                if len(cl)>8 and cl not in awards and not should_skip_line(cl) and '소속사' not in cl: awards.append(cl)
    if awards: career_parts.append("📌 수상 경력\n" + "\n".join(f"  • {a}" for a in awards[:10]))
    evaluation = sections.get('평가', '')
    if evaluation and '문서를 참고' not in evaluation.split('\n')[0]:
        ec = cut_at_sentence(filter_lines(evaluation), 500)
        if ec: career_parts.append("📌 평가\n" + ec)
    career_raw = ''
    for sn in ['선수 경력','프로 경력','KBO 경력','시즌별 활약','경력']:
        if sn in sections: career_raw = sections[sn]; break
    if not career_raw or ('문서를 참고' in career_raw.split('\n')[0] if career_raw else True):
        career_raw = sub_sections.get('선수 경력', '') or career_raw
    if career_raw:
        meaningful = []
        for line in filter_lines(career_raw).split('\n'):
            line = line.strip()
            if re.match(r'^\d{4}년?$', line): continue
            if '통합 선수 경력' in line: continue
            if len(line) < 15: continue
            if not meaningful and re.match(r'^(그|이|또한|그리고|하지만|그런데|이는)\s', line): continue
            if any(kw in line for kw in ['경기','이닝','타율','홈런','안타','승','패','세이브','방어율','출루율','장타율','도루','기록','선발','데뷔','시즌','활약','성적','계약','이적','트레이드','FA','복귀','부상','등판','타점','볼넷','삼진','ERA','WAR']):
                meaningful.append(line)
        if meaningful:
            career_parts.append("📌 커리어 하이라이트\n" + cut_at_sentence('\n'.join(meaningful[:25]), 1500))
    yedam = sections.get('여담', '')
    if not yedam or ('문서를 참고' in yedam.split('\n')[0] if yedam else True):
        yedam = sub_sections.get('여담', '') or ''
    yedam_lines = [l.strip() for l in filter_lines(yedam).split('\n') if l.strip() and len(l.strip())>5]
    eval_from_tmi, yedam_lines = extract_evaluation_from_tmi(yedam_lines)
    # 핵심요약: 개요 → 여담 → 플레이스타일 순으로 평가성 문장 추출
    summary_lines = []
    # 1순위: 개요 섹션 (가장 정제된 선수 소개)
    overview = sections.get('개요', '') or sections.get('소개', '')
    if overview and '문서를 참고' not in overview.split('\n')[0]:
        for ol in filter_lines(overview).split('\n')[:8]:
            ol = ol.strip()
            if len(ol) > 30 and any(kw in ol for kw in ['선수','활약','기록','대표','핵심','에이스','간판','주축','자리잡','팬들','사랑','등장','바탕으로','투수','타자','야수','포수','소속','이적','기여','우승','유명']):
                summary_lines.append(ol)
                if len(summary_lines) >= 3: break
    # 2순위: 여담에서 평가성 문장
    if not summary_lines:
        summary_lines = list(eval_from_tmi)
    elif eval_from_tmi:
        # 개요 + 여담 평가 합치기 (최대 4줄)
        for ev in eval_from_tmi:
            if ev not in summary_lines and len(summary_lines) < 4:
                summary_lines.append(ev)
    # 3순위: 플레이 스타일에서 평가성 문장
    if not summary_lines and style:
        for sl in filter_lines(style).split('\n'):
            sl = sl.strip()
            if len(sl) > 40 and any(kw in sl for kw in ['선수','타자','투수','야수','능력','장점','강점','스타일','특징','평가','뛰어난','최고','대표','간판','에이스','핵심']):
                summary_lines.append(sl)
                if len(summary_lines) >= 3: break
    if summary_lines: career_parts.append("📌 핵심 요약\n" + cut_at_sentence('\n'.join(summary_lines), 500))
    career = "\n\n".join(career_parts)
    tmi_parts = []
    if info.get('walk_up_song'): tmi_parts.append(f"🎵 등장곡: {info['walk_up_song']}")
    if info.get('cheer_song'): tmi_parts.append(f"🎶 응원가: {info['cheer_song']}")
    nickname = sections.get('별명', '')
    if nickname and '문서를 참고' not in nickname.split('\n')[0]:
        nc = filter_lines(nickname)[:300]
        if nc: tmi_parts.insert(0, f"🏷️ 별명: {nc}")
    good_deeds = sections.get('선행', '')
    if good_deeds and '문서를 참고' not in good_deeds.split('\n')[0]:
        gc = cut_at_sentence(filter_lines(good_deeds), 300)
        if gc: tmi_parts.append(f"🤝 선행:\n{gc}")
    cheer = sections.get('응원가', '')
    if cheer and '문서를 참고' not in cheer.split('\n')[0]:
        cc = filter_lines(cheer)[:300]
        if cc: tmi_parts.append(f"🎶 응원가 정보:\n{cc}")
    yedam_lines = prioritize_family_tmi(yedam_lines)
    for line in yedam_lines:
        if not should_skip_line(line): tmi_parts.append(f"• {line}")
    tmi = cut_at_sentence('\n'.join(tmi_parts), 4000)
    return {"bio": bio, "career": career, "tmi": tmi}

def process_player(name, team=''):
    html, suffix = fetch_html(name)
    if not html: return None
    info = parse_infobox(html)
    sections = parse_sections(html)
    if not sections: return None
    sub_sections = {}
    for sub_name in ['여담','플레이 스타일','선수 경력']:
        sc = sections.get(sub_name, '')
        needs = not sc or ('문서를 참고' in sc.split('\n')[0] if sc else False)
        if needs:
            sh = fetch_sub_page(name, suffix, sub_name)
            if sh:
                ss = parse_sections(sh)
                if ss:
                    sub_sections[sub_name] = '\n'.join(v for k,v in ss.items() if k not in SKIP_SECTIONS)
                    time.sleep(0.5)
    return build_structured_profile(info, sections, sub_sections)

def main():
    team = os.environ.get("TEAM", None)
    print("="*50)
    print(f"선수 프로필 Enrichment v7 (team={team or 'ALL'}, batch={BATCH_SIZE})")
    print("="*50)
    cp = load_json(CHECKPOINT, {"done":[],"failed":[]})
    output = load_json(OUTPUT, {})
    players = get_players(team)
    remaining = [(n,t) for n,t in players if n not in cp["done"] and n not in cp["failed"]]
    print(f"Total: {len(players)} | Done: {len(cp['done'])} | Failed: {len(cp['failed'])} | Remaining: {len(remaining)}")
    batch = remaining[:BATCH_SIZE]
    success = fail = 0
    for i, (name, t) in enumerate(batch):
        print(f"[{i+1}/{len(batch)}] {name} ({t})...", end=" ", flush=True)
        try:
            profile = process_player(name, t)
            if profile and len(profile['bio']) > 20:
                output[name] = profile; cp["done"].append(name)
                save_json(OUTPUT, output); save_json(CHECKPOINT, cp)
                total = len(profile["bio"])+len(profile["career"])+len(profile["tmi"])
                print(f"✅ ({total} chars)"); success += 1
            else:
                cp["failed"].append(name); save_json(CHECKPOINT, cp)
                print("⚠️ insufficient data"); fail += 1
        except Exception as e:
            cp["failed"].append(name); save_json(CHECKPOINT, cp)
            print(f"❌ {e}"); fail += 1
        time.sleep(SLEEP)
    print(f"\n✅ {success} / ❌ {fail} | 누적: {len(cp['done'])} done, {len(cp['failed'])} failed | 남은: {len(remaining)-len(batch)}")

if __name__ == "__main__":
    main()
