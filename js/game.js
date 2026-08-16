/* ============================================================
   game.js — Horizon Read. Five procedurally drawn scenes whose
   horizon is never drawn: boxes show tops only below eye level
   and undersides only above it, receding post rows converge to
   it, figures stand with their heads on it. The player drags a
   line to the hidden eye level and locks it in; the reveal draws
   the true line, the cue lines extended to the vanishing point,
   and a ring around the scene's decisive cue. Scenes are stored
   in normalized (0..1) coordinates so a resize never changes the
   ground truth, and the fence row is projected with the real
   pinhole formula rather than an arithmetic fake.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'horizon-read';
  var SCENES_PER_ROUND = 5;

  var GUESS_MIN = 0.02, GUESS_MAX = 0.98;
  var GRAB_PX = 30;        /* a press this close to the line grabs it */
  /* Fine control is about how fast the hand is MOVING, in px per ms —
     not about how many pixels arrived in one pointermove, which is that
     speed multiplied by whatever reporting interval the hardware has.
     See dragGain. 0.3 px/ms is the old 5px-per-step at a 60Hz rate. */
  var FINE_SPEED = 0.3;    /* px/ms — below this the drag is fine control */
  var FINE_GAIN = 0.45;    /* …and travels at this gain */
  var DT_MIN = 4, DT_MAX = 64, DT_FALLBACK = 16.7;
  var ADVANCE_MS = 420;    /* the reveal is protected from double taps */
  var MIN_STAGE_PX = 300;  /* touch parity: keep the aiming window big */
  var POST_COUNT = 6;

  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnLock = document.getElementById('btnLock');
  var pipList = document.getElementById('scenePips');

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

  /* Round score = mean of the five scene scores. sceneScore can only hand
     this finite values, but a mean that can return NaN is one refactor
     away from writing the literal text "NaN" into the HUD and into the
     permanent personal best, so it refuses to. */
  function roundScore(sceneScores) {
    if (!sceneScores.length) return 0;
    var sum = 0, v;
    for (var i = 0; i < sceneScores.length; i++) {
      v = sceneScores[i];
      /* Clamped as well as finiteness-checked: a finite number outside
         0–100 would print as "3e+307" on the HUD just as loudly as a NaN
         would, and clamping is the identity on every value sceneScore has
         ever produced. */
      sum += (typeof v === 'number' && isFinite(v)) ? clamp(v, 0, 100) : 0;
    }
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

  /* Real pinhole projection of an evenly spaced post row. Posts sit
     every `step` units along the ground line, the nearest one
     `depth` units in front of the camera; the camera scales each by
     depth / (depth + k*step), so post k lands
        t_k = k*step / (k*step + depth)
     of the way from the near post to the vanishing point. Arithmetic
     spacing (the old [0, .18, .34, …]) is not any real fence — an
     artist running the diagonal/halving check would catch it. */
  function postT(k, step, depth) {
    var z = k * step;
    var den = z + depth;
    /* a zero/negative-depth camera is not a scene — collapse the row
       onto the near post rather than emitting NaN into the drawing.
       Guarding `den` alone was not enough: a negative depth small enough
       to leave den positive (step .7, k 3, depth −2) returned t = 21, i.e.
       a post placed twenty vanishing-points past the horizon and far off
       the sheet. A post is always BETWEEN the near one and the VP, so the
       honest range is [0, 1). */
    if (!(den > 0) || !(depth > 0) || !(z >= 0)) return 0;
    var t = z / den;
    return isFinite(t) ? Math.max(0, Math.min(0.999, t)) : 0;
  }

  function postTs(count, step, depth) {
    var ts = [];
    for (var k = 0; k < count; k++) ts.push(postT(k, step, depth));
    return ts;
  }

  /* Perspective scale of that post — its apparent height and width. */
  function postScale(t) { return 1 - t; }

  /* Fine-control drag: slow pointer travel moves the line at reduced
     gain, so a jittering fingertip can still land a single pixel.
     SPEED, NOT STEP SIZE. This used to ask "were there fewer than five
     pixels in this pointermove?", which is not a question about the hand
     at all — it is that hand's speed times the reporting interval of the
     hardware. A confident 300px sweep in 300ms arrives as ~17px steps
     from a 60Hz mouse (full gain: the line follows the finger exactly)
     and as ~4px steps from a 120Hz phone or a 240Hz mouse (fine gain:
     the line travels 135px instead of 300 and visibly lags the finger
     the whole way down). The better the hardware, the less the drill
     listened. Dividing by the time the step took makes the threshold a
     real speed, identical on every device.
     dt is floored — two samples can carry the same timestamp — and
     capped, so a long pause reads as slow rather than as stopped. */
  function dragGain(dy, dtMs) {
    var a = Math.abs(dy);
    if (!isFinite(a)) return FINE_GAIN;
    var dt = (typeof dtMs === 'number' && isFinite(dtMs) && dtMs > 0) ? dtMs : DT_FALLBACK;
    dt = Math.max(DT_MIN, Math.min(DT_MAX, dt));
    return (a / dt) < FINE_SPEED ? FINE_GAIN : 1;
  }

  /* The scoring window is 0.14*H, so a short canvas turns identical
     perceptual skill into a lower score. Keep the stage tall enough
     on phones — never taller than the viewport can hold. */
  function canvasHeight(w, vh) {
    /* H divides into every score and every hint — never let it reach 0,
       and never let it run away either: an infinite height makes every
       band infinitely wide, which scores every guess a fake 100. */
    var base = (w > 0 && isFinite(w)) ? Math.max(1, Math.round(w * 0.62)) : 1;
    if (base >= MIN_STAGE_PX || !(vh > 0)) return base;
    return Math.max(base, Math.min(MIN_STAGE_PX, Math.round(vh * 0.52)));
  }

  /* A miss in pixels is device-dependent; the fraction of the frame
     is the number you can compare across sessions and screens. */
  function missPct(dy, height) {
    /* This number is turned straight into words by pctText, so a
       non-finite dy would put the literal text "NaN%" in front of a
       beginner in the one sentence that is supposed to explain their
       score. Guard the numerator as well as the denominator. */
    if (!(height > 0) || !isFinite(dy)) return 0;
    return (dy / height) * 100;
  }

  function pctText(dy, height) {
    var p = missPct(dy, height);
    return (p < 9.95 ? p.toFixed(1) : String(Math.round(p))) + '%';
  }

  /* WHICH WAY the line missed. The reveal's sentence was three ways of
     saying the same magnitude — "off by 3.2% of the frame (12px) —
     scored 77" — and a magnitude is not something a beginner can act on
     next scene. "too high" is. Screen y grows downward, so a guess above
     the true line is a negative delta. Pure; rounds first for the same
     reason pixelError does, so a 1px keyboard nudge can reach "dead on"
     rather than being told it is off by nothing. */
  function missWord(guessY, trueY) {
    var d = Math.round(guessY) - Math.round(trueY);
    if (!isFinite(d) || d === 0) return 'dead on';
    return d < 0 ? 'too high' : 'too low';
  }

  /* The tightest box the line cuts through — it brackets the answer
     from both sides, so it is the cue worth naming. */
  function straddleIndex(boxes, eye) {
    var best = -1, bestSpan = Infinity;
    for (var i = 0; i < boxes.length; i++) {
      if (boxFaces(boxes[i].top, boxes[i].bot, eye) !== 'none') continue;
      var span = boxes[i].bot - boxes[i].top;
      if (span < bestSpan) { bestSpan = span; best = i; }
    }
    return best;
  }

  /* Which single cue a beginner should have pulled on — ordered by how
     tightly each one pins the line, not by how loud it looks. Heads and
     the fence's vanishing point give an exact height; a straddling box
     only brackets the answer inside its span; face-flips across the
     whole scene are the loosest read of all. Ordering straddle above
     posts would make the fence unreachable — every scene that has posts
     also carries a straddler. */
  function decisiveCue(sc) {
    if (sc.figures && sc.figures.length) {
      return { kind: 'figures', label: 'same-height heads sit on the line' };
    }
    if (sc.posts) return { kind: 'posts', label: 'the receding row aims straight here' };
    var i = straddleIndex(sc.boxes, sc.eye);
    if (i >= 0) return { kind: 'straddle', index: i, label: 'no top, no underside — the line cuts it' };
    return { kind: 'faces', label: 'tops below the line, undersides above' };
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

  /* getComputedStyle() on the root forces a style resolve, and this ran at
     the top of every repaint — once per pointer sample while the line is
     under the finger — plus a hex parse and a mix for accentText. The
     tokens only move when the sheet flips theme, so cache them against
     data-theme; the cache invalidates itself the moment that attribute
     changes, so onTheme still repaints in the new colours. */
  var inkCache = null, inkKey = null;
  function inks() {
    var key = document.documentElement.dataset.theme || '';
    if (inkCache && inkKey === key) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var ink = cs.getPropertyValue('--ink').trim();
    var accent = cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--coral').trim();
    inkKey = key;
    inkCache = {
      ink: ink,
      muted: cs.getPropertyValue('--muted').trim(),
      card: cs.getPropertyValue('--card').trim(),
      accent: accent,
      accentText: ArtDaily.theme() === 'light' ? mixColors(accent, ink, 0.55) : accent,
    };
    return inkCache;
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ----
     Returns true only when the sheet really changed size. Assigning
     canvas.width reallocates and clears the backing store, and `resize`
     fires on every address-bar nudge on a phone — here the height also
     tracks the viewport, so both dimensions are compared. */
  var W = 0, H = 0, fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    var h = canvasHeight(w, window.innerHeight || 0);
    var dpr = window.devicePixelRatio || 1;
    if (w === W && h === H && dpr === fitDpr) return false;
    W = w;
    H = h;
    fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  /* ---- one repaint per frame ----
     A pointermove can arrive two or three times inside one displayed
     frame, and each used to redraw the whole scene — four boxes with
     three shaded faces each, six perspective-scaled posts, the figures.
     Only the last is ever shown. One rAF paints on the same vsync and
     stops the line feeling heavier than the finger dragging it. */
  var drawQueued = false;
  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(function () { drawQueued = false; draw(); });
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
    /* Scene 5 used to leave only the loosest cue in the set (which way
       the box faces point), which brackets the answer over a wide span
       instead of pinning it — so a round of confident play could end on
       a guess. It keeps one walker: still the hardest scene, but now a
       hard one rather than an under-determined one. */
    { posts: false, boxKinds: ['above', 'below'], figures: 1 },
  ];

  function planFor(idx) { return SCENE_PLANS[clamp(idx, 0, SCENE_PLANS.length - 1)]; }

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
    var plan = planFor(idx);
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
      var step = rand(0.55, 0.9);   /* ground units between posts */
      var depth = rand(1.3, 2.1);   /* ground units to the near post */
      posts = {
        x0: vpx < 0.5 ? rand(0.84, 0.92) : rand(0.08, 0.16),
        baseY: baseY,
        h: (baseY - eye) * rand(0.55, 0.8), /* fence-height: tops stay under eye level */
        step: step,
        depth: depth,
        ts: postTs(POST_COUNT, step, depth),
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

  /* Start the guess line well away from the answer. Both ends sit ≥0.2
     from every eye level the generator can produce (0.3..0.7), so which
     end you get carries no information. A mid-canvas start would leak:
     0.5 can only clear a "far enough from the answer" filter when the
     eye is outside 0.37..0.63, quietly ruling out most of the range. */
  function startGuess(eye) {
    /* 0.10 / 0.90 parked the line hard against the canvas edge, where the
       grab knob at W-28 can sit half under the border on a narrow sheet. */
    var pick = Math.random() < 0.5 ? 0.14 : 0.86;
    /* if the eye range is ever widened, keep the start off the answer */
    return Math.abs(pick - eye) > 0.13 ? pick : (eye > 0.5 ? 0.14 : 0.86);
  }

  /* ---- round state ---- */
  var round = 0, sceneIdx = 0, scene = null, sceneScores = [], guessF = 0.5;
  var phase = 'idle'; /* 'aim' | 'reveal' | 'done' */
  var lastScore = 0, reported = false;
  var advanceReadyAt = 0, advanceTimer = null;

  /* The reveal is the lesson — a stray second tap must not skip it,
     so every advance path (canvas, button, key) waits ADVANCE_MS. */
  function armAdvance() {
    advanceReadyAt = Date.now() + ADVANCE_MS;
    /* disabling a focused button blurs it — hand focus back on re-enable
       so a keyboard player never loses their place mid-round. */
    var hadFocus = document.activeElement === btnLock;
    btnLock.disabled = true;
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(function () {
      if (phase !== 'reveal' && phase !== 'done') return;
      btnLock.disabled = false;
      /* …but only if disabling the button is still what is holding the
         focus. Locking in with the button, then reaching for "how to play"
         or "new round" with Tab, is a reflex — and it fits comfortably
         inside 420ms. Handing focus back unconditionally yanked the ring
         off whatever the player had just moved to, so their next keystroke
         went somewhere they were no longer looking. Disabling a focused
         control drops focus to <body>, so that is the one state worth
         repairing; anything else is a place the player chose. */
      var here = document.activeElement;
      if (hadFocus && btnLock.focus && (!here || here === document.body)) btnLock.focus();
    }, ADVANCE_MS);
  }

  function canAdvance() { return Date.now() >= advanceReadyAt; }

  function currentMiss() {
    return scene ? pixelError(guessF * H, scene.eye * H) : 0;
  }

  function buildPips() {
    pipList.innerHTML = '';
    for (var i = 0; i < SCENES_PER_ROUND; i++) {
      var li = document.createElement('li');
      li.className = 'pip';
      var n = document.createElement('span');
      n.className = 'pip-n';
      n.textContent = String(i + 1);
      var v = document.createElement('span');
      v.className = 'pip-v';
      v.textContent = '–';
      li.appendChild(n);
      li.appendChild(v);
      pipList.appendChild(li);
    }
  }

  function paintPips() {
    var items = pipList.children;
    for (var i = 0; i < items.length; i++) {
      var scored = i < sceneScores.length;
      var val = scored ? String(Math.round(sceneScores[i])) : '–';
      items[i].className = 'pip' +
        (scored ? ' is-scored' : '') +
        (!scored && i === sceneIdx && phase !== 'done' ? ' is-current' : '');
      items[i].lastChild.textContent = val;
      items[i].setAttribute('aria-label', scored
        ? 'scene ' + (i + 1) + ' scored ' + val + ' of 100'
        : 'scene ' + (i + 1) + ' not played yet');
    }
  }

  function newRound() {
    clearTimeout(advanceTimer);
    advanceReadyAt = 0;
    round += 1;
    sceneIdx = 0;
    sceneScores = [];
    reported = false;
    dragId = null;  /* a stuck pointer must never outlive a round */
    scene = makeScene(0);
    guessF = startGuess(scene.eye);
    phase = 'aim';
    btnLock.disabled = false;
    btnLock.textContent = 'lock it in';
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    paintPips();
    refreshHint();
    draw();
  }

  /* One short cue per scene, so the drill teaches while it is played
     instead of hiding the rules inside "how to play". Read off the same
     decisiveCue the reveal will ring, so the thread you were pointed at
     and the thread the reveal circles are never two different ones.
     None of these name a position, so the answer stays hidden. */
  var CUE_TIPS = {
    figures: 'the walkers are all your height — their heads ride it.',
    straddle: 'one box shows you neither its top nor its underside.',
    posts: 'the fence row aims straight at it.',
    faces: 'box tops show only below it, undersides only above.',
  };

  function cueTip() {
    return scene ? CUE_TIPS[decisiveCue(scene).kind] : '';
  }

  /* "eye level" is the one term the whole drill turns on, and the only
     place it was defined was inside "how to play" — which a beginner opens
     after the drill has already confused them, not before. Gloss it on the
     opening scene, where the word is first used, then get out of the way. */
  function aimHint() {
    return 'scene ' + (sceneIdx + 1) + ' of ' + SCENES_PER_ROUND +
      ' — drag the line up or down onto the hidden eye level' +
      (sceneIdx === 0 ? ' (the height the camera was at — a flat line straight across the picture)' : '') +
      ', then lock it in. ' + cueTip();
  }

  function missPhrase() {
    var dy = currentMiss();
    var way = scene ? missWord(guessF * H, scene.eye * H) : 'dead on';
    if (way === 'dead on') return 'dead on the eye level — scored ' + lastScore + '.';
    /* Direction first, because it is the only part of this sentence that
       changes what you do next; then the share of the frame, because
       pixels are device-relative and mean nothing across sessions or
       between a phone and a desktop. */
    return 'your line sat ' + way + ' — off by ' + pctText(dy, H) +
      ' of the frame (' + dy + 'px), scored ' + lastScore + '.';
  }

  function refreshHint() {
    if (phase === 'aim') {
      hint.textContent = aimHint();
    } else if (phase === 'reveal') {
      hint.textContent = missPhrase() + ' tap the canvas or press “next scene” for scene ' + (sceneIdx + 2) + '.';
    } else if (phase === 'done') {
      hint.textContent = missPhrase() + ' round done — tap the canvas or press “new round” to go again.';
    }
  }

  function lockIn() {
    if (phase !== 'aim') return;
    var s = sceneScore(guessF * H, scene.eye * H, H);
    lastScore = Math.round(s);
    sceneScores.push(s);
    /* Running mean, so the HUD's "score" field is alive from scene 1
       rather than reading "–" until the round ends. The pips carry the
       per-scene detail; this is the one number that compares with the
       "best" sitting next to it. */
    hudScore.textContent = String(Math.round(roundScore(sceneScores)));
    phase = (sceneIdx + 1 < SCENES_PER_ROUND) ? 'reveal' : 'done';
    btnLock.textContent = phase === 'reveal' ? 'next scene →' : 'new round ↻';
    armAdvance();
    paintPips();
    refreshHint();
    draw();
    if (phase === 'done') finishRound();
  }

  function nextScene() {
    if (phase !== 'reveal' || !canAdvance()) return;
    clearTimeout(advanceTimer);
    sceneIdx += 1;
    dragId = null;  /* …nor one scene */
    scene = makeScene(sceneIdx);
    guessF = startGuess(scene.eye);
    phase = 'aim';
    btnLock.disabled = false;
    btnLock.textContent = 'lock it in';
    paintPips();
    refreshHint();
    draw();
  }

  /* Exactly one report per finished round, on every path. */
  function finishRound() {
    if (reported) return;
    reported = true;
    var res = ArtDaily.report(roundScore(sceneScores));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    refreshHint();
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  /* ============================================================
     Painting (canvas bg stays clear so the CSS dot-grid shows)
     ============================================================ */

  var MONO_FONT = '600 12px Menlo, Consolas, monospace';
  var CUE_PX = 17;
  function handFont(px) { return '700 ' + px + 'px Caveat, "Segoe Print", cursive'; }
  var HAND_FONT = handFont(21);

  function draw() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (phase === 'idle' || !scene) return;
    drawStill(c);
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

  /* A front-face corner pushed back along its ray to the VP — the
     exact projection of a fronto-parallel box's back corner. */
  function backPoint(p, vp, t) {
    return [lerp(p[0], vp[0], t), lerp(p[1], vp[1], t)];
  }

  function corners(b) {
    var x0 = b.x0 * W, x1 = b.x1 * W, ty = b.top * H, by = b.bot * H;
    return [[x0, ty], [x1, ty], [x1, by], [x0, by]];
  }

  function drawScene(c) {
    var vp = [scene.vpx * W, scene.eye * H];
    var i;
    if (scene.posts) drawPosts(c, vp);
    for (i = 0; i < scene.boxes.length; i++) drawBox(c, scene.boxes[i], vp);
    for (i = 0; i < scene.figures.length; i++) drawFigure(c, scene.figures[i]);
  }

  /* ---- THE SCENE IS A STILL LIFE ----
     Boxes, posts and walkers do not move while the line is under the finger:
     they are a function of the scene, the fitted sheet and the theme, and of
     nothing else. Measured, they were 142 of the 157 canvas calls in every
     frame of every drag — four boxes with three shaded faces each, six
     perspective-scaled posts, the figures — all pixel-identical to the frame
     before, while the part that actually MOVES is one line and a knob.
     So paint them once onto an offscreen sheet and blit it. The cache keys
     itself on the scene object, the fitted width AND height (this drill's
     height tracks the viewport, not just the width), the dpr and the ink
     object — inks() hands back a NEW object the moment data-theme changes —
     so a new scene, a resize, a dpr change and a theme flip each invalidate
     it by themselves, and onTheme still repaints in the new colours. With no
     offscreen sheet available the old direct path is still right there. */
  var still = null, stillCtx = null;
  var stillScene = null, stillW = 0, stillH = 0, stillDpr = 0, stillInks = null;

  function drawStill(c) {
    if (!(still && stillScene === scene && stillW === W && stillH === H &&
          stillDpr === fitDpr && stillInks === c)) {
      if (!still) {
        try {
          still = document.createElement('canvas');
          stillCtx = still.getContext('2d');
        } catch (e) { stillCtx = null; }
        if (!stillCtx) still = null;
      }
      var dpr = fitDpr || 1;
      var pw = Math.round(W * dpr), ph = Math.round(H * dpr);
      /* a zero-sized offscreen sheet is not a drawable image — drawImage
         throws on one, and a throw inside draw() takes the drill with it */
      if (!still || !(pw > 0) || !(ph > 0)) { drawScene(c); return; }
      still.width = pw;                     /* also clears the backing store */
      still.height = ph;
      /* every painter draws into `ctx` by name, so lend it to the offscreen
         sheet for the duration — synchronously, so nothing observes the swap.
         The `finally` is what makes the loan safe: a painter that threw with
         the loan outstanding would leave `ctx` pointing at the offscreen sheet
         for the rest of the session, and the drill would go on painting
         perfectly into a canvas nobody can see. */
      var sheet = ctx;
      try {
        ctx = stillCtx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawScene(c);
      } finally {
        ctx = sheet;
      }
      stillScene = scene; stillW = W; stillH = H; stillDpr = fitDpr; stillInks = c;
    }
    ctx.globalAlpha = 1;
    ctx.drawImage(still, 0, 0, W, H);
  }

  function drawBox(c, b, vp) {
    var p = corners(b);
    var A = p[0], B = p[1], C = p[2], D = p[3];
    var A2 = backPoint(A, vp, b.t), B2 = backPoint(B, vp, b.t);
    var C2 = backPoint(C, vp, b.t), D2 = backPoint(D, vp, b.t);
    var vis = boxFaces(A[1], D[1], vp[1]);

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
    if (B[0] < vp[0]) face(B, C, C2, B2, 0.1);
    else if (A[0] > vp[0]) face(A, D, D2, A2, 0.1);
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
      var s = postScale(t);                    /* real perspective scale */
      var x = lerp(bx0, vp[0], t);
      var yb = lerp(by0, vp[1], t);
      var yt = lerp(ty0, vp[1], t);
      ctx.lineWidth = Math.max(1, 3.6 * s);    /* thickness falls off with depth */
      ctx.beginPath();
      ctx.moveTo(x, yb);
      ctx.lineTo(x, yt);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, yt, Math.max(0.9, 2.8 * s), 0, Math.PI * 2);
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
    var hx = W - 28;
    ctx.fillStyle = c.card;
    ctx.strokeStyle = c.ink;
    ctx.beginPath();
    ctx.arc(hx, y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(hx, y - 8);
    ctx.lineTo(hx - 4.5, y - 3);
    ctx.lineTo(hx + 4.5, y - 3);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(hx, y + 8);
    ctx.lineTo(hx - 4.5, y + 3);
    ctx.lineTo(hx + 4.5, y + 3);
    ctx.closePath();
    ctx.fill();
  }

  function drawReveal(c) {
    var eyeY = scene.eye * H;
    var vp = [scene.vpx * W, eyeY];
    var i, b;

    /* Cue lines: every edge that runs away from you, extended to the
       vanishing point. On a busy scene that is 18+ rays at once and the
       single ringed cue drowns in its own correct spiderweb — so they sit
       well back and let drawCueHighlight carry the lesson. */
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.2;
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

    drawCueHighlight(c, vp);

    /* the miss, bracketed */
    var gY = guessF * H;
    var dy = currentMiss();
    if (dy > 0) {
      var bx = W - 56;
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
      ctx.fillText(dy + 'px · ' + pctText(dy, H), bx - 6, clamp(midY + 4, 12, H - 6));
    }
    ctx.textAlign = 'left';
  }

  /* Ring the one cue that settled this scene, so the reveal teaches
     which thread to pull instead of showing a correct spiderweb. */
  function drawCueHighlight(c, vp) {
    var cue = decisiveCue(scene);
    var eyeY = scene.eye * H;
    var lx = W / 2, i, p, b, f, h, r, vis;

    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';

    if (cue.kind === 'figures') {
      for (i = 0; i < scene.figures.length; i++) {
        f = scene.figures[i];
        h = f.feetY * H - eyeY;
        r = Math.max(5, h * 0.1);
        ctx.beginPath();
        ctx.arc(f.x * W, eyeY + r, r + 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      lx = scene.figures[0].x * W;
    } else if (cue.kind === 'straddle') {
      b = scene.boxes[cue.index];
      ctx.strokeRect(b.x0 * W, b.top * H, (b.x1 - b.x0) * W, (b.bot - b.top) * H);
      lx = (b.x0 + b.x1) / 2 * W;
    } else if (cue.kind === 'posts') {
      ctx.beginPath();
      ctx.arc(vp[0], vp[1], 11, 0, Math.PI * 2);
      ctx.stroke();
      lx = vp[0];
    } else {
      for (i = 0; i < scene.boxes.length; i++) {
        b = scene.boxes[i];
        p = corners(b);
        vis = boxFaces(p[0][1], p[3][1], eyeY);
        if (vis === 'top') {
          quad(p[0], p[1], backPoint(p[1], vp, b.t), backPoint(p[0], vp, b.t));
          ctx.stroke();
        } else if (vis === 'bottom') {
          quad(p[3], p[2], backPoint(p[2], vp, b.t), backPoint(p[3], vp, b.t));
          ctx.stroke();
        }
      }
    }

    ctx.fillStyle = c.accentText;
    ctx.font = cueFont(cue.label, W - 16);
    ctx.textAlign = 'center';
    var half = ctx.measureText(cue.label).width / 2 + 8;
    /* sit on the far side of the true line from the guess, so the label
       never lands on the miss bracket or the "eye level" tag */
    var ly = guessF * H < eyeY ? eyeY + 30 : eyeY - 30;
    if (ly > H - 8) ly = eyeY - 30;
    if (ly < 18) ly = eyeY + 30;
    ctx.fillText(cue.label, clamp(lx, Math.min(half, W / 2), Math.max(W - half, W / 2)), clamp(ly, 18, H - 8));
    ctx.textAlign = 'left';
  }

  /* Shrink the cue label until it fits a narrow phone canvas — a
     clipped sentence teaches nothing. */
  function cueFont(label, maxW) {
    var px = CUE_PX;
    ctx.font = handFont(px);
    var w = ctx.measureText(label).width;
    if (w > maxW && w > 0) {
      px = clamp(Math.floor(px * maxW / w), 12, CUE_PX);
      ctx.font = handFont(px);
    }
    return ctx.font;
  }

  function cueLine(x, y, vp) {
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(vp[0], vp[1]);
    ctx.stroke();
  }

  /* ============================================================
     Input — pointer-first, whole canvas drags the line.
     Grabbing near the line moves it by delta (the fingertip can
     rest off the line); a press further away places it there.
     ============================================================ */

  var dragId = null, dragPointerY = 0, dragLineY = 0, dragT = 0;

  /* getBoundingClientRect() is a layout read, and this used to run once
     per pointer sample — the most expensive thing in the move handler.
     The sheet cannot move under a live drag without a scroll or a resize,
     and the hint line above it only re-wraps between scenes, so measure
     once per gesture and drop the measurement on scroll or resize. */
  /* THE GRAB ORIGIN IS MEASURED AGAINST THAT RECT TOO. dragTo moves the line
     by (this sample − the last one), and both are canvas-local — so the
     moment the sheet slides under a live drag, the first sample after it is
     read against a new origin and differs from the stored one by the whole
     shift, not by anything the hand did. That bogus delta is big enough to
     clear the fine-gain threshold, so it travels at FULL gain: a hint line
     re-wrapping on a phone resize warps the guess ~20px — 7% of a short
     sheet, most of a scene's score — in one frame, with the finger still.
     So dropping the rect also marks the grab stale, and the next sample is
     spent re-anchoring instead of moving. One sample is 4–16ms; the warp was
     the whole scene. */
  var canvasRect = null, dragStale = false;
  function dropRect() { canvasRect = null; dragStale = true; }
  window.addEventListener('scroll', dropRect, true);

  function localY(ev) {
    var r = canvasRect || (canvasRect = canvas.getBoundingClientRect());
    return ev.clientY - r.top;
  }

  function setGuessPx(y) {
    /* clamp() is Math.max(lo, Math.min(hi, v)), and both of those
       propagate NaN — so one non-finite pointer sample would write NaN
       into guessF, the line would leave the sheet with no gesture that
       brings it back, and the reveal would then read "off by NaN% of the
       frame (NaN px)". Drop the sample; the next one is 4ms away. */
    if (!isFinite(y)) return;
    guessF = clamp(y / H, GUESS_MIN, GUESS_MAX);
    dragLineY = guessF * H;
    requestDraw();
  }

  function beginDrag(ev) {
    var py = localY(ev);
    var lineY = guessF * H;
    dragPointerY = py;
    dragT = (typeof ev.timeStamp === 'number' && isFinite(ev.timeStamp)) ? ev.timeStamp : 0;
    dragStale = false;   /* everything the drag needs was just measured */
    setGuessPx(Math.abs(py - lineY) > GRAB_PX ? py : lineY);
  }

  function dragTo(ev) {
    var py = localY(ev);
    var now = (typeof ev.timeStamp === 'number' && isFinite(ev.timeStamp)) ? ev.timeStamp : dragT + DT_FALLBACK;
    if (dragStale) {
      /* the sheet moved under the hand: re-anchor to where things are now
         and move nothing this frame */
      dragStale = false;
      dragPointerY = py;
      dragT = now;
      dragLineY = guessF * H;
      return;
    }
    var d = py - dragPointerY;
    var dt = now - dragT;
    dragPointerY = py;
    dragT = now;
    setGuessPx(dragLineY + d * dragGain(d, dt));
  }

  var lastPenAt = 0;
  canvas.addEventListener('pointerdown', function (ev) {
    ev.preventDefault();
    /* palm rejection: a pen always beats a palm that landed first */
    if (ev.pointerType === 'pen') lastPenAt = Date.now();
    else if (ev.pointerType === 'touch' && Date.now() - lastPenAt < 500) return;
    dropRect();                  /* a fresh gesture re-measures the sheet */
    if (phase === 'aim') {
      if (dragId !== null) return; /* first finger keeps the line */
      dragId = ev.pointerId;
      try { canvas.setPointerCapture(dragId); } catch (e) {}
      beginDrag(ev);
    } else if (phase === 'reveal') {
      nextScene();
    } else if (phase === 'done' && canAdvance()) {
      /* the canvas advanced the last four scenes — it must not go dead
         on the fifth. Same ADVANCE_MS guard, so the reveal still lands. */
      newRound();
    }
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (phase !== 'aim' || dragId === null || ev.pointerId !== dragId) return;
    ev.preventDefault();
    dragTo(ev);
  });

  function endDrag(ev) {
    if (ev.pointerId === dragId) dragId = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  /* A pointerup the canvas never sees used to leave the line
     undraggable for the rest of the session, because pointerdown
     returns early while one is in flight — a release off-window, or iOS
     dropping the capture with lostpointercapture and no pointerup. On a
     phone there is no keyboard fallback, so every remaining scene would
     be scored against a line the player cannot move. */
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);

  canvas.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      if (phase === 'aim') lockIn();
      else if (phase === 'reveal') nextScene();
      else if (phase === 'done' && canAdvance()) newRound();
      return;
    }
    if (phase !== 'aim') return;
    var step = (ev.shiftKey ? 8 : 1) / H;
    /* a held arrow auto-repeats faster than the screen refreshes */
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      guessF = clamp(guessF - step, GUESS_MIN, GUESS_MAX);
      requestDraw();
    } else if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      guessF = clamp(guessF + step, GUESS_MIN, GUESS_MAX);
      requestDraw();
    }
  });

  btnLock.addEventListener('click', function () {
    if (phase === 'aim') lockIn();
    else if (phase === 'reveal') nextScene();
    else if (phase === 'done' && canAdvance()) newRound();
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
  /* "new round" arms first when it would throw away a live round — a
     second press within the window confirms, otherwise it snaps back.
     An unfinished round is never reported, so a mis-tap here used to
     bin every scene locked so far without a word. (The five sibling
     drills all guard this button; this one did not.) */
  var btnRound = document.getElementById('btnRound');
  var roundArmTimer = null, roundArmed = false;
  function disarmRoundBtn() {
    roundArmed = false;
    clearTimeout(roundArmTimer);
    btnRound.innerHTML = 'new round <span aria-hidden="true">↻</span>';
  }
  btnRound.addEventListener('click', function () {
    if (sceneScores.length && phase !== 'done' && !roundArmed) {
      roundArmed = true;
      btnRound.textContent = 'discard round?';
      roundArmTimer = setTimeout(disarmRoundBtn, 2600);
      return;
    }
    disarmRoundBtn();
    newRound();
  });

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () {
    dropRect();
    /* fitCanvas is a no-op when nothing really moved, so an address bar
       nudge that changes neither dimension no longer reallocates the
       backing store nor rewrites the hint under the player's eyes. When
       it DID change, re-anchor the drag to the new frame height or the
       next move warps the line. */
    if (!fitCanvas()) { draw(); return; }
    dragLineY = guessF * H;
    refreshHint(); /* the px miss is read off the new frame height */
    draw();
  });

  /* ---- boot ---- */
  fitCanvas();
  buildPips();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
