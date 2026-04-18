// My / Profile / Social / Messages screens
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, PhoneHeader, ChipTabs, withAlpha

const NM = window.KBO.NEUTRAL;
const { teamPalette: teamPaletteMy, withAlpha: withAlphaMy } = window.KBO;

// ─────────────────────────────────────────────────────────────
// 32 · 프로필 편집
// ─────────────────────────────────────────────────────────────
function ScreenProfileEdit({ team, palette }) {
  const Field = ({ label, value, hint, accent }) => (
    <div style={{
      padding: '14px 16px', borderRadius: 14,
      background: NM.bg2, border: `1px solid ${NM.line}`,
      marginBottom: 10,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.1, color: NM.text3, textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, color: accent ? palette.accent : NM.text1, letterSpacing: -0.2 }}>{value}</div>
      {hint && <div style={{ fontSize: 11, color: NM.text3, marginTop: 4 }}>{hint}</div>}
    </div>
  );

  return (
    <>
      <StatusBar tint={NM.text1}/>
      <PhoneHeader title="프로필 편집" right={
        <span style={{ fontSize: 13, fontWeight: 700, color: palette.accent }}>저장</span>
      }/>

      <div style={{ padding: '0 20px 100px' }}>
        {/* Cover + avatar */}
        <div style={{
          position: 'relative', borderRadius: 20, overflow: 'hidden',
          height: 130, marginBottom: 52,
          background: `linear-gradient(135deg, ${palette.heroBgA} 0%, ${palette.heroBgB} 100%)`,
          border: `1px solid ${withAlphaMy(palette.base, 0.22)}`,
        }}>
          <div style={{
            position: 'absolute', right: -16, bottom: -16,
            width: 140, height: 140, opacity: 0.1,
          }}>
            <div dangerouslySetInnerHTML={{ __html: ((window.INLINE_LOGOS||{})[team.slug]||'').replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ') }}/>
          </div>
          <div style={{
            position: 'absolute', top: 10, right: 10,
            padding: '6px 10px', borderRadius: 999,
            background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(10px)',
            fontSize: 11, fontWeight: 700, color: '#fff', letterSpacing: -0.2,
          }}>커버 변경</div>
          {/* avatar */}
          <div style={{
            position: 'absolute', left: 16, bottom: -36,
            width: 72, height: 72, borderRadius: '50%',
            background: `conic-gradient(${palette.accent} 0deg, ${palette.accent} 287deg, rgba(255,255,255,0.15) 287deg)`,
            padding: 3, boxSizing: 'border-box',
          }}>
            <div style={{
              width: '100%', height: '100%', borderRadius: '50%',
              background: `linear-gradient(135deg, ${palette.base} 0%, ${NM.bg3} 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 26, fontWeight: 800, color: '#fff',
              border: `3px solid ${NM.bg0}`,
            }}>민</div>
          </div>
          <div style={{
            position: 'absolute', left: 92, bottom: -20,
            padding: '6px 10px', borderRadius: 999,
            background: palette.accent, color: palette.onAccent,
            fontSize: 11, fontWeight: 800, letterSpacing: -0.2,
          }}>사진 변경</div>
        </div>

        {/* Fields */}
        <Field label="닉네임" value="크보팬_민지" hint="한글·영문·숫자, 2~16자"/>
        <Field label="응원 구단" value={team.name} hint="90일 내 1회 변경 가능" accent/>
        <Field label="한줄 소개" value="9회말에 더 강한 팀의 팬" hint="프로필·댓글 옆에 표시됩니다"/>
        <Field label="최애 선수" value="김도영 · 박찬호 · 양현종" hint="최대 3명"/>

        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 4,
        }}>
          <Field label="공개 범위" value="팔로워" hint="전체 · 팔로워 · 나만"/>
          <Field label="테마" value="다크" hint="다크 · 라이트 · 시스템"/>
        </div>

        <div style={{
          marginTop: 14, padding: '12px 14px',
          borderRadius: 12,
          background: withAlphaMy(palette.base, 0.08),
          border: `1px solid ${withAlphaMy(palette.base, 0.2)}`,
          fontSize: 11, color: NM.text2, lineHeight: 1.5,
        }}>
          <b style={{ color: palette.accent }}>ⓘ</b> 응원 구단을 바꾸면 홈·커뮤니티·순위 화면의 강조 컬러가 함께 변경돼요.
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 33 · 프로필 공개 뷰 (남이 보는 내 프로필)
// ─────────────────────────────────────────────────────────────
function ScreenProfilePublic({ team, palette }) {
  const badges = [
    { emoji: '🏟', label: '직관 50', on: true },
    { emoji: '💎', label: 'DIAMOND', on: true },
    { emoji: '🔥', label: '10연승', on: true },
    { emoji: '✍️', label: '글쟁이', on: true },
    { emoji: '🎯', label: '예측왕', on: false },
    { emoji: '👑', label: '시즌권자', on: false },
  ];
  const activity = [
    { t: '2분 전', k: '댓글', text: '"9회말 역전!" 🔥' },
    { t: '12분 전', k: '게시글', text: '오늘 선발 라인업 분석' },
    { t: '1시간 전', k: '예측', text: 'vs 롯데 승리 예측 적중' },
    { t: '어제', k: '직관', text: '잠실 · 승리' },
  ];

  return (
    <>
      <StatusBar tint={NM.text1}/>
      <PhoneHeader title="프로필" right={
        <span style={{
          padding: '6px 12px', borderRadius: 999,
          background: palette.accent, color: palette.onAccent,
          fontSize: 12, fontWeight: 800, letterSpacing: -0.2,
        }}>팔로우</span>
      }/>

      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 240,
        background: `radial-gradient(100% 60% at 50% -20%, ${palette.ambient}, transparent 60%)`,
        pointerEvents: 'none',
      }}/>

      <div style={{ position: 'relative', padding: '4px 20px 100px' }}>
        {/* Hero */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16,
        }}>
          <div style={{
            width: 72, height: 72, borderRadius: '50%',
            background: `conic-gradient(${palette.accent} 0deg, ${palette.accent} 287deg, rgba(255,255,255,0.15) 287deg)`,
            padding: 3, boxSizing: 'border-box',
          }}>
            <div style={{
              width: '100%', height: '100%', borderRadius: '50%',
              background: `linear-gradient(135deg, ${palette.base} 0%, ${NM.bg3} 100%)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 28, fontWeight: 800, color: '#fff',
              border: `3px solid ${NM.bg0}`,
            }}>민</div>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: NM.text1, letterSpacing: -0.4 }}>크보팬_민지</div>
              <div style={{
                fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
                padding: '2px 6px', borderRadius: 4,
                background: palette.accent, color: palette.onAccent,
              }}>LV.42</div>
            </div>
            <div style={{ fontSize: 12, color: palette.accent, fontWeight: 700, letterSpacing: -0.2, marginBottom: 3 }}>
              {team.name} · DIAMOND III
            </div>
            <div style={{ fontSize: 11, color: NM.text3, letterSpacing: -0.1 }}>
              9회말에 더 강한 팀의 팬
            </div>
          </div>
        </div>

        {/* Stats strip */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 1, borderRadius: 14, overflow: 'hidden',
          background: NM.line, border: `1px solid ${NM.line}`,
          marginBottom: 16,
        }}>
          {[
            ['게시글', '132'],
            ['팔로워', '1,204'],
            ['팔로잉', '87'],
            ['직관', '52'],
          ].map(([l, v], i) => (
            <div key={i} style={{
              background: NM.bg2, padding: '12px 0', textAlign: 'center',
            }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: NM.text1, fontVariantNumeric: 'tabular-nums', letterSpacing: -0.5 }}>{v}</div>
              <div style={{ fontSize: 10, color: NM.text3, fontWeight: 600, letterSpacing: 0.3, marginTop: 2 }}>{l}</div>
            </div>
          ))}
        </div>

        {/* Badges */}
        <div style={{ fontSize: 12, fontWeight: 700, color: NM.text2, letterSpacing: -0.2, marginBottom: 10 }}>
          획득 뱃지 <span style={{ color: palette.accent }}>4</span> / 12
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, overflowX: 'hidden' }}>
          {badges.map((b, i) => (
            <div key={i} style={{
              flex: '0 0 auto', textAlign: 'center',
              opacity: b.on ? 1 : 0.35,
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 14,
                background: b.on ? withAlphaMy(palette.base, 0.15) : NM.bg2,
                border: `1px solid ${b.on ? withAlphaMy(palette.base, 0.3) : NM.line}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 20, marginBottom: 4,
              }}>{b.emoji}</div>
              <div style={{ fontSize: 9, fontWeight: 700, color: NM.text2, letterSpacing: 0.2 }}>{b.label}</div>
            </div>
          ))}
        </div>

        {/* Activity */}
        <div style={{ fontSize: 12, fontWeight: 700, color: NM.text2, letterSpacing: -0.2, marginBottom: 10 }}>
          최근 활동
        </div>
        <div style={{
          borderRadius: 14, background: NM.bg2,
          border: `1px solid ${NM.line}`, overflow: 'hidden',
        }}>
          {activity.map((a, i) => (
            <div key={i} style={{
              padding: '11px 14px',
              borderBottom: i < activity.length - 1 ? `1px solid ${NM.line}` : 'none',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                fontSize: 9, fontWeight: 800, color: palette.accent,
                letterSpacing: 0.4, width: 40, flexShrink: 0,
              }}>{a.k}</div>
              <div style={{ flex: 1, fontSize: 13, color: NM.text1, letterSpacing: -0.2, fontWeight: 500 }}>{a.text}</div>
              <div style={{ fontSize: 10, color: NM.text3, flexShrink: 0 }}>{a.t}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 34 · 설정 (허브)
// ─────────────────────────────────────────────────────────────
function ScreenSettings({ team, palette }) {
  const Section = ({ title, rows }) => (
    <>
      <div style={{
        fontSize: 10, fontWeight: 800, letterSpacing: 1.2,
        color: NM.text3, textTransform: 'uppercase',
        padding: '18px 4px 8px',
      }}>{title}</div>
      <div style={{
        borderRadius: 14, background: NM.bg2,
        border: `1px solid ${NM.line}`, overflow: 'hidden',
      }}>
        {rows.map((r, i) => (
          <div key={i} style={{
            padding: '13px 14px',
            borderBottom: i < rows.length - 1 ? `1px solid ${NM.line}` : 'none',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{ flex: 1, fontSize: 14, color: NM.text1, fontWeight: 500, letterSpacing: -0.2 }}>{r.label}</div>
            {r.toggle != null ? (
              <div style={{
                width: 38, height: 22, borderRadius: 999,
                background: r.toggle ? palette.accent : NM.bg3,
                border: `1px solid ${r.toggle ? palette.accent : NM.lineStrong}`,
                position: 'relative',
              }}>
                <div style={{
                  position: 'absolute', top: 2, left: r.toggle ? 18 : 2,
                  width: 16, height: 16, borderRadius: '50%',
                  background: '#fff',
                }}/>
              </div>
            ) : (
              <>
                {r.meta && <div style={{ fontSize: 12, color: r.metaColor || NM.text3, fontWeight: 600 }}>{r.meta}</div>}
                {r.chev !== false && <div style={{ color: NM.text4, fontSize: 14, lineHeight: 1 }}>›</div>}
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );

  return (
    <>
      <StatusBar tint={NM.text1}/>
      <PhoneHeader title="설정"/>

      <div style={{ padding: '0 20px 100px' }}>
        <Section title="계정" rows={[
          { label: '프로필 편집' },
          { label: '응원 구단 변경', meta: team.short, metaColor: palette.accent },
          { label: '이메일', meta: 'minji@kbo.fan' },
          { label: '비밀번호 변경' },
        ]}/>
        <Section title="알림" rows={[
          { label: '라이브 경기 시작', toggle: true },
          { label: '내 팀 득점 · 위기', toggle: true },
          { label: '댓글 · 답글', toggle: true },
          { label: '팔로우 · 메시지', toggle: true },
          { label: '커뮤니티 핫글', toggle: false },
          { label: '마케팅 · 이벤트', toggle: false },
        ]}/>
        <Section title="개인정보" rows={[
          { label: '프로필 공개 범위', meta: '팔로워', metaColor: palette.accent },
          { label: '차단 목록', meta: '3명' },
          { label: '데이터 내려받기' },
        ]}/>
        <Section title="앱" rows={[
          { label: '테마', meta: '다크', metaColor: palette.accent },
          { label: '언어', meta: '한국어' },
          { label: '캐시 비우기', meta: '42MB' },
          { label: '버전', meta: '4.2.1', chev: false },
        ]}/>

        <div style={{
          marginTop: 20, textAlign: 'center',
          fontSize: 12, color: NM.text3,
        }}>
          <span style={{ textDecoration: 'underline', marginRight: 20 }}>로그아웃</span>
          <span style={{ textDecoration: 'underline', color: 'rgba(255,69,58,0.7)' }}>계정 탈퇴</span>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 35 · 팔로우 / 팬 네트워크
// ─────────────────────────────────────────────────────────────
function ScreenFollowList({ team, palette }) {
  const follows = [
    { name: '직관요정_지수', team: 'lg', tn: 'LG', lvl: 'DIA', badge: '직관왕', you: true, back: true },
    { name: '투수러버_성우', team: 'kt', tn: 'KT', lvl: 'GOLD', badge: null, you: true, back: false },
    { name: '불꽃응원', team: team.slug, tn: team.short, lvl: 'DIA', badge: '글쟁이', you: true, back: true },
    { name: 'KBO데이터맨', team: 'neutral', tn: 'KBO', lvl: 'MASTER', badge: '분석가', you: true, back: false },
    { name: '야구보는누나', team: 'samsung', tn: '삼성', lvl: 'DIA', badge: '직관50', you: false, back: true },
    { name: '잠실지박령', team: 'doosan', tn: '두산', lvl: 'PLAT', badge: null, you: false, back: true },
    { name: '에이스맘', team: 'nc', tn: 'NC', lvl: 'GOLD', badge: null, you: true, back: false },
  ];
  const teamColors = {
    lg: '#C60C30', kt: '#1A1A1A', doosan: '#131230', ssg: '#CE0E2D',
    nc: '#315288', kia: '#EA0029', lotte: '#002856', samsung: '#074CA1',
    hanwha: '#FF6600', kiwoom: '#820024', neutral: '#6E6E73',
  };

  return (
    <>
      <StatusBar tint={NM.text1}/>
      <PhoneHeader title="팬 네트워크" right={
        <span style={{ fontSize: 18, color: NM.text2, lineHeight: 1 }}>⊕</span>
      }/>

      <div style={{ padding: '0 0 100px' }}>
        {/* tabs */}
        <div style={{ padding: '0 20px 14px', display: 'flex', gap: 6 }}>
          {[
            { label: '팔로잉', count: 87, on: true },
            { label: '팔로워', count: 1204, on: false },
            { label: '추천', count: null, on: false },
          ].map((t) => (
            <div key={t.label} style={{
              padding: '7px 14px', borderRadius: 999,
              fontSize: 12, fontWeight: 700, letterSpacing: -0.2,
              background: t.on ? palette.accent : NM.bg2,
              color: t.on ? palette.onAccent : NM.text2,
              border: t.on ? 'none' : `1px solid ${NM.line}`,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <span>{t.label}</span>
              {t.count != null && (
                <span style={{
                  fontSize: 10, fontWeight: 800,
                  color: t.on ? palette.onAccent : NM.text3,
                  opacity: t.on ? 0.8 : 1,
                }}>{t.count}</span>
              )}
            </div>
          ))}
        </div>

        {/* stats card */}
        <div style={{ padding: '0 20px 14px' }}>
          <div style={{
            padding: '12px 14px', borderRadius: 14,
            background: `linear-gradient(135deg, ${withAlphaMy(palette.base, 0.12)} 0%, ${NM.bg2} 100%)`,
            border: `1px solid ${withAlphaMy(palette.base, 0.25)}`,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: withAlphaMy(palette.base, 0.2),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18,
            }}>🤝</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: NM.text1, letterSpacing: -0.2 }}>
                같은 팀 팬 <span style={{ color: palette.accent }}>42명</span>과 연결됨
              </div>
              <div style={{ fontSize: 11, color: NM.text3, marginTop: 1 }}>
                직관 동행, 치맥 모임도 열어보세요
              </div>
            </div>
          </div>
        </div>

        {/* list */}
        <div style={{ padding: '0 20px' }}>
          {follows.map((f, i) => (
            <div key={i} style={{
              padding: '12px 0',
              borderBottom: i < follows.length - 1 ? `1px solid ${NM.line}` : 'none',
              display: 'flex', alignItems: 'center', gap: 12,
            }}>
              {/* avatar */}
              <div style={{
                width: 44, height: 44, borderRadius: '50%',
                background: `conic-gradient(${teamColors[f.team]} 0deg, ${teamColors[f.team]} 300deg, rgba(255,255,255,0.15) 300deg)`,
                padding: 2, boxSizing: 'border-box', flexShrink: 0,
              }}>
                <div style={{
                  width: '100%', height: '100%', borderRadius: '50%',
                  background: teamColors[f.team], color: '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 12, fontWeight: 800,
                  border: `2px solid ${NM.bg0}`,
                }}>{f.tn}</div>
              </div>
              {/* info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: NM.text1, letterSpacing: -0.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</div>
                  <div style={{
                    fontSize: 8, fontWeight: 800, letterSpacing: 0.4,
                    padding: '2px 5px', borderRadius: 3,
                    background: NM.bg3, color: NM.text2,
                  }}>{f.lvl}</div>
                </div>
                <div style={{ fontSize: 11, color: NM.text3, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: teamColors[f.team] === '#1A1A1A' ? NM.text2 : teamColors[f.team], fontWeight: 700 }}>{f.tn}</span>
                  {f.badge && <><span>·</span><span>{f.badge}</span></>}
                  {f.back && <><span>·</span><span style={{ color: palette.accent, fontWeight: 700 }}>맞팔</span></>}
                </div>
              </div>
              {/* action */}
              <div style={{
                padding: '6px 12px', borderRadius: 999,
                fontSize: 11, fontWeight: 700, letterSpacing: -0.1,
                background: f.you ? NM.bg3 : palette.accent,
                color: f.you ? NM.text2 : palette.onAccent,
                border: `1px solid ${f.you ? NM.line : palette.accent}`,
                flexShrink: 0,
              }}>
                {f.you ? '팔로잉' : '팔로우'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 36 · 초대 (QR + 링크)
// ─────────────────────────────────────────────────────────────
function ScreenInvite({ team, palette }) {
  // Build a fake-but-plausible QR as a grid of dots
  const QR_SIZE = 21;
  const qr = React.useMemo(() => {
    const seed = 17;
    const cells = [];
    for (let y = 0; y < QR_SIZE; y++) for (let x = 0; x < QR_SIZE; x++) {
      // finder squares
      const fin = (x < 7 && y < 7) || (x >= QR_SIZE - 7 && y < 7) || (x < 7 && y >= QR_SIZE - 7);
      if (fin) {
        const lx = x < 7 ? x : x - (QR_SIZE - 7);
        const ly = y < 7 ? y : y - (QR_SIZE - 7);
        const onFrame = lx === 0 || lx === 6 || ly === 0 || ly === 6;
        const onInner = lx >= 2 && lx <= 4 && ly >= 2 && ly <= 4;
        cells.push({ x, y, on: onFrame || onInner });
      } else {
        // pseudo-random
        const v = (x * 7 + y * 31 + seed * (x + 1)) % 5;
        cells.push({ x, y, on: v < 2 });
      }
    }
    return cells;
  }, []);

  const friends = [
    { name: '직관요정_지수', tn: 'LG', tc: '#C60C30' },
    { name: '투수러버_성우', tn: 'KT', tc: '#1A1A1A' },
    { name: '야구보는누나', tn: '삼성', tc: '#074CA1' },
  ];

  return (
    <>
      <StatusBar tint={NM.text1}/>
      <PhoneHeader title="친구 초대"/>

      <div style={{ padding: '0 20px 100px' }}>
        {/* QR card */}
        <div style={{
          position: 'relative', borderRadius: 22, overflow: 'hidden',
          padding: '24px 20px',
          background: `linear-gradient(160deg, ${palette.heroBgA} 0%, ${palette.heroBgB} 100%)`,
          border: `1px solid ${withAlphaMy(palette.base, 0.25)}`,
          marginBottom: 18, textAlign: 'center',
        }}>
          {/* watermark */}
          <div style={{
            position: 'absolute', right: -20, top: -20,
            width: 120, height: 120, opacity: 0.08, pointerEvents: 'none',
          }}>
            <div dangerouslySetInnerHTML={{ __html: ((window.INLINE_LOGOS||{})[team.slug]||'').replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ') }}/>
          </div>

          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.2, color: palette.accent, textTransform: 'uppercase', marginBottom: 4 }}>
            내 초대 QR
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: NM.text1, letterSpacing: -0.3, marginBottom: 14 }}>
            친구에게 보여주세요
          </div>

          {/* QR grid */}
          <div style={{
            width: 168, height: 168, margin: '0 auto',
            padding: 10, background: '#fff', borderRadius: 14,
            display: 'grid', gridTemplateColumns: `repeat(${QR_SIZE}, 1fr)`,
            gap: 0,
          }}>
            {qr.map((c, i) => (
              <div key={i} style={{
                background: c.on ? palette.base : 'transparent',
                aspectRatio: '1',
              }}/>
            ))}
          </div>

          <div style={{ marginTop: 14, fontSize: 13, fontWeight: 700, color: NM.text1, letterSpacing: -0.2 }}>
            크보팬_민지
          </div>
          <div style={{ fontSize: 11, color: NM.text3, marginTop: 2 }}>
            kbo.fan/i/minji-a42c
          </div>
        </div>

        {/* Share actions */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
          marginBottom: 22,
        }}>
          {['링크 복사', '카톡', 'SMS', 'QR 스캔'].map((label, i) => (
            <div key={i} style={{
              padding: '14px 0', borderRadius: 14, textAlign: 'center',
              background: NM.bg2, border: `1px solid ${NM.line}`,
            }}>
              <div style={{
                width: 30, height: 30, borderRadius: 10, margin: '0 auto 6px',
                background: withAlphaMy(palette.base, 0.15),
                border: `1px solid ${withAlphaMy(palette.base, 0.3)}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: palette.accent, fontSize: 14, fontWeight: 800,
              }}>{['⎘', '💬', '✉', '📷'][i]}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: NM.text2, letterSpacing: -0.1 }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Reward */}
        <div style={{
          padding: '14px 16px', borderRadius: 16,
          background: `linear-gradient(135deg, ${withAlphaMy(palette.base, 0.12)} 0%, ${NM.bg2} 100%)`,
          border: `1px solid ${withAlphaMy(palette.base, 0.25)}`,
          marginBottom: 18, display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: 12,
            background: withAlphaMy(palette.base, 0.2),
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 22,
          }}>🎁</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: NM.text1, letterSpacing: -0.2, marginBottom: 2 }}>
              친구 초대하고 경험치 500xp
            </div>
            <div style={{ fontSize: 11, color: NM.text3, letterSpacing: -0.1 }}>
              초대 3명 완료 시 한정 뱃지 · 이번 달 <b style={{ color: palette.accent }}>2/3</b>
            </div>
          </div>
        </div>

        {/* Invited */}
        <div style={{ fontSize: 12, fontWeight: 700, color: NM.text2, marginBottom: 10, letterSpacing: -0.2 }}>
          연락처에서 찾기
        </div>
        <div style={{
          borderRadius: 14, background: NM.bg2,
          border: `1px solid ${NM.line}`, overflow: 'hidden',
        }}>
          {friends.map((f, i) => (
            <div key={i} style={{
              padding: '11px 14px',
              borderBottom: i < friends.length - 1 ? `1px solid ${NM.line}` : 'none',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                width: 34, height: 34, borderRadius: '50%',
                background: f.tc, color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 800, flexShrink: 0,
              }}>{f.tn}</div>
              <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: NM.text1, letterSpacing: -0.2 }}>{f.name}</div>
              <div style={{
                padding: '5px 10px', borderRadius: 999,
                fontSize: 11, fontWeight: 800,
                background: palette.accent, color: palette.onAccent,
              }}>초대</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 37 · 메시지 리스트
// ─────────────────────────────────────────────────────────────
function ScreenMessages({ team, palette }) {
  const threads = [
    { name: '직관요정_지수', tn: 'LG', tc: '#C60C30', last: '내일 잠실 직관 ㄱㄱ?', time: '방금', unread: 2, pin: true, live: true },
    { name: '불꽃응원', tn: team.short, tc: palette.base, last: '오늘 라인업 봤어? 김도영이 4번으로', time: '12분', unread: 1 },
    { name: '투수러버_성우', tn: 'KT', tc: '#1A1A1A', last: '문동주 vs 원태인, 누가 이길 것 같음?', time: '1시간', unread: 0 },
    { name: 'KBO데이터맨', tn: 'KBO', tc: '#6E6E73', last: '분석글 초안 보냈습니다', time: '3시간', unread: 0 },
    { name: '야구보는누나', tn: '삼성', tc: '#074CA1', last: '치맥 모임 화요일로 바뀜', time: '어제', unread: 0 },
    { name: '잠실지박령', tn: '두산', tc: '#131230', last: 'ㄱㅅㄱㅅ 🙏', time: '어제', unread: 0 },
    { name: '에이스맘', tn: 'NC', tc: '#315288', last: '우리 형호 응원글 봤어요?', time: '2일', unread: 0 },
  ];

  return (
    <>
      <StatusBar tint={NM.text1}/>
      <PhoneHeader title="메시지" right={
        <span style={{ fontSize: 18, color: NM.text2, lineHeight: 1 }}>✎</span>
      }/>

      <div style={{ padding: '0 0 100px' }}>
        {/* search */}
        <div style={{ padding: '0 20px 12px' }}>
          <div style={{
            padding: '10px 14px', borderRadius: 12,
            background: NM.bg2, border: `1px solid ${NM.line}`,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ color: NM.text3, fontSize: 13 }}>🔍</span>
            <span style={{ fontSize: 13, color: NM.text3, letterSpacing: -0.2 }}>팬 이름으로 검색</span>
          </div>
        </div>

        {/* quick filter */}
        <div style={{ padding: '0 20px 8px', display: 'flex', gap: 6 }}>
          {[{ l: '전체', on: true, n: 7 }, { l: '안읽음', on: false, n: 3 }, { l: '내 팀', on: false, n: 2 }, { l: '라이브 중', on: false, n: 1 }].map((f, i) => (
            <div key={i} style={{
              padding: '5px 10px', borderRadius: 999,
              fontSize: 11, fontWeight: 700,
              background: f.on ? palette.accent : NM.bg2,
              color: f.on ? palette.onAccent : NM.text2,
              border: `1px solid ${f.on ? palette.accent : NM.line}`,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>{f.l} <span style={{ opacity: 0.6 }}>{f.n}</span></div>
          ))}
        </div>

        {/* list */}
        <div style={{ padding: '6px 0' }}>
          {threads.map((t, i) => (
            <div key={i} style={{
              padding: '12px 20px',
              display: 'flex', alignItems: 'center', gap: 12,
              borderBottom: `1px solid ${NM.line}`,
              background: t.unread ? withAlphaMy(palette.base, 0.04) : 'transparent',
            }}>
              <div style={{ position: 'relative', flexShrink: 0 }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%',
                  background: t.tc, color: t.tc === '#1A1A1A' ? '#fff' : '#fff',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 13, fontWeight: 800,
                  border: `2px solid ${NM.bg0}`,
                }}>{t.tn}</div>
                {t.live && (
                  <div style={{
                    position: 'absolute', bottom: -2, right: -2,
                    padding: '2px 5px', borderRadius: 999,
                    background: NM.live, color: '#fff',
                    fontSize: 8, fontWeight: 800, letterSpacing: 0.3,
                    border: `2px solid ${NM.bg0}`,
                  }}>LIVE</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 3 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: NM.text1, letterSpacing: -0.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</div>
                  {t.pin && <span style={{ fontSize: 9, color: palette.accent }}>📌</span>}
                  <div style={{ marginLeft: 'auto', fontSize: 10, color: t.unread ? palette.accent : NM.text3, fontWeight: t.unread ? 700 : 500, flexShrink: 0 }}>{t.time}</div>
                </div>
                <div style={{
                  fontSize: 12, color: t.unread ? NM.text1 : NM.text3,
                  fontWeight: t.unread ? 600 : 400, letterSpacing: -0.1,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.last}</span>
                  {t.unread > 0 && (
                    <div style={{
                      minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999,
                      background: palette.accent, color: palette.onAccent,
                      fontSize: 10, fontWeight: 800,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>{t.unread}</div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// 38 · 메시지 대화 (1:1 DM)
// ─────────────────────────────────────────────────────────────
function ScreenMessageChat({ team, palette }) {
  // Partner is another team's fan → their color for their bubbles
  const partnerColor = '#C60C30'; // LG red (example — cross-team chat)
  const partnerBg = withAlphaMy(partnerColor, 0.12);

  const msgs = [
    { you: false, text: '오늘 김도영 한 방 치면 저녁은 내가 쏜다 ㅋㅋ', time: '19:24' },
    { you: true, text: '그 말 아까 문자로도 했잖아 ㅋㅋㅋ', time: '19:25' },
    { you: false, text: '아 진짜 잠실 직관 가면 항상 져서', time: '19:25' },
    { you: false, text: '오늘은 TV로 봄', time: '19:25' },
    { you: true, text: '나는 집에서 치맥 중 🍗', time: '19:30' },
    { you: true, text: '투수 교체 타이밍 지금이 맞나?', time: '19:31' },
    { you: false, text: '아니 이건 좀 빠른듯... 6회 마무리 시키지', time: '19:32', system: false },
    { you: false, text: '오 역전!!', time: '19:38' },
    { you: true, text: '🔥🔥🔥', time: '19:38' },
  ];

  // Shared game context pinned at top
  return (
    <>
      <StatusBar tint={NM.text1}/>
      {/* Custom header with avatar */}
      <div style={{
        padding: '8px 16px 10px',
        borderBottom: `1px solid ${NM.line}`,
        display: 'flex', alignItems: 'center', gap: 10,
        background: NM.bg0,
      }}>
        <span style={{ color: NM.text2, fontSize: 18 }}>‹</span>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: partnerColor, color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 11, fontWeight: 800,
        }}>LG</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: NM.text1, letterSpacing: -0.2 }}>직관요정_지수</div>
          <div style={{ fontSize: 10, color: partnerColor, fontWeight: 700 }}>
            LG 트윈스 팬 · <span style={{ color: NM.win }}>● 온라인</span>
          </div>
        </div>
        <span style={{ color: NM.text2, fontSize: 16 }}>⋯</span>
      </div>

      {/* Shared game pinned */}
      <div style={{
        margin: '10px 16px 4px',
        padding: '10px 12px', borderRadius: 12,
        background: withAlphaMy(palette.base, 0.08),
        border: `1px solid ${withAlphaMy(palette.base, 0.22)}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
          padding: '2px 6px', borderRadius: 4,
          background: NM.live, color: '#fff',
        }}>LIVE</div>
        <div style={{ fontSize: 12, fontWeight: 700, color: NM.text1, letterSpacing: -0.2, flex: 1 }}>
          {team.short} <span style={{ color: palette.accent }}>4</span> : <span>3</span> LG · 7회말
        </div>
        <div style={{ fontSize: 10, color: NM.text3 }}>함께 보는 중</div>
      </div>

      {/* Messages */}
      <div style={{ padding: '8px 12px 120px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {msgs.map((m, i) => {
          const prev = msgs[i - 1];
          const next = msgs[i + 1];
          const first = !prev || prev.you !== m.you;
          const last = !next || next.you !== m.you;
          return (
            <div key={i} style={{
              display: 'flex',
              justifyContent: m.you ? 'flex-end' : 'flex-start',
              marginTop: first ? 6 : 0,
            }}>
              <div style={{
                maxWidth: '78%',
                padding: '8px 12px',
                background: m.you ? palette.accent : partnerBg,
                color: m.you ? palette.onAccent : NM.text1,
                fontSize: 13, fontWeight: 500, letterSpacing: -0.1, lineHeight: 1.4,
                borderRadius: 16,
                borderTopLeftRadius: m.you ? 16 : (first ? 16 : 6),
                borderBottomLeftRadius: m.you ? 16 : (last ? 16 : 6),
                borderTopRightRadius: m.you ? (first ? 16 : 6) : 16,
                borderBottomRightRadius: m.you ? (last ? 16 : 6) : 16,
                border: m.you ? 'none' : `1px solid ${withAlphaMy(partnerColor, 0.25)}`,
                position: 'relative',
              }}>
                {m.text}
                {last && (
                  <div style={{
                    fontSize: 9, color: m.you ? withAlphaMy(palette.onAccent, 0.7) : NM.text3,
                    marginTop: 2, textAlign: m.you ? 'right' : 'left', fontWeight: 600,
                  }}>{m.time}</div>
                )}
              </div>
            </div>
          );
        })}

        {/* typing */}
        <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: 6 }}>
          <div style={{
            padding: '10px 14px', background: partnerBg,
            border: `1px solid ${withAlphaMy(partnerColor, 0.25)}`,
            borderRadius: 16, borderBottomLeftRadius: 6,
            display: 'flex', gap: 4, alignItems: 'center',
          }}>
            {[0,1,2].map(i => (
              <div key={i} style={{
                width: 6, height: 6, borderRadius: '50%',
                background: partnerColor, opacity: 0.4 + i * 0.2,
              }}/>
            ))}
          </div>
        </div>
      </div>

      {/* Input bar */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 0,
        padding: '10px 14px 26px',
        background: NM.bg0, borderTop: `1px solid ${NM.line}`,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          background: NM.bg2, border: `1px solid ${NM.line}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: NM.text2, fontSize: 16, flexShrink: 0,
        }}>+</div>
        <div style={{
          flex: 1, padding: '8px 14px',
          background: NM.bg2, border: `1px solid ${NM.line}`,
          borderRadius: 999,
          fontSize: 13, color: NM.text3, letterSpacing: -0.2,
        }}>메시지 입력...</div>
        <div style={{
          padding: '7px 14px', borderRadius: 999,
          background: palette.accent, color: palette.onAccent,
          fontSize: 12, fontWeight: 800, letterSpacing: -0.2,
          flexShrink: 0,
        }}>전송</div>
      </div>
    </>
  );
}

Object.assign(window, {
  ScreenProfileEdit,
  ScreenProfilePublic,
  ScreenSettings,
  ScreenFollowList,
  ScreenInvite,
  ScreenMessages,
  ScreenMessageChat,
});
