/* ===== screens-community.jsx ===== */
// Community-related screens: home, team board, post detail, composer, comments, search, activity.
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, PhoneHeader, ChipTabs

const { NEUTRAL: NCo, withAlpha: waCo, TEAMS: TCo } = window.KBO;

// ─────────────────────────── 1) Community home (all teams)

function ScreenCommunityHome({ team, palette }) {
  const boards = [
    { slug: 'doosan',  topic: '[속보] 9회말 장성우 역전 투런!',   cnt: 847, hot: true },
    { slug: 'lg',      topic: '오스틴 재계약 썰 어떻게 생각?',     cnt: 612, hot: true },
    { slug: 'kia',     topic: '양현종 FA 관련 정리',              cnt: 423 },
    { slug: 'ssg',     topic: '내일 선발 추신수면 좋겠다',         cnt: 298 },
    { slug: 'samsung', topic: '원태인 오늘 투구수 보자',          cnt: 287 },
    { slug: 'kt',      topic: '박영현 셋업으로 돌리는거 어떰',     cnt: 251 },
    { slug: 'nc',      topic: '창원 직관 꿀팁 모음',              cnt: 189 },
    { slug: 'lotte',   topic: '사직 떼창 금요일 가실분',          cnt: 167 },
    { slug: 'hanwha', topic: '문동주 다음 등판 언제?',            cnt: 142 },
    { slug: 'kiwoom',  topic: '김혜성 MLB 진출 루머',             cnt: 88 },
  ];
  const hot = [
    { team: 'doosan', title: '장성우 홈런 미쳤다 직관한 사람?', cmt: 284, like: 1823, time: '2분 전' },
    { team: 'lg',     title: '오늘 심판 스트존 진짜 일관성 없음',  cmt: 456, like: 892,  time: '12분 전' },
    { team: 'kia',    title: '김도영 시즌 몇 홈런까지 갈까?',       cmt: 198, like: 745,  time: '34분 전' },
  ];
  return (
    <>
      <StatusBar tint={NCo.text1}/>
      <PhoneHeader title="커뮤니티" back={false} right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="6.5" stroke={NCo.text2} strokeWidth="1.6"/>
          <path d="M16 16l4 4" stroke={NCo.text2} strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      }/>

      {/* HOT strip */}
      <div style={{ padding: '2px 16px 16px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NCo.live, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: NCo.live, boxShadow: `0 0 5px ${NCo.live}` }}/>
          실시간 HOT
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {hot.map((h, i) => {
            const t = TCo[h.team];
            return (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center',
                padding: '10px 12px', borderRadius: 12,
                background: NCo.bg2, border: `1px solid ${NCo.line}`,
              }}>
                <div style={{
                  width: 22, height: 22, borderRadius: 6,
                  background: waCo(t.primary, 0.3),
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, fontWeight: 800, color: t.light,
                }}>{i + 1}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, fontWeight: 700, color: NCo.text1, letterSpacing: -0.2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{h.title}</div>
                  <div style={{ fontSize: 10, color: NCo.text3, marginTop: 2, display: 'flex', gap: 6 }}>
                    <span style={{ color: t.light, fontWeight: 700 }}>{t.short}</span>
                    <span>💬 {h.cmt}</span>
                    <span>❤ {h.like}</span>
                    <span style={{ marginLeft: 'auto', color: NCo.text4 }}>{h.time}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Team boards */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: NCo.text3, letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10 }}>팀 게시판</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {boards.map((b, i) => {
            const t = TCo[b.slug];
            return (
              <div key={i} style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center',
                padding: '10px 4px',
              }}>
                <TeamLogo team={t} size={28}/>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: NCo.text1, letterSpacing: -0.2 }}>
                    {t.name}
                  </div>
                  <div style={{ fontSize: 10.5, color: NCo.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.hot && <span style={{ color: NCo.live, fontWeight: 800, marginRight: 4 }}>N</span>}
                    {b.topic}
                  </div>
                </div>
                <div style={{ fontSize: 10, color: NCo.text3, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>
                  <div style={{ fontWeight: 700 }}>{b.cnt}</div>
                  <div style={{ fontSize: 9, color: NCo.text4 }}>게시글</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <TabBar active="community" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 2) Team board feed

function ScreenCommunityBoard({ team, palette }) {
  // Posts relevant to current team (or doosan if neutral)
  const displayTeam = palette.isNeutral ? TCo.doosan : team;
  const posts = [
    { badge: 'HOT', tags: ['직관', '승리'],
      title: '오늘 잠실 직관 후기 + 9회 홈런 영상',
      excerpt: '직관 운이 좋아서 역전 홈런 현장에서 봤습니다. 진짜 경기장 전체가 뒤집어졌는데…',
      author: '베어스러버',  lvl: 51, time: '12분 전',
      cmt: 284, like: 1823, view: 8420, pinned: false },
    { badge: null, tags: ['라인업'],
      title: '내일 선발 라인업 예상 (업데이트)',
      excerpt: '선발은 발라조빅이 거의 확정. 유력한 타순은…',
      author: '잠실의신',    lvl: 42, time: '34분 전',
      cmt: 67,  like: 231,  view: 1432 },
    { badge: null, tags: ['질문'],
      title: '초보인데 OPS가 뭔가요? 이해하기 쉽게',
      excerpt: '야구 본지 얼마 안돼서 용어가 헷갈려요. OPS랑 WAR 차이도 궁금…',
      author: '새내기팬',    lvl: 3,  time: '1시간 전',
      cmt: 43,  like: 58,   view: 892 },
    { badge: '공지', tags: [],
      title: '게시판 운영 가이드 (필독)',
      excerpt: '욕설·상대팀 비방·광고글은 즉시 차단됩니다.',
      author: '운영자',      lvl: null, time: '고정',
      cmt: 0,   like: 0,    view: 15234, pinned: true },
  ];

  return (
    <>
      <StatusBar tint={NCo.text1}/>
      <PhoneHeader title={`${displayTeam.name} 게시판`} right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="11" cy="11" r="6.5" stroke={NCo.text2} strokeWidth="1.6"/>
          <path d="M16 16l4 4" stroke={NCo.text2} strokeWidth="1.6" strokeLinecap="round"/>
        </svg>
      }/>

      {/* Team banner */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          borderRadius: 16, padding: '14px 16px',
          background: `linear-gradient(135deg, ${waCo(displayTeam.primary, 0.35)}, ${waCo(displayTeam.primary, 0.1)})`,
          border: `1px solid ${waCo(displayTeam.primary, 0.4)}`,
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <TeamLogo team={displayTeam} size={40} pad={4}/>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: NCo.text1, letterSpacing: -0.3 }}>
              {displayTeam.name} 팬 게시판
            </div>
            <div style={{ fontSize: 10.5, color: NCo.text3, marginTop: 2 }}>
              멤버 <b style={{ color: NCo.text1 }}>24,831</b> · 오늘 글 <b style={{ color: displayTeam.light }}>412</b>
            </div>
          </div>
          <div style={{
            padding: '6px 12px', borderRadius: 999,
            background: displayTeam.primary, color: '#fff',
            fontSize: 11, fontWeight: 800, letterSpacing: -0.2,
          }}>가입됨</div>
        </div>
      </div>

      {/* Sort chips */}
      <ChipTabs tabs={['전체', '실시간', '인기', '질문', '직관', '공지']} active="전체" palette={palette}/>

      {/* Posts */}
      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {posts.map((p, i) => (
          <div key={i} style={{
            padding: '12px 0',
            borderBottom: i < posts.length - 1 ? `1px solid ${NCo.line}` : 'none',
            position: 'relative',
          }}>
            {/* Badges */}
            <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
              {p.badge === '공지' && <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: waCo(NCo.warn, 0.18), color: NCo.warn, letterSpacing: 0.5 }}>공지</span>}
              {p.badge === 'HOT' && <span style={{ fontSize: 9, fontWeight: 800, padding: '2px 7px', borderRadius: 4, background: waCo(NCo.live, 0.18), color: NCo.live, letterSpacing: 0.5 }}>HOT 🔥</span>}
              {p.tags.map(t => <span key={t} style={{ fontSize: 9, fontWeight: 700, color: palette.accent, letterSpacing: 0.3 }}>#{t}</span>)}
            </div>

            {/* Title */}
            <div style={{ fontSize: 14, fontWeight: 700, color: NCo.text1, letterSpacing: -0.3, lineHeight: 1.35, marginBottom: 4 }}>
              {p.title}
            </div>

            {/* Excerpt */}
            {p.excerpt && (
              <div style={{
                fontSize: 11.5, color: NCo.text3, lineHeight: 1.5,
                marginBottom: 8,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}>{p.excerpt}</div>
            )}

            {/* Meta row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 10, color: NCo.text3 }}>
              <span style={{ fontWeight: 700, color: NCo.text2 }}>{p.author}</span>
              {p.lvl !== null && (
                <span style={{
                  fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3,
                  background: waCo(palette.base, 0.18), color: palette.accent,
                }}>Lv.{p.lvl}</span>
              )}
              <span style={{ color: NCo.text4 }}>·</span>
              <span>{p.time}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontVariantNumeric: 'tabular-nums' }}>
                <span>💬 {p.cmt}</span>
                <span>❤ {p.like}</span>
                <span style={{ color: NCo.text4 }}>👁 {p.view > 999 ? (p.view/1000).toFixed(1)+'k' : p.view}</span>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* FAB */}
      <div style={{
        position: 'absolute', bottom: 96, right: 16, zIndex: 20,
        width: 52, height: 52, borderRadius: '50%',
        background: palette.accent,
        boxShadow: `0 8px 20px ${waCo(palette.base, 0.45)}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14m-7-7h14" stroke={palette.onAccent} strokeWidth="2.2" strokeLinecap="round"/>
        </svg>
      </div>

      <TabBar active="community" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 3) Post detail

function ScreenCommunityPost({ team, palette }) {
  const displayTeam = palette.isNeutral ? TCo.doosan : team;

  return (
    <>
      <StatusBar tint={NCo.text1}/>
      <PhoneHeader title={`${displayTeam.name} 게시판`} right={
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="5" cy="12" r="1.6" fill={NCo.text2}/>
          <circle cx="12" cy="12" r="1.6" fill={NCo.text2}/>
          <circle cx="19" cy="12" r="1.6" fill={NCo.text2}/>
        </svg>
      }/>

      <div style={{ padding: '0 16px 10px' }}>
        {/* Tags */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 9, fontWeight: 800, padding: '3px 8px', borderRadius: 4, background: waCo(NCo.live, 0.18), color: NCo.live, letterSpacing: 0.5 }}>HOT 🔥</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: palette.accent }}>#직관 #승리</span>
        </div>
        {/* Title */}
        <div style={{ fontSize: 17, fontWeight: 800, color: NCo.text1, letterSpacing: -0.4, lineHeight: 1.35, marginBottom: 10 }}>
          오늘 잠실 직관 후기 + 9회 홈런 영상
        </div>
        {/* Author row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingBottom: 12, borderBottom: `1px solid ${NCo.line}` }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: waCo(displayTeam.primary, 0.3), border: `1px solid ${waCo(displayTeam.primary, 0.4)}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: NCo.text1 }}>베</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: displayTeam.light, letterSpacing: -0.2 }}>베어스러버</span>
              <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: waCo(palette.base, 0.18), color: palette.accent }}>Lv.51</span>
            </div>
            <div style={{ fontSize: 10, color: NCo.text3, marginTop: 1 }}>12분 전 · 조회 8,420</div>
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, color: palette.accent, padding: '5px 10px', borderRadius: 999, border: `1px solid ${waCo(palette.base, 0.35)}` }}>팔로우</div>
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '4px 16px 14px' }}>
        <p style={{ fontSize: 13, lineHeight: 1.7, color: NCo.text2, letterSpacing: -0.2, margin: 0 }}>
          직관 운이 좋아서 역전 홈런 현장에서 봤습니다. 진짜 경기장 전체가 뒤집어졌는데, 9회초까지 2점 뒤지고 있다가 1사 1·3루 상황에서…
        </p>

        {/* Image placeholder */}
        <div style={{
          marginTop: 12, borderRadius: 14,
          background: `linear-gradient(135deg, ${waCo(displayTeam.primary, 0.25)}, ${waCo(displayTeam.primary, 0.05)})`,
          border: `1px solid ${NCo.line}`,
          aspectRatio: '16/10',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          position: 'relative', overflow: 'hidden',
        }}>
          <div style={{
            width: 44, height: 44, borderRadius: '50%',
            background: 'rgba(255,255,255,0.95)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#000"><path d="M8 5v14l11-7z"/></svg>
          </div>
          <div style={{
            position: 'absolute', bottom: 8, left: 10,
            fontSize: 10, fontWeight: 700, color: '#fff',
            padding: '3px 8px', borderRadius: 4,
            background: 'rgba(0,0,0,0.6)',
          }}>0:48</div>
        </div>

        <p style={{ fontSize: 13, lineHeight: 1.7, color: NCo.text2, marginTop: 12, marginBottom: 0, letterSpacing: -0.2 }}>
          관중 반응이 진짜 어마어마했습니다. 응원가까지 다같이 불렀는데 소름이었음. 다음에도 직관 또 가야지…
        </p>
      </div>

      {/* Reactions bar */}
      <div style={{ padding: '0 16px 12px' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6,
          padding: 10, borderRadius: 14,
          background: NCo.bg2, border: `1px solid ${NCo.line}`,
        }}>
          {[{e:'❤', l:'좋아요', n:1823, on:true}, {e:'🔥', l:'불타', n:421}, {e:'😂', l:'웃겨', n:87}, {e:'🎉', l:'축하', n:312}].map((r, i) => (
            <div key={i} style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              padding: '6px 0', borderRadius: 10,
              background: r.on ? waCo(palette.base, 0.2) : 'transparent',
              border: r.on ? `1px solid ${waCo(palette.base, 0.35)}` : `1px solid transparent`,
            }}>
              <span style={{ fontSize: 18 }}>{r.e}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: r.on ? palette.accent : NCo.text2, fontVariantNumeric: 'tabular-nums' }}>{r.n > 999 ? (r.n/1000).toFixed(1)+'k' : r.n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Comments section header */}
      <div style={{ padding: '0 16px', borderTop: `1px solid ${NCo.line}`, paddingTop: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: NCo.text1 }}>댓글 <span style={{ color: palette.accent }}>284</span></div>
          <div style={{ fontSize: 10, color: NCo.text3, display: 'flex', alignItems: 'center', gap: 3 }}>인기순
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke={NCo.text3} strokeWidth="2"/></svg>
          </div>
        </div>

        {/* Comments preview */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            { name: '잠실키드', lvl: 38, team: 'doosan', text: '저도 거기 있었어요!! 진짜 소름돋았음 ㄷㄷ', like: 124, time: '8분 전', best: true },
            { name: '야구즐기자', lvl: 12, team: 'lg',    text: '축하드려요. 명승부였네요 👏', like: 67, time: '10분 전' },
          ].map((c, i) => {
            const ct = TCo[c.team];
            return (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', background: waCo(ct.primary, 0.25), border: `1px solid ${waCo(ct.primary, 0.4)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 10, fontWeight: 800, color: NCo.text1 }}>
                  {c.name[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 2 }}>
                    {c.best && <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: waCo(palette.base, 0.2), color: palette.accent }}>BEST</span>}
                    <span style={{ fontSize: 11, fontWeight: 800, color: ct.light }}>{c.name}</span>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: waCo('#ffffff', 0.08), color: NCo.text3 }}>Lv.{c.lvl}</span>
                  </div>
                  <div style={{ fontSize: 12, color: NCo.text1, lineHeight: 1.5, letterSpacing: -0.2 }}>{c.text}</div>
                  <div style={{ fontSize: 9.5, color: NCo.text3, marginTop: 4, display: 'flex', gap: 10 }}>
                    <span>{c.time}</span>
                    <span>❤ {c.like}</span>
                    <span>답글</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Bottom input bar */}
      <div style={{
        position: 'absolute', bottom: 84, left: 0, right: 0,
        padding: '10px 14px',
        background: waCo('#000', 0.7), backdropFilter: 'blur(14px)',
        borderTop: `1px solid ${NCo.line}`,
        display: 'flex', gap: 8, alignItems: 'center',
      }}>
        <div style={{
          flex: 1, padding: '9px 14px', borderRadius: 999,
          background: NCo.bg3, border: `1px solid ${NCo.line}`,
          fontSize: 12, color: NCo.text3,
        }}>댓글을 남겨보세요…</div>
        <div style={{
          padding: '8px 14px', borderRadius: 999,
          fontSize: 11, fontWeight: 800,
          background: palette.accent, color: palette.onAccent,
        }}>등록</div>
      </div>

      <TabBar active="community" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 4) Composer

