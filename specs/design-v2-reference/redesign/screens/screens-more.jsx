// Predict / Highlights / News / Tickets / Stadium
// Depends on: window.KBO, PhoneFrame, StatusBar, TabBar, TeamLogo, PhoneHeader

const NMR = window.KBO.NEUTRAL;

function withA(hex, a) {
  const h = hex.replace('#','');
  const r = parseInt(h.slice(0,2),16);
  const g = parseInt(h.slice(2,4),16);
  const b = parseInt(h.slice(4,6),16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ─────────────── 40 · 예측 투표 (경기 시작 전)
function ScreenPredictVote({ team, palette }) {
  const away = window.KBO.TEAMS.ssg;
  const home = window.KBO.TEAMS.lg;
  const myPick = 'home';
  return (
    <div style={{ background: NMR.bg1, minHeight:'100%', display:'flex', flexDirection:'column' }}>
      <StatusBar tint={NMR.text1}/>
      <PhoneHeader title="오늘의 예측" right={
        <span style={{ fontSize: 11, fontWeight:800, color: palette.accent, letterSpacing:0.6 }}>MY: 72%</span>
      }/>
      <div style={{ padding:'0 0 100px' }}>
        {/* hero match */}
        <div style={{ margin:'0 20px 16px', borderRadius: 20, overflow:'hidden',
          background:`linear-gradient(160deg, ${withA(away.primary, 0.14)} 0%, ${withA(home.primary, 0.14)} 100%)`,
          border:`1px solid ${NMR.line}`, padding: 20 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom: 14 }}>
            <div style={{ fontSize:10, fontWeight:800, color:NMR.text3, letterSpacing:1 }}>9/24 · 18:30 · 잠실</div>
            <div style={{ padding:'3px 8px', borderRadius:6, background:NMR.text1, color:NMR.bg1, fontSize:9, fontWeight:800, letterSpacing:1 }}>VOTE OPEN</div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr auto 1fr', alignItems:'center', gap: 14 }}>
            <div style={{ textAlign:'center' }}>
              <TeamLogo team={window.KBO.TEAMS.ssg} size={58}/>
              <div style={{ fontSize:13, fontWeight:800, color:NMR.text1, marginTop:8 }}>{away.nameKo}</div>
              <div style={{ fontSize:10, color:NMR.text3, marginTop:2 }}>원정 · 2위</div>
            </div>
            <div style={{ fontSize:11, fontWeight:800, color:NMR.text3, letterSpacing:1 }}>VS</div>
            <div style={{ textAlign:'center' }}>
              <TeamLogo team={window.KBO.TEAMS.lg} size={58}/>
              <div style={{ fontSize:13, fontWeight:800, color:NMR.text1, marginTop:8 }}>{home.nameKo}</div>
              <div style={{ fontSize:10, color:NMR.text3, marginTop:2 }}>홈 · 1위</div>
            </div>
          </div>
        </div>

        {/* win pick */}
        <div style={{ padding:'0 20px 12px' }}>
          <div style={{ fontSize:12, fontWeight:800, color:NMR.text2, marginBottom:10, letterSpacing:-0.2 }}>승부 예측 <span style={{ color: NMR.text3, fontWeight:600 }}>· 팬 14,203명 참여</span></div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap: 10 }}>
            {[
              { slug:'ssg', label:'SSG 승', pct: 38, on:false },
              { slug:'lg',  label:'LG 승',  pct: 62, on:myPick==='home' },
            ].map(p => (
              <div key={p.slug} style={{
                padding:'14px 14px 12px', borderRadius:14,
                background: p.on ? withA(palette.base, 0.1) : NMR.bg2,
                border: p.on ? `2px solid ${palette.base}` : `1px solid ${NMR.line}`,
                position:'relative', overflow:'hidden',
              }}>
                <div style={{ position:'absolute', left:0, bottom:0, width: `${p.pct}%`, height: 4, background: p.on ? palette.base : NMR.line }}/>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom: 6 }}>
                  <TeamLogo team={window.KBO.TEAMS[p.slug]} size={22}/>
                  <span style={{ fontSize:12, fontWeight:800, color:NMR.text1 }}>{p.label}</span>
                </div>
                <div style={{ fontSize: 22, fontWeight: 900, color: p.on ? palette.base : NMR.text1, letterSpacing:-0.6 }}>{p.pct}<span style={{ fontSize:11 }}>%</span></div>
                {p.on && <div style={{ fontSize:9, fontWeight:800, color: palette.base, letterSpacing:1, marginTop:2 }}>MY PICK</div>}
              </div>
            ))}
          </div>
        </div>

        {/* prop bets */}
        <div style={{ padding:'8px 20px 12px' }}>
          <div style={{ fontSize:12, fontWeight:800, color:NMR.text2, marginBottom:10, letterSpacing:-0.2 }}>미니 예측</div>
          {[
            { q:'총 득점', opts:[{t:'7점 이하', p:42},{t:'8~10점', p:35, on:true},{t:'11점+', p:23}] },
            { q:'홈런 개수', opts:[{t:'0개', p:28},{t:'1~2개', p:54, on:true},{t:'3개+', p:18}] },
            { q:'MVP 후보', opts:[{t:'오스틴', p:31, on:true},{t:'박동원', p:24},{t:'홍창기', p:45}] },
          ].map((row,i) => (
            <div key={i} style={{ padding:'12px 14px', background: NMR.bg1, border:`1px solid ${NMR.line}`, borderRadius:12, marginBottom:8 }}>
              <div style={{ fontSize:11, fontWeight:700, color:NMR.text2, marginBottom:8 }}>{row.q}</div>
              <div style={{ display:'flex', gap:6 }}>
                {row.opts.map((o,j)=>(
                  <div key={j} style={{
                    flex:1, padding:'7px 0', textAlign:'center', borderRadius:8,
                    background: o.on ? palette.accent : NMR.bg2,
                    color: o.on ? palette.onAccent : NMR.text2,
                    fontSize:10, fontWeight:800, letterSpacing:-0.1,
                    border: o.on ? 'none' : `1px solid ${NMR.line}`,
                  }}>
                    <div>{o.t}</div>
                    <div style={{ fontSize:9, opacity:0.8, marginTop:2 }}>{o.p}%</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* streak */}
        <div style={{ margin:'4px 20px 0', padding:'12px 14px', borderRadius:12,
          background: NMR.text1, color: NMR.bg1, display:'flex', alignItems:'center', gap:12 }}>
          <div style={{ fontSize: 22, fontWeight: 900, letterSpacing:-0.5, color: palette.accent }}>7연승</div>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:11, fontWeight:800, marginBottom:2 }}>예측 스트릭</div>
            <div style={{ fontSize:10, opacity:0.7 }}>적중률 상위 3.2% · 다음 적중 시 +120P</div>
          </div>
        </div>
      </div>
      <TabBar active="home" palette={palette}/>
    </div>
  );
}

// ─────────────── 41 · 하이라이트 피드 (세로 숏폼)
function ScreenHighlights({ team, palette }) {
  return (
    <div style={{ background:'#000', minHeight:'100%', position:'relative', overflow:'hidden', color:'#fff' }}>
      <StatusBar tint="#fff"/>
      {/* video frame mock */}
      <div style={{ position:'absolute', inset:0,
        background:`
          radial-gradient(ellipse at 30% 20%, ${withA(palette.base, 0.35)} 0%, transparent 55%),
          radial-gradient(ellipse at 70% 80%, ${withA(palette.accent, 0.25)} 0%, transparent 60%),
          linear-gradient(180deg, #1a1a1a 0%, #000 70%)`,
      }}/>
      {/* faux diamond */}
      <svg width="100%" height="100%" viewBox="0 0 420 900" style={{ position:'absolute', inset:0, opacity:0.35 }}>
        <path d="M210 360 L320 470 L210 580 L100 470 Z" stroke="#fff" strokeWidth="2" fill="none"/>
        <circle cx="210" cy="470" r="4" fill="#fff"/>
        <circle cx="210" cy="360" r="10" fill={palette.accent}/>
      </svg>

      {/* top tabs */}
      <div style={{ position:'absolute', top: 56, left:0, right:0, display:'flex', justifyContent:'center', gap:18, zIndex:2 }}>
        {['FOR YOU','FOLLOWING','LIVE'].map((t,i)=>(
          <div key={t} style={{ fontSize:12, fontWeight:800, color: i===0 ? '#fff' : 'rgba(255,255,255,0.5)', letterSpacing:0.4,
            borderBottom: i===0 ? `2px solid ${palette.accent}` : '2px solid transparent', padding:'6px 2px' }}>{t}</div>
        ))}
      </div>

      {/* play indicator */}
      <div style={{ position:'absolute', left:'50%', top:'38%', transform:'translate(-50%,-50%)',
        width: 78, height: 78, borderRadius:999, border:'3px solid rgba(255,255,255,0.8)',
        display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}>
        <div style={{ width:0, height:0, borderLeft:'22px solid #fff', borderTop:'14px solid transparent', borderBottom:'14px solid transparent', marginLeft:6 }}/>
      </div>

      {/* scoreboard chip */}
      <div style={{ position:'absolute', top: 106, left: 16, right: 16, display:'flex', justifyContent:'space-between', alignItems:'center', zIndex:2 }}>
        <div style={{ padding:'6px 10px', borderRadius:8, background:'rgba(0,0,0,0.55)', backdropFilter:'blur(8px)',
          display:'flex', alignItems:'center', gap:8, fontSize:11, fontWeight:800 }}>
          <TeamLogo team={window.KBO.TEAMS.ssg} size={18} mono="light"/>
          <span>3</span>
          <span style={{ color:'rgba(255,255,255,0.5)' }}>:</span>
          <span>5</span>
          <TeamLogo team={window.KBO.TEAMS.lg} size={18} mono="light"/>
          <span style={{ marginLeft:6, fontSize:9, fontWeight:700, color:'#ff6b6b' }}>● 9회말</span>
        </div>
        <div style={{ padding:'5px 9px', borderRadius:6, background:withA(palette.accent, 0.25), border:`1px solid ${palette.accent}`,
          fontSize:9, fontWeight:900, letterSpacing:1, color: palette.accent }}>끝내기</div>
      </div>

      {/* bottom meta + actions */}
      <div style={{ position:'absolute', bottom: 110, left: 0, right: 0, padding:'0 16px', zIndex:2,
        display:'flex', alignItems:'flex-end', justifyContent:'space-between', gap: 14 }}>
        <div style={{ flex:1 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom: 10 }}>
            <div style={{ width: 34, height: 34, borderRadius:999, background: palette.accent,
              display:'flex', alignItems:'center', justifyContent:'center', color: palette.onAccent, fontSize:12, fontWeight:900 }}>LG</div>
            <div>
              <div style={{ fontSize:13, fontWeight:800 }}>@lg_twins_official</div>
              <div style={{ fontSize:10, opacity:0.7 }}>공식 · 2시간 전</div>
            </div>
            <div style={{ marginLeft:'auto', padding:'5px 11px', borderRadius:999, background:palette.base, fontSize:10, fontWeight:800 }}>팔로우</div>
          </div>
          <div style={{ fontSize:14, fontWeight:700, lineHeight:1.4, marginBottom: 6, textWrap:'pretty' }}>
            박동원 9회말 끝내기 투런 💥
          </div>
          <div style={{ fontSize:11, opacity:0.75, lineHeight:1.4 }}>
            #박동원 #끝내기 #LG #LGvsSSG #0924 · 구장 잠실
          </div>
        </div>
        {/* right rail */}
        <div style={{ display:'flex', flexDirection:'column', gap: 16, alignItems:'center', paddingBottom:4 }}>
          {[
            { n:'12.4K', s:'좋아요' },
            { n:'842', s:'댓글' },
            { n:'3.1K', s:'공유' },
          ].map((x,i)=>(
            <div key={i} style={{ textAlign:'center' }}>
              <div style={{ width: 42, height: 42, borderRadius:999, background:'rgba(255,255,255,0.15)', border:'1px solid rgba(255,255,255,0.3)' }}/>
              <div style={{ fontSize:10, fontWeight:800, marginTop: 4 }}>{x.n}</div>
            </div>
          ))}
        </div>
      </div>

      {/* progress bar */}
      <div style={{ position:'absolute', bottom: 86, left:16, right:16, height: 3, background:'rgba(255,255,255,0.2)', borderRadius:2, zIndex:2 }}>
        <div style={{ width:'62%', height:'100%', background: palette.accent, borderRadius:2 }}/>
      </div>

      <TabBar active="highlights" palette={palette} dark/>
    </div>
  );
}

// ─────────────── 42 · 뉴스 리스트
function ScreenNewsList({ team, palette }) {
  const stories = [
    { tag:'SCOOP', title:'LG 트윈스, 포스트시즌 불펜 정비 완료… "경기 끝까지 믿는다"', src:'스포츠동아', time:'32분 전', img: palette.base },
    { tag:'분석', title:'SSG vs LG 상대전적으로 본 한국시리즈 시나리오', src:'KBO 매거진', time:'1시간 전', img: palette.accent },
    { tag:'인터뷰', title:'박동원 "끝내기 순간, 응원가가 들려서 배트가 움직였다"', src:'스포츠서울', time:'2시간 전', img: palette.base },
    { tag:'이슈', title:'KT, 외국인 투수 교체 발표… 대체자는 베테랑 좌완', src:'OSEN', time:'3시간 전', img: NMR.text1 },
    { tag:'칼럼', title:'세이브왕 경쟁, 마지막 10경기가 가른다', src:'일간스포츠', time:'5시간 전', img: NMR.text2 },
  ];
  return (
    <div style={{ background: NMR.bg1, minHeight:'100%' }}>
      <StatusBar tint={NMR.text1}/>
      <PhoneHeader title="뉴스" right={
        <span style={{ fontSize:16, color: NMR.text2 }}>⌕</span>
      }/>
      {/* chips */}
      <div style={{ padding:'0 20px 14px', display:'flex', gap:6, overflow:'hidden' }}>
        {[{t:'전체',on:true},{t:'내 팀'},{t:'이적'},{t:'부상'},{t:'경기 리뷰'},{t:'칼럼'}].map(x=>(
          <div key={x.t} style={{
            padding:'7px 12px', borderRadius:999, fontSize:11, fontWeight:800, letterSpacing:-0.2,
            background: x.on ? palette.accent : NMR.bg2, color: x.on ? palette.onAccent : NMR.text2,
            border: x.on ? 'none' : `1px solid ${NMR.line}`, whiteSpace:'nowrap',
          }}>{x.t}</div>
        ))}
      </div>

      {/* hero story */}
      <div style={{ margin:'0 20px 14px', borderRadius: 16, overflow:'hidden', border:`1px solid ${NMR.line}` }}>
        <div style={{ height: 160, background:`linear-gradient(135deg, ${palette.base} 0%, ${withA(palette.base,0.6)} 100%)`, position:'relative' }}>
          <div style={{ position:'absolute', left: 14, top: 14, padding:'4px 10px', borderRadius:6,
            background:'rgba(255,255,255,0.9)', color: palette.base, fontSize:10, fontWeight:900, letterSpacing:1 }}>HEADLINE</div>
          <div style={{ position:'absolute', right: 14, top: 14, fontSize: 42, fontWeight:900, color:'rgba(255,255,255,0.25)', letterSpacing:-2 }}>LG</div>
        </div>
        <div style={{ padding:'14px 14px 16px' }}>
          <div style={{ fontSize: 15, fontWeight:800, color: NMR.text1, lineHeight:1.35, textWrap:'pretty', marginBottom: 8 }}>
            LG 트윈스, 포스트시즌 불펜 정비 완료… "경기 끝까지 믿는다"
          </div>
          <div style={{ fontSize:10, color: NMR.text3, display:'flex', alignItems:'center', gap:6 }}>
            <span>스포츠동아</span><span>·</span><span>32분 전</span><span>·</span><span>읽음 4.2K</span>
          </div>
        </div>
      </div>

      {/* list */}
      <div style={{ padding:'0 20px 100px' }}>
        {stories.slice(1).map((s, i) => (
          <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 88px', gap:12,
            padding:'14px 0', borderBottom: i<stories.length-2 ? `1px solid ${NMR.line}` : 'none' }}>
            <div>
              <div style={{ fontSize:10, fontWeight:800, color: palette.base, letterSpacing:0.6, marginBottom: 6 }}>{s.tag}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color: NMR.text1, lineHeight: 1.35, textWrap:'pretty', marginBottom: 8 }}>
                {s.title}
              </div>
              <div style={{ fontSize:10, color: NMR.text3, display:'flex', gap:6 }}>
                <span>{s.src}</span><span>·</span><span>{s.time}</span>
              </div>
            </div>
            <div style={{ width: 88, height: 88, borderRadius:10,
              background:`linear-gradient(135deg, ${s.img} 0%, ${withA(s.img, 0.5)} 100%)` }}/>
          </div>
        ))}
      </div>
      <TabBar active="home" palette={palette}/>
    </div>
  );
}

