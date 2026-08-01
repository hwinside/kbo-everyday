#!/usr/bin/env python3
"""KBO 공식 e북 PDF → JSONL 코퍼스 (야잘알봇 RAG용)
- pypdf로 페이지별 텍스트 추출
- 페이지 단위 저장 (page 메타 보존 → 인용 시 근거 페이지 표시 가능)
- 텍스트 레이어 없는(스캔) PDF는 사유와 함께 스킵 보고
"""
import json, os, sys, re, datetime
from pypdf import PdfReader

SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kbo-pdf')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kbo-official.jsonl')
MIN_PAGE_CHARS = 40   # 이 미만이면 빈 페이지로 간주

TITLES = {
 '2026_리그규정.pdf': ('2026 KBO 리그 규정','rule'),
 '2026_야구규약.pdf': ('2026 KBO 야구규약','rule'),
 '2026_야구규칙.pdf': ('2026 공식야구규칙','rule'),
 '2026_연감.pdf': ('2026 KBO 연감','record'),
 '2026_레코드북.pdf': ('2026 KBO 레코드북','record'),
 '2026_가이드북.pdf': ('2026 KBO 가이드북','guide'),
 '2021_클린베이스볼_가이드북.pdf': ('2021 클린베이스볼 가이드북','guide'),
 '2015_deagam.pdf': ('2015 KBO 기록대백과 제5판','record'),
 '2014_whitebook.pdf': ('2014 전국 야구장 백서','misc'),
 '2014_report.pdf': ('2014 야구발전 보고서','misc'),
 '2024_야구장 규모·용도별 건립 가이드북.pdf': ('야구장 규모·용도별 건립 가이드북','misc'),
 '2014chronicles.pdf': ('한국 야구사 연표','history'),
}

def clean(t):
    t = t.replace('\x00','')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()

def main():
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    stats = []
    with open(OUT,'w',encoding='utf-8') as fo:
        for fn in sorted(os.listdir(SRC)):
            if not fn.lower().endswith('.pdf'): continue
            title, kind = TITLES.get(fn, (fn[:-4], 'misc'))
            path = os.path.join(SRC, fn)
            try:
                r = PdfReader(path)
            except Exception as e:
                stats.append((fn, 0, 0, f'READ_FAIL {e}')); continue
            pages_written = 0; chars = 0; empty = 0
            for i, pg in enumerate(r.pages, 1):
                try: t = clean(pg.extract_text() or '')
                except Exception: t = ''
                if len(t) < MIN_PAGE_CHARS:
                    empty += 1; continue
                fo.write(json.dumps({
                    'source':'kbo_official','doc':f'{title}#p{i}','kind':kind,
                    'entity':title,'title':title,'page':i,'pages_total':len(r.pages),
                    'file':fn,'len':len(t),'text':t,'fetchedAt':now
                }, ensure_ascii=False)+'\n')
                pages_written += 1; chars += len(t)
            note = 'OK' if pages_written else f'NO_TEXT_LAYER(scanned?) empty={empty}'
            stats.append((fn, pages_written, chars, note))
            print(f'{fn:50s} pages={pages_written:5d}/{len(r.pages):5d} chars={chars:9,d} {note}', flush=True)
    print('\n=== SUMMARY ===')
    tp = sum(s[1] for s in stats); tc = sum(s[2] for s in stats)
    print(f'files={len(stats)} pages={tp:,} chars={tc:,}')
    for s in stats:
        if s[3] != 'OK': print('  !', s[0], s[3])

if __name__ == '__main__': main()
