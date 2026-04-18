/* ===== atoms.jsx ===== */
// Shared atomic bits used across all mock screens.
// Depends on window.KBO (tokens.js).

const { NEUTRAL, teamPalette, withAlpha } = window.KBO;

// ─────────────────────────── PhoneFrame
function PhoneFrame({ team, palette, children, label }) {
  const W = 390, H = 844;
  return (
    <div style={{
      width: W + 24, position: 'relative',
    }}>
      {label && (
        <div style={{
          fontSize: 12, fontWeight: 500, color: 'rgba(60,50,40,0.7)',
          marginBottom: 10, paddingLeft: 2,
        }}>{label}</div>
      )}
      <div style={{
        width: W + 24, height: H + 24,
        padding: 12, borderRadius: 52,
        background: '#0a0a0a',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25), 0 16px 40px rgba(0,0,0,0.18)',
        position: 'relative',
      }}>
        <div style={{
          width: W, height: H,
          borderRadius: 40, overflow: 'hidden',
          background: NEUTRAL.bg0,
          position: 'relative',
          fontFamily: '"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
          color: NEUTRAL.text1,
        }}>
          {/* dynamic island */}
          <div style={{
            position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)',
            width: 120, height: 34, borderRadius: 20, background: '#000', zIndex: 50,
          }}/>
          {children}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── StatusBar
function StatusBar({ tint = 'rgba(255,255,255,0.9)' }) {
  return (
    <div style={{
      height: 54, paddingTop: 18, paddingLeft: 28, paddingRight: 28,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 15, fontWeight: 600, color: tint,
      position: 'relative', zIndex: 40,
    }}>
      <span style={{ letterSpacing: -0.2 }}>9:41</span>
      <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <svg width="18" height="11" viewBox="0 0 18 11" fill="none"><path d="M1 10V7M5 10V5M9 10V3M13 10V1M17 10V6" stroke={tint} strokeWidth="1.5" strokeLinecap="round"/></svg>
        <svg width="16" height="11" viewBox="0 0 16 11" fill="none"><path d="M8 9.5c1.5-1.5 3-1.5 4.5 0M5 6.5c2.5-2.5 6-2.5 8.5 0M2 3.5c4-4 10-4 14 0" stroke={tint} strokeWidth="1.5" strokeLinecap="round"/></svg>
        <div style={{
          width: 24, height: 11, borderRadius: 3,
          border: `1px solid ${tint}`, position: 'relative', padding: 1.5,
        }}>
          <div style={{ width: '80%', height: '100%', background: tint, borderRadius: 1 }}/>
        </div>
      </span>
    </div>
  );
}

// ─────────────────────────── TeamLogo (uses <img>)
function TeamLogo({ team, size = 24, bg = '#fff', pad = 3 }) {
  const svg = (window.INLINE_LOGOS || {})[team.slug] || '';
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: bg, padding: pad, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <div
        style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        dangerouslySetInnerHTML={{ __html: svg.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ') }}
      />
    </div>
  );
}

// ─────────────────────────── Section header
function SectionTitle({ children, kicker, right }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
      padding: '0 20px', marginBottom: 12,
    }}>
      <div>
        {kicker && <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 1.2,
          color: NEUTRAL.text3, textTransform: 'uppercase', marginBottom: 4,
        }}>{kicker}</div>}
        <div style={{
          fontSize: 19, fontWeight: 700, color: NEUTRAL.text1,
          letterSpacing: -0.4,
        }}>{children}</div>
      </div>
      {right && <div style={{ fontSize: 13, color: NEUTRAL.text3 }}>{right}</div>}
    </div>
  );
}

// ─────────────────────────── Tab bar (bottom)
function TabBar({ active = 'home', palette }) {
  const items = [
    { k: 'home', label: '홈', icon: (c) => <path d="M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V11z" stroke={c} strokeWidth="1.6" fill="none" strokeLinejoin="round"/> },
    { k: 'games', label: '경기', icon: (c) => <><circle cx="12" cy="12" r="9" stroke={c} strokeWidth="1.6" fill="none"/><path d="M5 7.5c4 3 10 3 14 0M5 16.5c4-3 10-3 14 0" stroke={c} strokeWidth="1.6" fill="none"/></> },
    { k: 'rank', label: '순위', icon: (c) => <><rect x="4" y="13" width="4" height="7" stroke={c} strokeWidth="1.6" fill="none"/><rect x="10" y="8" width="4" height="12" stroke={c} strokeWidth="1.6" fill="none"/><rect x="16" y="4" width="4" height="16" stroke={c} strokeWidth="1.6" fill="none"/></> },
    { k: 'com',   label: '커뮤', icon: (c) => <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" stroke={c} strokeWidth="1.6" fill="none" strokeLinejoin="round"/> },
    { k: 'my',    label: 'My', icon: (c) => <><circle cx="12" cy="8" r="3.5" stroke={c} strokeWidth="1.6" fill="none"/><path d="M4 20c1.5-4 5-6 8-6s6.5 2 8 6" stroke={c} strokeWidth="1.6" fill="none" strokeLinecap="round"/></> },
  ];
  // allow numeric index aliases (0=home, 1=games, 2=rank, 3=com, 4=my)
  const activeKey = typeof active === 'number' ? items[active]?.k : active;
  return (
    <div style={{
      position: 'absolute', bottom: 0, left: 0, right: 0,
      height: 84, paddingBottom: 24,
      background: withAlpha('#000', 0.6),
      backdropFilter: 'blur(24px)',
      WebkitBackdropFilter: 'blur(24px)',
      borderTop: `1px solid ${NEUTRAL.line}`,
      display: 'flex', alignItems: 'center', justifyContent: 'space-around',
      zIndex: 30,
    }}>
      {items.map(it => {
        const on = activeKey === it.k;
        const c = on ? palette.accent : NEUTRAL.text3;
        return (
          <div key={it.k} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1,
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24">{it.icon(c)}</svg>
            <span style={{ fontSize: 10, fontWeight: 600, color: c, letterSpacing: -0.2 }}>{it.label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────── Diamond (baseball field)
function Diamond({ r1, r2, r3, color, size = 44 }) {
  const s = size;
  const Base = ({ cx, cy, on }) => (
    <rect
      x={cx - 5.5} y={cy - 5.5} width={11} height={11}
      transform={`rotate(45 ${cx} ${cy})`}
      fill={on ? color : 'rgba(255,255,255,0.05)'}
      stroke={on ? color : 'rgba(255,255,255,0.15)'}
      strokeWidth={1}
    />
  );
  return (
    <svg width={s} height={s} viewBox="0 0 44 44">
      <Base cx={22} cy={8}  on={r2}/>
      <Base cx={8}  cy={22} on={r3}/>
      <Base cx={36} cy={22} on={r1}/>
      <Base cx={22} cy={36} on={false}/>
    </svg>
  );
}

// ─────────────────────────── Pip row (balls/strikes/outs)
function Pips({ filled, total, color }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {Array.from({length: total}).map((_,i) => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%',
          background: i < filled ? color : 'rgba(255,255,255,0.14)',
        }}/>
      ))}
    </span>
  );
}

Object.assign(window, { PhoneFrame, StatusBar, TeamLogo, SectionTitle, TabBar, Diamond, Pips });