/* ===== screens-game.jsx ===== */
// Game-related screens: schedule list, game detail tabs (preview / live / lineup / timeline / chat / predict)
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, Pips, Diamond

const { NEUTRAL: NG, withAlpha: waG, TEAMS: TG } = window.KBO;

// ─────────────────────────── shared bits for this section

function PhoneHeader({ title, back = true, right }) {
  return (
    <div style={{
      height: 44, padding: '0 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      position: 'relative', zIndex: 20,
    }}>
      {back ? (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke={NG.text1} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      ) : <div style={{ width: 24 }}/>}
      <div style={{ fontSize: 16, fontWeight: 700, color: NG.text1, letterSpacing: -0.3 }}>{title}</div>
      <div style={{ width: 24 }}>{right}</div>
    </div>
  );
}

function ChipTabs({ tabs, active, palette }) {
  return (
    <div style={{
      padding: '4px 16px 12px', display: 'flex', gap: 6,
      overflow: 'hidden',
    }}>
      {tabs.map(t => {
        const on = t === active;
        return (
          <div key={t} style={{
            padding: '7px 14px', borderRadius: 999,
            fontSize: 12, fontWeight: 700, letterSpacing: -0.2,
            background: on ? palette.accent : NG.bg2,
            color: on ? palette.onAccent : NG.text2,
            border: on ? 'none' : `1px solid ${NG.line}`,
            whiteSpace: 'nowrap',
          }}>{t}</div>
        );
      })}
    </div>
  );
}

// ─────────────────────────── 1) Schedule list

