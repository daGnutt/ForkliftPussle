// Splash animation: a forklift drives a figure eight and drifts through the two end turns,
// leaving skidmarks and tyre smoke. Purely decorative; independent of the game state.
const W = 440, H = 190;
const A = 165, B = 90; // x = A sin t, y = B sin t cos t (Gerono lemniscate)
const SPEED = 210;     // px/s along the path
const FADE = 6;        // seconds until skidmarks and smoke are gone

function pathAt(t) {
  const s = Math.sin(t), c = Math.cos(t);
  const x = A * s, y = B * s * c;
  const dx = A * c, dy = B * (c * c - s * s);
  const ddx = -A * s, ddy = -4 * B * s * c;
  const v = Math.hypot(dx, dy);
  return { x, y, v, ang: Math.atan2(dy, dx), k: (dx * ddy - dy * ddx) / (v * v * v) };
}

function wheel(f, lx, ly) {
  const c = Math.cos(f.h), s = Math.sin(f.h);
  return { x: f.x + lx * c - ly * s, y: f.y + lx * s + ly * c };
}

function drawForklift(ctx, f) {
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.rotate(f.h);
  ctx.fillStyle = '#222';
  for (const [wx, wy] of [[9, -11], [9, 11], [-12, -11], [-12, 11]]) ctx.fillRect(wx - 5, wy - 3.5, 10, 7);
  ctx.fillStyle = '#9e9e9e'; // tines
  ctx.fillRect(17, -9, 22, 3.5); ctx.fillRect(17, 5.5, 22, 3.5);
  ctx.fillStyle = '#555'; // mast
  ctx.fillRect(14, -11, 4, 22);
  ctx.fillStyle = '#f9a825'; // body
  ctx.beginPath(); ctx.roundRect(-19, -10, 33, 20, 4); ctx.fill();
  ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.stroke();
  ctx.fillStyle = '#6d4c00'; // counterweight
  ctx.fillRect(-19, -10, 6, 20);
  ctx.fillStyle = 'rgba(0,0,0,.35)'; // cab roof
  ctx.fillRect(-9, -8, 15, 16);
  ctx.fillStyle = '#fff3c4';
  ctx.fillRect(-7, -6, 11, 12);
  ctx.restore();
}

export function startSplashAnimation(canvas, isActive) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  const marks = []; // {x0,y0,x1,y1,born}
  const smoke = []; // {x,y,vx,vy,born,r}
  let t = 0, slip = 0, last = null, markAcc = 0;
  let prev = null;

  function frame(now) {
    if (!isActive()) return;
    requestAnimationFrame(frame);
    const dt = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = now / 1000;

    const p = pathAt(t);
    t += SPEED * dt / p.v;
    const target = Math.sign(p.k) * Math.min(0.75, Math.max(0, (Math.abs(p.k) - 0.013) * 60));
    slip += (target - slip) * Math.min(1, dt * 8);
    const f = { x: W / 2 + p.x, y: H / 2 + p.y, h: p.ang + slip };
    const drifting = Math.abs(slip) > 0.15;

    const rear = [wheel(f, -12, -11), wheel(f, -12, 11)];
    if (prev && drifting) {
      rear.forEach((w, i) => marks.push({ x0: prev[i].x, y0: prev[i].y, x1: w.x, y1: w.y, born: time }));
      markAcc += dt;
      if (markAcc > 0.03) {
        markAcc = 0;
        for (const w of rear) smoke.push({ x: w.x, y: w.y, vx: (Math.random() - 0.5) * 18, vy: (Math.random() - 0.5) * 18 - 6, born: time, r: 4 + Math.random() * 3 });
      }
    }
    prev = rear;
    while (marks.length && time - marks[0].born > FADE) marks.shift();
    while (smoke.length && time - smoke[0].born > 2) smoke.shift();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineWidth = 4;
    for (const m of marks) {
      ctx.strokeStyle = `rgba(20,20,20,${0.55 * (1 - (time - m.born) / FADE)})`;
      ctx.beginPath(); ctx.moveTo(m.x0, m.y0); ctx.lineTo(m.x1, m.y1); ctx.stroke();
    }
    drawForklift(ctx, f);
    for (const s of smoke) {
      const a = (time - s.born) / 2;
      ctx.fillStyle = `rgba(200,200,200,${0.5 * (1 - a)})`;
      ctx.beginPath();
      ctx.arc(s.x + s.vx * (time - s.born), s.y + s.vy * (time - s.born), s.r + a * 14, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  requestAnimationFrame(frame);
}
