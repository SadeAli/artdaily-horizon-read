/* ============================================================
   game.js — Horizon Read. Five procedurally drawn scenes whose
   horizon is never drawn: boxes show tops only below eye level
   and undersides only above it, receding post rows converge to
   it, figures stand with their heads on it. The player drags a
   line to the hidden eye level and locks it in; the reveal draws
   the true line plus the cue lines extended to the vanishing
   point. Scenes are stored in normalized (0..1) coordinates so a
   resize never changes the ground truth.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'horizon-read';
  var SCENES_PER_ROUND = 5;

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnLock = document.getElementById('btnLock');

  ArtDaily.init({ slug: SLUG });

  /* ============================================================
     Pure scoring + geometry helpers — inputs in, numbers out.
     No canvas, no DOM, unit-testable as-is.
     ============================================================ */

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function lerp(a, b, t) { return a + (b - a) * t; }

  /* Positions round to whole pixels first so a 1px keyboard nudge
     can land dy = 0 — a 100 is genuinely reachable. */
  function pixelError(guessY, trueY) {
    return Math.abs(Math.round(guessY) - Math.round(trueY));
  }

  /* score = 100 * clamp(1 - |dy| / (0.14 * H), 0, 1) */
  function sceneScore(guessY, trueY, height) {
    if (!(height > 0)) return 0;
    var dy = pixelError(guessY, trueY);
    if (!isFinite(dy)) return 0;
    return 100 * clamp(1 - dy / (0.14 * height), 0, 1);
  }

  /* Round score = mean of the five scene scores. */
  function roundScore(sceneScores) {
    if (!sceneScores.length) return 0;
    var sum = 0;
    for (var i = 0; i < sceneScores.length; i++) sum += sceneScores[i];
    return sum / sceneScores.length;
  }

  /* Which horizontal face of a box the camera sees. Screen y grows
     downward: a box wholly below eye level shows its top, wholly
     above shows its underside, straddling shows neither. */
  function boxFaces(topY, botY, eyeY) {
    if (topY >= eyeY) return 'top';
    if (botY <= eyeY) return 'bottom';
    return 'none';
  }

  /* ---- theme-aware inks (re-read on every repaint) ---- */

  /* Accent is watercolor-weak on paper: coral on the light card sits
     near 3:1. The template's .toast-accent solves this by mixing the
     accent 55/45 toward ink on light — mirror that for canvas TEXT
     (lines keep the pure accent; 3:1 is fine for graphics). */
  function parseColor(s) {
    s = (s || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function mixColors(a, b, wa) {
    var A = parseColor(a), B = parseColor(b);
    if (!A || !B) return a;
    function ch(i) { return Math.round(A[i] * wa + B[i] * (1 - wa)); }
    return 'rgb(' + ch(0) + ',' + ch(1) + ',' + ch(2) + ')';
  }

  function inks() {
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--coral').trim();
    return {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accent,
      accentText: ArtDaily.theme() === 'light' ? mixColors(accent, ink, 0.55) : accent,
    };
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ============================================================
     Scene generation — all coordinates are fractions of W / H.
     Cue budget shrinks scene by scene: the ramp within a round.
     ============================================================ */

  var SCENE_PLANS = [
    { posts: true,  boxKinds: ['above', 'below', 'span'], figures: 2 },
    { posts: true,  boxKinds: ['above', 'below', 'span'], figures: 0 },
    { posts: false, boxKinds: ['above', 'below', 'span', 'below'], figures: 2 },
    { posts: false, boxKinds: ['above', 'below', 'span'], figures: 0 },
    { posts: false, boxKinds: ['above', 'below'], figures: 0 },
  ];

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function makeBox(kind, xc, halfW, eye, vpx) {
    var top, bot;
    if (kind === 'below') {          /* below eye level → top face shows */
      top = eye + rand(0.05, Math.min(0.2, 0.8 - eye));
      bot = Math.min(0.97, top + rand(0.16, 0.34));
    } else if (kind === 'above') {   /* above eye level → underside shows */
      bot = eye - rand(0.05, Math.min(0.2, eye - 0.2));
      top = Math.max(0.03, bot - rand(0.16, 0.34));
    } else {                         /* straddles it → neither face shows */
      top = clamp(eye - rand(0.09, 0.26), 0.04, 1);
      bot = clamp(eye + rand(0.09, 0.26), 0, 0.96);
      /* A straddling box needs a visible side face to carry any
         perspective cue — keep the VP outside its front face. */
      if (Math.abs(xc - vpx) < halfW + 0.04) {
        xc = vpx + (xc >= vpx ? 1 : -1) * (halfW + 0.07);
      }
    }
    xc = clamp(xc, 0.04 + halfW, 0.96 - halfW);
    return { x0: xc - halfW, x1: xc + halfW, top: top, bot: bot, t: rand(0.16, 0.32) };
  }

  function makeScene(idx) {
    var plan = SCENE_PLANS[clamp(idx, 0, SCENE_PLANS.length - 1)];
    var eye = rand(0.3, 0.7);
    var vpx = rand(0.32, 0.68);

    var kinds = shuffle(plan.boxKinds.slice());
    var n = kinds.length;
    var slotW = 0.9 / n;
    var slots = shuffle([0, 1, 2, 3].slice(0, n));
    var boxes = [];
    for (var i = 0; i < n; i++) {
      var xc = 0.05 + slotW * (slots[i] + 0.5) + rand(-0.12, 0.12) * slotW;
      boxes.push(makeBox(kinds[i], xc, slotW * rand(0.26, 0.4), eye, vpx));
    }

    var posts = null;
    if (plan.posts) {
      var baseY = eye + rand(0.2, Math.min(0.32, 0.93 - eye));
      posts = {
        x0: vpx < 0.5 ? rand(0.84, 0.92) : rand(0.08, 0.16),
        baseY: baseY,
        h: (baseY - eye) * rand(0.55, 0.8), /* fence-height: tops stay under eye level */
        ts: [0, 0.18, 0.34, 0.48, 0.6, 0.7],
      };
    }

    var figures = [];
    for (var f = 0; f < plan.figures; f++) {
      figures.push({
        x: f === 0 ? rand(0.14, 0.4) : rand(0.6, 0.88),
        feetY: eye + rand(0.12, Math.min(0.3, 0.92 - eye)),
      });
    }

    return { eye: eye, vpx: vpx, boxes: boxes, posts: posts, figures: figures };
  }

  /* Start the guess line well away from the answer, on a side that
     does not leak which half the eye level is in. */
  function startGuess(eye) {
    var candidates = [0.1, 0.5, 0.9];
    var ok = [];
    for (var i = 0; i < candidates.length; i++) {
      if (Math.abs(candidates[i] - eye) > 0.13) ok.push(candidates[i]);
    }
    return ok[Math.floor(Math.random() * ok.length)];
  }

  /* ---- round state ---- */
  var round = 0, sceneIdx = 0, scene = null, sceneScores = [], guessF = 0.5;
  var phase = 'idle'; /* 'aim' | 'reveal' | 'done' */
  var lastDy = 0, lastScore = 0;

  function newRound() {
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    scene = makeScene(0);
    guessF = startGuess(scene.eye);
    phase = 'aim';
    btnLock.disabled = false;
    btnLock.textContent = 'lock it in';
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    hint.textContent = aimHint();
    draw();
  }

  function aimHint() {
    return 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND +
      ' — drag the line to the hidden eye level, then lock it in.';
  }

  function lockIn() {
    if (phase !== 'aim') return;
    var s = sceneScore(guessF * H, scene.eye * H, H);
    lastDy = pixelError(guessF * H, scene.eye * H);
    lastScore = Math.round(s);
    sceneScores.push(s);
    if (sceneIdx + 1 < SCENES_PER_ROUND) {
      phase = 'reveal';
      btnLock.textContent = 'next scene →';
      hint.textContent = 'off by ' + lastDy + 'px — ' + lastScore +
        '. tap the canvas for scene ' + (sceneIdx + 2) + '.';
      draw();
      return;
    }
    phase = 'done';
    btnLock.disabled = true;
    draw();
    finishRound();
  }

  function nextScene() {
    if (phase !== 'reveal') return;
    sceneIdx += 1;
    scene = makeScene(sceneIdx);
    guessF = startGuess(scene.eye);
    phase = 'aim';
    btnLock.textContent = 'lock it in';
    hint.textContent = aimHint();
    draw();
  }

  function finishRound() {
    var res = ArtDaily.report(roundScore(sceneScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'off by ' + lastDy + 'px — ' + lastScore +
      '. round done — press “new round” to go again.';
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  /* ============================================================
     Painting (canvas bg stays clear so the CSS dot-grid shows)
     ============================================================ */

  var MONO_FONT = '600 12px Menlo, Consolas, monospace';
  var HAND_FONT = '700 21px Caveat, "Segoe Print", cursive';

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (phase === 'idle' || !scene) return;
    drawScene(c);
    if (phase === 'aim') {
      drawGuess(c, false);
    } else {
      drawReveal(c);
      drawGuess(c, true);
    }
  }

  function quad(a, b, cP, d) {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.lineTo(cP[0], cP[1]);
    ctx.lineTo(d[0], d[1]);
    ctx.closePath();
  }

  function drawScene(c) {
    var vp = [scene.vpx * W, scene.eye * H];
    var i;
    if (scene.posts) drawPosts(c, vp);
    for (i = 0; i < scene.boxes.length; i++) drawBox(c, scene.boxes[i], vp);
    for (i = 0; i < scene.figures.length; i++) drawFigure(c, scene.figures[i]);
  }

  function drawBox(c, b, vp) {
    var x0 = b.x0 * W, x1 = b.x1 * W, ty = b.top * H, by = b.bot * H;
    function back(p) { return [lerp(p[0], vp[0], b.t), lerp(p[1], vp[1], b.t)]; }
    var A = [x0, ty], B = [x1, ty], C = [x1, by], D = [x0, by];
    var A2 = back(A), B2 = back(B), C2 = back(C), D2 = back(D);
    var vis = boxFaces(ty, by, vp[1]);

    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = c.ink;
    ctx.fillStyle = c.ink;

    function face(a, b2, c2, d2, alpha) {
      quad(a, b2, c2, d2);
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    /* side face first (it sits behind the front face) */
    if (x1 < vp[0]) face(B, C, C2, B2, 0.1);
    else if (x0 > vp[0]) face(A, D, D2, A2, 0.1);
    /* top only below eye level, underside only above — the drill's truth */
    if (vis === 'top') face(A, B, B2, A2, 0.15);
    if (vis === 'bottom') face(D, C, C2, D2, 0.2);
    face(A, B, C, D, 0.05);
  }

  function drawPosts(c, vp) {
    var p = scene.posts;
    var bx0 = p.x0 * W, by0 = p.baseY * H, ty0 = (p.baseY - p.h) * H;
    ctx.strokeStyle = c.ink;
    ctx.fillStyle = c.ink;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    for (var i = 0; i < p.ts.length; i++) {
      var t = p.ts[i];
      var x = lerp(bx0, vp[0], t);
      var yb = lerp(by0, vp[1], t);
      var yt = lerp(ty0, vp[1], t);
      ctx.lineWidth = lerp(3.5, 1.2, t);
      ctx.beginPath();
      ctx.moveTo(x, yb);
      ctx.lineTo(x, yt);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, yt, lerp(2.6, 1, t), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  /* Same-height walkers: the camera sits at head height, so every
     head top lands exactly on the hidden eye level. */
  function drawFigure(c, f) {
    var eyeY = scene.eye * H;
    var x = f.x * W, feet = f.feetY * H, h = feet - eyeY;
    if (h < 14) return;
    var r = h * 0.1;
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = Math.max(1.2, h * 0.022);
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(x, eyeY + r, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, eyeY + 2 * r);
    ctx.lineTo(x, eyeY + h * 0.62);
    ctx.moveTo(x, eyeY + h * 0.62);
    ctx.lineTo(x - h * 0.11, feet);
    ctx.moveTo(x, eyeY + h * 0.62);
    ctx.lineTo(x + h * 0.11, feet);
    ctx.moveTo(x - h * 0.13, eyeY + h * 0.46);
    ctx.lineTo(x, eyeY + h * 0.28);
    ctx.lineTo(x + h * 0.13, eyeY + h * 0.46);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineCap = 'butt';
  }

  function drawGuess(c, dim) {
    var y = guessF * H;
    ctx.strokeStyle = dim ? c.muted : c.ink;
    ctx.lineWidth = 2;
    ctx.setLineDash(dim ? [7, 6] : []);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (dim) return;
    /* grab knob (visual only — the whole canvas is the handle) */
    var hx = W - 26;
    ctx.fillStyle = c.card;
    ctx.strokeStyle = c.ink;
    ctx.beginPath();
    ctx.arc(hx, y, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(hx, y - 7);
    ctx.lineTo(hx - 4, y - 2.5);
    ctx.lineTo(hx + 4, y - 2.5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx, y + 7);
    ctx.lineTo(hx - 4, y + 2.5);
    ctx.lineTo(hx + 4, y + 2.5);
    ctx.closePath();
    ctx.fill();
  }

  function drawReveal(c) {
    var eyeY = scene.eye * H;
    var vp = [scene.vpx * W, eyeY];
    var i, b;

    /* cue lines: every receding edge extended to the vanishing point */
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([4, 4]);
    for (i = 0; i < scene.boxes.length; i++) {
      b = scene.boxes[i];
      cueLine(b.x0 * W, b.top * H, vp);
      cueLine(b.x1 * W, b.top * H, vp);
      cueLine(b.x0 * W, b.bot * H, vp);
      cueLine(b.x1 * W, b.bot * H, vp);
    }
    if (scene.posts) {
      cueLine(scene.posts.x0 * W, scene.posts.baseY * H, vp);
      cueLine(scene.posts.x0 * W, (scene.posts.baseY - scene.posts.h) * H, vp);
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    /* the vanishing point itself */
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.arc(vp[0], vp[1], 4, 0, Math.PI * 2);
    ctx.fill();

    /* the true eye level */
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, eyeY);
    ctx.lineTo(W, eyeY);
    ctx.stroke();
    ctx.fillStyle = c.accentText;
    ctx.font = HAND_FONT;
    ctx.textAlign = 'left';
    ctx.fillText('eye level', 10, eyeY < 34 ? eyeY + 26 : eyeY - 10);

    /* the miss, bracketed */
    var gY = guessF * H;
    if (lastDy > 0) {
      var bx = W - 52;
      ctx.strokeStyle = c.muted;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(bx, gY);
      ctx.lineTo(bx, eyeY);
      ctx.stroke();
      ctx.fillStyle = c.ink;
      ctx.font = MONO_FONT;
      ctx.textAlign = 'right';
      var midY = (gY + eyeY) / 2;
      ctx.fillText(lastDy + 'px', bx - 6, clamp(midY + 4, 12, H - 6));
    }
    ctx.textAlign = 'left';
  }

  function cueLine(x, y, vp) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(vp[0], vp[1]);
    ctx.stroke();
  }

  /* ============================================================
     Input — pointer-first, whole canvas drags the line
     ============================================================ */

  var dragId = null;

  function moveGuessTo(ev) {
    var rect = canvas.getBoundingClientRect();
    guessF = clamp((ev.clientY - rect.top) / H, 0.02, 0.98);
    draw();
  }

  canvas.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    if (phase === 'aim') {
      if (dragId !== null) return; /* first finger keeps the line */
      dragId = ev.pointerId;
      try { canvas.setPointerCapture(dragId); } catch (e) {}
      moveGuessTo(ev);
    } else if (phase === 'reveal') {
      nextScene();
    }
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (phase !== 'aim' || dragId === null || ev.pointerId !== dragId) return;
    ev.preventDefault();
    moveGuessTo(ev);
  });

  function endDrag(ev) {
    if (ev.pointerId === dragId) dragId = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (phase === 'aim') lockIn();
      else if (phase === 'reveal') nextScene();
      return;
    }
    if (phase !== 'aim') return;
    var step = (ev.shiftKey ? 8 : 1) / H;
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      guessF = clamp(guessF - step, 0.02, 0.98);
      draw();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      guessF = clamp(guessF + step, 0.02, 0.98);
      draw();
    }
  });

  btnLock.addEventListener('click', function () {
    if (phase === 'aim') lockIn();
    else if (phase === 'reveal') nextScene();
  });

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); draw(); });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
