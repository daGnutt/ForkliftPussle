// First-run popup on the splash: pick the keyboard scheme (keyboard devices) or the touch layout (touch devices).
const key = (x, y, t, hi) => `<rect x="${x}" y="${y}" width="30" height="30" rx="5" class="${hi ? 'hi' : ''}"/><text x="${x + 15}" y="${y + 20}">${t}</text>`;
export const KEYBOARD = {
  arrows: { label: 'Arrows + A/Z forks', svg: `<svg viewBox="0 0 220 100">${key(40, 4, '▲')}${key(5, 36, '◀')}${key(40, 36, '▼')}${key(75, 36, '▶')}${key(135, 4, 'A', 1)}${key(135, 36, 'Z', 1)}<text class="cap" x="57" y="86">drive / steer</text><text class="cap" x="150" y="86">forks up / down</text></svg>` },
  wasd: { label: 'WASD + E/Q forks', svg: `<svg viewBox="0 0 220 100">${key(40, 4, 'W')}${key(5, 36, 'A')}${key(40, 36, 'S')}${key(75, 36, 'D')}${key(135, 4, 'E', 1)}${key(135, 36, 'Q', 1)}<text class="cap" x="57" y="86">drive / steer</text><text class="cap" x="150" y="86">forks up / down</text></svg>` },
};
const btn = (x, y, w, h, t, hi) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" class="${hi ? 'hi' : ''}"/><text x="${x + w / 2}" y="${y + h / 2 + 5}">${t}</text>`;
const frame = (inner) => `<svg viewBox="0 0 160 100"><rect x="1" y="1" width="158" height="98" rx="8" class="scr"/>${inner}</svg>`;
// Orange = fork buttons (⇧ up, ⇩ down), grey = drive/steer.
const TOUCH = {
  classic: { label: 'Buttons (classic)', svg: frame(btn(8, 40, 26, 54, '◀') + btn(38, 40, 26, 54, '▶') + btn(96, 52, 26, 20, '▲') + btn(126, 52, 26, 20, '⇧', 1) + btn(96, 76, 26, 20, '▼') + btn(126, 76, 26, 20, '⇩', 1)) },
  rotated: { label: 'Buttons (forks left, drive right)', svg: frame(btn(8, 40, 26, 54, '◀') + btn(38, 40, 26, 54, '▶') + btn(96, 52, 26, 20, '⇧', 1) + btn(96, 76, 26, 20, '⇩', 1) + btn(126, 52, 26, 20, '▲') + btn(126, 76, 26, 20, '▼')) },
  joystick: { label: 'Joystick + fork buttons', svg: frame(btn(8, 52, 26, 20, '⇧', 1) + btn(8, 76, 26, 20, '⇩', 1) + '<rect x="100" y="36" width="52" height="58" rx="8" class="stk"/><circle cx="126" cy="65" r="12" class="knob"/>') },
};

// Gamepad pictogram + hint, shown with the keyboard schemes only.
const PAD = '<svg viewBox="0 0 120 70"><path class="body" d="M30 12h60q18 0 24 30l4 18q1 8-8 6l-14-10H24L10 66q-9 2-8-6l4-18Q12 12 30 12z"/><circle cx="30" cy="27" r="9" class="stk"/><circle cx="30" cy="27" r="4.5" class="knob"/><circle cx="78" cy="44" r="9" class="stk"/><circle cx="78" cy="44" r="4.5" class="knob"/><rect x="43" y="37" width="5" height="14" rx="1.5"/><rect x="38.5" y="41.5" width="14" height="5" rx="1.5"/><circle cx="88" cy="26" r="3.5"/><circle cx="96" cy="19" r="3.5"/><circle cx="104" cy="26" r="3.5"/><circle cx="96" cy="33" r="3.5" class="hi"/></svg>';
const PAD_HINT = `<div class="padhint">${PAD}<p><b>Gamepad supported too</b> - just plug one in and press a button. Keyboard + gamepad = local multiplayer: turn it on under Menu → Game &amp; levels → Local multiplayer, then gamepads join by pressing A.</p></div>`;

// Resolves with the chosen scheme name once the user picks one.
export function pickScheme(kind) {
  const opts = kind === 'touch' ? TOUCH : KEYBOARD;
  const el = document.createElement('div');
  el.id = 'schemePicker';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Choose your controls');
  el.innerHTML = `<div class="box"><h2>Choose your controls</h2><div class="cards">${Object.entries(opts).map(([name, o], i) =>
    `<button type="button" data-scheme="${name}">${o.svg}<span>${kind === 'touch' ? '' : `${i + 1}. `}${o.label}</span></button>`).join('')}</div>${kind === 'touch' ? '' : PAD_HINT}` +
    '<small>You can change this at any time in the settings menu.</small></div>';
  document.body.appendChild(el);
  const names = Object.keys(opts);
  return new Promise((resolve) => {
    const done = (name) => { window.removeEventListener('keydown', onKey, true); el.remove(); resolve(name); };
    const onKey = (e) => {
      const n = names[parseInt(e.key, 10) - 1];
      e.stopImmediatePropagation();
      if (n && kind !== 'touch') { e.preventDefault(); done(n); }
    };
    window.addEventListener('keydown', onKey, true);
    el.addEventListener('click', (e) => { const b = e.target.closest('button[data-scheme]'); if (b) done(b.dataset.scheme); });
    el.querySelector('button').focus();
  });
}