// ─────────────── 43 · 뉴스 상세
function ScreenNewsDetail({ team, palette }) {
  return (
    <div style={{ background: NMR.bg1, minHeight:'100%' }}>
      <StatusBar tint={NMR.text1}/>
      <PhoneHeader title="" back
        right={<div style={{ display:'flex', gap: 14, color: NMR.text2 }}>
          <span style={{ fontSize:15 }}>♡</span>
          <span style={{ fontSize:15 }}>↗</span>
          <span style={{ fontSize:15 }}>⋯</span>
        </div>}
      />
      <div style={{ padding:'0 0 100px' }}>
        {/* hero image */}
        <div style={{ height: 220, background:`linear-gradient(135deg, ${palette.base} 0%, ${palette.accent} 100%)`, position:'relative', marginBottom: 16 }}>
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(180deg, transparent 50%, rgba(0,0,0,0.45) 100%)' }}/>
          <div style={{ position:'absolute', left: 16, bottom: 12, fontSize:10, color:'rgba(255,255,255,0.85)', fontWeight:600 }}>사진 · 스포츠동아 김민수 기자</div>
        </div>
        {/* meta */}
        <div style={{ padding:'0 20px' }}>
          <div style={{ display:'inline-block', padding:'4px 10px', borderRadius:6, background: withA(palette.base, 0.1), color: palette.base, fontSize:10, fontWeight:900, letterSpacing:1, marginBottom: 14 }}>SCOOP</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: NMR.text1, lineHeight: 1.25, letterSpacing:-0.5, textWrap:'pretty', marginBottom: 14 }}>
            LG 트윈스, 포스트시즌 불펜 정비 완료… "경기 끝까지 믿는다"
          </div>
          <div style={{ display:'flex', alignItems:'center', gap: 10, paddingBottom: 16, marginBottom: 16, borderBottom:`1px solid ${NMR.line}` }}>
            <div style={{ width: 36, height: 36, borderRadius:999, background: NMR.bg2, border:`1px solid ${NMR.line}` }}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:800, color: NMR.text1 }}>스포츠동아 · 김민수</div>
              <div style={{ fontSize:10, color: NMR.text3 }}>2024.09.24 14:32 · 4분 읽기</div>
            </div>
            <div style={{ padding:'6px 11px', borderRadius:999, background: NMR.text1, color: NMR.bg1, fontSize:10, fontWeight:800 }}>구독</div>
          </div>

          {/* body */}
          <div style={{ fontSize:14, lineHeight: 1.7, color: NMR.text1 }}>
            <p style={{ margin:'0 0 14px', fontWeight: 600 }}>LG 트윈스가 포스트시즌을 앞두고 불펜진 재정비를 마쳤다. 마무리 고우석의 복귀와 함께 필승조가 다시 한 번 가동된다.</p>
            <p style={{ margin:'0 0 14px' }}>감독은 24일 훈련 후 취재진과 만나 "경기 끝까지 믿을 수 있는 그림이 나왔다. 선발이 5이닝만 책임져주면 나머지는 불펜이 지킨다"고 밝혔다.</p>
            <div style={{ margin:'18px 0', padding:'14px 16px', borderLeft:`3px solid ${palette.base}`, background: NMR.bg2,
              fontSize:14, fontWeight: 700, fontStyle:'italic', lineHeight:1.5 }}>
              "1년간 준비한 것을 10월에 쏟아붓는다. 팬들이 끝까지 믿고 응원해주시면 좋겠다."
            </div>
            <p style={{ margin:'0 0 14px' }}>불펜 가동 순서는 김진성-정우영-함덕주-고우석으로 굳어졌다…</p>
          </div>

          {/* related */}
          <div style={{ marginTop: 24, padding: 16, background: NMR.bg2, borderRadius: 14 }}>
            <div style={{ fontSize:11, fontWeight:800, color: NMR.text3, letterSpacing:1, marginBottom: 10 }}>관련 기사</div>
            {['포스트시즌 매직넘버, 이제 2경기 남았다','박동원 "끝내기 순간, 배트가 저절로 움직였다"'].map((t,i)=>(
              <div key={i} style={{ fontSize:12, fontWeight:700, color: NMR.text1, padding:'10px 0', borderTop: i===0 ? 'none' : `1px solid ${NMR.line}`, textWrap:'pretty' }}>{t}</div>
            ))}
          </div>
        </div>
      </div>
      <TabBar active="home" palette={palette}/>
    </div>
  );
}

