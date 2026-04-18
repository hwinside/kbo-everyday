// Modals: onboarding steps, composer, comment sheet, context menu, toasts
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, PhoneHeader

const NMOD = window.KBO.NEUTRAL;
function withAMod(hex, a) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16), g = parseInt(h.slice(2,4),16), b = parseInt(h.slice(4,6),16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Blurred content behind modal
function FauxContentBehind({ palette }) {
  return (
    <div style={{ position:'absolute', inset:0, filter:'blur(2px) brightness(0.96)', opacity:0.85 }}>
      <div style={{ height: 56, background: NMOD.bg1 }}/>
      <div style={{ height: 56, background: palette.base }}/>
      <div style={{ padding: 16, display:'flex', flexDirection:'column', gap: 12 }}>
        {[0,1,2].map(i=>(
          <div key={i} style={{ height: 110, borderRadius: 14, background: NMOD.bg2, border:`1px solid ${NMOD.line}` }}/>
        ))}
      </div>
    </div>
  );
}

// 46 · 팀 선택 온보딩
function ModalTeamPicker({ team, palette }) {
  const teams = ['lg','doosan','kia','ssg','samsung','lotte','kt','hanwha','nc','kiwoom'];
  return (
    <div style={{ background: NMOD.bg1, minHeight:'100%', position:'relative', overflow:'hidden' }}>
      <StatusBar tint={NMOD.text1}/>
      <div style={{ padding:'16px 20px 0' }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: palette.base, letterSpacing: 1.5, marginBottom: 10 }}>STEP 1 / 3</div>
        <div style={{ height: 4, background: NMOD.bg2, borderRadius: 2, marginBottom: 24, overflow:'hidden' }}>
          <div style={{ width:'33%', height:'100%', background: palette.base }}/>
        </div>
        <div style={{ fontSize: 24, fontWeight: 900, color: NMOD.text1, letterSpacing:-0.6, lineHeight: 1.2, marginBottom: 8, textWrap:'pretty' }}>
          당신의 팀을<br/>선택해 주세요
        </div>
        <div style={{ fontSize: 13, color: NMOD.text3, lineHeight:1.5, marginBottom: 24, textWrap:'pretty' }}>
          앱의 모든 색과 응원, 추천은 여러분의 팀을 중심으로 움직입니다.
        </div>
      </div>
      <div style={{ padding: '0 20px', display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 12 }}>
        {teams.map((slug, i) => {
          const t = window.KBO.TEAMS[slug];
          const on = slug === 'lg';
          return (
            <div key={slug} style={{
              padding: '18px 10px 14px',
              borderRadius: 16,
              background: on ? t.primary : NMOD.bg2,
              border: on ? `2px solid ${t.primary}` : `1px solid ${NMOD.line}`,
              display:'flex', flexDirection:'column', alignItems:'center', gap: 8,
              position:'relative',
            }}>
              <TeamLogo team={t} size={38} bg={on ? 'rgba(255,255,255,0.95)' : '#fff'}/>
              <div style={{ fontSize: 10, fontWeight: 800, color: on ? '#fff' : NMOD.text1, letterSpacing:-0.2 }}>{t.nameKo}</div>
              {on && (
                <div style={{ position:'absolute', top:6, right:6, width: 16, height: 16, borderRadius:999,
                  background:'#fff', color: t.primary, fontSize:11, fontWeight:900,
                  display:'flex', alignItems:'center', justifyContent:'center' }}>✓</div>
              )}
            </div>
          );
        })}
      </div>
      <div style={{ padding: '24px 20px', position:'absolute', left: 0, right: 0, bottom: 0 }}>
        <div style={{ padding: '16px 0', borderRadius: 12, background: palette.base, color:'#fff',
          fontSize: 14, fontWeight: 900, textAlign:'center', letterSpacing: 0.3 }}>
          LG 트윈스로 시작하기
        </div>
      </div>
    </div>
  );
}

