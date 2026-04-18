/* ===== screens-player.jsx ===== */
// Player-related screens: list, profile, stats detail, game log, compare, player board.
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, PhoneHeader, ChipTabs

const { NEUTRAL: NP, withAlpha: waP, TEAMS: TP } = window.KBO;

// Mock player data — realistic KBO players
const PLAYERS = {
  ja_choi:    { name: '최정',     pos: '3B',  team: 'ssg',    no: 14, bats: '우',  throws: '우',
                avg: '.289', hr: 26, rbi: 86, ops: '.910', war: 4.8, sb: 3 },
  gu_gim:     { name: '김도영',   pos: '3B',  team: 'kia',    no: 5,  bats: '우',  throws: '우',
                avg: '.341', hr: 38, rbi: 109, ops: '1.067', war: 8.3, sb: 38 },
  do_mun:     { name: '문동주',   pos: 'SP',  team: 'hanwha', no: 1,  bats: '우',  throws: '우',
                era: '2.48', w: 10, l: 4, k: 132, whip: 1.12, ip: '155.1' },
  ta_won:     { name: '원태인',   pos: 'SP',  team: 'samsung', no: 18, bats: '우', throws: '우',
                era: '3.15', w: 12, l: 6, k: 128, whip: 1.21, ip: '162.2' },
  bh_park:    { name: '박병호',   pos: '1B',  team: 'kt',     no: 52, bats: '우',  throws: '우',
                avg: '.255', hr: 22, rbi: 78, ops: '.842', war: 2.4, sb: 0 },
  sw_jang:    { name: '장성우',   pos: 'C',   team: 'kt',     no: 22, bats: '우', throws: '우',
                avg: '.242', hr: 18, rbi: 65, ops: '.801', war: 2.1, sb: 0 },
};

// ─────────────────────────── 1) Player list / roster

function ScreenPlayerList({ team, palette }) {
  const displayTeam = palette.isNeutral ? TP.kia : team;

  // Stat rankings with players of current team
  const rankings = [
    { cat: '타율',   leader: 'gu_gim', v: '.341', rank: 1 },
    { cat: '홈런',   leader: 'gu_gim', v: '38',   rank: 1 },
    { cat: '타점',   leader: 'gu_gim', v: '109',  rank: 1 },
    { cat: 'OPS',    leader: 'gu_gim', v: '1.067', rank: 1 },
  ];

  const roster = [
    { key: 'gu_gim',  no: 5,  name: '김도영',   pos: '3루수',  stat: '.341', statL: 'AVG' },
    { key: 'na_choi', no: 54, name: '나성범',   pos: '외야수', stat: '.302', statL: 'AVG' },
    { key: 'hj_choi', no: 50, name: '최형우',   pos: '지명',  stat: '.289', statL: 'AVG' },
    { key: 'sw_kim',  no: 7,  name: '김선빈',   pos: '2루수', stat: '.278', statL: 'AVG' },
    { key: 'gy_lee',  no: 58, name: '이의리',   pos: '선발',  stat: '3.15', statL: 'ERA' },
    { key: 'yj_yang', no: 54, name: '양현종',   pos: '선발',  stat: '3.45', statL: 'ERA' },
    { key: 'st_jun',  no: 22, name: '전상현',   pos: '셋업',  stat: '2.20', statL: 'ERA' },
    { key: 'yw_jung', no: 20, name: '정해영',   pos: '마무리', stat: '1.85', statL: 'ERA' },
  ];

  return (
    <>
      <StatusBar tint={NP.text1}/>
      <PhoneHeader title={`${displayTeam.name} 선수`} right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="6.5" stroke={NP.text2} strokeWidth="1.6"/>
          <path d="M16 16l4 4" stroke={NP.text2} strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      }/>

      {/* Category chips */}
      <ChipTabs tabs={['전체', '타자', '투수', '신인', '부상자']} active="전체" palette={palette}/>

      {/* Stat leaders card */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          borderRadius: 16, padding: 14,
          background: `linear-gradient(135deg, ${waP(displayTeam.primary, 0.2)}, ${NP.bg2} 85%)`,
          border: `1px solid ${waP(displayTeam.primary, 0.3)}`,
        }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: palette.accent, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10 }}>
            팀 스탯 리더
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            {rankings.map((r, i) => (
              <div key={i} style={{
                padding: '8px 6px', borderRadius: 10,
                background: NP.bg3, border: `1px solid ${NP.line}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
              }}>
                <div style={{ fontSize: 8.5, fontWeight: 700, color: NP.text3, marginBottom: 2 }}>{r.cat}</div>
                <div style={{ fontSize: 14, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.5, color: NP.text1 }}>{r.v}</div>
                <div style={{ fontSize: 9, color: NP.text3, marginTop: 1 }}>리그 {r.rank}위</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Roster list */}
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NP.text3, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6, display: 'flex', justifyContent: 'space-between' }}>
          <span>로스터 {roster.length}명</span>
          <span style={{ color: NP.text4 }}>등번호순 ▼</span>
        </div>
        {roster.map((p, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 10, alignItems: 'center',
            padding: '10px 0',
            borderBottom: i < roster.length - 1 ? `1px solid ${NP.line}` : 'none',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: '50%',
              background: waP(displayTeam.primary, 0.25),
              border: `1px solid ${waP(displayTeam.primary, 0.4)}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 900, color: displayTeam.light,
              fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3,
            }}>{p.no}</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800, color: NP.text1, letterSpacing: -0.2 }}>{p.name}</div>
              <div style={{ fontSize: 10, color: NP.text3, marginTop: 1 }}>{p.pos}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 14, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3, color: NP.text1 }}>{p.stat}</div>
              <div style={{ fontSize: 9, color: NP.text4 }}>{p.statL}</div>
            </div>
          </div>
        ))}
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

