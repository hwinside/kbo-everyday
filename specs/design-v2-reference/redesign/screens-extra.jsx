/* ===== screen-community.jsx + screen-my.jsx =====
   Extra screens: team community board + My page.
   Depends on atoms (TeamLogo, StatusBar, TabBar, SectionTitle) + window.KBO.
*/

const { NEUTRAL: NC, withAlpha: waC } = window.KBO;

// ─────────────────────────── helpers
function Avatar({ team, size = 32, seed = 0 }) {
  // Placeholder circle tinted with team color, initial letter.
  const hues = ['#E04050','#9BA8D4','#E85050','#FFB81C','#7DA3C9','#D45C5C','#6BC4E8','#5A8FBD','#FFA766','#C97088'];
  const c = hues[seed % hues.length];
  const letter = ['민','윤','재','수','하','지','예','서','도','준'][seed % 10];
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `linear-gradient(135deg, ${c} 0%, ${NC.bg2} 100%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.42, fontWeight: 700, color: '#fff',
      flexShrink: 0, border: `1px solid ${NC.line}`,
    }}>{letter}</div>
  );
}

// ─────────────────────────── Community — team board
function ScreenCommunity({ team, palette }) {
  const posts = [
    { id: 1, author: '민지', lvl: 42, badge: '직관왕', time: '2분 전',
      title: '오늘 직관 가시는 분 계세요?', body: '1루 응원석 4열이에요. 저희 팀 화이팅!',
      likes: 24, comments: 12, hot: true, img: true },
    { id: 2, author: '준호', lvl: 18, badge: null, time: '14분 전',
      title: '오늘 선발 ERA 봤냐?', body: '완전 미쳤다. 시즌 들어와서 3연속 QS+ 찍고 있음',
      likes: 56, comments: 31, hot: true, img: false },
    { id: 3, author: '서연', lvl: 7, badge: null, time: '31분 전',
      title: '유니폼 사이즈 문의', body: '이번 시즌 어센틱 XL이 평소 XL보다 타이트한 편인가요?',
      likes: 4, comments: 8, hot: false, img: false },
    { id: 4, author: '도윤', lvl: 27, badge: '분석가', time: '1시간 전',
      title: '타율 vs 출루율 — 우리 팀 3번 타자',
      body: '최근 10경기 OPS .912. 타격 조정 후 정말 안정화되는 느낌.',
      likes: 92, comments: 47, hot: true, img: false },
  ];

  return (
    <>
      <StatusBar tint={NC.text1}/>
      {/* Ambient team tint */}
      <div style={{
        position: 'absolute', inset: 0,
        background: `
          radial-gradient(90% 40% at 50% -5%, ${palette.ambient}, transparent 60%)
        `,
        pointerEvents: 'none',
      }}/>

      <div style={{ position: 'relative', zIndex: 1, paddingBottom: 100 }}>
        {/* Header */}
        <div style={{
          padding: '4px 20px 12px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 22, color: NC.text2, fontWeight: 400 }}>‹</div>
          <TeamLogo team={team} size={28} pad={3}/>
          <div style={{ fontSize: 17, fontWeight: 700, color: NC.text1, letterSpacing: -0.3, flex: 1 }}>
            {team.name}
          </div>
          <div style={{
            padding: '6px 12px', borderRadius: 999,
            border: `1px solid ${NC.line}`, background: NC.bg2,
            fontSize: 11, fontWeight: 700, color: NC.text2,
          }}>다른 팀</div>
        </div>

        {/* Team hero strip (compact) */}
        <div style={{ padding: '0 20px 14px' }}>
          <div style={{
            position: 'relative',
            borderRadius: 18, overflow: 'hidden',
            background: `linear-gradient(155deg, ${palette.heroBgA} 0%, ${palette.heroBgB} 100%)`,
            border: `1px solid ${withAlpha(palette.base, 0.22)}`,
            padding: '14px 16px',
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{
              position: 'absolute', right: -20, top: -10,
              width: 120, height: 120, opacity: 0.08, pointerEvents: 'none',
            }}>
              <div dangerouslySetInnerHTML={{ __html: ((window.INLINE_LOGOS||{})[team.slug]||'').replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ') }} style={{width:'100%',height:'100%'}}/>
            </div>
            <div style={{ flex: 1, position: 'relative' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: withAlpha(palette.base, 0.9), textTransform: 'uppercase', marginBottom: 4 }}>
                MY TEAM BOARD
              </div>
              <div style={{ fontSize: 13, color: NC.text2, fontWeight: 600 }}>
                오늘 <b style={{ color: NC.text1 }}>428</b>명이 함께 응원 중
              </div>
            </div>
            <div style={{
              fontSize: 11, fontWeight: 700, color: palette.accent,
              padding: '8px 12px', borderRadius: 999,
              background: palette.accentSoft, border: `1px solid ${palette.accentBorder}`,
              letterSpacing: -0.2,
            }}>+ 글쓰기</div>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ padding: '0 20px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            padding: '6px 4px', borderRadius: 10,
            background: NC.bg2, border: `1px solid ${NC.line}`,
            display: 'flex', gap: 2,
          }}>
            {['일반', '사진'].map((t, i) => (
              <div key={t} style={{
                padding: '6px 14px', borderRadius: 8,
                fontSize: 12, fontWeight: 700, letterSpacing: -0.2,
                background: i === 0 ? NC.text1 : 'transparent',
                color: i === 0 ? NC.bg0 : NC.text3,
              }}>{t}</div>
            ))}
          </div>
          <div style={{ flex: 1 }}/>
          {['최신', '인기'].map((t, i) => (
            <div key={t} style={{
              padding: '6px 12px', borderRadius: 999,
              fontSize: 12, fontWeight: 600,
              color: i === 0 ? NC.text1 : NC.text3,
              background: i === 0 ? NC.bg3 : 'transparent',
            }}>{t}</div>
          ))}
        </div>

        {/* Posts */}
        <div style={{ padding: '4px 20px 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {posts.map((p, i) => (
            <div key={p.id} style={{
              padding: '14px 14px',
              borderRadius: 16, background: NC.bg2,
              border: `1px solid ${NC.line}`,
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              {/* author row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Avatar seed={i + team.id} size={26}/>
                <div style={{ fontSize: 12, fontWeight: 700, color: NC.text1, letterSpacing: -0.2 }}>{p.author}</div>
                <div style={{
                  fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
                  padding: '2px 6px', borderRadius: 4,
                  background: withAlpha(palette.base, 0.18), color: palette.accent,
                }}>LV.{p.lvl}</div>
                {p.badge && <div style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: 0.2,
                  padding: '2px 6px', borderRadius: 4,
                  background: NC.bg3, color: NC.text2,
                }}>{p.badge}</div>}
                <div style={{ marginLeft: 'auto', fontSize: 10, color: NC.text3, fontWeight: 600 }}>{p.time}</div>
              </div>
              {/* title + body */}
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: 700, color: NC.text1,
                    letterSpacing: -0.3, lineHeight: 1.35, marginBottom: 3,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {p.hot && <span style={{
                      fontSize: 9, fontWeight: 800, letterSpacing: 0.5,
                      padding: '2px 5px', borderRadius: 4,
                      background: NC.live, color: '#fff',
                    }}>HOT</span>}
                    {p.title}
                  </div>
                  <div style={{
                    fontSize: 12, color: NC.text2, lineHeight: 1.5, letterSpacing: -0.2,
                    overflow: 'hidden', textOverflow: 'ellipsis',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}>{p.body}</div>
                </div>
                {p.img && (
                  <div style={{
                    width: 56, height: 56, borderRadius: 10, flexShrink: 0,
                    background: `linear-gradient(135deg, ${palette.heroBgA} 0%, ${NC.bg3} 100%)`,
                    border: `1px solid ${NC.line}`,
                  }}/>
                )}
              </div>
              {/* actions */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingTop: 4 }}>
                <div style={{ fontSize: 11, color: NC.text3, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: palette.accent }}>♥</span> {p.likes}
                </div>
                <div style={{ fontSize: 11, color: NC.text3, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                  💬 {p.comments}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* FAB */}
      <div style={{
        position: 'absolute', right: 20, bottom: 96,
        width: 52, height: 52, borderRadius: '50%',
        background: palette.accent,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: `0 8px 24px ${withAlpha(palette.base, 0.4)}`,
        color: palette.onAccent, fontSize: 22, fontWeight: 300,
        zIndex: 5,
      }}>✎</div>

      <TabBar active={3} palette={palette}/>
    </>
  );
}

window.ScreenCommunity = ScreenCommunity;

// ─────────────────────────── My Page
function ScreenMy({ team, palette }) {
  const menu = [
    { icon: '🔄', label: '응원 구단 변경', meta: team.name, metaColor: palette.accent, hasChev: true },
    { icon: '📲', label: '앱 설치하기', meta: null, hasChev: true },
    { icon: '⭐', label: '최애 선수', meta: '3명', hasChev: true },
    { icon: '🔔', label: '알림 설정', meta: 'ON', metaColor: NC.win, hasChev: true },
    { icon: '🎨', label: '테마', meta: '다크', hasChev: true },
  ];

  const settings = [
    { label: '공지사항', hasChev: true },
    { label: '이용약관', hasChev: true },
    { label: '개인정보 처리방침', hasChev: true },
    { label: '피드백 보내기', hasChev: true },
  ];

  return (
    <>
      <StatusBar tint={NC.text1}/>
      <div style={{
        position: 'absolute', inset: 0,
        background: `radial-gradient(100% 50% at 50% -10%, ${palette.ambient}, transparent 55%)`,
        pointerEvents: 'none',
      }}/>

      <div style={{ position: 'relative', zIndex: 1, paddingBottom: 100 }}>
        {/* Header */}
        <div style={{
          padding: '4px 20px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: NC.text1, letterSpacing: -0.6 }}>My</div>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: NC.bg3, border: `1px solid ${NC.line}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, color: NC.text2,
          }}>⚙</div>
        </div>

        {/* Profile hero */}
        <div style={{ padding: '0 20px 20px' }}>
          <div style={{
            position: 'relative', overflow: 'hidden',
            borderRadius: 22,
            background: `linear-gradient(160deg, ${palette.heroBgA} 0%, ${palette.heroBgB} 100%)`,
            border: `1px solid ${withAlpha(palette.base, 0.22)}`,
            padding: 20,
          }}>
            {/* big watermark logo */}
            <div style={{
              position: 'absolute', right: -30, bottom: -30,
              width: 180, height: 180, opacity: 0.07, pointerEvents: 'none',
            }}>
              <div dangerouslySetInnerHTML={{ __html: ((window.INLINE_LOGOS||{})[team.slug]||'').replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ') }} style={{width:'100%',height:'100%'}}/>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, position: 'relative' }}>
              {/* avatar with team ring */}
              <div style={{
                width: 64, height: 64, borderRadius: '50%',
                background: `conic-gradient(${palette.accent} 0deg, ${palette.accent} 287deg, ${withAlpha('#ffffff',0.15)} 287deg)`,
                padding: 3, boxSizing: 'border-box',
              }}>
                <div style={{
                  width: '100%', height: '100%', borderRadius: '50%',
                  background: `linear-gradient(135deg, ${palette.base} 0%, ${NC.bg3} 100%)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 24, fontWeight: 800, color: '#fff',
                  border: `2px solid ${NC.bg0}`,
                }}>H</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: NC.text1, letterSpacing: -0.3 }}>크보팬_민지</div>
                  <div style={{
                    fontSize: 9, fontWeight: 800, letterSpacing: 0.4,
                    padding: '2px 6px', borderRadius: 4,
                    background: palette.accent, color: palette.onAccent,
                  }}>LV.42</div>
                </div>
                <div style={{ fontSize: 11, color: NC.text2, fontWeight: 600, letterSpacing: -0.2 }}>
                  {team.name} · 가입 238일째
                </div>
              </div>
            </div>

            {/* level progress */}
            <div style={{ marginBottom: 14, position: 'relative' }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.4, marginBottom: 6,
              }}>
                <span style={{ color: NC.text3 }}>DIAMOND III</span>
                <span style={{ color: NC.text2 }}>
                  <b style={{ color: NC.text1 }}>2,870</b> / 3,000
                </span>
              </div>
              <div style={{
                height: 5, borderRadius: 999,
                background: withAlpha('#ffffff', 0.08),
                overflow: 'hidden',
              }}>
                <div style={{
                  width: '95.6%', height: '100%',
                  background: `linear-gradient(90deg, ${palette.accent} 0%, ${palette.light} 100%)`,
                  borderRadius: 999,
                }}/>
              </div>
            </div>

            {/* stats row */}
            <div style={{
              display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
              paddingTop: 12,
              borderTop: `1px solid ${withAlpha(palette.base, 0.18)}`,
            }}>
              {[
                { n: '128', l: '게시글' },
                { n: '1.2K', l: '받은 ♥' },
                { n: '86%', l: '예측 적중' },
              ].map((s, i) => (
                <div key={s.l} style={{
                  textAlign: 'center',
                  borderLeft: i === 0 ? 'none' : `1px solid ${withAlpha(palette.base, 0.15)}`,
                }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: NC.text1, letterSpacing: -0.5, fontVariantNumeric: 'tabular-nums' }}>{s.n}</div>
                  <div style={{ fontSize: 10, color: NC.text3, fontWeight: 600, letterSpacing: 0.3 }}>{s.l}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Badges strip */}
        <div style={{ padding: '0 20px 20px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 10,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.2, color: NC.text3, textTransform: 'uppercase' }}>
              획득 뱃지 <span style={{ color: palette.accent, marginLeft: 4 }}>12</span>
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: NC.text3 }}>전체 →</div>
          </div>
          <div style={{
            display: 'flex', gap: 8, overflow: 'hidden',
          }}>
            {['🏆','⚾','🔥','💎','🎯','📊','🏟️'].map((e, i) => (
              <div key={i} style={{
                width: 52, height: 52, flexShrink: 0, borderRadius: 14,
                background: i < 3
                  ? `linear-gradient(135deg, ${withAlpha(palette.base, 0.3)} 0%, ${NC.bg2} 100%)`
                  : NC.bg2,
                border: `1px solid ${i < 3 ? palette.accentBorder : NC.line}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 22, opacity: i < 3 ? 1 : 0.35,
              }}>{e}</div>
            ))}
          </div>
        </div>

        {/* Menu section 1 */}
        <div style={{ padding: '0 20px 12px' }}>
          <div style={{
            borderRadius: 16,
            background: NC.bg2,
            border: `1px solid ${NC.line}`,
            overflow: 'hidden',
          }}>
            {menu.map((m, i) => (
              <div key={m.label} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '13px 16px',
                borderTop: i === 0 ? 'none' : `1px solid ${NC.line}`,
              }}>
                <div style={{
                  width: 30, height: 30, borderRadius: 8,
                  background: NC.bg3,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14,
                }}>{m.icon}</div>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: NC.text1, letterSpacing: -0.2 }}>{m.label}</div>
                {m.meta && (
                  <div style={{
                    fontSize: 12, fontWeight: 700,
                    color: m.metaColor || NC.text2, letterSpacing: -0.2,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {m.label === '응원 구단 변경' && (
                      <TeamLogo team={team} size={20} pad={2}/>
                    )}
                    {m.meta}
                  </div>
                )}
                {m.hasChev && <div style={{ color: NC.text3, fontSize: 16 }}>›</div>}
              </div>
            ))}
          </div>
        </div>

        {/* Menu section 2 — settings */}
        <div style={{ padding: '0 20px' }}>
          <div style={{
            borderRadius: 16,
            background: NC.bg2,
            border: `1px solid ${NC.line}`,
            overflow: 'hidden',
          }}>
            {settings.map((m, i) => (
              <div key={m.label} style={{
                display: 'flex', alignItems: 'center',
                padding: '13px 16px',
                borderTop: i === 0 ? 'none' : `1px solid ${NC.line}`,
              }}>
                <div style={{ flex: 1, fontSize: 14, fontWeight: 500, color: NC.text2, letterSpacing: -0.2 }}>{m.label}</div>
                <div style={{ color: NC.text3, fontSize: 16 }}>›</div>
              </div>
            ))}
          </div>
        </div>

        <div style={{
          padding: '20px 20px 0',
          textAlign: 'center', fontSize: 10, color: NC.text3, letterSpacing: 0.3,
        }}>
          크보팬 v1.4.2 · hwinside
        </div>
      </div>

      <TabBar active={4} palette={palette}/>
    </>
  );
}

window.ScreenMy = ScreenMy;
