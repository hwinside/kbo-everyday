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

// Portrait silhouette placeholder — stylized baseball cap + shoulders in team color
function PlayerPortrait({ team, size = 180 }) {
  // Cap color = team primary, subtle gradient background
  return (
    <svg width={size} height={size * 1.15} viewBox="0 0 180 210" style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`pp-${team.slug}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={waP(team.primary, 0.12)}/>
          <stop offset="1" stopColor="transparent"/>
        </linearGradient>
        <clipPath id={`pp-${team.slug}-clip`}>
          <rect x="10" y="10" width="160" height="200" rx="12"/>
        </clipPath>
      </defs>
      <g clipPath={`url(#pp-${team.slug}-clip)`}>
        <rect x="10" y="10" width="160" height="200" fill={`url(#pp-${team.slug}-bg)`}/>
        {/* Shoulders / jersey */}
        <path d="M 25 210 Q 30 150 60 140 L 120 140 Q 150 150 155 210 Z"
              fill={waP(team.primary, 0.85)}/>
        {/* Neck */}
        <rect x="78" y="120" width="24" height="30" fill={waP('#E4B590', 0.9)}/>
        {/* Head */}
        <ellipse cx="90" cy="95" rx="32" ry="38" fill="#E4B590"/>
        {/* Jaw shadow */}
        <path d="M 62 95 Q 64 125 90 133 Q 116 125 118 95" fill={waP('#000', 0.12)}/>
        {/* Ears */}
        <ellipse cx="59" cy="98" rx="5" ry="8" fill="#D9A27F"/>
        <ellipse cx="121" cy="98" rx="5" ry="8" fill="#D9A27F"/>
        {/* Cap base */}
        <path d="M 56 78 Q 60 55 90 52 Q 120 55 124 78 L 124 85 L 56 85 Z" fill={team.primary}/>
        <path d="M 56 78 Q 60 55 90 52 Q 120 55 124 78 L 124 85 L 56 85 Z" fill="none" stroke={team.light} strokeWidth="0.5" opacity="0.6"/>
        {/* Cap brim */}
        <path d="M 54 82 L 140 82 Q 140 88 136 90 L 54 90 Z" fill={waP('#000', 0.7)}/>
        {/* Cap logo area */}
        <circle cx="88" cy="72" r="8" fill={waP('#fff', 0.15)}/>
        <text x="88" y="76" textAnchor="middle" fontSize="11" fontWeight="900" fill="#fff" fontFamily="system-ui">{team.short[0]}</text>
        {/* Eye hints */}
        <ellipse cx="78" cy="99" rx="2.5" ry="1.5" fill="#3a2d22"/>
        <ellipse cx="102" cy="99" rx="2.5" ry="1.5" fill="#3a2d22"/>
        {/* Stubble / beard hint */}
        <path d="M 68 113 Q 90 125 112 113 Q 110 125 90 128 Q 70 125 68 113" fill={waP('#3a2d22', 0.55)}/>
        {/* Jersey collar V */}
        <path d="M 70 140 L 90 155 L 110 140" fill="none" stroke={waP('#fff', 0.3)} strokeWidth="1"/>
      </g>
    </svg>
  );
}

function ScreenPlayerProfile({ team, palette }) {
  // Always show the team's star — or KIA's Kim Do-young when neutral
  const p = palette.isNeutral ? PLAYERS.gu_gim : (
    team.slug === 'hanwha' ? PLAYERS.do_mun :
    team.slug === 'samsung' ? PLAYERS.ta_won :
    team.slug === 'kia' ? PLAYERS.gu_gim :
    team.slug === 'ssg' ? PLAYERS.ja_choi :
    team.slug === 'kt' ? PLAYERS.bh_park :
    team.slug === 'lg' ? { name: '오스틴', pos: '내야수', team: 'lg', no: 23, avg: '.358', hr: 5, h: 24 } :
    PLAYERS.gu_gim
  );
  const playerTeam = TP[p.team];
  const isPitcher = p.pos === 'SP' || p.pos === 'RP' || p.pos === 'CP';

  // Real stats for hero right column
  const heroStats = isPitcher ? [
    { l: '방어', v: p.era },
    { l: '승',   v: p.w },
    { l: 'K',    v: p.k },
  ] : [
    { l: '타율', v: p.avg },
    { l: '홈런', v: p.hr },
    { l: '안타', v: p.h || '126' },
  ];

  return (
    <>
      <StatusBar tint={NP.text1}/>

      {/* Header — matches reference design */}
      <div style={{
        height: 44, padding: '0 14px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke={NP.text1} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <div style={{ fontSize: 17, fontWeight: 800, color: NP.text1, letterSpacing: -0.3 }}>선수</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M4 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H9l-4 4V5z" stroke={NP.text1} strokeWidth="1.8" strokeLinejoin="round"/>
          </svg>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M12 3l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 17l-5.6 3 1.5-6.3L3 9.5 9.4 9z" fill="#FFB23F"/>
          </svg>
        </div>
      </div>

      {/* Ad banner placeholder — preserved per reference */}
      <div style={{ padding: '4px 12px 8px' }}>
        <div style={{
          height: 36, borderRadius: 4,
          background: waP('#000', 0.35),
          border: `1px dashed ${waP('#fff', 0.1)}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, color: NP.text4, letterSpacing: 0.5,
        }}>AD</div>
      </div>

      {/* Hero — reference layout */}
      <div style={{
        padding: '4px 14px 10px',
        position: 'relative',
        borderLeft: `3px solid ${playerTeam.light}`,
        marginLeft: 14, paddingLeft: 12,
      }}>
        <div style={{
          display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10,
          alignItems: 'stretch',
        }}>
          {/* Left: team + name + number + pos */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingRight: 4 }}>
            <div>
              <div style={{
                display: 'inline-block',
                fontSize: 11, fontWeight: 800, color: playerTeam.light,
                letterSpacing: 0.3, marginBottom: 2,
              }}>{playerTeam.short}</div>
              <div style={{ fontSize: 34, fontWeight: 900, color: NP.text1, letterSpacing: -1.5, lineHeight: 1, marginBottom: 10 }}>
                {p.name}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: NP.text2, letterSpacing: -0.3, fontVariantNumeric: 'tabular-nums', marginBottom: 2 }}>#{p.no}</div>
              <div style={{ fontSize: 12, color: NP.text3, letterSpacing: -0.2 }}>{p.pos === 'SP' ? '투수' : (p.pos.includes('B') ? '내야수' : p.pos === 'C' ? '포수' : p.pos)}</div>
            </div>
          </div>

          {/* Middle: portrait */}
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end', marginBottom: -10 }}>
            <PlayerPortrait team={playerTeam} size={140}/>
          </div>

          {/* Right: stats column */}
          <div style={{
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            paddingLeft: 4, textAlign: 'right',
          }}>
            {heroStats.map((s, i) => (
              <div key={i}>
                <div style={{ fontSize: 11, fontWeight: 600, color: NP.text3, marginBottom: 1 }}>{s.l}</div>
                <div style={{
                  fontSize: i === 0 ? 26 : 20,
                  fontWeight: 900, color: NP.text1,
                  letterSpacing: -0.8, lineHeight: 1,
                  fontVariantNumeric: 'tabular-nums',
                  marginBottom: 6,
                }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Icon tabs — reference style */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        borderBottom: `1px solid ${NP.line}`, marginTop: 6,
      }}>
        {[
          { l: '선수정보', i: '⚾', active: true },
          { l: '사진',     i: '📸' },
          { l: '최신글',   i: '📝' },
          { l: '인기글',   i: '🔥' },
        ].map((t, i) => (
          <div key={i} style={{
            padding: '10px 4px 8px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            borderBottom: t.active ? `2px solid ${NP.live}` : '2px solid transparent',
            marginBottom: -1,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 13 }}>{t.i}</span>
              <span style={{
                fontSize: 12, fontWeight: t.active ? 800 : 600,
                color: t.active ? NP.text1 : NP.text3,
                letterSpacing: -0.2,
              }}>{t.l}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Radar chart — ability spider */}
      <div style={{ padding: '14px 16px 6px', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 14, right: 20 }}>
          <div style={{ width: 18, height: 18, borderRadius: '50%', border: `1px solid ${NP.text3}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, color: NP.text3, fontWeight: 700 }}>i</div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <RadarChart
            labels={['타격', '파워', '선구안', '주루', '안정감', '출루']}
            player={[85, 78, 72, 45, 68, 82]}
            league={[60, 55, 58, 55, 60, 58]}
            color={palette.accent}
            leagueColor={waP('#fff', 0.25)}
          />
        </div>
        <div style={{ textAlign: 'center', fontSize: 10, color: NP.text3, marginTop: 6 }}>
          점선 = 리그 평균 기준
        </div>
      </div>

      {/* Trait chips */}
      <div style={{ padding: '8px 16px 14px', display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'center' }}>
        {[
          { i: '💪', l: '파워히터', v: `${p.hr || 5}홈런` },
          { i: '🎯', l: '방망이장인', v: `타율 ${p.avg || '.358'}` },
        ].map((c, i) => (
          <div key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '6px 12px', borderRadius: 999,
            background: NP.bg2, border: `1px solid ${NP.line}`,
          }}>
            <span style={{ fontSize: 13 }}>{c.i}</span>
            <span style={{ fontSize: 11.5, fontWeight: 800, color: NP.text1, letterSpacing: -0.2 }}>{c.l}</span>
            <span style={{ fontSize: 10, color: NP.text3, fontVariantNumeric: 'tabular-nums' }}>{c.v}</span>
          </div>
        ))}
      </div>

      <TabBar active="players" palette={palette}/>
    </>
  );
}

// Radar chart — hex with player polygon + league reference
function RadarChart({ labels, player, league, color, leagueColor }) {
  const size = 200;
  const cx = size / 2, cy = size / 2 + 6;
  const radius = 68;
  const n = labels.length;

  const pointAt = (i, r) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
  };

  const buildPoly = (values, maxVal = 100) => {
    return values.map((v, i) => {
      const r = (v / maxVal) * radius;
      return pointAt(i, r).join(',');
    }).join(' ');
  };

  return (
    <svg width={size} height={size + 30} viewBox={`0 0 ${size} ${size + 30}`}>
      {/* Grid rings */}
      {[0.25, 0.5, 0.75, 1].map((scale, si) => (
        <polygon key={si}
          points={Array.from({ length: n }).map((_, i) => pointAt(i, radius * scale).join(',')).join(' ')}
          fill="none"
          stroke={waP('#fff', 0.08)}
          strokeWidth="1"
          strokeDasharray={scale === 1 ? '0' : '2 3'}
        />
      ))}
      {/* Spokes */}
      {Array.from({ length: n }).map((_, i) => (
        <line key={i}
          x1={cx} y1={cy}
          x2={pointAt(i, radius)[0]} y2={pointAt(i, radius)[1]}
          stroke={waP('#fff', 0.05)} strokeWidth="1"
        />
      ))}
      {/* League reference (dashed) */}
      <polygon points={buildPoly(league)}
        fill="none" stroke={leagueColor} strokeWidth="1.3"
        strokeDasharray="3 3"
      />
      {/* Player polygon */}
      <polygon points={buildPoly(player)}
        fill={waP(color, 0.25)}
        stroke={color} strokeWidth="1.8"
      />
      {/* Player dots */}
      {player.map((v, i) => {
        const [x, y] = pointAt(i, (v / 100) * radius);
        return <circle key={i} cx={x} cy={y} r="3" fill={color} stroke={NP.bg0} strokeWidth="1.5"/>;
      })}
      {/* Labels */}
      {labels.map((label, i) => {
        const [x, y] = pointAt(i, radius + 14);
        return (
          <text key={i} x={x} y={y}
            textAnchor="middle" dominantBaseline="middle"
            fontSize="10" fontWeight="700" fill={NP.text2}
            fontFamily="system-ui"
          >{label}</text>
        );
      })}
    </svg>
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