// ─────────────────────────── Helpers: Donut gauge + Bar

function Donut({ value, max = 1, color, bg, size = 64, stroke = 8, label }) {
  const pct = Math.min(1, value / max);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} stroke={bg || waP('#fff', 0.08)} strokeWidth={stroke} fill="none"/>
        <circle cx={size/2} cy={size/2} r={r} stroke={color} strokeWidth={stroke} fill="none"
          strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round"/>
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      }}>
        {label && <div style={{ fontSize: 8, fontWeight: 700, color: NP.text3, letterSpacing: 0.4 }}>{label}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────── 2) Player profile

function ScreenPlayerProfile({ team, palette }) {
  // Always show the team's star — or KIA's Kim Do-young when neutral
  const p = palette.isNeutral ? PLAYERS.gu_gim : (
    team.slug === 'hanwha' ? PLAYERS.do_mun :
    team.slug === 'samsung' ? PLAYERS.ta_won :
    team.slug === 'kia' ? PLAYERS.gu_gim :
    team.slug === 'ssg' ? PLAYERS.ja_choi :
    team.slug === 'kt' ? PLAYERS.bh_park :
    PLAYERS.gu_gim
  );
  const playerTeam = TP[p.team];
  const isPitcher = p.pos === 'SP' || p.pos === 'RP' || p.pos === 'CP';

  return (
    <>
      <StatusBar tint={NP.text1}/>
      <div style={{ position: 'absolute', top: 44, right: 14, display: 'flex', gap: 14, zIndex: 10 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 21s-7-4.5-7-11a4 4 0 017-2.6A4 4 0 0119 10c0 6.5-7 11-7 11z" stroke={palette.accent} strokeWidth="1.8" fill={waP(palette.base, 0.15)}/>
        </svg>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M4 4h16v16l-8-5-8 5V4z" stroke={NP.text2} strokeWidth="1.8"/>
        </svg>
      </div>
      <div style={{ position: 'absolute', top: 44, left: 14, zIndex: 10 }}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke={NP.text1} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>

      {/* Hero */}
      <div style={{
        padding: '80px 16px 20px', marginTop: -44,
        background: `linear-gradient(155deg, ${waP(playerTeam.primary, 0.55)} 0%, ${waP(playerTeam.primary, 0.15)} 70%, ${NP.bg0} 100%)`,
        position: 'relative', overflow: 'hidden',
      }}>
        {/* Watermark number */}
        <div style={{
          position: 'absolute', top: -20, right: -30,
          fontSize: 240, fontWeight: 900, color: waP(playerTeam.primary, 0.25),
          letterSpacing: -10, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          pointerEvents: 'none',
        }}>{p.no}</div>

        {/* Team chip */}
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px 4px 4px', borderRadius: 999,
          background: waP('#000', 0.35), backdropFilter: 'blur(8px)',
          marginBottom: 14,
        }}>
          <TeamLogo team={playerTeam} size={18}/>
          <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', letterSpacing: -0.2 }}>{playerTeam.short}</span>
          <span style={{ fontSize: 10, color: waP('#fff', 0.6) }}>#{p.no}</span>
        </div>

        {/* Name */}
        <div style={{ fontSize: 36, fontWeight: 900, color: NP.text1, letterSpacing: -1.5, lineHeight: 1, marginBottom: 6, position: 'relative' }}>
          {p.name}
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: NP.text2, letterSpacing: -0.2, position: 'relative' }}>
          {p.pos} · 만 21세 · 우투좌타 · 183cm / 82kg
        </div>
      </div>

      {/* Key stat row */}
      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {(isPitcher ? [
            { l: 'ERA', v: p.era, sub: '리그 3위' },
            { l: '승',   v: p.w, sub: `${p.l}패` },
            { l: 'K',    v: p.k, sub: `${p.ip}이닝` },
            { l: 'WHIP', v: p.whip, sub: '리그 5위' },
          ] : [
            { l: 'AVG',  v: p.avg, sub: '리그 1위' },
            { l: 'HR',   v: p.hr, sub: '리그 1위' },
            { l: 'RBI',  v: p.rbi, sub: '리그 1위' },
            { l: 'OPS',  v: p.ops, sub: '리그 1위' },
          ]).map((s, i) => (
            <div key={i} style={{
              padding: '10px 6px 9px', borderRadius: 12,
              background: NP.bg2, border: `1px solid ${NP.line}`,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1,
            }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: NP.text3, letterSpacing: 0.5 }}>{s.l}</div>
              <div style={{ fontSize: 17, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.5, color: NP.text1 }}>{s.v}</div>
              <div style={{ fontSize: 8.5, color: palette.accent, fontWeight: 700 }}>{s.sub}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <ChipTabs tabs={['개요', '스탯', '경기별', '응원글', '커리어']} active="개요" palette={palette}/>

      {/* Form gauges */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          borderRadius: 16, padding: 14,
          background: NP.bg2, border: `1px solid ${NP.line}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: NP.text1, letterSpacing: -0.2 }}>최근 10경기 폼</span>
            <span style={{ fontSize: 10, fontWeight: 800, color: NP.win, padding: '2px 8px', borderRadius: 6, background: waP(NP.win, 0.15) }}>↑ HOT</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 14 }}>
            {[
              { l: '타율',  v: '.412', max: 0.4, color: NP.win },
              { l: '출루',  v: '.489', max: 0.5, color: palette.accent },
              { l: '장타',  v: '.751', max: 0.8, color: NP.warn },
            ].map((g, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <div style={{ position: 'relative' }}>
                  <Donut value={parseFloat(g.v)} max={g.max} color={g.color} size={60} stroke={6}/>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ fontSize: 12, fontWeight: 900, color: NP.text1, letterSpacing: -0.3, fontVariantNumeric: 'tabular-nums' }}>{g.v}</div>
                  </div>
                </div>
                <div style={{ fontSize: 9, color: NP.text3, fontWeight: 700 }}>{g.l}</div>
              </div>
            ))}
          </div>
          {/* Hit streak bar */}
          <div style={{ display: 'flex', gap: 3, alignItems: 'end', height: 32, paddingTop: 8, borderTop: `1px solid ${NP.line}` }}>
            {[1.5, 2, 0, 3, 1, 2.5, 1, 3, 2, 2].map((h, i) => (
              <div key={i} style={{
                flex: 1, height: `${Math.max(h * 25, 4)}%`,
                background: h === 0 ? waP(NP.text4, 0.3) : waP(palette.base, 0.8),
                borderRadius: 2,
              }}/>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: NP.text4, marginTop: 4 }}>
            <span>10경기 전</span><span>오늘</span>
          </div>
        </div>
      </div>

      {/* Today's game */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          borderRadius: 14, padding: '10px 14px',
          background: `linear-gradient(135deg, ${waP(palette.base, 0.14)}, ${NP.bg2} 80%)`,
          border: `1px solid ${waP(palette.base, 0.22)}`,
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: NP.live, boxShadow: `0 0 5px ${NP.live}`, flexShrink: 0 }}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: NP.live, letterSpacing: 0.5, marginBottom: 1 }}>오늘 경기</div>
            <div style={{ fontSize: 11.5, color: NP.text1, fontWeight: 600 }}>
              vs KT · <b style={{ color: palette.accent, fontVariantNumeric: 'tabular-nums' }}>3타수 2안타 1홈런</b>
            </div>
          </div>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke={NP.text3} strokeWidth="1.8"/></svg>
        </div>
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 3) Stats detail

function ScreenPlayerStats({ team, palette }) {
  const p = palette.isNeutral ? PLAYERS.gu_gim : PLAYERS.ja_choi;
  const playerTeam = TP[p.team];

  // Split table — rows × metrics
  const splits = [
    { l: '홈',    g: 50, avg: '.362', hr: 22, ops: '1.112' },
    { l: '원정',  g: 45, avg: '.318', hr: 16, ops: '.997'  },
    { l: '좌투',  g: 28, avg: '.378', hr: 11, ops: '1.165' },
    { l: '우투',  g: 67, avg: '.327', hr: 27, ops: '1.024' },
    { l: '득점권', g: 95, avg: '.389', hr: 14, ops: '1.201' },
  ];

  // Month-by-month
  const months = [
    { m: '4월', avg: .295 },
    { m: '5월', avg: .341 },
    { m: '6월', avg: .368 },
    { m: '7월', avg: .302 },
    { m: '8월', avg: .378 },
    { m: '9월', avg: .385 },
  ];
  const maxAvg = 0.4;

  return (
    <>
      <StatusBar tint={NP.text1}/>
      <PhoneHeader title={`${p.name} · 스탯`}/>

      <ChipTabs tabs={['개요', '스탯', '경기별', '응원글', '커리어']} active="스탯" palette={palette}/>

      {/* Season totals */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NP.text3, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>2024 시즌</div>
        <div style={{
          borderRadius: 14, padding: 2,
          background: NP.bg2, border: `1px solid ${NP.line}`,
        }}>
          {[
            [['G', '95'], ['AB', '369'], ['H', '126'], ['2B', '24'], ['3B', '3']],
            [['HR', p.hr], ['RBI', p.rbi], ['R', '98'], ['SB', p.sb], ['BB', '51']],
            [['SO', '72'], ['AVG', p.avg], ['OBP', '.412'], ['SLG', '.655'], ['OPS', p.ops]],
          ].map((row, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
              padding: '9px 6px',
              borderBottom: i < 2 ? `1px solid ${NP.line}` : 'none',
            }}>
              {row.map(([l, v], j) => (
                <div key={j} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <div style={{ fontSize: 8.5, fontWeight: 700, color: NP.text3, letterSpacing: 0.4 }}>{l}</div>
                  <div style={{ fontSize: 13, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3, color: NP.text1, marginTop: 1 }}>{v}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Month trend */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          borderRadius: 14, padding: 14,
          background: NP.bg2, border: `1px solid ${NP.line}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: NP.text1 }}>월별 타율 추이</span>
            <span style={{ fontSize: 9, color: NP.text3 }}>Y: .000 ~ .400</span>
          </div>
          <div style={{ position: 'relative', height: 90 }}>
            {/* grid lines */}
            {[0, 25, 50, 75, 100].map(y => (
              <div key={y} style={{ position: 'absolute', left: 0, right: 0, top: `${y}%`, height: 1, background: waP('#fff', 0.04) }}/>
            ))}
            {/* bars */}
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 6 }}>
              {months.map((m, i) => {
                const h = (m.avg / maxAvg) * 100;
                return (
                  <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end', position: 'relative' }}>
                    <div style={{
                      fontSize: 9, fontWeight: 700, color: NP.text2, fontVariantNumeric: 'tabular-nums',
                      marginBottom: 3,
                    }}>{m.avg.toFixed(3)}</div>
                    <div style={{
                      width: '100%', height: `${h}%`,
                      background: `linear-gradient(180deg, ${palette.accent}, ${waP(palette.base, 0.5)})`,
                      borderRadius: '3px 3px 0 0',
                      minHeight: 4,
                    }}/>
                  </div>
                );
              })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {months.map(m => <div key={m.m} style={{ flex: 1, fontSize: 9, color: NP.text3, textAlign: 'center' }}>{m.m}</div>)}
          </div>
        </div>
      </div>

      {/* Splits */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NP.text3, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>스플릿</div>
        <div style={{
          borderRadius: 14, background: NP.bg2, border: `1px solid ${NP.line}`,
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1.2fr 0.6fr 0.8fr 0.6fr 0.8fr',
            padding: '8px 12px', fontSize: 9, fontWeight: 800, color: NP.text3, letterSpacing: 0.5,
            borderBottom: `1px solid ${NP.line}`,
          }}>
            <div>구분</div><div style={{ textAlign: 'right' }}>G</div><div style={{ textAlign: 'right' }}>AVG</div><div style={{ textAlign: 'right' }}>HR</div><div style={{ textAlign: 'right' }}>OPS</div>
          </div>
          {splits.map((s, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1.2fr 0.6fr 0.8fr 0.6fr 0.8fr',
              padding: '10px 12px', fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
              borderBottom: i < splits.length - 1 ? `1px solid ${waP('#fff', 0.04)}` : 'none',
            }}>
              <div style={{ fontWeight: 700, color: NP.text1 }}>{s.l}</div>
              <div style={{ textAlign: 'right', color: NP.text3 }}>{s.g}</div>
              <div style={{ textAlign: 'right', color: NP.text1, fontWeight: 700 }}>{s.avg}</div>
              <div style={{ textAlign: 'right', color: NP.text2 }}>{s.hr}</div>
              <div style={{ textAlign: 'right', color: palette.accent, fontWeight: 700 }}>{s.ops}</div>
            </div>
          ))}
        </div>
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 4) Game log