function ScreenGameSchedule({ team, palette }) {
  const today = [
    { away: 'ssg', home: 'kt',      status: 'live',   inning: '9회말', aS: 3, hS: 5, venue: '수원' },
    { away: 'lg',  home: 'doosan',  status: 'live',   inning: '6회초', aS: 4, hS: 2, venue: '잠실' },
    { away: 'kia', home: 'samsung', status: 'final',  meta: '종료',      aS: 7, hS: 4, venue: '대구' },
    { away: 'nc',  home: 'lotte',   status: 'sched',  time: '18:30',     venue: '사직' },
    { away: 'hanwha', home: 'kiwoom', status: 'sched', time: '18:30',    venue: '고척' },
  ];

  // Build date row (today ±3)
  const dates = [
    { d: 22, w: '목', past: true },
    { d: 23, w: '금', past: true },
    { d: 24, w: '토', today: true },
    { d: 25, w: '일' },
    { d: 26, w: '월' },
    { d: 27, w: '화' },
    { d: 28, w: '수' },
  ];

  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title="경기 일정" right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="6.5" stroke={NG.text2} strokeWidth="1.6"/>
          <path d="M16 16l4 4" stroke={NG.text2} strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      }/>

      {/* Date strip */}
      <div style={{ padding: '6px 16px 16px', display: 'flex', gap: 6 }}>
        {dates.map((x, i) => (
          <div key={i} style={{
            flex: 1, aspectRatio: '1/1.15',
            borderRadius: 14,
            background: x.today ? palette.accent : NG.bg2,
            border: x.today ? 'none' : `1px solid ${NG.line}`,
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            opacity: x.past ? 0.45 : 1,
          }}>
            <div style={{
              fontSize: 9, fontWeight: 700, letterSpacing: 0.6,
              color: x.today ? waG(palette.onAccent, 0.7) : NG.text3,
              marginBottom: 2,
            }}>{x.w}</div>
            <div style={{
              fontSize: 17, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
              color: x.today ? palette.onAccent : NG.text1,
              letterSpacing: -0.5,
            }}>{x.d}</div>
          </div>
        ))}
      </div>

      {/* Game cards */}
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {today.map((g, i) => {
          const away = TG[g.away], home = TG[g.home];
          const isLive = g.status === 'live';
          const final = g.status === 'final';
          const winHome = final && g.hS > g.aS;
          const winAway = final && g.aS > g.hS;
          return (
            <div key={i} style={{
              borderRadius: 18,
              background: isLive
                ? `linear-gradient(135deg, ${waG(palette.base, 0.14)} 0%, ${NG.bg2} 60%)`
                : NG.bg2,
              border: `1px solid ${isLive ? waG(palette.base, 0.35) : NG.line}`,
              padding: '14px 16px',
              position: 'relative', overflow: 'hidden',
            }}>
              {/* status strip */}
              <div style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', marginBottom: 12,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {isLive && (
                    <>
                      <div style={{ width: 5, height: 5, borderRadius: '50%', background: NG.live, boxShadow: `0 0 6px ${NG.live}` }}/>
                      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: NG.live, textTransform: 'uppercase' }}>LIVE · {g.inning}</span>
                    </>
                  )}
                  {final && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: NG.text3, textTransform: 'uppercase' }}>종료</span>}
                  {g.status === 'sched' && <span style={{ fontSize: 11, fontWeight: 800, color: NG.text1, fontVariantNumeric: 'tabular-nums' }}>{g.time}</span>}
                </div>
                <div style={{ fontSize: 10, fontWeight: 600, color: NG.text3 }}>{g.venue}</div>
              </div>

              {/* score row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <TeamLogo team={away} size={36}/>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: winAway ? NG.text1 : NG.text2 }}>{away.short}</div>
                    {g.status !== 'sched' && (
                      <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -1, color: winAway ? palette.accent : NG.text1 }}>{g.aS}</div>
                    )}
                  </div>
                </div>

                <div style={{ fontSize: 11, fontWeight: 700, color: NG.text3 }}>VS</div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: winHome ? NG.text1 : NG.text2 }}>{home.short}</div>
                    {g.status !== 'sched' && (
                      <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums', letterSpacing: -1, color: winHome ? palette.accent : NG.text1 }}>{g.hS}</div>
                    )}
                  </div>
                  <TeamLogo team={home} size={36}/>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 2) Game detail — preview

function ScreenGamePreview({ team, palette }) {
  const away = palette.isNeutral ? TG.ssg : team;
  const home = palette.isNeutral ? TG.kt : TG.doosan;
  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title={`${away.short} vs ${home.short}`} right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 4v10m0 0l-4-4m4 4l4-4M6 20h12" stroke={NG.text2} strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      }/>

      {/* Hero — scheduled */}
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{
          borderRadius: 20,
          background: `linear-gradient(155deg, ${palette.heroBgA} 0%, ${palette.heroBgB} 100%)`,
          border: `1px solid ${waG(palette.base, 0.25)}`,
          padding: 18, position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, color: palette.accent, textTransform: 'uppercase', marginBottom: 4 }}>오늘 · 18:30</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: NG.text2 }}>잠실 · 맑음 · 22°C</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <TeamLogo team={away} size={56} pad={6}/>
              <div style={{ fontSize: 14, fontWeight: 800, color: NG.text1 }}>{away.short}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>52승 34패 .605</div>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: NG.text3, letterSpacing: -1 }}>VS</div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <TeamLogo team={home} size={56} pad={6}/>
              <div style={{ fontSize: 14, fontWeight: 800, color: NG.text1 }}>{home.short}</div>
              <div style={{ fontSize: 10, fontWeight: 600, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>48승 40패 .545</div>
            </div>
          </div>

          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${waG(palette.base, 0.18)}` }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: NG.text3, textTransform: 'uppercase', marginBottom: 8 }}>선발 투수</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: waG(away.primary, 0.2), border: `1px solid ${waG(away.primary, 0.35)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: NG.text1 }}>SP</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: NG.text1 }}>문동주</div>
                  <div style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>ERA 2.48 · 10승 4패</div>
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: NG.text1 }}>원태인</div>
                  <div style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>ERA 3.15 · 12승 6패</div>
                </div>
                <div style={{ width: 28, height: 28, borderRadius: '50%', background: waG(home.primary, 0.2), border: `1px solid ${waG(home.primary, 0.35)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: NG.text1 }}>SP</div>
                </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <ChipTabs tabs={['프리뷰', '라인업', '경기', '채팅', '예측']} active="프리뷰" palette={palette}/>

      {/* AI preview card */}
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{
          borderRadius: 16, padding: 14,
          background: NG.bg2, border: `1px solid ${NG.line}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: palette.accent, letterSpacing: 1, textTransform: 'uppercase' }}>AI 프리뷰</div>
            <div style={{ fontSize: 9, color: NG.text4 }}>· 24초 전 업데이트</div>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.7, color: NG.text2 }}>
            오늘 맞대결은 <b style={{ color: NG.text1 }}>문동주</b>의 커맨드 회복 여부가 관건입니다.
            지난 3경기 평균 구속이 150km/h대로 올라왔고, 잠실 원정에서 ERA 2.10으로 좋은 기록을 보이고 있습니다.
            <br/><br/>
            홈팀은 최근 5경기 타율이 <b style={{ color: palette.accent }}>.298</b>로 반등세입니다.
          </div>
        </div>
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 3) Live scoreboard (enhanced)

