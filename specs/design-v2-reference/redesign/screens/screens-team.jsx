/* ===== screens-team.jsx ===== */
// Team + standings + records screens.
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, PhoneHeader, ChipTabs

const { NEUTRAL: NT, withAlpha: waT, TEAMS: TT } = window.KBO;

// ─────────────────────────── 1) Team hub

function ScreenTeamHub({ team, palette }) {
  const t = palette.isNeutral ? TT.doosan : team;

  return (
    <>
      <StatusBar tint={NT.text1}/>

      {/* Hero */}
      <div style={{
        padding: '50px 18px 20px',
        background: `linear-gradient(165deg, ${waT(t.primary, 0.55)} 0%, ${waT(t.primary, 0.15)} 65%, ${NT.bg0} 100%)`,
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Watermark logo */}
        <div style={{
          position: 'absolute', top: -30, right: -40, width: 220, height: 220,
          opacity: 0.12, filter: 'brightness(1.5)',
          backgroundImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(t.logo || '')}")`,
          backgroundSize: 'contain', backgroundRepeat: 'no-repeat', backgroundPosition: 'center',
          pointerEvents: 'none',
        }}/>

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M15 5l-7 7 7 7" stroke={NT.text1} strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="5" cy="12" r="1.6" fill={NT.text1}/>
            <circle cx="12" cy="12" r="1.6" fill={NT.text1}/>
            <circle cx="19" cy="12" r="1.6" fill={NT.text1}/>
          </svg>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, position: 'relative' }}>
          <TeamLogo team={t} size={52} pad={4}/>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: waT('#fff', 0.7), letterSpacing: 1, textTransform: 'uppercase' }}>Since 1982</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: NT.text1, letterSpacing: -0.8, marginTop: 1 }}>{t.name}</div>
            <div style={{ fontSize: 11, color: NT.text2, marginTop: 2 }}>
              {t.slug === 'doosan' && '잠실 베이스볼 파크'}
              {t.slug === 'lg' && '잠실 베이스볼 파크'}
              {t.slug === 'kia' && '광주-기아 챔피언스 필드'}
              {t.slug === 'ssg' && '인천 SSG 랜더스필드'}
              {t.slug === 'samsung' && '대구 라이온즈파크'}
              {t.slug === 'kt' && '수원 KT 위즈파크'}
              {t.slug === 'nc' && '창원 NC 파크'}
              {t.slug === 'lotte' && '사직 야구장'}
              {t.slug === 'hanwha' && '한화생명 볼파크'}
              {t.slug === 'kiwoom' && '고척 스카이돔'}
            </div>
          </div>
        </div>
      </div>

      {/* Record + rank banner */}
      <div style={{ padding: '0 16px', marginTop: -14, position: 'relative', zIndex: 5 }}>
        <div style={{
          borderRadius: 16, padding: '14px 16px',
          background: NT.bg2, border: `1px solid ${NT.line}`,
          boxShadow: `0 8px 20px ${waT('#000', 0.35)}`,
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
        }}>
          {[
            { l: '순위', v: '3', unit: '위', c: t.light },
            { l: '승률', v: '.545', unit: null, c: NT.text1 },
            { l: '승차', v: '4.5', unit: null, c: NT.text2 },
            { l: '연속', v: 'W3', unit: null, c: NT.win },
          ].map((s, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              borderRight: i < 3 ? `1px solid ${NT.line}` : 'none',
            }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: NT.text3, letterSpacing: 0.5 }}>{s.l}</div>
              <div style={{ fontSize: 20, fontWeight: 900, color: s.c, letterSpacing: -0.8, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
                {s.v}{s.unit && <span style={{ fontSize: 11, fontWeight: 700, color: NT.text3, marginLeft: 1 }}>{s.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sections */}
      <div style={{ padding: '18px 16px 8px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NT.text3, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 10 }}>팀 메뉴</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {[
            { l: '선수', i: '👥' },
            { l: '일정', i: '📅' },
            { l: '기록', i: '📊' },
            { l: '응원가', i: '🎵' },
            { l: '구장', i: '🏟' },
            { l: '티켓', i: '🎫' },
            { l: '굿즈', i: '🎁' },
            { l: '공지', i: '📢' },
          ].map((m, i) => (
            <div key={i} style={{
              padding: '12px 6px', borderRadius: 10,
              background: NT.bg2, border: `1px solid ${NT.line}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
            }}>
              <div style={{ fontSize: 18 }}>{m.i}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: NT.text2 }}>{m.l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Next game */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NT.text3, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>다음 경기</div>
        <div style={{
          borderRadius: 14, padding: 14,
          background: `linear-gradient(135deg, ${waT(palette.base, 0.12)}, ${NT.bg2} 80%)`,
          border: `1px solid ${waT(palette.base, 0.22)}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              fontSize: 20, fontWeight: 900, color: palette.accent, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums',
              padding: '4px 10px', borderRadius: 8,
              background: waT(palette.base, 0.18),
            }}>18:30</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: NT.text1, letterSpacing: -0.2 }}>vs KT · 홈</div>
              <div style={{ fontSize: 10, color: NT.text3 }}>문동주 → 원태인 · 잠실</div>
            </div>
            <div style={{
              padding: '6px 12px', borderRadius: 999,
              background: palette.accent, color: palette.onAccent,
              fontSize: 11, fontWeight: 800,
            }}>응원하기</div>
          </div>
        </div>
      </div>

      <TabBar active="teams" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 2) Standings detail

function ScreenStandingsDetail({ team, palette }) {
  const rows = [
    { slug: 'kia',     w: 87, l: 55, d: 2, pct: .613, gb: '-',   last10: [1,1,1,0,1,1,1,0,1,1] },
    { slug: 'samsung', w: 78, l: 64, d: 2, pct: .549, gb: '9.0', last10: [1,1,0,1,1,0,1,1,0,1] },
    { slug: 'lg',      w: 76, l: 66, d: 2, pct: .535, gb: '11',  last10: [1,0,1,1,0,1,1,1,1,0] },
    { slug: 'doosan',  w: 74, l: 66, d: 4, pct: .529, gb: '12',  last10: [0,1,1,1,0,1,1,0,1,1] },
    { slug: 'kt',      w: 72, l: 68, d: 4, pct: .514, gb: '14',  last10: [1,0,0,1,1,1,0,1,1,0] },
    { slug: 'ssg',     w: 70, l: 70, d: 4, pct: .500, gb: '16',  last10: [0,1,1,0,1,0,1,1,0,1] },
    { slug: 'lotte',   w: 66, l: 74, d: 4, pct: .471, gb: '20',  last10: [0,0,1,1,0,1,0,1,0,0] },
    { slug: 'hanwha',  w: 60, l: 80, d: 4, pct: .429, gb: '26',  last10: [1,0,0,1,0,0,1,0,0,1] },
    { slug: 'nc',      w: 58, l: 82, d: 4, pct: .414, gb: '28',  last10: [0,1,0,0,1,0,0,1,0,0] },
    { slug: 'kiwoom',  w: 50, l: 90, d: 4, pct: .357, gb: '36',  last10: [0,0,1,0,0,0,1,0,0,0] },
  ];
  const myIdx = team.slug === 'neutral' ? -1 : rows.findIndex(r => r.slug === team.slug);

  return (
    <>
      <StatusBar tint={NT.text1}/>
      <PhoneHeader title="순위" back={false} right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M3 6h18M6 12h12M10 18h4" stroke={NT.text2} strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
      }/>

      <ChipTabs tabs={['정규', '포스트시즌', '경기별', '주간']} active="정규" palette={palette}/>

      {/* Table */}
      <div style={{ padding: '0 16px' }}>
        {/* Header */}
        <div style={{
          display: 'grid', gridTemplateColumns: '18px 1fr 22px 22px 22px 38px 28px 56px',
          padding: '8px 6px', fontSize: 8.5, fontWeight: 800, color: NT.text3, letterSpacing: 0.3,
          borderBottom: `1px solid ${NT.line}`,
        }}>
          <div>#</div>
          <div>팀</div>
          <div style={{ textAlign: 'right' }}>승</div>
          <div style={{ textAlign: 'right' }}>패</div>
          <div style={{ textAlign: 'right' }}>무</div>
          <div style={{ textAlign: 'right' }}>승률</div>
          <div style={{ textAlign: 'right' }}>GB</div>
          <div style={{ textAlign: 'right' }}>최근10</div>
        </div>
        {/* Rows */}
        {rows.map((r, i) => {
          const t = TT[r.slug];
          const isMe = i === myIdx;
          const wins = r.last10.filter(x => x === 1).length;
          return (
            <div key={r.slug} style={{
              display: 'grid', gridTemplateColumns: '18px 1fr 22px 22px 22px 38px 28px 56px',
              padding: '9px 6px', alignItems: 'center',
              background: isMe ? waT(palette.base, 0.15) : 'transparent',
              borderBottom: i < rows.length - 1 ? `1px solid ${waT('#fff', 0.04)}` : 'none',
              borderRadius: isMe ? 10 : 0,
              borderLeft: isMe ? `3px solid ${palette.accent}` : '3px solid transparent',
              paddingLeft: isMe ? 3 : 6,
              fontVariantNumeric: 'tabular-nums',
            }}>
              <div style={{
                fontSize: 11, fontWeight: 900, letterSpacing: -0.3,
                color: i < 3 ? t.light : (i >= 5 ? NT.text4 : NT.text3),
              }}>{i+1}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <TeamLogo team={t} size={18}/>
                <span style={{
                  fontSize: 12, fontWeight: isMe ? 900 : 700,
                  color: isMe ? palette.accent : NT.text1, letterSpacing: -0.2,
                }}>{t.short}</span>
              </div>
              <div style={{ textAlign: 'right', fontSize: 11.5, fontWeight: 700, color: NT.text1 }}>{r.w}</div>
              <div style={{ textAlign: 'right', fontSize: 11.5, color: NT.text3 }}>{r.l}</div>
              <div style={{ textAlign: 'right', fontSize: 11.5, color: NT.text4 }}>{r.d}</div>
              <div style={{ textAlign: 'right', fontSize: 11.5, fontWeight: 800, color: NT.text1 }}>{r.pct.toFixed(3)}</div>
              <div style={{ textAlign: 'right', fontSize: 10.5, color: NT.text3 }}>{r.gb}</div>
              {/* last10 mini bars */}
              <div style={{ display: 'flex', gap: 1, justifyContent: 'flex-end', alignItems: 'center' }}>
                {r.last10.map((x, j) => (
                  <div key={j} style={{
                    width: 3, height: 10, borderRadius: 1,
                    background: x === 1 ? waT(NT.win, 0.85) : waT(NT.text4, 0.4),
                  }}/>
                ))}
                <span style={{ fontSize: 9, fontWeight: 800, color: NT.text2, marginLeft: 3, minWidth: 14 }}>{wins}W</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ padding: '10px 16px 0', display: 'flex', gap: 12, fontSize: 9, color: NT.text3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 10, height: 3, borderRadius: 1, background: NT.win }}/>
          <span>승</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 10, height: 3, borderRadius: 1, background: waT(NT.text4, 0.4) }}/>
          <span>패</span>
        </div>
        <div style={{ marginLeft: 'auto' }}>포스트시즌 1~5위</div>
      </div>

      <TabBar active="teams" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 3) Team schedule (calendar month)

function ScreenTeamSchedule({ team, palette }) {
  const t = palette.isNeutral ? TT.doosan : team;

  // Build 5-week calendar grid for September
  // Each cell: day + opponent (W/L/scheduled) or rest day
  const mkCell = (day, opp, result, home) => ({ day, opp, result, home });
  const cells = [
    // week 1
    null, { day: 1 }, mkCell(2, 'kt',     'W', true),  mkCell(3, 'kt',     'W', true),  mkCell(4, 'kt',     'L', true),  { day: 5, rest: true }, mkCell(6, 'samsung', 'W', false),
    // week 2
    mkCell(7, 'samsung', 'W', false), mkCell(8, 'samsung', 'L', false), { day: 9, rest: true }, mkCell(10, 'lg',    'W', true),  mkCell(11, 'lg',    'L', true),  mkCell(12, 'lg',    'W', true), mkCell(13, 'ssg',   'W', false),
    // week 3
    mkCell(14, 'ssg',    'L', false), mkCell(15, 'ssg',    'W', false), { day: 16, rest: true }, mkCell(17, 'nc',     'W', true),  mkCell(18, 'nc',     'W', true),  mkCell(19, 'nc',     'L', true),  mkCell(20, 'kia',    'W', false),
    // week 4
    mkCell(21, 'kia',    'L', false), mkCell(22, 'kia',    'W', false), { day: 23, rest: true }, mkCell(24, 'kt',     'live', false), mkCell(25, 'kt',     'next', false), mkCell(26, 'hanwha', 'next', true),  mkCell(27, 'hanwha', 'next', true),
    // week 5
    mkCell(28, 'hanwha', 'next', true), mkCell(29, 'lotte',  'next', false), mkCell(30, 'lotte',  'next', false), { day: '', empty: true }, { day: '', empty: true }, { day: '', empty: true }, { day: '', empty: true },
  ];

  return (
    <>
      <StatusBar tint={NT.text1}/>
      <PhoneHeader title={`${t.short} 스케줄`}/>

      {/* Month picker */}
      <div style={{ padding: '0 16px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke={NT.text3} strokeWidth="1.8"/></svg>
        <div style={{ fontSize: 14, fontWeight: 800, color: NT.text1, letterSpacing: -0.3 }}>2024년 9월</div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke={NT.text3} strokeWidth="1.8"/></svg>
      </div>

      {/* Month record */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          padding: '8px 12px', borderRadius: 10,
          background: waT(palette.base, 0.1),
          border: `1px solid ${waT(palette.base, 0.22)}`,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <span style={{ fontSize: 10, fontWeight: 800, color: palette.accent, letterSpacing: 0.5 }}>이번 달 성적</span>
          <span style={{ fontSize: 12, fontWeight: 800, color: NT.text1, fontVariantNumeric: 'tabular-nums' }}>
            <b style={{ color: NT.win }}>14승</b> 8패 · 승률 .636
          </span>
        </div>
      </div>

      {/* Calendar */}
      <div style={{ padding: '0 16px' }}>
        {/* day names */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 6 }}>
          {['일','월','화','수','목','금','토'].map((d, i) => (
            <div key={d} style={{
              textAlign: 'center', fontSize: 9, fontWeight: 700, padding: '4px 0',
              color: i === 0 ? NT.live : (i === 6 ? palette.accent : NT.text3),
            }}>{d}</div>
          ))}
        </div>
        {/* cells */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
          {cells.map((c, i) => {
            if (!c) return <div key={i}/>;
            if (c.empty) return <div key={i} style={{ aspectRatio: '1/1.1' }}/>;
            if (c.rest || !c.opp) {
              return (
                <div key={i} style={{
                  aspectRatio: '1/1.1', borderRadius: 8,
                  background: c.rest ? waT('#fff', 0.02) : 'transparent',
                  border: `1px solid ${NT.line}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  opacity: c.rest ? 0.5 : 1,
                }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: NT.text3 }}>{c.day}</div>
                  {c.rest && <div style={{ fontSize: 8, color: NT.text4, marginTop: 1 }}>휴</div>}
                </div>
              );
            }
            const opp = TT[c.opp];
            const isLive = c.result === 'live';
            const isNext = c.result === 'next';
            const w = c.result === 'W';
            const l = c.result === 'L';
            return (
              <div key={i} style={{
                aspectRatio: '1/1.1', borderRadius: 8,
                background: isLive ? waT(NT.live, 0.2) :
                            w ? waT(NT.win, 0.12) :
                            l ? waT(NT.text4, 0.1) :
                            NT.bg2,
                border: `1px solid ${
                  isLive ? NT.live :
                  isNext ? waT(palette.base, 0.35) :
                  NT.line
                }`,
                display: 'flex', flexDirection: 'column',
                padding: '3px 4px',
                position: 'relative',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div style={{ fontSize: 9, fontWeight: 700, color: NT.text2, fontVariantNumeric: 'tabular-nums' }}>{c.day}</div>
                  {!c.home && <div style={{ fontSize: 7, color: NT.text4 }}>@</div>}
                </div>
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <TeamLogo team={opp} size={18}/>
                </div>
                {isLive && (
                  <div style={{ position: 'absolute', top: 2, right: 2, width: 4, height: 4, borderRadius: '50%', background: NT.live, boxShadow: `0 0 4px ${NT.live}` }}/>
                )}
                {(w || l) && (
                  <div style={{
                    position: 'absolute', bottom: 2, right: 3,
                    fontSize: 7, fontWeight: 900, letterSpacing: 0.3,
                    color: w ? NT.win : NT.text4,
                  }}>{w ? 'W' : 'L'}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <TabBar active="teams" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 4) Team records (team-level season stats)

function ScreenTeamRecords({ team, palette }) {
  const t = palette.isNeutral ? TT.doosan : team;

  const battingRows = [
    { l: '타율',   v: '.278', rank: 3, max: 5 },
    { l: 'OPS',    v: '.745', rank: 4, max: 5 },
    { l: '홈런',   v: '138',  rank: 5, max: 3 },
    { l: '득점',   v: '712',  rank: 3, max: 5 },
    { l: '도루',   v: '98',   rank: 2, max: 7 },
  ];
  const pitchingRows = [
    { l: 'ERA',    v: '3.84', rank: 2, max: 7 },
    { l: 'WHIP',   v: '1.32', rank: 3, max: 5 },
    { l: '탈삼진', v: '1087', rank: 4, max: 3 },
    { l: '세이브', v: '38',   rank: 3, max: 5 },
    { l: '피홈런', v: '112',  rank: 5, max: 3 },
  ];

  return (
    <>
      <StatusBar tint={NT.text1}/>
      <PhoneHeader title={`${t.short} 기록`}/>

      <ChipTabs tabs={['팀 기록', '선수 기록', '대기록', '시즌']} active="팀 기록" palette={palette}/>

      {/* Summary hero */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          borderRadius: 16, padding: 14,
          background: `linear-gradient(135deg, ${waT(t.primary, 0.2)}, ${NT.bg2} 85%)`,
          border: `1px solid ${waT(t.primary, 0.25)}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 800, color: t.light, letterSpacing: 1, textTransform: 'uppercase' }}>팀 OPS</div>
              <div style={{ fontSize: 30, fontWeight: 900, color: NT.text1, letterSpacing: -1, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>.745</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: NT.text3 }}>리그</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: palette.accent, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>4위</div>
            </div>
          </div>
          {/* rank bar */}
          <div style={{ display: 'flex', gap: 3 }}>
            {[1,2,3,4,5,6,7,8,9,10].map(r => (
              <div key={r} style={{
                flex: 1, height: 6, borderRadius: 2,
                background: r === 4 ? palette.accent :
                            r <= 4 ? waT(palette.base, 0.4) : waT('#fff', 0.06),
              }}/>
            ))}
          </div>
        </div>
      </div>

      {/* Batting stats */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NT.text3, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>타격</div>
        <div style={{
          borderRadius: 14, background: NT.bg2, border: `1px solid ${NT.line}`, overflow: 'hidden',
        }}>
          {battingRows.map((r, i) => (
            <div key={i} style={{
              padding: '11px 14px',
              borderBottom: i < battingRows.length - 1 ? `1px solid ${waT('#fff', 0.04)}` : 'none',
              display: 'grid', gridTemplateColumns: '50px 1fr auto', alignItems: 'center', gap: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: NT.text2 }}>{r.l}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: waT('#fff', 0.06), overflow: 'hidden' }}>
                  <div style={{
                    width: `${((11 - r.rank) / 10) * 100}%`, height: '100%',
                    background: r.rank <= 3 ? palette.accent : waT(palette.base, 0.5),
                    borderRadius: 2,
                  }}/>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.2, color: NT.text1, minWidth: 42, textAlign: 'right' }}>{r.v}</div>
              </div>
              <div style={{
                fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 999,
                background: r.rank <= 3 ? waT(palette.base, 0.2) : waT('#fff', 0.06),
                color: r.rank <= 3 ? palette.accent : NT.text3,
                minWidth: 34, textAlign: 'center',
              }}>{r.rank}위</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pitching stats */}
      <div style={{ padding: '0 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NT.text3, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>투구</div>
        <div style={{
          borderRadius: 14, background: NT.bg2, border: `1px solid ${NT.line}`, overflow: 'hidden',
        }}>
          {pitchingRows.map((r, i) => (
            <div key={i} style={{
              padding: '11px 14px',
              borderBottom: i < pitchingRows.length - 1 ? `1px solid ${waT('#fff', 0.04)}` : 'none',
              display: 'grid', gridTemplateColumns: '50px 1fr auto', alignItems: 'center', gap: 10,
            }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: NT.text2 }}>{r.l}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: waT('#fff', 0.06), overflow: 'hidden' }}>
                  <div style={{
                    width: `${((11 - r.rank) / 10) * 100}%`, height: '100%',
                    background: r.rank <= 3 ? palette.accent : waT(palette.base, 0.5),
                    borderRadius: 2,
                  }}/>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.2, color: NT.text1, minWidth: 42, textAlign: 'right' }}>{r.v}</div>
              </div>
              <div style={{
                fontSize: 10, fontWeight: 800, padding: '3px 8px', borderRadius: 999,
                background: r.rank <= 3 ? waT(palette.base, 0.2) : waT('#fff', 0.06),
                color: r.rank <= 3 ? palette.accent : NT.text3,
                minWidth: 34, textAlign: 'center',
              }}>{r.rank}위</div>
            </div>
          ))}
        </div>
      </div>

      <TabBar active="teams" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 5) League leaderboard (player records)

function ScreenLeagueRecords({ team, palette }) {
  const boards = [
    { cat: '타율', leaders: [
      { name: '김도영', team: 'kia',     v: '.341', no: 5 },
      { name: '기예르모', team: 'ssg',   v: '.331', no: 35 },
      { name: '나성범',   team: 'kia',  v: '.313', no: 54 },
      { name: '박건우',   team: 'nc',    v: '.308', no: 37 },
      { name: '김현수',   team: 'lg',    v: '.299', no: 22 },
    ]},
    { cat: '홈런', leaders: [
      { name: '김도영', team: 'kia',     v: '38', no: 5 },
      { name: '노시환', team: 'hanwha',  v: '34', no: 8 },
      { name: '오스틴', team: 'lg',      v: '32', no: 13 },
      { name: '최정',     team: 'ssg',   v: '26', no: 14 },
      { name: '박병호', team: 'kt',      v: '22', no: 52 },
    ]},
    { cat: 'ERA',  leaders: [
      { name: '네일',    team: 'kia',     v: '2.41', no: 55 },
      { name: '문동주', team: 'hanwha',  v: '2.48', no: 1 },
      { name: '하트',    team: 'nc',     v: '2.69', no: 40 },
      { name: '원태인', team: 'samsung', v: '3.15', no: 18 },
      { name: '코너',    team: 'samsung', v: '3.22', no: 28 },
    ]},
  ];

  return (
    <>
      <StatusBar tint={NT.text1}/>
      <PhoneHeader title="리그 기록실"/>

      <ChipTabs tabs={['타격', '투구', '수비', '주루', '종합']} active="타격" palette={palette}/>

      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {boards.map((b, i) => (
          <div key={i}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 900, color: NT.text1, letterSpacing: -0.4 }}>{b.cat}</div>
              <div style={{ fontSize: 10, color: NT.text3 }}>전체 보기 →</div>
            </div>
            <div style={{
              borderRadius: 14, background: NT.bg2, border: `1px solid ${NT.line}`, overflow: 'hidden',
            }}>
              {b.leaders.map((l, j) => {
                const lt = TT[l.team];
                return (
                  <div key={j} style={{
                    display: 'grid', gridTemplateColumns: '24px 28px 1fr 60px',
                    padding: '9px 12px', alignItems: 'center', gap: 8,
                    borderBottom: j < b.leaders.length - 1 ? `1px solid ${waT('#fff', 0.04)}` : 'none',
                    background: j === 0 ? waT(palette.base, 0.07) : 'transparent',
                  }}>
                    <div style={{
                      fontSize: 13, fontWeight: 900, letterSpacing: -0.3, fontVariantNumeric: 'tabular-nums',
                      color: j === 0 ? palette.accent : (j < 3 ? NT.text1 : NT.text3),
                    }}>{j+1}</div>
                    <TeamLogo team={lt} size={20}/>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: NT.text1, letterSpacing: -0.2 }}>{l.name}</span>
                      <span style={{ fontSize: 9, color: NT.text4 }}>#{l.no}</span>
                    </div>
                    <div style={{ textAlign: 'right', fontSize: 14, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.4, color: j === 0 ? palette.accent : NT.text1 }}>{l.v}</div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <TabBar active="teams" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 6) Head-to-head matrix

function ScreenHeadToHead({ team, palette }) {
  const t = palette.isNeutral ? TT.doosan : team;
  // Build 10x10 matrix with opponent records vs row team
  // For simplicity we render row = team, col = opponent, cell = W-L diff
  const allTeams = ['kia','samsung','lg','doosan','kt','ssg','lotte','hanwha','nc','kiwoom'];

  // Mock records for row team's H2H vs each opponent
  const vsRecords = {
    kia:     { w: 4, l: 11, d: 1 },
    samsung: { w: 7, l: 8,  d: 1 },
    lg:      { w: 9, l: 7,  d: 0 },
    doosan:  { w: 8, l: 7,  d: 1 },
    kt:      { w: 12, l: 4, d: 0 },
    ssg:     { w: 8, l: 7,  d: 1 },
    lotte:   { w: 9, l: 6,  d: 1 },
    hanwha:  { w: 11, l: 5, d: 0 },
    nc:      { w: 10, l: 5, d: 1 },
    kiwoom:  { w: 14, l: 2, d: 0 },
  };

  // remove the team's own row from display
  const oppList = allTeams.filter(s => s !== t.slug);

  const totalW = oppList.reduce((a, s) => a + vsRecords[s].w, 0);
  const totalL = oppList.reduce((a, s) => a + vsRecords[s].l, 0);

  return (
    <>
      <StatusBar tint={NT.text1}/>
      <PhoneHeader title={`${t.short} 상대 전적`}/>

      {/* Summary */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          borderRadius: 16, padding: '12px 14px',
          background: `linear-gradient(135deg, ${waT(t.primary, 0.2)}, ${NT.bg2} 85%)`,
          border: `1px solid ${waT(t.primary, 0.25)}`,
          display: 'flex', alignItems: 'center', gap: 14,
        }}>
          <TeamLogo team={t} size={36}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: NT.text3, letterSpacing: 0.5 }}>시즌 통산</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: NT.text1, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums' }}>
              <b style={{ color: NT.win }}>{totalW}</b>승 {totalL}패
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: NT.text3, fontWeight: 700 }}>승률</div>
            <div style={{ fontSize: 16, fontWeight: 900, color: palette.accent, letterSpacing: -0.4, fontVariantNumeric: 'tabular-nums' }}>.{(totalW/(totalW+totalL)).toFixed(3).slice(2)}</div>
          </div>
        </div>
      </div>

      {/* Matrix */}
      <div style={{ padding: '0 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NT.text3, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>상대별 전적</div>
        <div style={{
          borderRadius: 14, background: NT.bg2, border: `1px solid ${NT.line}`, overflow: 'hidden',
        }}>
          {oppList.map((slug, i) => {
            const opp = TT[slug];
            const r = vsRecords[slug];
            const total = r.w + r.l;
            const winPct = r.w / total;
            const dominant = winPct >= 0.6;
            const weak = winPct <= 0.4;
            return (
              <div key={slug} style={{
                display: 'grid', gridTemplateColumns: '24px 1fr auto 70px',
                padding: '10px 14px', alignItems: 'center', gap: 10,
                borderBottom: i < oppList.length - 1 ? `1px solid ${waT('#fff', 0.04)}` : 'none',
              }}>
                <TeamLogo team={opp} size={22}/>
                <div style={{ fontSize: 12, fontWeight: 700, color: NT.text1, letterSpacing: -0.2 }}>{opp.short}</div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11.5, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                }}>
                  <span style={{ color: NT.win }}>{r.w}</span>
                  <span style={{ color: NT.text4, fontSize: 9 }}>-</span>
                  <span style={{ color: NT.text3 }}>{r.l}</span>
                  {r.d > 0 && <span style={{ color: NT.text4, fontSize: 9 }}>·{r.d}무</span>}
                </div>
                {/* win % bar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{ flex: 1, height: 5, borderRadius: 2, background: waT(NT.text4, 0.25), overflow: 'hidden', display: 'flex' }}>
                    <div style={{
                      width: `${winPct * 100}%`, height: '100%',
                      background: dominant ? NT.win : weak ? waT(NT.text4, 0.5) : waT(palette.base, 0.7),
                    }}/>
                  </div>
                  <div style={{
                    fontSize: 9, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                    minWidth: 28, textAlign: 'right',
                    color: dominant ? NT.win : weak ? NT.text4 : NT.text2,
                  }}>.{winPct.toFixed(3).slice(2)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div style={{ padding: '8px 16px 0', display: 'flex', gap: 10, fontSize: 9, color: NT.text3, alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ width: 10, height: 3, background: NT.win, borderRadius: 1 }}/>
          <span>우세 (0.6↑)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ width: 10, height: 3, background: waT(palette.base, 0.7), borderRadius: 1 }}/>
          <span>비슷</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          <div style={{ width: 10, height: 3, background: waT(NT.text4, 0.5), borderRadius: 1 }}/>
          <span>약세 (0.4↓)</span>
        </div>
      </div>

      <TabBar active="teams" palette={palette}/>
    </>
  );
}

Object.assign(window, {
  ScreenTeamHub,
  ScreenStandingsDetail,
  ScreenTeamSchedule,
  ScreenTeamRecords,
  ScreenLeagueRecords,
  ScreenHeadToHead,
});