// 47 · 글쓰기 컴포저 (바텀시트)
function ModalComposer({ team, palette }) {
  return (
    <div style={{ background: '#000', minHeight:'100%', position:'relative', overflow:'hidden' }}>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.35)' }}/>
      <FauxContentBehind palette={palette}/>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.45)', backdropFilter:'blur(3px)' }}/>
      {/* sheet */}
      <div style={{ position:'absolute', left: 0, right: 0, bottom: 0, top: 130,
        background: NMOD.bg1, borderTopLeftRadius: 22, borderTopRightRadius: 22,
        boxShadow:'0 -20px 50px rgba(0,0,0,0.35)', overflow:'hidden' }}>
        {/* handle */}
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 4px' }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: NMOD.line }}/>
        </div>
        <div style={{ padding:'10px 20px 14px', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontSize:13, fontWeight:700, color: NMOD.text2 }}>취소</div>
          <div style={{ fontSize: 14, fontWeight: 900, color: NMOD.text1 }}>글쓰기</div>
          <div style={{ padding:'7px 14px', borderRadius:999, background: palette.base, color: '#fff',
            fontSize: 12, fontWeight: 800 }}>등록</div>
        </div>

        {/* audience */}
        <div style={{ padding: '8px 20px 14px', display:'flex', alignItems:'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 999, background: palette.base,
            display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:12, fontWeight:900 }}>잠</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: NMOD.text1 }}>@jamsil_fan</div>
            <div style={{ padding:'3px 9px', borderRadius:999, background: withAMod(palette.base, 0.1),
              color: palette.base, fontSize: 10, fontWeight: 800, display:'inline-block', marginTop: 3 }}>
              # LG 트윈스 팬 공간
            </div>
          </div>
        </div>

        {/* textarea mock */}
        <div style={{ padding:'0 20px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: NMOD.text1, lineHeight: 1.4, letterSpacing:-0.3, textWrap:'pretty' }}>
            박동원 끝내기 보는데 심장이 진짜
          </div>
          <div style={{ display:'inline-block', width: 2, height: 22, background: palette.base, verticalAlign:'middle', marginLeft: 2,
            animation:'blink 1s steps(1) infinite' }}/>
          <div style={{ fontSize: 14, color: NMOD.text3, marginTop: 12, lineHeight:1.5 }}>
            #끝내기 #박동원 #LG
          </div>
        </div>

        {/* attached game card */}
        <div style={{ margin:'16px 20px 0', padding: 12, borderRadius: 12, background: NMOD.bg2, border: `1px solid ${NMOD.line}`,
          display:'flex', alignItems:'center', gap: 10 }}>
          <div style={{ width: 44, height: 44, borderRadius: 8, background: NMOD.text1, color:'#fff',
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:900 }}>경기</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: NMOD.text1 }}>SSG 3 : 5 LG · 9회말</div>
            <div style={{ fontSize: 9, color: NMOD.text3, marginTop: 2 }}>오늘 경기 · 잠실</div>
          </div>
          <div style={{ fontSize: 16, color: NMOD.text3 }}>×</div>
        </div>

        {/* toolbar */}
        <div style={{ position:'absolute', bottom: 20, left: 0, right: 0, padding:'10px 20px',
          borderTop: `1px solid ${NMOD.line}`, background: NMOD.bg1,
          display:'flex', alignItems:'center', gap: 18 }}>
          {['📷','📹','#','GIF','📊','📍'].map((ic,i)=>(
            <div key={i} style={{ fontSize: 18, color: NMOD.text2, opacity: i===0 ? 1 : 0.7 }}>{ic}</div>
          ))}
          <div style={{ marginLeft:'auto', fontSize:11, color: NMOD.text3, fontWeight:700 }}>218 / 500</div>
        </div>
      </div>
    </div>
  );
}

