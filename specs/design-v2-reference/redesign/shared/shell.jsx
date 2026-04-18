/* ===== shell.jsx ===== */
// Shared shell for all redesign section pages.
// - Wraps DesignCanvas
// - Provides team + intensity state via Tweaks panel
// - Handles edit-mode protocol with the host
// - Exposes a common intro header
//
// Usage in a section page:
//   <AppShell introTitle="라이브 스코어보드" introSubtitle="..." editModeKeys={['teamSlug','intensity']}>
//     {({ team, palette }) => (
//       <>
//         <DCSection title="..."> ... </DCSection>
//       </>
//     )}
//   </AppShell>

function AppShell({ introKicker, introTitle, introSubtitle, children, defaults }) {
  const TWEAK_DEFAULTS = defaults || { teamSlug: 'neutral', intensity: 10 };
  const [teamSlug, setTeamSlug] = React.useState(TWEAK_DEFAULTS.teamSlug);
  const [intensity, setIntensity] = React.useState(TWEAK_DEFAULTS.intensity);
  const team = window.KBO.TEAMS[teamSlug];
  const palette = window.KBO.teamPalette(team, intensity);

  // Build team picker once + on team change
  React.useEffect(() => {
    const teams = Object.values(window.KBO.TEAMS);
    const host = document.getElementById('tp-teams');
    if (!host) return;
    host.innerHTML = '';
    teams.forEach(t => {
      const el = document.createElement('div');
      el.className = 'tp-team' + (t.slug === teamSlug ? ' on' : '');
      el.style.color = t.slug === 'neutral'
        ? 'rgba(255,255,255,0.85)'
        : (window.KBO.luminance(t.primary) < 0.06 ? t.light : t.primary);
      if (t.slug === 'neutral') {
        el.innerHTML = '<div style="font-size:10px;font-weight:800;letter-spacing:0.6px;color:rgba(255,255,255,0.85);display:flex;align-items:center;justify-content:center;width:100%;height:100%">중립</div>';
      } else {
        const svg = (window.INLINE_LOGOS || {})[t.slug] || '';
        const fitted = svg.replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="width:100%;height:100%;display:block" ');
        el.innerHTML = fitted;
      }
      el.addEventListener('click', () => setTeamSlug(t.slug));
      host.appendChild(el);
    });
  }, [teamSlug]);

  // Intensity slider
  React.useEffect(() => {
    const s = document.getElementById('tp-intensity');
    const v = document.getElementById('tp-intensity-val');
    if (!s || !v) return;
    v.textContent = intensity;
    const onChange = (e) => setIntensity(parseInt(e.target.value));
    s.value = intensity;
    s.addEventListener('input', onChange);
    return () => s.removeEventListener('input', onChange);
  }, [intensity]);

  // Tweaks protocol
  React.useEffect(() => {
    const onMsg = (e) => {
      if (e.data?.type === '__activate_edit_mode') {
        document.getElementById('tweaks-panel')?.classList.add('open');
      } else if (e.data?.type === '__deactivate_edit_mode') {
        document.getElementById('tweaks-panel')?.classList.remove('open');
      }
    };
    window.addEventListener('message', onMsg);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => window.removeEventListener('message', onMsg);
  }, []);

  React.useEffect(() => {
    window.parent.postMessage({
      type: '__edit_mode_set_keys',
      edits: { teamSlug, intensity }
    }, '*');
  }, [teamSlug, intensity]);

  return (
    <DesignCanvas>
      {(introTitle || introSubtitle || introKicker) && (
        <div style={{ padding: '0 60px 40px', maxWidth: 900 }}>
          {introKicker && (
            <div style={{
              fontSize: 11, fontWeight: 700, letterSpacing: 2,
              color: 'rgba(60,50,40,0.55)', textTransform: 'uppercase',
              marginBottom: 8,
            }}>{introKicker} · {team.name}</div>
          )}
          {introTitle && (
            <div style={{
              fontSize: 36, fontWeight: 700, color: 'rgba(40,30,20,0.88)',
              letterSpacing: -0.8, marginBottom: 10,
            }}>{introTitle}</div>
          )}
          {introSubtitle && (
            <div style={{
              fontSize: 15, lineHeight: 1.6, color: 'rgba(60,50,40,0.7)',
              maxWidth: 620,
            }}>{introSubtitle}</div>
          )}
        </div>
      )}
      {typeof children === 'function' ? children({ team, palette }) : children}
    </DesignCanvas>
  );
}

window.AppShell = AppShell;