function ScreenGameLive({ team, palette }) {
  const away = palette.isNeutral ? TG.ssg : team;
  const home = palette.isNeutral ? TG.kt : TG.doosan;
  const aS = 3, hS = 5;
  const isTop = false;
  const inning = '9회말';

  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title={`${away.short} vs ${home.short}`}
        right={<div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: NG.live, boxShadow: `0 0 6px ${NG.live}` }}/>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: NG.live }}>LIVE</span>
        </div>}
      />

      {/* Inning pill */}
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase',
          padding: '4px 10px', borderRadius: 999,
          background: waG(palette.base, 0.15), color: palette.accent,
        }}>{inning}</span>
      </div>

      {/* Big score */}
      <div style={{ padding: '0 16px', display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 10, alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: isTop ? 1 : 0.6 }}>
          <TeamLogo team={away} size={36}/>
          <div style={{ fontSize: 11, fontWeight: 700, color: NG.text3 }}>{away.short}</div>
          <div style={{ fontSize: 52, fontWeight: 900, letterSpacing: -2, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: NG.text1 }}>{aS}</div>
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: NG.text3 }}>:</div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, opacity: isTop ? 0.6 : 1 }}>
          <TeamLogo team={home} size={36}/>
          <div style={{ fontSize: 11, fontWeight: 700, color: NG.text3 }}>{home.short}</div>
          <div style={{ fontSize: 52, fontWeight: 900, letterSpacing: -2, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: NG.text1 }}>{hS}</div>
        </div>
      </div>

      {/* Linescore table */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ background: NG.bg2, borderRadius: 12, border: `1px solid ${NG.line}`, padding: '10px 6px', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '50px repeat(9, 1fr) 28px 28px 28px', fontSize: 10, color: NG.text3, fontWeight: 700, padding: '0 4px 6px', borderBottom: `1px solid ${NG.line}`, fontVariantNumeric: 'tabular-nums', textAlign: 'center' }}>
            <div style={{ textAlign: 'left' }}></div>
            {[1,2,3,4,5,6,7,8,9].map(n => <div key={n}>{n}</div>)}
            <div style={{ color: NG.text2 }}>R</div>
            <div>H</div>
            <div>E</div>
          </div>
          {[
            { name: away.short, color: away.light, runs: [0,0,1,0,0,2,0,0,0], R: 3, H: 7, E: 1 },
            { name: home.short, color: home.light, runs: [0,1,0,0,2,0,0,1,1], R: 5, H: 9, E: 0 },
          ].map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '50px repeat(9, 1fr) 28px 28px 28px', fontSize: 12, color: NG.text1, fontWeight: 600, padding: '7px 4px 0', fontVariantNumeric: 'tabular-nums', textAlign: 'center', alignItems: 'center' }}>
              <div style={{ textAlign: 'left', fontWeight: 800, color: r.color }}>{r.name}</div>
              {r.runs.map((n, j) => <div key={j} style={{ color: n > 0 ? NG.text1 : NG.text4 }}>{n}</div>)}
              <div style={{ color: palette.accent, fontWeight: 800 }}>{r.R}</div>
              <div style={{ color: NG.text2 }}>{r.H}</div>
              <div style={{ color: NG.text3 }}>{r.E}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Field + BSO */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ background: NG.bg2, borderRadius: 16, border: `1px solid ${NG.line}`, padding: 14, display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, alignItems: 'center' }}>
          <Diamond r1={true} r2={false} r3={true} color={palette.accent} size={60}/>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[
              { l: 'B', n: 2, t: 4, c: NG.win },
              { l: 'S', n: 1, t: 3, c: NG.warn },
              { l: 'O', n: 1, t: 3, c: NG.live },
            ].map((x, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: NG.text3, width: 10 }}>{x.l}</span>
                <Pips filled={x.n} total={x.t} color={x.c}/>
              </div>
            ))}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: NG.text3, letterSpacing: 0.5, marginBottom: 1 }}>주자</div>
            <div style={{ fontSize: 12, fontWeight: 700, color: NG.text1 }}>1루·3루</div>
          </div>
        </div>
      </div>

      {/* Pitcher-batter matchup */}
      <div style={{ padding: '0 16px' }}>
        <div style={{ background: NG.bg2, borderRadius: 16, border: `1px solid ${NG.line}`, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', position: 'relative' }}>
            {/* Pitcher */}
            <div style={{ padding: '12px 14px', borderRight: `1px solid ${NG.line}` }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: waG(home.primary, 0.9), textTransform: 'uppercase', marginBottom: 4 }}>투수</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: NG.text1, marginBottom: 2, letterSpacing: -0.3 }}>박영현</div>
              <div style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>ERA 2.48 · 72구</div>
            </div>
            {/* Batter */}
            <div style={{ padding: '12px 14px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, color: waG(away.primary, 0.9), textTransform: 'uppercase', marginBottom: 4 }}>타자</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: NG.text1, marginBottom: 2, letterSpacing: -0.3 }}>최정</div>
              <div style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>AVG .289 · 2타수 1안타</div>
            </div>
          </div>
          {/* Chat hook */}
          <div style={{
            padding: '10px 14px', borderTop: `1px solid ${NG.line}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            background: waG(palette.base, 0.05),
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ display: 'flex' }}>
                {['#E04050','#9BA8D4','#7DA3C9'].map((c,i) => (
                  <div key={i} style={{ width: 18, height: 18, borderRadius: '50%', background: c, border: `2px solid ${NG.bg2}`, marginLeft: i===0?0:-6 }}/>
                ))}
              </div>
              <span style={{ fontSize: 11, fontWeight: 700, color: NG.text2 }}>1,204명 관전 중</span>
            </div>
            <span style={{ fontSize: 11, fontWeight: 800, color: palette.accent }}>라이브 채팅 →</span>
          </div>
        </div>
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 4) Lineup tab

function ScreenGameLineup({ team, palette }) {
  const away = palette.isNeutral ? TG.ssg : team;
  const home = palette.isNeutral ? TG.kt : TG.doosan;
  const lineupAway = [
    { n: '최지훈', p: '중견수', avg: '.287' },
    { n: '오태곤', p: '유격수', avg: '.245' },
    { n: '최정',   p: '3루수', avg: '.289' },
    { n: '한유섬', p: '우익수', avg: '.263' },
    { n: '기예르모',p: '1루수', avg: '.302' },
    { n: '김성현', p: '2루수', avg: '.251' },
    { n: '박성한', p: '지명', avg: '.272' },
    { n: '이지영', p: '포수',  avg: '.218' },
    { n: '고명준', p: '좌익수', avg: '.234' },
  ];
  const lineupHome = [
    { n: '김상수', p: '2루수', avg: '.268' },
    { n: '배정대', p: '중견수', avg: '.275' },
    { n: '박병호', p: '1루수', avg: '.255' },
    { n: '알포드', p: '지명',  avg: '.293' },
    { n: '장성우', p: '포수',  avg: '.242' },
    { n: '황재균', p: '3루수', avg: '.260' },
    { n: '오재일', p: '좌익수', avg: '.221' },
    { n: '조용호', p: '우익수', avg: '.215' },
    { n: '권동진', p: '유격수', avg: '.198' },
  ];

  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title={`${away.short} vs ${home.short}`}/>
      <ChipTabs tabs={['프리뷰', '라인업', '경기', '채팅', '예측']} active="라인업" palette={palette}/>

      {/* Starting pitchers */}
      <div style={{ padding: '0 16px 14px', display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 8 }}>
        {[{ t: away, n: '문동주', era: '2.48', w: '10승 4패' }, null, { t: home, n: '원태인', era: '3.15', w: '12승 6패' }].map((x, i) =>
          x === null ? <div key={i} style={{ fontSize: 14, color: NG.text3, textAlign: 'center', fontWeight: 700 }}>VS</div> :
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ position: 'relative' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: waG(x.t.primary, 0.22), border: `2px solid ${x.t.light}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: NG.text1 }}>{x.n[0]}{x.n[1]}</div>
              </div>
              <div style={{ position: 'absolute', bottom: -4, right: -4 }}>
                <TeamLogo team={x.t} size={22}/>
              </div>
            </div>
            <div style={{
              padding: '3px 10px', borderRadius: 999,
              background: x.t.primary, color: '#fff',
              fontSize: 11, fontWeight: 700, letterSpacing: -0.2,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ opacity: 0.8 }}>SP</span>{x.n}
            </div>
            <div style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>ERA {x.era} · {x.w}</div>
          </div>
        )}
      </div>

      {/* AI analysis card */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          borderRadius: 14, padding: 12,
          background: `linear-gradient(135deg, ${waG(palette.base, 0.10)} 0%, ${NG.bg2} 80%)`,
          border: `1px solid ${waG(palette.base, 0.22)}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <div style={{ width: 18, height: 18, borderRadius: '50%', background: palette.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 900, color: palette.onAccent }}>AI</div>
            <div style={{ fontSize: 11, fontWeight: 800, color: NG.text1 }}>라인업 분석</div>
          </div>
          <div style={{ fontSize: 11.5, color: NG.text2, lineHeight: 1.6 }}>
            원태인 상대 좌타 강세 — <b style={{ color: NG.text1 }}>최정·기예르모</b>가 키. 박영현이 던진 뒤 KT 불펜 ERA 4.20.
          </div>
        </div>
      </div>

      {/* Lineup table */}
      <div style={{ padding: '0 16px 8px' }}>
        <div style={{
          borderRadius: 14, background: NG.bg2, border: `1px solid ${NG.line}`,
          overflow: 'hidden',
        }}>
          {/* header */}
          <div style={{
            display: 'grid', gridTemplateColumns: '18px 1fr 18px 1fr 18px',
            padding: '8px 12px', borderBottom: `1px solid ${NG.line}`,
            fontSize: 9, fontWeight: 800, color: NG.text3, letterSpacing: 0.5,
          }}>
            <div>#</div>
            <div style={{ color: away.light }}>{away.short}</div>
            <div/>
            <div style={{ textAlign: 'right', color: home.light }}>{home.short}</div>
            <div style={{ textAlign: 'right' }}>#</div>
          </div>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '18px 1fr 18px 1fr 18px',
              padding: '8px 12px', alignItems: 'center',
              background: i % 2 === 0 ? waG('#ffffff', 0.015) : 'transparent',
              borderBottom: i < 8 ? `1px solid ${waG('#ffffff', 0.04)}` : 'none',
              fontSize: 11,
            }}>
              <div style={{ color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>{i+1}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 9, color: NG.text3, width: 24 }}>{lineupAway[i].p}</span>
                <span style={{ fontWeight: 700, color: NG.text1, letterSpacing: -0.2 }}>{lineupAway[i].n}</span>
                <span style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>{lineupAway[i].avg}</span>
              </div>
              <div style={{ textAlign: 'center', color: NG.text4 }}>·</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <span style={{ fontSize: 10, color: NG.text3, fontVariantNumeric: 'tabular-nums' }}>{lineupHome[i].avg}</span>
                <span style={{ fontWeight: 700, color: NG.text1, letterSpacing: -0.2 }}>{lineupHome[i].n}</span>
                <span style={{ fontSize: 9, color: NG.text3, width: 24, textAlign: 'right' }}>{lineupHome[i].p}</span>
              </div>
              <div style={{ color: NG.text3, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{i+1}</div>
            </div>
          ))}
        </div>
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 5) Play-by-play timeline

function ScreenGameTimeline({ team, palette }) {
  const away = palette.isNeutral ? TG.ssg : team;
  const home = palette.isNeutral ? TG.kt : TG.doosan;
  const plays = [
    { t: 'live', inning: '9말', badge: 'HR', color: NG.live,
      title: '장성우 좌중간 2점 홈런',
      desc: '박영현 슬라이더 초구 공략. 시즌 18호.',
      score: '5-3' },
    { t: 'e',  inning: '9말', badge: '1B', color: NG.win,
      title: '배정대 중전 안타',
      desc: '최지훈 수비 범위 빠짐. 2루 주자 득점.',
      score: '3-3' },
    { t: 'e',  inning: '9말', badge: 'K',  color: waG('#ffffff', 0.5),
      title: '박병호 헛스윙 삼진',
      desc: '박영현 149km/h 직구. 1아웃.' },
    { t: 'e',  inning: '9초', badge: '2B', color: NG.win,
      title: '한유섬 우중간 2루타',
      desc: '원태인 체인지업 실투. 1점 추가.',
      score: '3-2' },
    { t: 'e',  inning: '8말', badge: 'BB', color: NG.warn,
      title: '황재균 볼넷 출루',
      desc: '6구 승부. 무사 1루.' },
  ];

  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title={`${away.short} vs ${home.short}`}/>
      <ChipTabs tabs={['프리뷰', '라인업', '경기', '채팅', '예측']} active="경기" palette={palette}/>

      {/* Filter pills */}
      <div style={{ padding: '0 16px 12px', display: 'flex', gap: 6, overflow: 'hidden' }}>
        {['전체', '득점', '홈런', '투수 교체', '주요 상황'].map((f, i) => (
          <div key={f} style={{
            padding: '6px 10px', borderRadius: 999,
            fontSize: 10, fontWeight: 700,
            background: i === 0 ? waG(palette.base, 0.18) : NG.bg2,
            color: i === 0 ? palette.accent : NG.text2,
            border: `1px solid ${i === 0 ? waG(palette.base, 0.35) : NG.line}`,
            whiteSpace: 'nowrap',
          }}>{f}</div>
        ))}
      </div>

      {/* Timeline */}
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {plays.map((p, i) => (
          <div key={i} style={{
            display: 'grid', gridTemplateColumns: '44px 1fr', gap: 10,
          }}>
            {/* timeline rail */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: NG.text3, marginBottom: 4 }}>{p.inning}</div>
              <div style={{
                padding: '3px 7px', borderRadius: 8,
                background: waG(p.color, 0.18), color: p.color,
                fontSize: 10, fontWeight: 900, letterSpacing: 0.4,
                border: `1px solid ${waG(p.color, 0.35)}`,
              }}>{p.badge}</div>
              {i < plays.length - 1 && <div style={{ flex: 1, width: 1, background: NG.line, marginTop: 6, minHeight: 20 }}/>}
            </div>
            {/* card */}
            <div style={{
              background: NG.bg2, borderRadius: 14,
              border: `1px solid ${p.t === 'live' ? waG(p.color, 0.35) : NG.line}`,
              padding: 12,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 4,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: NG.text1, letterSpacing: -0.2 }}>
                  {p.title}
                </div>
                {p.score && (
                  <div style={{
                    fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
                    padding: '2px 8px', borderRadius: 6,
                    background: waG(palette.base, 0.15), color: palette.accent,
                  }}>{p.score}</div>
                )}
              </div>
              <div style={{ fontSize: 11, color: NG.text3, lineHeight: 1.5 }}>{p.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 6) Live chat

function ScreenGameChat({ team, palette }) {
  const away = palette.isNeutral ? TG.ssg : team;
  const home = palette.isNeutral ? TG.kt : TG.doosan;
  const msgs = [
    { t: 'sys', text: '9회말 장성우 2점 홈런! 5-3', color: NG.live },
    { side: 'home', name: '김두산',  lvl: 28, text: '우와!!!!! 장성우 가자!!!! 🔥🔥', time: '21:47' },
    { side: 'home', name: '베어스러버', lvl: 51, text: '봄에 일어서서 봤다가 주저앉음', time: '21:47' },
    { side: 'away', name: '유광민',  lvl: 62, text: '박영현 오늘 왜이래 ㅠㅠ', time: '21:47' },
    { side: 'home', name: '잠실의신',  lvl: 42, text: '이거 역전까지 가자!!!', time: '21:48' },
    { side: 'away', name: '민지',    lvl: 17, text: '그래도 3점 남았음 파이팅', time: '21:48' },
    { side: 'home', name: '두산승리', lvl: 89, text: '역전타 각인데...', time: '21:49' },
  ];

  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title={`${away.short} vs ${home.short}`}
        right={<span style={{ fontSize: 11, fontWeight: 700, color: NG.text3 }}>1,204</span>}/>
      <ChipTabs tabs={['프리뷰', '라인업', '경기', '채팅', '예측']} active="채팅" palette={palette}/>

      {/* Mini scorebar */}
      <div style={{ padding: '0 16px 10px' }}>
        <div style={{
          background: NG.bg2, borderRadius: 12, border: `1px solid ${NG.line}`,
          padding: '8px 14px',
          display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TeamLogo team={away} size={22}/>
            <span style={{ fontSize: 11, color: NG.text2 }}>{away.short}</span>
            <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: NG.text1, letterSpacing: -0.8 }}>3</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: NG.live, boxShadow: `0 0 4px ${NG.live}` }}/>
            <span style={{ fontSize: 10, fontWeight: 800, color: NG.live, letterSpacing: 0.5 }}>9말</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
            <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: NG.text1, letterSpacing: -0.8 }}>5</span>
            <span style={{ fontSize: 11, color: NG.text2 }}>{home.short}</span>
            <TeamLogo team={home} size={22}/>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 60 }}>
        {msgs.map((m, i) => {
          if (m.t === 'sys') {
            return (
              <div key={i} style={{ textAlign: 'center', padding: '6px 0' }}>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  padding: '3px 10px', borderRadius: 999,
                  background: waG(m.color, 0.15),
                  color: m.color,
                  border: `1px solid ${waG(m.color, 0.3)}`,
                }}>📢 {m.text}</span>
              </div>
            );
          }
          const t = m.side === 'away' ? away : home;
          return (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ width: 24, height: 24, borderRadius: '50%', background: waG(t.primary, 0.25), border: `1px solid ${waG(t.primary, 0.4)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: NG.text1 }}>{m.name[0]}</div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: t.light, letterSpacing: -0.2 }}>{m.name}</span>
                  <span style={{
                    fontSize: 8, fontWeight: 800,
                    padding: '1px 5px', borderRadius: 4,
                    background: waG(palette.base, 0.15), color: palette.accent,
                  }}>Lv.{m.lvl}</span>
                  <span style={{ fontSize: 9, color: NG.text4, marginLeft: 'auto' }}>{m.time}</span>
                </div>
                <div style={{ fontSize: 12.5, color: NG.text1, lineHeight: 1.4, letterSpacing: -0.2 }}>{m.text}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Input bar */}
      <div style={{
        position: 'absolute', bottom: 84, left: 0, right: 0,
        padding: '10px 14px',
        background: waG('#000', 0.7),
        backdropFilter: 'blur(14px)',
        borderTop: `1px solid ${NG.line}`,
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <div style={{
          flex: 1, padding: '9px 14px', borderRadius: 999,
          background: NG.bg3, border: `1px solid ${NG.line}`,
          fontSize: 12, color: NG.text3,
        }}>응원 메시지 입력…</div>
        <div style={{
          width: 36, height: 36, borderRadius: '50%',
          background: palette.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M4 12l16-8-5 16-3-7-8-1z" stroke={palette.onAccent} strokeWidth="1.8" strokeLinejoin="round"/>
          </svg>
        </div>
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 7) Predict

function ScreenGamePredict({ team, palette }) {
  const away = palette.isNeutral ? TG.ssg : team;
  const home = palette.isNeutral ? TG.kt : TG.doosan;
  // aggregate share
  const awayPct = 42, homePct = 58;

  return (
    <>
      <StatusBar tint={NG.text1}/>
      <PhoneHeader title={`${away.short} vs ${home.short}`}/>
      <ChipTabs tabs={['프리뷰', '라인업', '경기', '채팅', '예측']} active="예측" palette={palette}/>

      {/* Deadline banner */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{
          borderRadius: 14, padding: '10px 14px',
          background: waG(NG.warn, 0.1),
          border: `1px solid ${waG(NG.warn, 0.3)}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: NG.warn }}/>
          <div style={{ fontSize: 11, fontWeight: 700, color: NG.warn, letterSpacing: -0.2 }}>
            마감 00:28:14
          </div>
          <div style={{ fontSize: 10.5, color: NG.text2, marginLeft: 'auto' }}>
            경기 시작 전까지
          </div>
        </div>
      </div>

      {/* Pick card */}
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{
          borderRadius: 18, overflow: 'hidden',
          background: NG.bg2, border: `1px solid ${NG.line}`,
        }}>
          <div style={{ padding: '12px 14px', borderBottom: `1px solid ${NG.line}` }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: NG.text3, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4 }}>오늘의 승부예측</div>
            <div style={{ fontSize: 14, fontWeight: 800, color: NG.text1, letterSpacing: -0.3 }}>누가 이길까요?</div>
          </div>

          {/* Two picks */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, padding: 14 }}>
            {[{t: away, pct: awayPct, pick: true}, {t: home, pct: homePct, pick: false}].map((x, i) => (
              <div key={i} style={{
                borderRadius: 14,
                padding: 14,
                background: x.pick
                  ? `linear-gradient(155deg, ${waG(x.t.primary, 0.28)}, ${waG(x.t.primary, 0.1)})`
                  : NG.bg3,
                border: x.pick
                  ? `2px solid ${x.t.light}`
                  : `1px solid ${NG.line}`,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                position: 'relative',
              }}>
                {x.pick && (
                  <div style={{
                    position: 'absolute', top: 6, right: 6,
                    fontSize: 9, fontWeight: 800, color: x.t.light,
                    padding: '2px 7px', borderRadius: 999,
                    background: NG.bg0, border: `1px solid ${x.t.light}`,
                  }}>내 픽</div>
                )}
                <TeamLogo team={x.t} size={48} pad={5}/>
                <div style={{ fontSize: 13, fontWeight: 800, color: NG.text1 }}>{x.t.short}</div>
                <div style={{ fontSize: 24, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: -1, color: x.pick ? x.t.light : NG.text1 }}>{x.pct}%</div>
                <div style={{
                  width: '100%', height: 4, borderRadius: 2,
                  background: NG.bg0, overflow: 'hidden',
                }}>
                  <div style={{
                    width: `${x.pct}%`, height: '100%',
                    background: x.t.light, borderRadius: 2,
                  }}/>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Streak card */}
      <div style={{ padding: '0 16px 16px' }}>
        <div style={{
          borderRadius: 16, padding: 14,
          background: `linear-gradient(135deg, ${waG(palette.base, 0.14)}, ${NG.bg2} 80%)`,
          border: `1px solid ${waG(palette.base, 0.22)}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: palette.accent, letterSpacing: 1, textTransform: 'uppercase' }}>내 예측 기록</div>
            <div style={{ fontSize: 10, color: NG.text3 }}>이번 시즌</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            {[{l:'적중률', v:'58.3%', c: palette.accent}, {l:'연승', v:'4', c: NG.win}, {l:'총 예측', v:'127', c: NG.text1}].map((x, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ fontSize: 22, fontWeight: 900, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.6, color: x.c }}>{x.v}</div>
                <div style={{ fontSize: 10, fontWeight: 600, color: NG.text3, marginTop: 2 }}>{x.l}</div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 4 }}>
            {['W','W','W','W','L','W','L','W','W','L'].map((r, i) => (
              <div key={i} style={{
                flex: 1, height: 5, borderRadius: 2,
                background: r === 'W' ? waG(NG.win, 0.8) : waG(NG.text4, 0.4),
              }}/>
            ))}
          </div>
        </div>
      </div>

      <TabBar active="games" palette={palette}/>
    </>
  );
}

Object.assign(window, {
  ScreenGameSchedule,
  ScreenGamePreview,
  ScreenGameLive,
  ScreenGameLineup,
  ScreenGameTimeline,
  ScreenGameChat,
  ScreenGamePredict,
  PhoneHeader,
  ChipTabs,
});