function ScreenPlayerGameLog({ team, palette }) {
  const p = palette.isNeutral ? PLAYERS.gu_gim : PLAYERS.ja_choi;
  const games = [
    { date: '09.24', opp: 'kt', home: false, r: 'L 3-5', ab: 4, h: 2, hr: 1, rbi: 2, avg: '.342', good: true },
    { date: '09.23', opp: 'kt', home: false, r: 'W 7-4', ab: 5, h: 3, hr: 0, rbi: 1, avg: '.338', good: true },
    { date: '09.22', opp: 'kt', home: false, r: 'L 2-6', ab: 4, h: 0, hr: 0, rbi: 0, avg: '.330' },
    { date: '09.21', opp: 'samsung', home: true, r: 'W 8-2', ab: 5, h: 2, hr: 1, rbi: 3, avg: '.334', good: true },
    { date: '09.20', opp: 'samsung', home: true, r: 'W 5-1', ab: 4, h: 1, hr: 0, rbi: 1, avg: '.328' },
    { date: '09.19', opp: 'samsung', home: true, r: 'L 3-7', ab: 4, h: 2, hr: 0, rbi: 0, avg: '.326', good: true },
    { date: '09.17', opp: 'lg', home: false, r: 'W 6-3', ab: 3, h: 1, hr: 0, rbi: 2, avg: '.321' },
    { date: '09.16', opp: 'lg', home: false, r: 'L 2-4', ab: 4, h: 0, hr: 0, rbi: 0, avg: '.318' },
  ];

  return (
    <>
      <StatusBar tint={NP.text1}/>
      <PhoneHeader title={`${p.name} · 경기별`}/>

      <ChipTabs tabs={['개요', '스탯', '경기별', '응원글', '커리어']} active="경기별" palette={palette}/>

      {/* Recent summary */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          borderRadius: 14, padding: '12px 14px',
          background: `linear-gradient(135deg, ${waP(palette.base, 0.12)}, ${NP.bg2} 85%)`,
          border: `1px solid ${waP(palette.base, 0.22)}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: palette.accent, letterSpacing: 1, textTransform: 'uppercase' }}>최근 10경기</span>
            <span style={{ fontSize: 10, color: NP.text3 }}>타율 .412 · HR 4</span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {['H','H','H','0','H','H','0','H','H','H'].map((r, i) => (
              <div key={i} style={{
                flex: 1, height: 24, borderRadius: 4,
                background: r === 'H' ? waP(palette.base, 0.7) : waP(NP.text4, 0.35),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 9, fontWeight: 800, color: r === 'H' ? '#fff' : NP.text3,
              }}>{r}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Game log table */}
      <div style={{ padding: '0 16px' }}>
        <div style={{
          background: NP.bg2, borderRadius: 14, border: `1px solid ${NP.line}`, overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '0.9fr 1.1fr 0.85fr 0.4fr 0.4fr 0.4fr 0.5fr 0.7fr',
            padding: '8px 10px', fontSize: 8.5, fontWeight: 800, color: NP.text3, letterSpacing: 0.3,
            borderBottom: `1px solid ${NP.line}`,
          }}>
            <div>날짜</div><div>상대</div><div>결과</div>
            <div style={{ textAlign: 'right' }}>AB</div>
            <div style={{ textAlign: 'right' }}>H</div>
            <div style={{ textAlign: 'right' }}>HR</div>
            <div style={{ textAlign: 'right' }}>타점</div>
            <div style={{ textAlign: 'right' }}>AVG</div>
          </div>
          {games.map((g, i) => {
            const opp = TP[g.opp];
            const w = g.r.startsWith('W');
            return (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: '0.9fr 1.1fr 0.85fr 0.4fr 0.4fr 0.4fr 0.5fr 0.7fr',
                padding: '8px 10px', fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
                alignItems: 'center',
                borderBottom: i < games.length - 1 ? `1px solid ${waP('#fff', 0.04)}` : 'none',
                background: g.good ? waP(palette.base, 0.05) : 'transparent',
              }}>
                <div style={{ color: NP.text3, fontWeight: 700 }}>{g.date}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 8, color: NP.text4 }}>{g.home ? '' : '@'}</span>
                  <TeamLogo team={opp} size={14}/>
                  <span style={{ color: NP.text1, fontWeight: 600 }}>{opp.short}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    fontSize: 8.5, fontWeight: 900,
                    padding: '1px 4px', borderRadius: 3,
                    background: waP(w ? NP.win : NP.text4, 0.2),
                    color: w ? NP.win : NP.text3,
                  }}>{w ? 'W' : 'L'}</span>
                  <span style={{ color: NP.text3, fontSize: 9.5 }}>{g.r.slice(2)}</span>
                </div>
                <div style={{ textAlign: 'right', color: NP.text2 }}>{g.ab}</div>
                <div style={{ textAlign: 'right', color: g.h > 0 ? NP.text1 : NP.text4, fontWeight: 700 }}>{g.h}</div>
                <div style={{ textAlign: 'right', color: g.hr > 0 ? palette.accent : NP.text4, fontWeight: g.hr > 0 ? 800 : 400 }}>{g.hr || '-'}</div>
                <div style={{ textAlign: 'right', color: NP.text2 }}>{g.rbi || '-'}</div>
                <div style={{ textAlign: 'right', color: NP.text1, fontWeight: 700 }}>{g.avg}</div>
              </div>
            );
          })}
        </div>
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 5) Compare

function ScreenPlayerCompare({ team, palette }) {
  const pA = PLAYERS.gu_gim;
  const pB = PLAYERS.ja_choi;
  const tA = TP[pA.team], tB = TP[pB.team];

  const rows = [
    { l: '타율',  a: 0.341, b: 0.289, af: pA.avg, bf: pB.avg, max: 0.4,  higher: 'a' },
    { l: 'HR',    a: pA.hr, b: pB.hr, af: pA.hr, bf: pB.hr, max: 45,    higher: 'a' },
    { l: 'RBI',   a: pA.rbi, b: pB.rbi, af: pA.rbi, bf: pB.rbi, max: 120, higher: 'a' },
    { l: 'OPS',   a: 1.067, b: 0.910, af: pA.ops, bf: pB.ops, max: 1.2, higher: 'a' },
    { l: 'WAR',   a: pA.war, b: pB.war, af: pA.war, bf: pB.war, max: 10, higher: 'a' },
    { l: '도루',  a: pA.sb, b: pB.sb, af: pA.sb, bf: pB.sb, max: 40,    higher: 'a' },
  ];

  return (
    <>
      <StatusBar tint={NP.text1}/>
      <PhoneHeader title="선수 비교" right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 4v16M17 9l-5-5-5 5M7 15l5 5 5-5" stroke={NP.text2} strokeWidth="1.6"/>
        </svg>
      }/>

      {/* Twin hero */}
      <div style={{ padding: '0 12px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {[{p: pA, t: tA}, {p: pB, t: tB}].map((x, i) => (
          <div key={i} style={{
            borderRadius: 16, padding: '14px 12px',
            background: `linear-gradient(160deg, ${waP(x.t.primary, 0.45)}, ${waP(x.t.primary, 0.1)} 80%)`,
            border: `1px solid ${waP(x.t.primary, 0.4)}`,
            position: 'relative', overflow: 'hidden',
          }}>
            <div style={{
              position: 'absolute', top: -10, right: -15,
              fontSize: 84, fontWeight: 900, color: waP(x.t.primary, 0.3),
              letterSpacing: -3, lineHeight: 1, pointerEvents: 'none',
            }}>{x.p.no}</div>
            <TeamLogo team={x.t} size={22}/>
            <div style={{ marginTop: 24, position: 'relative' }}>
              <div style={{ fontSize: 18, fontWeight: 900, color: NP.text1, letterSpacing: -0.5 }}>{x.p.name}</div>
              <div style={{ fontSize: 10, color: NP.text3, marginTop: 2 }}>{x.t.short} · {x.p.pos}</div>
            </div>
          </div>
        ))}
      </div>

      {/* VS divider */}
      <div style={{ position: 'relative', textAlign: 'center', padding: '0 0 4px' }}>
        <div style={{
          display: 'inline-block', padding: '3px 12px',
          background: NP.bg0, border: `1px solid ${NP.line}`,
          borderRadius: 999, fontSize: 10, fontWeight: 900, color: palette.accent, letterSpacing: 1,
        }}>VS</div>
      </div>

      {/* Compare rows */}
      <div style={{ padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map((r, i) => {
          const aPct = (r.a / r.max) * 100;
          const bPct = (r.b / r.max) * 100;
          const aWin = r.higher === 'a' ? r.a > r.b : r.a < r.b;
          return (
            <div key={i}>
              {/* values */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8,
                marginBottom: 4,
              }}>
                <div style={{ textAlign: 'right', fontSize: 14, fontWeight: aWin ? 900 : 700, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3, color: aWin ? tA.light : NP.text2 }}>
                  {r.af}
                </div>
                <div style={{ fontSize: 9, fontWeight: 800, color: NP.text3, letterSpacing: 0.5, textTransform: 'uppercase' }}>{r.l}</div>
                <div style={{ textAlign: 'left', fontSize: 14, fontWeight: !aWin ? 900 : 700, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3, color: !aWin ? tB.light : NP.text2 }}>
                  {r.bf}
                </div>
              </div>
              {/* twin bars meeting in middle */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3, alignItems: 'center' }}>
                <div style={{ height: 5, background: waP('#fff', 0.05), borderRadius: 2, overflow: 'hidden', display: 'flex', justifyContent: 'flex-end' }}>
                  <div style={{ width: `${aPct}%`, height: '100%', background: tA.light, borderRadius: 2 }}/>
                </div>
                <div style={{ height: 5, background: waP('#fff', 0.05), borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${bPct}%`, height: '100%', background: tB.light, borderRadius: 2 }}/>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Verdict card */}
      <div style={{ padding: '14px 16px 0' }}>
        <div style={{
          borderRadius: 12, padding: '10px 12px',
          background: NP.bg2, border: `1px solid ${NP.line}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: waP(palette.base, 0.22), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 }}>👑</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 10.5, fontWeight: 800, color: NP.text2, letterSpacing: -0.2 }}>
              6개 지표 중 <b style={{ color: tA.light }}>{pA.name} 우세 6개</b>
            </div>
            <div style={{ fontSize: 9.5, color: NP.text3, marginTop: 1 }}>올시즌 MVP 레이스 선두</div>
          </div>
        </div>
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 6) Player fan board

function ScreenPlayerBoard({ team, palette }) {
  const p = palette.isNeutral ? PLAYERS.gu_gim : PLAYERS.ja_choi;
  const playerTeam = TP[p.team];

  const posts = [
    { badge: '🏆', title: '김도영 오늘 멀티 홈런! 축하합니다!',    name: '광주아재', lvl: 41, time: '3분 전',  cmt: 87, like: 412 },
    { badge: null, title: '김도영 타격 폼 분석 - 미세한 변화',     name: '야구분석', lvl: 67, time: '22분 전', cmt: 45, like: 128 },
    { badge: null, title: '내년에 MLB 진출할까요? 진심 걱정...',    name: '타이거즈',  lvl: 19, time: '1시간', cmt: 234, like: 98 },
    { badge: null, title: '[직관] 오늘 홈런 공 받은 사람 있다!',    name: '직관왕',    lvl: 28, time: '2시간', cmt: 56, like: 201 },
  ];

  return (
    <>
      <StatusBar tint={NP.text1}/>
      <PhoneHeader title={`${p.name} 응원글`}/>

      {/* Player mini-hero */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          borderRadius: 14, padding: 14,
          background: `linear-gradient(135deg, ${waP(playerTeam.primary, 0.45)}, ${waP(playerTeam.primary, 0.1)} 80%)`,
          border: `1px solid ${waP(playerTeam.primary, 0.4)}`,
          display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'center',
        }}>
          <div style={{
            width: 48, height: 48, borderRadius: 12,
            background: waP('#000', 0.35), backdropFilter: 'blur(8px)',
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 8, fontWeight: 700, color: waP('#fff', 0.7), letterSpacing: 0.5 }}>NO.</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#fff', letterSpacing: -0.5, lineHeight: 1 }}>{p.no}</div>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 900, color: NP.text1, letterSpacing: -0.4 }}>{p.name}</div>
            <div style={{ fontSize: 10, color: NP.text2, marginTop: 2 }}>{playerTeam.short} · {p.pos}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: NP.text3, fontWeight: 700, marginBottom: 2 }}>팬 수</div>
            <div style={{ fontSize: 14, fontWeight: 900, color: NP.text1, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.3 }}>12.4k</div>
          </div>
        </div>
      </div>

      <ChipTabs tabs={['개요', '스탯', '경기별', '응원글', '커리어']} active="응원글" palette={palette}/>

      {/* Cheer composer shortcut */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          padding: '10px 12px', borderRadius: 12,
          background: NP.bg2, border: `1px dashed ${waP(palette.base, 0.3)}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ width: 22, height: 22, borderRadius: '50%', background: waP(palette.base, 0.25), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 12 }}>📣</span>
          </div>
          <span style={{ fontSize: 11, color: NP.text3 }}>{p.name} 선수에게 응원 메시지를 남겨보세요</span>
          <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: palette.accent }}>+ 글쓰기</span>
        </div>
      </div>

      {/* Posts */}
      <div style={{ padding: '0 16px' }}>
        {posts.map((p, i) => (
          <div key={i} style={{
            padding: '12px 0',
            borderBottom: i < posts.length - 1 ? `1px solid ${NP.line}` : 'none',
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: NP.text1, letterSpacing: -0.3, lineHeight: 1.4 }}>
              {p.badge && <span style={{ marginRight: 4 }}>{p.badge}</span>}
              {p.title}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 10, color: NP.text3 }}>
              <span style={{ fontWeight: 700, color: playerTeam.light }}>{p.name}</span>
              <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: waP(palette.base, 0.18), color: palette.accent }}>Lv.{p.lvl}</span>
              <span style={{ color: NP.text4 }}>·</span>
              <span>{p.time}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontVariantNumeric: 'tabular-nums' }}>
                <span>💬 {p.cmt}</span>
                <span>❤ {p.like}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

Object.assign(window, {
  ScreenPlayerList,
  ScreenPlayerProfile,
  ScreenPlayerStats,
  ScreenPlayerGameLog,
  ScreenPlayerCompare,
  ScreenPlayerBoard,
  PLAYERS,
});