function ScreenCommunityComposer({ team, palette }) {
  const displayTeam = palette.isNeutral ? TCo.doosan : team;
  return (
    <>
      <StatusBar tint={NCo.text1}/>
      {/* Composer header — custom cancel/submit */}
      <div style={{
        height: 48, padding: '0 16px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${NCo.line}`,
      }}>
        <span style={{ fontSize: 13, color: NCo.text2, fontWeight: 600 }}>취소</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: NCo.text1, letterSpacing: -0.3 }}>새 글 쓰기</span>
        <span style={{
          fontSize: 13, fontWeight: 800,
          color: palette.accent,
        }}>등록</span>
      </div>

      {/* Board picker */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${NCo.line}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: NCo.text3, letterSpacing: 0.5 }}>게시판</span>
        <div style={{
          padding: '5px 10px 5px 7px', borderRadius: 999,
          background: waCo(displayTeam.primary, 0.2), border: `1px solid ${waCo(displayTeam.primary, 0.4)}`,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <TeamLogo team={displayTeam} size={16}/>
          <span style={{ fontSize: 11, fontWeight: 800, color: displayTeam.light, letterSpacing: -0.2 }}>{displayTeam.name}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke={NCo.text3} strokeWidth="2"/></svg>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          {['일반', '질문', '직관'].map((t, i) => (
            <div key={t} style={{
              padding: '4px 9px', borderRadius: 6,
              fontSize: 10, fontWeight: 700,
              background: i === 0 ? NCo.bg2 : 'transparent',
              color: i === 0 ? NCo.text1 : NCo.text3,
              border: `1px solid ${i === 0 ? NCo.line : 'transparent'}`,
            }}>{t}</div>
          ))}
        </div>
      </div>

      {/* Title field */}
      <div style={{ padding: '14px 16px 10px' }}>
        <input readOnly placeholder="제목을 입력해주세요" style={{
          width: '100%', background: 'transparent', border: 0, outline: 0,
          fontSize: 16, fontWeight: 800, color: NCo.text1, letterSpacing: -0.4,
          fontFamily: 'inherit',
        }}/>
      </div>

      {/* Body field with caret */}
      <div style={{ padding: '0 16px', fontSize: 13, lineHeight: 1.7, color: NCo.text1, letterSpacing: -0.2 }}>
        오늘 직관 다녀왔는데요,<br/>
        9회말에 진짜 말도 안되는 상황이<span style={{ display: 'inline-block', width: 1.5, height: 16, background: palette.accent, verticalAlign: 'text-bottom', marginLeft: 1, animation: 'blink 1s infinite' }}/>
      </div>

      {/* Image strip */}
      <div style={{ padding: '16px 16px 0', display: 'flex', gap: 8 }}>
        <div style={{
          aspectRatio: '1/1', width: 72, borderRadius: 10,
          background: `linear-gradient(135deg, ${waCo(displayTeam.primary, 0.3)}, ${NCo.bg3})`,
          border: `1px solid ${NCo.line}`,
          position: 'relative',
        }}>
          <div style={{
            position: 'absolute', top: -6, right: -6,
            width: 20, height: 20, borderRadius: '50%',
            background: NCo.bg0, border: `1px solid ${NCo.line}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke={NCo.text2} strokeWidth="2"/></svg>
          </div>
        </div>
        <div style={{
          aspectRatio: '1/1', width: 72, borderRadius: 10,
          background: NCo.bg2, border: `1px dashed ${NCo.line}`,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3,
        }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke={NCo.text3} strokeWidth="1.5"/>
            <path d="M3 16l5-4 4 3 3-2 6 4" stroke={NCo.text3} strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="8.5" cy="10" r="1.5" stroke={NCo.text3} strokeWidth="1.5"/>
          </svg>
          <span style={{ fontSize: 9, color: NCo.text3 }}>사진 추가</span>
        </div>
      </div>

      {/* Poll composer */}
      <div style={{ padding: '18px 16px 0' }}>
        <div style={{
          borderRadius: 14, padding: 12,
          background: NCo.bg2, border: `1px solid ${NCo.line}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <div style={{ width: 20, height: 20, borderRadius: 6, background: waCo(palette.base, 0.22), display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M7 13v6M12 9v10M17 5v14" stroke={palette.accent} strokeWidth="2" strokeLinecap="round"/></svg>
            </div>
            <span style={{ fontSize: 11, fontWeight: 800, color: NCo.text1 }}>투표 추가</span>
            <span style={{ marginLeft: 'auto', fontSize: 9, color: NCo.text3 }}>최대 4개</span>
          </div>
          {['내일 선발 문동주', '원태인', '직접 입력'].map((opt, i) => (
            <div key={i} style={{
              padding: '8px 10px', borderRadius: 8,
              background: i < 2 ? NCo.bg3 : 'transparent',
              border: `1px ${i < 2 ? 'solid' : 'dashed'} ${NCo.line}`,
              fontSize: 11, color: i < 2 ? NCo.text1 : NCo.text3,
              marginBottom: 5,
            }}>{opt}</div>
          ))}
        </div>
      </div>

      {/* Toolbar */}
      <div style={{
        position: 'absolute', bottom: 84, left: 0, right: 0,
        padding: '10px 14px',
        background: waCo('#000', 0.7), backdropFilter: 'blur(14px)',
        borderTop: `1px solid ${NCo.line}`,
        display: 'flex', gap: 16, alignItems: 'center',
      }}>
        {[
          <svg key="1" width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="14" rx="2" stroke={NCo.text2} strokeWidth="1.6"/><circle cx="8.5" cy="10" r="1.5" fill={NCo.text2}/><path d="M3 16l5-4 4 3 3-2 6 4" stroke={NCo.text2} strokeWidth="1.6"/></svg>,
          <svg key="2" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 10l-7 7a4 4 0 005.6 5.6L21 13a6 6 0 00-8.5-8.5L6 11" stroke={NCo.text2} strokeWidth="1.6" strokeLinecap="round"/></svg>,
          <svg key="3" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M6 4h9l5 5v11a1 1 0 01-1 1H6a1 1 0 01-1-1V5a1 1 0 011-1z" stroke={NCo.text2} strokeWidth="1.6"/><path d="M9 13h6M9 17h4" stroke={NCo.text2} strokeWidth="1.6" strokeLinecap="round"/></svg>,
          <svg key="4" width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M7 13v6M12 9v10M17 5v14" stroke={palette.accent} strokeWidth="1.8" strokeLinecap="round"/></svg>,
        ].map((icon, i) => (
          <div key={i}>{icon}</div>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: NCo.text3, fontVariantNumeric: 'tabular-nums' }}>142 / 5000</span>
        </div>
      </div>
    </>
  );
}

// ─────────────────────────── 5) Comments full view

function ScreenCommunityComments({ team, palette }) {
  const displayTeam = palette.isNeutral ? TCo.doosan : team;
  const comments = [
    { name: '잠실키드',  lvl: 38, team: 'doosan', text: '저도 거기 있었어요!! 진짜 소름돋았음 ㄷㄷ 방송으로 봤으면 평생 후회할뻔', like: 124, time: '8분 전', best: true,
      replies: [
        { name: '베어스러버', lvl: 51, team: 'doosan', text: '그니까요 ㅋㅋ 우리 오늘 럭키 ㅎㅎ', like: 42, time: '5분 전' },
        { name: '야덕후',    lvl: 22, team: 'doosan', text: '영상 공유 좀요!!!', like: 18, time: '3분 전' },
      ]
    },
    { name: '야구즐기자', lvl: 12, team: 'lg',  text: '축하드려요. 명승부였네요 👏 저는 옆팀 팬이지만 인정합니다.', like: 67, time: '10분 전' },
    { name: '잠실의신',   lvl: 42, team: 'doosan', text: '9회말 투아웃에 역전... 진짜 드라마틱 했음', like: 54, time: '12분 전', best: true },
    { name: '새내기팬',   lvl: 3,  team: 'doosan', text: '아직 규칙 잘 모르는데 오늘 같은 경기 보니까 진짜 재밌네요', like: 23, time: '15분 전' },
  ];

  return (
    <>
      <StatusBar tint={NCo.text1}/>
      <PhoneHeader title="댓글 284개"/>

      {/* Sort */}
      <div style={{
        padding: '0 16px 10px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: `1px solid ${NCo.line}`, paddingBottom: 10,
      }}>
        <div style={{ display: 'flex', gap: 10 }}>
          {['인기순', '최신순', '베스트'].map((s, i) => (
            <span key={s} style={{
              fontSize: 11, fontWeight: i === 0 ? 800 : 600,
              color: i === 0 ? NCo.text1 : NCo.text3,
              paddingBottom: 2,
              borderBottom: i === 0 ? `2px solid ${palette.accent}` : 'none',
            }}>{s}</span>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: NCo.text3 }}>
          <input type="checkbox" style={{ accentColor: palette.accent }}/>
          <span>답글 펼치기</span>
        </div>
      </div>

      {/* Comments */}
      <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 50 }}>
        {comments.map((c, i) => {
          const ct = TCo[c.team];
          return (
            <div key={i}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ width: 30, height: 30, borderRadius: '50%', background: waCo(ct.primary, 0.25), border: `1px solid ${waCo(ct.primary, 0.4)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 11, fontWeight: 800, color: NCo.text1 }}>
                  {c.name[0]}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', marginBottom: 2 }}>
                    {c.best && <span style={{ fontSize: 8, fontWeight: 800, padding: '1px 5px', borderRadius: 3, background: waCo(palette.base, 0.2), color: palette.accent }}>BEST</span>}
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: ct.light, letterSpacing: -0.2 }}>{c.name}</span>
                    <span style={{ fontSize: 9, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: waCo('#ffffff', 0.08), color: NCo.text3 }}>Lv.{c.lvl}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 9.5, color: NCo.text4 }}>{c.time}</span>
                  </div>
                  <div style={{ fontSize: 12.5, color: NCo.text1, lineHeight: 1.55, letterSpacing: -0.2 }}>{c.text}</div>
                  <div style={{ fontSize: 10, color: NCo.text3, marginTop: 6, display: 'flex', gap: 12 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M7 11v9h3V11M7 11l4-7a2 2 0 013 1v4h5a2 2 0 012 2l-1 6a2 2 0 01-2 2H10" stroke={NCo.text3} strokeWidth="1.4"/></svg>
                      {c.like}
                    </span>
                    <span>답글</span>
                    <span>공유</span>
                  </div>
                </div>
              </div>

              {/* Replies */}
              {c.replies && (
                <div style={{ paddingLeft: 38, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10, borderLeft: `1px solid ${NCo.line}`, marginLeft: 14 }}>
                  {c.replies.map((r, j) => {
                    const rt = TCo[r.team];
                    return (
                      <div key={j} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', paddingLeft: 10 }}>
                        <div style={{ width: 22, height: 22, borderRadius: '50%', background: waCo(rt.primary, 0.22), display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 9, fontWeight: 800, color: NCo.text1 }}>
                          {r.name[0]}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 1 }}>
                            <span style={{ fontSize: 10.5, fontWeight: 800, color: rt.light }}>{r.name}</span>
                            <span style={{ fontSize: 8.5, fontWeight: 800, padding: '1px 4px', borderRadius: 3, background: waCo('#ffffff', 0.08), color: NCo.text3 }}>Lv.{r.lvl}</span>
                            <span style={{ marginLeft: 'auto', fontSize: 9, color: NCo.text4 }}>{r.time}</span>
                          </div>
                          <div style={{ fontSize: 11.5, color: NCo.text1, lineHeight: 1.5 }}>{r.text}</div>
                          <div style={{ fontSize: 9.5, color: NCo.text3, marginTop: 4, display: 'flex', gap: 10 }}>
                            <span>❤ {r.like}</span>
                            <span>답글</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─────────────────────────── 6) Search

function ScreenCommunitySearch({ team, palette }) {
  const recent = ['문동주 구속', '잠실 직관', '오스틴 재계약', '오늘 선발'];
  const trending = [
    { r: 1, kw: '장성우 홈런', chg: 'up' },
    { r: 2, kw: '9회말 역전',  chg: 'up' },
    { r: 3, kw: '박영현',      chg: 'new' },
    { r: 4, kw: '김도영 홈런', chg: 'same' },
    { r: 5, kw: '오늘 라인업', chg: 'down' },
    { r: 6, kw: '추신수',      chg: 'up' },
    { r: 7, kw: '심판 판정',   chg: 'down' },
    { r: 8, kw: '허슬두',      chg: 'same' },
  ];
  return (
    <>
      <StatusBar tint={NCo.text1}/>

      {/* Search bar */}
      <div style={{
        padding: '10px 16px',
        display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: `1px solid ${NCo.line}`,
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M15 5l-7 7 7 7" stroke={NCo.text2} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <div style={{
          flex: 1, padding: '8px 14px', borderRadius: 999,
          background: NCo.bg2, border: `1px solid ${NCo.line}`,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="6.5" stroke={NCo.text3} strokeWidth="1.6"/>
            <path d="M16 16l4 4" stroke={NCo.text3} strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <span style={{ fontSize: 12, color: NCo.text1, letterSpacing: -0.2 }}>장성우</span>
          <div style={{ width: 2, height: 14, background: palette.accent, marginLeft: -4, animation: 'blink 1s infinite' }}/>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 'auto' }}>
            <circle cx="12" cy="12" r="9" fill={NCo.text3}/>
            <path d="M8 8l8 8M16 8l-8 8" stroke={NCo.bg0} strokeWidth="1.8" strokeLinecap="round"/>
          </svg>
        </div>
      </div>

      {/* Recent */}
      <div style={{ padding: '16px 16px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: NCo.text3, letterSpacing: 1, textTransform: 'uppercase' }}>최근 검색</span>
          <span style={{ fontSize: 10, color: NCo.text4 }}>전체 삭제</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {recent.map((k, i) => (
            <div key={i} style={{
              padding: '5px 4px 5px 10px', borderRadius: 999,
              background: NCo.bg2, border: `1px solid ${NCo.line}`,
              fontSize: 11, color: NCo.text2,
              display: 'flex', alignItems: 'center', gap: 4,
            }}>
              {k}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.5, marginLeft: 2 }}>
                <path d="M6 6l12 12M18 6L6 18" stroke={NCo.text3} strokeWidth="1.8"/>
              </svg>
            </div>
          ))}
        </div>
      </div>

      {/* Trending */}
      <div style={{ padding: '12px 16px 10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <span style={{ fontSize: 11, fontWeight: 800, color: NCo.text3, letterSpacing: 1, textTransform: 'uppercase' }}>실시간 인기</span>
          <span style={{ fontSize: 9, color: NCo.text4 }}>21:47 기준</span>
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 16px',
        }}>
          {trending.map((t, i) => (
            <div key={i} style={{
              padding: '7px 0',
              display: 'grid', gridTemplateColumns: '18px 1fr auto', gap: 8, alignItems: 'center',
            }}>
              <span style={{
                fontSize: 13, fontWeight: 900, fontVariantNumeric: 'tabular-nums',
                color: t.r <= 3 ? palette.accent : NCo.text3, letterSpacing: -0.5,
              }}>{t.r}</span>
              <span style={{ fontSize: 12, color: NCo.text1, letterSpacing: -0.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.kw}</span>
              <span style={{
                fontSize: 9, fontWeight: 800,
                color: t.chg === 'up' ? NCo.win :
                       t.chg === 'down' ? NCo.text4 :
                       t.chg === 'new' ? NCo.live : NCo.text3,
              }}>
                {t.chg === 'up' && '▲'}
                {t.chg === 'down' && '▼'}
                {t.chg === 'new' && 'N'}
                {t.chg === 'same' && '−'}
              </span>
            </div>
          ))}
        </div>
      </div>

      <TabBar active="community" palette={palette}/>
    </>
  );
}

// ─────────────────────────── 7) Activity feed

function ScreenCommunityActivity({ team, palette }) {
  const items = [
    { t: 'like',    from: '잠실키드', team: 'doosan', target: '오늘 잠실 직관 후기', time: '방금',   lvl: 38 },
    { t: 'comment', from: '야구즐기자', team: 'lg', target: '오늘 잠실 직관 후기', text: '축하드려요. 명승부였네요', time: '10분 전', lvl: 12 },
    { t: 'mention', from: '잠실의신',  team: 'doosan', target: '내일 선발 라인업 예상', text: '@베어스러버 어떻게 생각해?', time: '34분 전', lvl: 42 },
    { t: 'like',    from: '야덕후',    team: 'doosan', target: '오늘 잠실 직관 후기', time: '1시간 전', lvl: 22 },
    { t: 'follow',  from: '새내기팬',  team: 'lg',     time: '2시간 전', lvl: 3 },
    { t: 'level',   target: 'Lv.52 달성', time: '어제',   detail: '열혈팬 티어' },
  ];

  const iconFor = (t) => {
    if (t === 'like')    return { s: '❤', c: NCo.live };
    if (t === 'comment') return { s: '💬', c: palette.accent };
    if (t === 'mention') return { s: '@', c: NCo.warn };
    if (t === 'follow')  return { s: '+', c: NCo.win };
    return { s: '★', c: palette.accent };
  };

  return (
    <>
      <StatusBar tint={NCo.text1}/>
      <PhoneHeader title="활동" back={false} right={
        <span style={{ fontSize: 11, fontWeight: 700, color: palette.accent }}>모두 읽음</span>
      }/>

      <ChipTabs tabs={['전체', '멘션', '댓글', '좋아요', '팔로우']} active="전체" palette={palette}/>

      <div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column' }}>
        {items.map((x, i) => {
          const ico = iconFor(x.t);
          const ct = x.team ? TCo[x.team] : null;
          const unread = i < 3;
          return (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '36px 1fr auto', gap: 10, alignItems: 'center',
              padding: '14px 0', borderBottom: i < items.length - 1 ? `1px solid ${NCo.line}` : 'none',
              position: 'relative',
            }}>
              {unread && (
                <div style={{
                  position: 'absolute', left: -8, top: '50%', transform: 'translateY(-50%)',
                  width: 6, height: 6, borderRadius: '50%', background: palette.accent,
                }}/>
              )}
              <div style={{ position: 'relative' }}>
                {ct ? (
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: waCo(ct.primary, 0.25), border: `1px solid ${waCo(ct.primary, 0.4)}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 800, color: NCo.text1 }}>
                    {x.from[0]}
                  </div>
                ) : (
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: waCo(palette.base, 0.2), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>🎉</div>
                )}
                <div style={{
                  position: 'absolute', bottom: -3, right: -3,
                  width: 18, height: 18, borderRadius: '50%',
                  background: ico.c, border: `2px solid ${NCo.bg0}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 9, fontWeight: 900, color: '#fff',
                }}>{ico.s}</div>
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, color: NCo.text1, letterSpacing: -0.2, lineHeight: 1.45 }}>
                  {x.from && <b style={{ color: ct?.light || NCo.text1 }}>{x.from}</b>}
                  {x.t === 'like'    && <> 님이 <b style={{ color: NCo.text1 }}>{x.target}</b> 을(를) 좋아합니다.</>}
                  {x.t === 'comment' && <> 님이 댓글을 남겼습니다.</>}
                  {x.t === 'mention' && <> 님이 회원님을 멘션했습니다.</>}
                  {x.t === 'follow'  && <> 님이 회원님을 팔로우합니다.</>}
                  {x.t === 'level'   && <b style={{ color: palette.accent }}>{x.target}</b>}
                </div>
                {x.text && (
                  <div style={{ fontSize: 11, color: NCo.text3, marginTop: 2, fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    &ldquo;{x.text}&rdquo;
                  </div>
                )}
                {x.detail && (
                  <div style={{ fontSize: 11, color: NCo.text3, marginTop: 2 }}>{x.detail}</div>
                )}
                <div style={{ fontSize: 9.5, color: NCo.text4, marginTop: 3 }}>{x.time}</div>
              </div>
              {x.t === 'follow' && (
                <div style={{
                  fontSize: 10, fontWeight: 700, color: palette.accent,
                  padding: '5px 10px', borderRadius: 999, border: `1px solid ${waCo(palette.base, 0.35)}`,
                }}>맞팔로우</div>
              )}
            </div>
          );
        })}
      </div>

      <TabBar active="community" palette={palette}/>
    </>
  );
}

Object.assign(window, {
  ScreenCommunityHome,
  ScreenCommunityBoard,
  ScreenCommunityPost,
  ScreenCommunityComposer,
  ScreenCommunityComments,
  ScreenCommunitySearch,
  ScreenCommunityActivity,
});
