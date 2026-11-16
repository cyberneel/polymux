/* <friday-face state="idle" size="56">: Friday's character, Wisp (task-675). Two eyes and a soft
   glow drawn in the element's CSS color, so state tints and themes stay plain CSS. Each mood is one
   row of numbers in MOODS and every shape keeps its point count, so any two moods interpolate with
   no animation library. FridayFace.swift mirrors the same table. `state` takes a mood name or one
   of the old <thinking-orb> states (ALIAS). Below 48px it draws a solid disc so the eyes stay
   readable. Draws at most ~30fps, only while on screen; Reduce Motion holds each pose. */
(() => {
  const MOODS = {
    rest:   {eyeW:4.2,eyeH:8,  gap:11,eyeY:-1, bend:0,lid:0,  slope:0,  lookX:0,  lookY:0,   tilt:0, scale:1,   squash:0,   breathe:1, wobble:.35,ring:0,halo:0,speak:0,blink:1, wander:.6},
    listen: {eyeW:5,  eyeH:10, gap:12,eyeY:-2, bend:0,lid:0,  slope:0,  lookX:0,  lookY:-.15,tilt:0, scale:1.05,squash:-.03,breathe:.5,wobble:.5, ring:1,halo:0,speak:0,blink:1, wander:.15},
    think:  {eyeW:4,  eyeH:7,  gap:10,eyeY:-2, bend:0,lid:.28,slope:0,  lookX:.6, lookY:-.7, tilt:0, scale:1,   squash:0,   breathe:.4,wobble:.9, ring:0,halo:0,speak:0,blink:.4,wander:0},
    speak:  {eyeW:4.4,eyeH:8.5,gap:11,eyeY:-1, bend:0,lid:0,  slope:0,  lookX:0,  lookY:0,   tilt:0, scale:1.02,squash:0,   breathe:.3,wobble:.6, ring:0,halo:0,speak:1,blink:1, wander:.3},
    ask:    {eyeW:4.6,eyeH:9.5,gap:11,eyeY:-1, bend:0,lid:0,  slope:0,  lookX:.25,lookY:-.25,tilt:.2,scale:1,   squash:0,   breathe:.6,wobble:.4, ring:0,halo:1,speak:0,blink:1, wander:.2},
    done:   {eyeW:5,  eyeH:1.5,gap:12,eyeY:-1, bend:1,lid:0,  slope:0,  lookX:0,  lookY:0,   tilt:0, scale:1.03,squash:0,   breathe:.8,wobble:.4, ring:0,halo:0,speak:0,blink:0, wander:0},
    fail:   {eyeW:4.4,eyeH:7,  gap:11,eyeY:1,  bend:0,lid:.5, slope:.45,lookX:0,  lookY:.45, tilt:0, scale:.96, squash:.08, breathe:.3,wobble:.15,ring:0,halo:0,speak:0,blink:.3,wander:0},
    away:   {eyeW:4.4,eyeH:8,  gap:11,eyeY:1.5,bend:0,lid:.88,slope:0,  lookX:0,  lookY:.2,  tilt:0, scale:.94, squash:.04, breathe:.6,wobble:.1, ring:0,halo:0,speak:0,blink:0, wander:0},
    muted:  {eyeW:4,  eyeH:7,  gap:10,eyeY:0,  bend:0,lid:.22,slope:0,  lookX:0,  lookY:0,   tilt:0, scale:.96, squash:0,   breathe:.4,wobble:.1, ring:0,halo:0,speak:0,blink:1, wander:.2},
  };
  const ALIAS = {idle:'rest', connecting:'think', working:'think', searching:'think', composing:'think', shaping:'think', listening:'listen', responding:'speak'};
  const TAU = Math.PI * 2, K = 1.45, f = v => v.toFixed(2);
  const rm = matchMedia('(prefers-reduced-motion: reduce)');

  // Closed Catmull-Rom spline through the points, as cubic Beziers.
  function path(p) {
    const n = p.length; let d = `M${f(p[0][0])},${f(p[0][1])}`;
    for (let i = 0; i < n; i++) {
      const a = p[(i - 1 + n) % n], b = p[i], c = p[(i + 1) % n], e = p[(i + 2) % n];
      d += `C${f(b[0] + (c[0] - a[0]) / 6)},${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)},${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])},${f(c[1])}`;
    }
    return d + 'Z';
  }
  // An eye: a superellipse, cut by a lid line (slope lowers the outer end) and bent into an arch.
  function eye(cx, cy, w, h, bend, lid, slope, side) {
    const p = [];
    for (let i = 0; i < 28; i++) {
      const a = i / 28 * TAU, x = w * Math.cos(a);
      let y = h * Math.sin(a);
      if (lid > .001 || slope > .001) y = Math.max(y, Math.min(-h + 2 * h * lid + slope * h * (x * side / w), h * .9));
      p.push([cx + x, cy + y - bend * 3.2 * (1 - (x / w) ** 2)]);
    }
    return path(p);
  }
  const glowR = (a, w, wt) => 31 * (1 + w * (.05 * Math.sin(3 * a + wt * 1.56) + .035 * Math.sin(5 * a - wt * 2.04 + 1) + .025 * Math.sin(2 * a + wt * 1.08 + 2)));

  let ptr = null, ptrAt = -9, t = 0, last = 0, running = false;
  const live = new Set();
  addEventListener('pointermove', e => { ptr = [e.clientX, e.clientY]; ptrAt = t; }, {passive:true});
  function kick() { if (!running && live.size) { running = true; last = performance.now(); requestAnimationFrame(frame); } }
  function frame(now) {
    if (!live.size) { running = false; return; }
    requestAnimationFrame(frame);
    if (now - last < 32) return;
    const dt = Math.min(.1, (now - last) / 1000); last = now; t += dt;
    for (const F of live) if (F.seen !== false) F.draw(dt);
  }

  class FridayFace extends HTMLElement {
    static observedAttributes = ['state', 'size'];
    connectedCallback() {
      if (!this.svg) {
        this.innerHTML = '<svg aria-hidden="true" style="display:block;overflow:visible"><circle r="40" fill="none" stroke="currentColor" stroke-width="1.6"/><circle r="40" fill="none" stroke="currentColor" stroke-width="1.6"/><circle r="40" fill="none" stroke="var(--amber,#e8b874)" stroke-width="2.4"/><g><path fill="currentColor"/><path/><path/></g></svg>';
        this.svg = this.firstChild;
        [this.r1, this.r2, this.halo] = this.svg.querySelectorAll('circle');
        this.g = this.svg.querySelector('g');
        [this.glow, this.e1, this.e2] = this.g.children;
        this.cur = {...MOODS.rest}; this.m = 'rest'; this.gaze = [0, 0]; this.wt = Math.random() * 9;
        this.hopAt = this.failAt = -9; this.blinkAt = t + 1 + Math.random() * 3;
      }
      if (!this.hasAttribute('role')) this.setAttribute('role', 'img');
      this.sync(); live.add(this);
      (this.io ||= new IntersectionObserver(([e]) => { this.seen = e.isIntersecting; })).observe(this);
      kick();
    }
    disconnectedCallback() { live.delete(this); this.io.disconnect(); }
    attributeChangedCallback() { if (this.svg) this.sync(); }
    sync() {
      const px = +this.getAttribute('size') || 56, small = px < 48;
      this.svg.setAttribute('width', px); this.svg.setAttribute('height', px);
      this.svg.setAttribute('viewBox', small ? '-37 -37 74 74' : '-50 -50 100 100');
      this.glow.setAttribute('fill-opacity', small ? 1 : .2);
      for (const e of [this.e1, this.e2]) e.setAttribute('fill', small ? 'var(--bg,#141312)' : 'currentColor');
      for (const c of [this.r1, this.r2, this.halo]) c.style.display = small ? 'none' : '';
      const s = this.getAttribute('state') || 'idle', m = MOODS[s] ? s : ALIAS[s] || 'rest';
      if (m !== this.m) { if (m === 'done') this.hopAt = t; if (m === 'fail') this.failAt = t; this.m = m; }
      if (!this.drawn) this.draw(0);
    }
    draw(dt) {
      this.drawn = true;
      const still = rm.matches, P = this.cur, tgt = MOODS[this.m], k = still ? 1 : 1 - Math.exp(-dt * 7);
      for (const key in tgt) P[key] += (tgt[key] - P[key]) * k;
      this.wt += dt * (.6 + P.wobble * 1.2);
      const go = !still;
      if (t > this.blinkAt + .5) { this.blinkAt = t + 3 + Math.random() * 3; this.twice = Math.random() < .25; }
      const one = d => (d > 0 && d < .16) ? 1 - Math.abs(d / .08 - 1) : 0;
      const blink = go ? Math.max(one(t - this.blinkAt), this.twice ? one(t - this.blinkAt - .24) : 0) * P.blink : 0;
      const amp = go ? P.speak * Math.max(0, Math.min(1, .5 + .5 * Math.sin(t * 11) * Math.sin(t * 3.7 + 1) + .2 * Math.sin(t * 23))) : 0;
      const hp = (t - this.hopAt) / .55, ft = t - this.failAt;
      const hopY = go && hp > 0 && hp < 1 ? -10 * Math.sin(Math.PI * hp) : 0;
      const land = go && hp >= 1 && hp < 1.3 ? .1 * Math.sin(Math.PI * (hp - 1) / .3) : 0;
      const shake = go && ft > 0 && ft < .6 ? 2.5 * Math.sin(ft * 45) * Math.exp(-ft * 5) : 0;
      // Eyes follow the pointer for a few seconds after it moves, else wander.
      let g = [0, 0];
      if (go && ptr && t - ptrAt < 3) {
        const r = this.getBoundingClientRect(), dx = ptr[0] - r.left - r.width / 2, dy = ptr[1] - r.top - r.height / 2, d = Math.hypot(dx, dy) + 140;
        g = [dx / d, dy / d];
      } else if (go) g = [Math.sin(t * .37) * Math.sin(t * .23 + 1) * P.wander, Math.sin(t * .29 + 2) * .5 * P.wander];
      const e = 1 - Math.exp(-dt * 6);
      this.gaze[0] += (g[0] - this.gaze[0]) * e; this.gaze[1] += (g[1] - this.gaze[1]) * e;
      const lx = P.lookX + this.gaze[0], ly = P.lookY + this.gaze[1];

      const s = P.scale * (1 + (go ? .018 * P.breathe * Math.sin(TAU * t / 5) : 0)) * (1 + .05 * amp), sq = P.squash + land;
      this.g.setAttribute('transform', `translate(${f(lx * .8 + shake)},${f(ly * .8 + hopY)}) rotate(${f(P.tilt * 57.3)}) translate(0,33) scale(${f(s * (1 + sq))},${f(s * (1 - sq))}) translate(0,-33)`);
      const pts = [], w = .6 + P.wobble, wt = go ? this.wt : 0;
      for (let i = 0; i < 72; i++) { const a = i / 72 * TAU, r = glowR(a, w, wt); pts.push([Math.cos(a) * r, Math.sin(a) * r]); }
      this.glow.setAttribute('d', path(pts));
      const ex = lx * 3.5 * K, ey = (P.eyeY + ly * 3.2 - amp * .8) * K, half = P.gap / 2 * K;
      const lid = Math.max(P.lid, blink * .92), ew = P.eyeW * K, eh = P.eyeH * K * (1 - .15 * amp);
      this.e1.setAttribute('d', eye(ex - half, ey, ew, eh, P.bend * K, lid, P.slope, -1));
      this.e2.setAttribute('d', eye(ex + half, ey, ew, eh, P.bend * K, lid, P.slope, 1));
      // A pulse ring while listening or speaking, an amber halo while asking.
      const pulse = Math.max(P.ring, amp * .8);
      [this.r1, this.r2].forEach((c, i) => {
        const fr = go ? ((t * (.7 + P.speak * .8)) + i * .5) % 1 : .2;
        c.setAttribute('r', f(38 + fr * 12)); c.setAttribute('opacity', f((go ? 1 - fr : i ? 0 : .8) * pulse));
      });
      this.halo.setAttribute('opacity', f(P.halo * (go ? .75 + .25 * Math.sin(t * 3) : 1)));
    }
  }
  customElements.define('friday-face', FridayFace);
})();