// ─────────────── 44 · 티켓 예매 (좌석맵)
function ScreenTickets({ team, palette }) {
  return (
    <div style={{ background: NMR.bg1, minHeight:'100%' }}>
      <StatusBar tint={NMR.text1}/>
      <PhoneHeader title="티켓 예매" right={<span style={{ fontSize:11, color: palette.accent, fontWeight:800 }}>내 티켓</span>}/>
      <div style={{ padding:'0 0 140px' }}>
        {/* match strip */}
        <div style={{ margin:'0 20px 14px', padding:'14px 16px', borderRadius:14, background: NMR.text1, color: NMR.bg1 }}>
          <div style={{ fontSize:10, opacity:0.7, letterSpacing:0.8, marginBottom: 8 }}>9월 24일 · 화 · 18:30 · 잠실</div>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <TeamLogo team={window.KBO.TEAMS.ssg} size={26} mono="light"/>
            <span style={{ fontSize:14, fontWeight:800 }}>SSG</span>
            <span style={{ fontSize:11, opacity:0.5, margin:'0 4px' }}>vs</span>
            <TeamLogo team={window.KBO.TEAMS.lg} size={26} mono="light"/>
            <span style={{ fontSize:14, fontWeight:800 }}>LG</span>
            <div style={{ marginLeft:'auto', padding:'4px 10px', borderRadius:999, background: palette.accent, color: palette.onAccent, fontSize:10, fontWeight:900 }}>잔여 12%</div>
          </div>
        </div>

        {/* stadium map */}
        <div style={{ margin:'0 20px 16px', padding: 16, borderRadius: 16, border:`1px solid ${NMR.line}`, background: NMR.bg2 }}>
          <div style={{ fontSize:11, fontWeight:800, color: NMR.text2, marginBottom: 10 }}>구역을 선택하세요</div>
          <svg viewBox="0 0 360 240" style={{ width:'100%', height: 'auto' }}>
            {/* field */}
            <path d="M180 200 L260 130 L180 60 L100 130 Z" fill={withA(palette.base, 0.08)} stroke={NMR.text3} strokeWidth="1"/>
            <circle cx="180" cy="130" r="3" fill={NMR.text3}/>
            {/* sections */}
            {[
              { d:'M 40 200 L 140 200 L 120 140 L 30 140 Z', label:'내야1루', price:'45K', color: palette.base, on:true },
              { d:'M 220 200 L 320 200 L 330 140 L 240 140 Z', label:'내야3루', price:'45K', color: NMR.bg1 },
              { d:'M 30 130 L 120 130 L 100 80 L 30 80 Z', label:'외야응원', price:'20K', color: palette.accent },
              { d:'M 240 130 L 330 130 L 330 80 L 260 80 Z', label:'외야 원정', price:'20K', color: NMR.bg1 },
              { d:'M 140 200 L 220 200 L 220 160 L 140 160 Z', label:'중앙석', price:'120K', color: '#222' },
              { d:'M 100 80 L 260 80 L 260 30 L 100 30 Z', label:'상단석', price:'15K', color: NMR.bg1 },
            ].map((s,i)=>(
              <g key={i}>
                <path d={s.d} fill={s.color} stroke={s.on ? palette.base : NMR.line} strokeWidth={s.on ? 2.5 : 1} opacity={s.color === NMR.bg1 ? 1 : 0.85}/>
              </g>
            ))}
            {/* labels */}
            <text x="85" y="175" fontSize="8" fontWeight="700" fill={palette.onAccent} textAnchor="middle">1루 내야</text>
            <text x="275" y="175" fontSize="8" fontWeight="700" fill={NMR.text1} textAnchor="middle">3루 내야</text>
            <text x="70" y="110" fontSize="8" fontWeight="700" fill={palette.onAccent} textAnchor="middle">외야 응원</text>
            <text x="290" y="110" fontSize="8" fontWeight="700" fill={NMR.text1} textAnchor="middle">원정</text>
            <text x="180" y="184" fontSize="8" fontWeight="700" fill="#fff" textAnchor="middle">중앙</text>
          </svg>
          {/* legend */}
          <div style={{ display:'flex', gap: 12, marginTop: 10, fontSize: 10, color: NMR.text3 }}>
            <span style={{ display:'flex', alignItems:'center', gap:4 }}>
              <span style={{ width:10, height:10, background:palette.base, borderRadius:2 }}/>선택
            </span>
            <span style={{ display:'flex', alignItems:'center', gap:4 }}>
              <span style={{ width:10, height:10, background:NMR.bg1, border:`1px solid ${NMR.line}`, borderRadius:2 }}/>예매 가능
            </span>
            <span style={{ display:'flex', alignItems:'center', gap:4 }}>
              <span style={{ width:10, height:10, background:'#222', borderRadius:2 }}/>매진
            </span>
          </div>
        </div>

        {/* selected section detail */}
        <div style={{ margin:'0 20px', padding:'16px', borderRadius: 14, background: withA(palette.base, 0.06), border: `2px solid ${palette.base}` }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom: 10 }}>
            <div>
              <div style={{ fontSize:10, fontWeight:800, color: palette.base, letterSpacing:0.8, marginBottom: 4 }}>SELECTED</div>
              <div style={{ fontSize: 16, fontWeight: 900, color: NMR.text1 }}>1루 내야 응원석</div>
              <div style={{ fontSize:10, color: NMR.text3, marginTop: 2 }}>블록 115 · 남은 좌석 143석</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize: 18, fontWeight:900, color: NMR.text1, letterSpacing:-0.5 }}>45,000<span style={{ fontSize:11, fontWeight:700, color: NMR.text3 }}>원</span></div>
              <div style={{ fontSize:9, color: NMR.text3 }}>1매 기준</div>
            </div>
          </div>
          <div style={{ display:'flex', gap: 6, marginTop: 8 }}>
            {['일반','청소년','경로','단체'].map((t,i)=>(
              <div key={t} style={{ flex:1, padding:'8px 0', borderRadius:8, textAlign:'center',
                background: i===0 ? palette.accent : NMR.bg1, color: i===0 ? palette.onAccent : NMR.text2,
                fontSize:10, fontWeight:800, border: i===0 ? 'none' : `1px solid ${NMR.line}` }}>{t}</div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA */}
      <div style={{ position:'absolute', bottom: 68, left: 0, right: 0, padding: 16, background: NMR.bg1, borderTop:`1px solid ${NMR.line}` }}>
        <div style={{ padding:'14px 0', textAlign:'center', borderRadius:12, background: palette.base, color:'#fff', fontSize:13, fontWeight:900, letterSpacing:0.3 }}>
          선택한 좌석으로 예매하기
        </div>
      </div>
      <TabBar active="home" palette={palette}/>
    </div>
  );
}