// 48 · 댓글 시트 (from 게시글 상세)
function ModalCommentSheet({ team, palette }) {
  const comments = [
    { u:'@twins_dongwon', t:'9회말이면 심장 무조건 터짐ㅠㅠ', like: 132, time: '1분', me:true, color: palette.base },
    { u:'@ssgforever', t:'솔직히 오늘은 인정합니다… 박수 드려요 👏', like: 87, time: '3분', me:false, color: '#C8102E' },
    { u:'@jamsil_goer', t:'직관 가서 봤는데 진짜 일어섰습니다', like: 45, time: '5분', me:false, color: palette.base },
    { u:'@kt_wizard', t:'PO에서 다시 붙자 ㅋㅋ 오늘은 인정', like: 33, time: '8분', me:false, color: '#000' },
  ];
  return (
    <div style={{ background:'#000', minHeight:'100%', position:'relative', overflow:'hidden' }}>
      <FauxContentBehind palette={palette}/>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.55)' }}/>
      <div style={{ position:'absolute', left:0, right:0, bottom:0, top: 90,
        background: NMOD.bg1, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow:'hidden' }}>
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 4px' }}>
          <div style={{ width: 40, height: 4, borderRadius: 2, background: NMOD.line }}/>
        </div>
        <div style={{ padding:'8px 20px 14px', display:'flex', alignItems:'center', justifyContent:'space-between', borderBottom:`1px solid ${NMOD.line}` }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: NMOD.text1 }}>댓글 <span style={{ color: NMOD.text3, fontWeight:700 }}>842</span></div>
          <div style={{ display:'flex', gap:14, fontSize:11, color: NMOD.text2, fontWeight:700 }}>
            <span style={{ color: palette.base, fontWeight:800 }}>인기순</span>
            <span>최신순</span>
          </div>
        </div>

        <div style={{ padding: '10px 20px 90px' }}>
          {comments.map((c, i)=>(
            <div key={i} style={{ display:'flex', gap: 10, padding:'12px 0', borderBottom: i<comments.length-1 ? `1px solid ${NMOD.line}` : 'none' }}>
              <div style={{ width: 36, height: 36, borderRadius:999, background: c.color,
                border: `2px solid ${withAMod(c.color, 0.35)}`,
                display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:11, fontWeight:900 }}>
                {c.u[1].toUpperCase()}
              </div>
              <div style={{ flex:1 }}>
                <div style={{ display:'flex', alignItems:'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: NMOD.text1 }}>{c.u}</span>
                  {c.me && <span style={{ padding:'2px 7px', borderRadius:4, background: palette.base, color:'#fff', fontSize:8, fontWeight:900 }}>ME</span>}
                  <span style={{ fontSize:10, color: NMOD.text3 }}>· {c.time}</span>
                </div>
                <div style={{ fontSize: 13, color: NMOD.text1, lineHeight:1.5, textWrap:'pretty' }}>{c.t}</div>
                <div style={{ display:'flex', gap: 14, marginTop: 8, fontSize: 10, color: NMOD.text3, fontWeight:700 }}>
                  <span>♡ {c.like}</span>
                  <span>답글 달기</span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* input bar */}
        <div style={{ position:'absolute', bottom: 0, left: 0, right: 0, padding:'10px 16px 20px',
          background: NMOD.bg1, borderTop: `1px solid ${NMOD.line}`,
          display:'flex', alignItems:'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 999, background: palette.base }}/>
          <div style={{ flex: 1, padding: '10px 14px', borderRadius: 999, background: NMOD.bg2, fontSize: 12, color: NMOD.text3 }}>
            @twins_dongwon 님에게 답글 달기…
          </div>
          <div style={{ width: 34, height: 34, borderRadius: 999, background: palette.base,
            display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:15 }}>↑</div>
        </div>
      </div>
    </div>
  );
}

// 49 · 컨텍스트 메뉴 / 롱프레스
function ModalContextMenu({ team, palette }) {
  return (
    <div style={{ background:'#000', minHeight:'100%', position:'relative', overflow:'hidden' }}>
      <FauxContentBehind palette={palette}/>
      <div style={{ position:'absolute', inset:0, background:'rgba(0,0,0,0.62)' }}/>
      {/* highlighted card */}
      <div style={{ position:'absolute', top: 130, left: 20, right: 20, padding:'14px 16px',
        background: NMOD.bg1, borderRadius: 14, boxShadow:'0 16px 40px rgba(0,0,0,0.4)',
        transform:'scale(1.02)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius:999, background: palette.base, color:'#fff',
            display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:900 }}>LG</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: NMOD.text1 }}>@twins_dongwon</div>
            <div style={{ fontSize: 10, color: NMOD.text3 }}>2분 전</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: NMOD.text1, lineHeight: 1.5 }}>
          끝내기 보는데 심장이 진짜… #박동원
        </div>
      </div>

      {/* menu */}
      <div style={{ position:'absolute', top: 240, right: 30, width: 220,
        background: NMOD.bg1, borderRadius: 14, overflow:'hidden',
        boxShadow:'0 12px 36px rgba(0,0,0,0.45)' }}>
        {[
          { ic:'↗', t:'공유하기' },
          { ic:'🔖', t:'저장' },
          { ic:'⊕', t:'이 사람 팔로우' },
          { ic:'⊘', t:'관심 없음', sub:'비슷한 게시물 덜 보기' },
          { ic:'🚩', t:'신고하기', danger: true },
        ].map((m,i)=>(
          <div key={i} style={{
            padding:'13px 14px',
            display:'flex', alignItems:'center', gap: 12,
            borderBottom: i<4 ? `1px solid ${NMOD.line}` : 'none',
            color: m.danger ? '#c94a3f' : NMOD.text1,
          }}>
            <span style={{ fontSize: 14, width: 20, textAlign:'center' }}>{m.ic}</span>
            <div style={{ flex:1 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>{m.t}</div>
              {m.sub && <div style={{ fontSize: 10, color: NMOD.text3, marginTop: 2 }}>{m.sub}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* reaction tray */}
      <div style={{ position:'absolute', top: 96, left: 36, padding: 8,
        background: NMOD.bg1, borderRadius: 999, boxShadow:'0 10px 30px rgba(0,0,0,0.35)',
        display:'flex', gap: 4 }}>
        {['❤️','🔥','😂','😭','👏','⚾'].map((e,i)=>(
          <div key={i} style={{
            width: 34, height: 34, borderRadius: 999,
            display:'flex', alignItems:'center', justifyContent:'center',
            fontSize: 18,
            background: i===1 ? withAMod(palette.accent, 0.25) : 'transparent',
            transform: i===1 ? 'scale(1.25)' : 'scale(1)',
          }}>{e}</div>
        ))}
      </div>
    </div>
  );
}

// 50 · 알림 토스트 스택
function ModalToasts({ team, palette }) {
  return (
    <div style={{ background: NMOD.bg1, minHeight:'100%', position:'relative', overflow:'hidden' }}>
      <FauxContentBehind palette={palette}/>
      {/* Live score banner (top) */}
      <div style={{ position:'absolute', top: 54, left: 12, right: 12, padding: 12,
        background: NMOD.text1, color: NMOD.bg1, borderRadius: 14,
        boxShadow:'0 10px 28px rgba(0,0,0,0.35)',
        display:'flex', alignItems:'center', gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: 999, background:'#ff4d4d',
          boxShadow:`0 0 0 4px ${withAMod('#ff4d4d', 0.3)}` }}/>
        <TeamLogo team={window.KBO.TEAMS.ssg} size={22}/>
        <div style={{ fontSize: 14, fontWeight: 900, letterSpacing:-0.3 }}>3 : 5</div>
        <TeamLogo team={window.KBO.TEAMS.lg} size={22}/>
        <div style={{ marginLeft:'auto', fontSize: 10, fontWeight:800, color: palette.accent, letterSpacing:0.4 }}>9회말</div>
      </div>

      {/* Home run burst — mid */}
      <div style={{ position:'absolute', top: 160, left: 12, right: 12, padding:'14px 16px',
        background:`linear-gradient(120deg, ${palette.base} 0%, ${palette.accent} 100%)`, color:'#fff',
        borderRadius: 16, boxShadow:`0 14px 36px ${withAMod(palette.base, 0.4)}`,
        display:'flex', alignItems:'center', gap: 12 }}>
        <div style={{ fontSize: 28 }}>🎉</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 1.2, opacity: 0.85 }}>HOMERUN · 9회말</div>
          <div style={{ fontSize: 14, fontWeight: 900, marginTop: 2, letterSpacing:-0.3 }}>박동원 끝내기 투런! 5 : 3</div>
        </div>
        <div style={{ padding:'6px 10px', borderRadius: 999, background:'rgba(255,255,255,0.25)', backdropFilter:'blur(8px)',
          fontSize: 10, fontWeight: 900, letterSpacing:0.4 }}>보기 →</div>
      </div>

      {/* Friend activity (below) */}
      <div style={{ position:'absolute', top: 254, left: 12, right: 12, padding:'12px 14px',
        background: NMOD.bg1, borderRadius: 14, border:`1px solid ${NMOD.line}`,
        boxShadow:'0 8px 24px rgba(0,0,0,0.08)',
        display:'flex', alignItems:'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius:999, background: palette.base, color:'#fff',
          display:'flex', alignItems:'center', justifyContent:'center', fontSize: 12, fontWeight: 900 }}>J</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize: 12, color: NMOD.text1, lineHeight: 1.4 }}>
            <b>@jamsil_goer</b> 님과 <b>3명</b>이 지금 경기를 보고 있어요
          </div>
          <div style={{ fontSize: 10, color: NMOD.text3, marginTop: 2 }}>함께 시청 초대 받기</div>
        </div>
      </div>

      {/* Small toast bottom */}
      <div style={{ position:'absolute', bottom: 90, left: '50%', transform:'translateX(-50%)',
        padding:'10px 16px', background: NMOD.text1, color: NMOD.bg1, borderRadius: 999,
        fontSize: 12, fontWeight: 700, display:'flex', alignItems:'center', gap: 8,
        boxShadow:'0 10px 24px rgba(0,0,0,0.35)' }}>
        <span style={{ color: palette.accent }}>✓</span>
        저장되었습니다 · 내 보관함에서 보기
      </div>

      <style>{`@keyframes blink { 50% { opacity: 0 } }`}</style>
    </div>
  );
}

// 51 · 유틸리티 · 에러·빈 상태·로딩
function ModalUtility({ team, palette }) {
  return (
    <div style={{ background: NMOD.bg1, minHeight:'100%', padding: 20 }}>
      <StatusBar tint={NMOD.text1}/>
      <div style={{ fontSize:10, fontWeight:800, color: NMOD.text3, letterSpacing:1.2, marginBottom: 12 }}>UTILITY STATES</div>

      {/* empty */}
      <div style={{ padding: '28px 20px', textAlign:'center', border:`1px dashed ${NMOD.line}`, borderRadius: 16, marginBottom: 14 }}>
        <div style={{ width: 60, height: 60, margin:'0 auto 14px', borderRadius: 16,
          background: withAMod(palette.base, 0.1), display:'flex', alignItems:'center', justifyContent:'center',
          color: palette.base, fontSize: 26, fontWeight: 900 }}>⚾</div>
        <div style={{ fontSize: 14, fontWeight: 800, color: NMOD.text1, marginBottom: 6 }}>아직 팔로우한 사람이 없어요</div>
        <div style={{ fontSize: 11, color: NMOD.text3, lineHeight: 1.5, marginBottom: 14, textWrap:'pretty' }}>
          좋아하는 팬을 팔로우하면 이곳에서 그들의 활동을 볼 수 있어요.
        </div>
        <div style={{ display:'inline-block', padding:'10px 18px', borderRadius: 999,
          background: palette.base, color:'#fff', fontSize: 12, fontWeight: 800 }}>추천 팬 찾아보기</div>
      </div>

      {/* error */}
      <div style={{ padding: '14px 16px', background:'#fff4f3', border:`1px solid #e9b5b0`, borderRadius: 12,
        display:'flex', alignItems:'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{ width: 22, height: 22, borderRadius: 999, background:'#c94a3f', color:'#fff',
          fontSize:12, fontWeight:900, display:'flex', alignItems:'center', justifyContent:'center' }}>!</div>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:12, fontWeight:800, color:'#8a241b' }}>연결이 끊겼습니다</div>
          <div style={{ fontSize:11, color:'#8a241b', opacity:0.85, marginTop: 2 }}>와이파이를 확인하거나 다시 시도해 주세요.</div>
          <div style={{ display:'inline-block', marginTop:10, padding:'6px 12px', borderRadius:999,
            background:'#c94a3f', color:'#fff', fontSize:10, fontWeight:800 }}>다시 시도</div>
        </div>
      </div>

      {/* skeleton */}
      <div style={{ padding: 14, border:`1px solid ${NMOD.line}`, borderRadius: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight:800, color: NMOD.text3, letterSpacing: 1.2, marginBottom: 10 }}>LOADING · SKELETON</div>
        {[0,1,2].map(i=>(
          <div key={i} style={{ display:'flex', gap: 10, marginBottom: 10 }}>
            <div style={{ width: 40, height: 40, borderRadius: 999,
              background: `linear-gradient(90deg, ${NMOD.bg2} 0%, ${NMOD.line} 50%, ${NMOD.bg2} 100%)` }}/>
            <div style={{ flex:1 }}>
              <div style={{ height: 10, width:'60%', borderRadius: 4, background: NMOD.bg2, marginBottom: 6 }}/>
              <div style={{ height: 10, width:'90%', borderRadius: 4, background: NMOD.bg2, marginBottom: 6 }}/>
              <div style={{ height: 10, width:'40%', borderRadius: 4, background: NMOD.bg2 }}/>
            </div>
          </div>
        ))}
      </div>

      {/* confirm dialog */}
      <div style={{ padding: 14, borderRadius: 16, background: NMOD.bg1, border:`1px solid ${NMOD.line}` }}>
        <div style={{ fontSize: 14, fontWeight: 900, color: NMOD.text1, marginBottom: 6 }}>경기 알림을 끌까요?</div>
        <div style={{ fontSize: 11, color: NMOD.text3, lineHeight: 1.5, marginBottom: 14 }}>
          설정에서 언제든 다시 켤 수 있어요. 득점 · 홈런 · 경기 종료 알림이 중단됩니다.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 8 }}>
          <div style={{ padding: '11px 0', textAlign:'center', borderRadius: 10, background: NMOD.bg2, color: NMOD.text1, fontSize:12, fontWeight:800 }}>취소</div>
          <div style={{ padding: '11px 0', textAlign:'center', borderRadius: 10, background: '#c94a3f', color: '#fff', fontSize:12, fontWeight:800 }}>알림 끄기</div>
        </div>
      </div>
    </div>
  );
}

Object.assign(window, {
  ModalTeamPicker,
  ModalComposer,
  ModalCommentSheet,
  ModalContextMenu,
  ModalToasts,
  ModalUtility,
});