// ─────────────── 45 · 구장 가이드
function ScreenStadium({ team, palette }) {
  return (
    <div style={{ background: NMR.bg1, minHeight:'100%' }}>
      <StatusBar tint={NMR.text1}/>
      <PhoneHeader title="" back right={<span style={{ fontSize:14, color: NMR.text2 }}>♡</span>}/>
      <div style={{ padding:'0 0 100px' }}>
        {/* hero */}
        <div style={{ height: 200, position:'relative',
          background:`linear-gradient(160deg, ${palette.base} 0%, ${withA(palette.base, 0.7)} 50%, ${NMR.text1} 100%)` }}>
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.5) 100%)' }}/>
          <div style={{ position:'absolute', left:20, bottom: 20, right: 20, color:'#fff' }}>
            <div style={{ fontSize:10, fontWeight:700, letterSpacing:1.2, opacity:0.8, marginBottom: 4 }}>SEOUL · 잠실</div>
            <div style={{ fontSize: 22, fontWeight:900, letterSpacing:-0.5 }}>잠실야구장</div>
            <div style={{ fontSize:11, opacity:0.85, marginTop: 4 }}>LG 트윈스 · 두산 베어스 홈구장 · 수용 25,000</div>
          </div>
          <div style={{ position:'absolute', right: 16, top: 16, display:'flex', gap:6 }}>
            {['홈','원정','공원'].map((t,i)=>(
              <div key={t} style={{ padding:'5px 10px', borderRadius:999,
                background: i===0 ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.15)',
                color: i===0 ? palette.base : '#fff', fontSize:10, fontWeight:900, letterSpacing:0.3,
                backdropFilter:'blur(6px)' }}>{t}</div>
            ))}
          </div>
        </div>

        {/* quick stats */}
        <div style={{ padding:'16px 20px 0', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap: 10 }}>
          {[
            { n:'25,000', s:'수용인원' },
            { n:'2호선', s:'종합운동장' },
            { n:'4.7', s:'팬 별점' },
          ].map((x,i)=>(
            <div key={i} style={{ padding:'12px 10px', background: NMR.bg2, borderRadius:12, textAlign:'center' }}>
              <div style={{ fontSize:15, fontWeight:900, color: NMR.text1, letterSpacing:-0.3 }}>{x.n}</div>
              <div style={{ fontSize:9, color: NMR.text3, fontWeight:700, marginTop:2 }}>{x.s}</div>
            </div>
          ))}
        </div>

        {/* sections with pills */}
        <div style={{ padding:'16px 20px 6px' }}>
          <div style={{ fontSize:12, fontWeight:800, color: NMR.text2, marginBottom: 10, letterSpacing:-0.2 }}>응원 좌석 추천</div>
          {[
            { name:'1루 내야 응원석', tag:'LG', sub:'육성응원 · 치킨로드 근처', rating: 4.8, color: palette.base },
            { name:'3루 외야 그린존', tag:'가족', sub:'조용함 · 잔디 · 그늘 많음', rating: 4.5, color: '#4a7c3d' },
            { name:'중앙 프리미엄', tag:'전망', sub:'정면 뷰 · 푹신한 좌석', rating: 4.9, color: '#333' },
          ].map((s,i)=>(
            <div key={i} style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 0', borderBottom: i<2 ? `1px solid ${NMR.line}` : 'none' }}>
              <div style={{ width: 44, height: 44, borderRadius:12, background: s.color,
                display:'flex', alignItems:'center', justifyContent:'center', color:'#fff', fontSize:10, fontWeight:900 }}>{s.tag}</div>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:800, color: NMR.text1 }}>{s.name}</div>
                <div style={{ fontSize:10, color: NMR.text3, marginTop:2 }}>{s.sub}</div>
              </div>
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:12, fontWeight:900, color: NMR.text1 }}>★ {s.rating}</div>
                <div style={{ fontSize:9, color: NMR.text3 }}>리뷰 312</div>
              </div>
            </div>
          ))}
        </div>

        {/* food */}
        <div style={{ padding:'16px 20px 6px' }}>
          <div style={{ fontSize:12, fontWeight:800, color: NMR.text2, marginBottom: 10, letterSpacing:-0.2 }}>꼭 먹어야 하는 것 🍗</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap: 10 }}>
            {[
              { n:'잠실 치킨', p:'18,000', c: palette.accent },
              { n:'응원 맥주', p:'6,000', c: '#e6c84a' },
              { n:'구단 핫도그', p:'7,500', c: '#c94a3f' },
            ].map((f,i)=>(
              <div key={i} style={{ padding:10, borderRadius:12, border:`1px solid ${NMR.line}` }}>
                <div style={{ width:'100%', aspectRatio:'1', borderRadius:8, background: withA(f.c, 0.3), marginBottom: 8,
                  display:'flex', alignItems:'center', justifyContent:'center', color: f.c, fontSize:22, fontWeight:900 }}>◷</div>
                <div style={{ fontSize:11, fontWeight:800, color: NMR.text1 }}>{f.n}</div>
                <div style={{ fontSize:10, color: NMR.text3, fontWeight:700, marginTop:2 }}>{f.p}원</div>
              </div>
            ))}
          </div>
        </div>

        {/* transit */}
        <div style={{ margin:'18px 20px 0', padding: 14, borderRadius: 12, background: NMR.text1, color: NMR.bg1 }}>
          <div style={{ fontSize:10, fontWeight:800, letterSpacing:1, opacity:0.6, marginBottom: 8 }}>GETTING THERE</div>
          <div style={{ display:'flex', alignItems:'center', gap: 10, marginBottom: 6 }}>
            <div style={{ width: 26, height: 26, borderRadius:6, background: '#4eb325', display:'flex', alignItems:'center', justifyContent:'center', fontSize:10, fontWeight:900 }}>2</div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, fontWeight:800 }}>종합운동장역 5·6번 출구</div>
              <div style={{ fontSize:10, opacity:0.6 }}>도보 3분</div>
            </div>
            <div style={{ fontSize:10, fontWeight:800, color: palette.accent }}>경로 →</div>
          </div>
        </div>
      </div>
      <TabBar active="home" palette={palette}/>
    </div>
  );
}

Object.assign(window, {
  ScreenPredictVote,
  ScreenHighlights,
  ScreenNewsList,
  ScreenNewsDetail,
  ScreenTickets,
  ScreenStadium,
});
