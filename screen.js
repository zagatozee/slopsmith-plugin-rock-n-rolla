/**
 * Rock 'n' Rolla — Slopsmith Plugin  v0.14
 *
 * Changes in v0.14:
 *  - Fixed chord queue in song order from the arrangement XML
 *  - Floating fretboard diagrams: CURRENT (now) + NEXT (upcoming)
 *  - Source selector: DLC dropdown + file upload
 *  - Strum queue: each chord subdivided into half-measure pulses
 *    (beat_span 2 → 1 strum, beat_span 4 → 2 strums, etc.)
 */

(() => {
  /* ═══════════════════════════════════════════
     CONSTANTS
  ═══════════════════════════════════════════ */
  const LIVES_MAX        = 3;
  const BARREL_W         = 74;
  const BARREL_H         = 46;
  const PLATFORM_H       = 14;
  const FLOOR_Y_RAT      = 0.88;
  const SPAWN_COLS       = 5;
  const SCORE_HIT        = 100;
  const SCORE_COMBO_BONUS= 50;

  // Timing window (ms from barrel crossing the hit line)
  const HIT_ZONE_Y_RAT  = 0.76;   // fraction of canvas height — the target strum line
  const WINDOW_AMAZING  = 5;
  const WINDOW_GOOD     = 25;
  const WINDOW_OK       = 50;
  const WINDOW_LATE     = 100;

  /* ═══════════════════════════════════════════
     STATE
  ═══════════════════════════════════════════ */
  // Source data (from loaded arrangement XML)
  let sourceTitle  = '';
  let sourceArtist = '';
  let chordPool    = [];   // [{name, frets, fingers}] — all unique chords in arrangement
  let chordQueue   = [];   // [{name, strum_index, num_strums}] — strum pulses from XML
  let ebeats       = [];   // [{time, is_downbeat}] — for metronome scheduling
  let queueHead    = 0;    // index into chordQueue for next spawn

  // Game
  let barrels      = [];
  let score        = 0;
  let streak       = 0;
  let lives        = LIVES_MAX;
  let level        = 1;
  let gameRunning  = false;
  let detectActive    = true;
  let _gameStartTime  = 0;
  let infiniteLives   = false;
  let nextBarrelId = 0;
  let spawnTimer   = 0;
  let lastTs       = null;
  let raf          = null;
  let missParticles    = [];    // { x, y, vx, vy, col, life, decay }
  let comboPopups      = [];    // { x, y, vy, text, col, life, decay }
  let _gorillaThrowing  = false;
  let _gorillaThrowTime = 0;
  let _lastBeatPulseTime  = 0;
  let _lastBeatIsDownbeat = false;
  let _nextBeatIdx        = 0;
  let _playerStrumTime    = -1;
  let _kongModeActive     = false;
  let _kongModeEndTime    = 0;
  const KONG_STREAK       = 10;
  const KONG_DURATION_MS  = 5000;
  let _gorillaChestBeat   = false;
  let _hasMissed          = false;

  /* ═══════════════════════════════════════════
     DOM
  ═══════════════════════════════════════════ */
  const canvas        = document.getElementById('gameCanvas');
  const ctx           = canvas.getContext('2d');
  const hudScore      = document.getElementById('hud-score');
  const hudStreak     = document.getElementById('hud-streak');
  const hudLives      = document.getElementById('hud-lives');
  const hudLevel      = document.getElementById('hud-level');
  const hudQueue      = document.getElementById('hud-queue');
  const statusMsg     = document.getElementById('status-msg');
  const chordPanel    = document.getElementById('chord-panel');
  const overlay       = document.getElementById('overlay');
  const overlayTitle  = document.getElementById('overlay-title');
  const overlayBody   = document.getElementById('overlay-body');
  const overlayScore  = document.getElementById('overlay-score');
  const flashEl       = document.getElementById('flash');
  const speedSel      = document.getElementById('speed-select');
  const dlcSelect     = document.getElementById('dlc-select');
  const fileInput     = document.getElementById('file-input');

  // Diagram elements
  const cfCurrentName = document.getElementById('cf-current-name');
  const cfNextName    = document.getElementById('cf-next-name');
  const diagCurrent   = document.getElementById('diag-current');
  const timingPopup   = document.getElementById('timing-popup');
  const diagNext      = document.getElementById('diag-next');
  const dcCtx         = diagCurrent.getContext('2d');
  const dnCtx         = diagNext.getContext('2d');

  /* ═══════════════════════════════════════════
     CANVAS RESIZE
  ═══════════════════════════════════════════ */
  function setLayoutHeight() {
    const pluginDiv = document.getElementById('plugin-rock_n_rolla');
    const isMgMode  = pluginDiv && pluginDiv.dataset.mgActive === '1';
    const navbar    = document.getElementById('navbar');
    // In minigame mode the div is a fixed full-screen overlay — no navbar offset needed.
    const navH      = (!isMgMode && navbar) ? navbar.offsetHeight : 0;
    const totalH    = window.innerHeight - navH;

    const topbar    = document.getElementById('topbar');
    const sourceRow = document.getElementById('source-row');
    const footer    = document.getElementById('footer');
    const main      = document.getElementById('main');

    const topH    = (topbar    ? topbar.offsetHeight    : 0);
    const srcH    = (sourceRow ? sourceRow.offsetHeight : 0);
    const footH   = (footer    ? footer.offsetHeight    : 0);
    const mainTop = topH + srcH;
    const mainH   = totalH - mainTop - footH;

    if (mainH > 50 && main) {
      main.style.top    = mainTop + 'px';
      main.style.bottom = footH   + 'px';
      main.style.height = mainH   + 'px';
    }

    // In plugin-nav mode, size the screen div to fill the area below the fixed navbar.
    if (pluginDiv && !isMgMode) {
      pluginDiv.style.marginTop = navH   + 'px';
      pluginDiv.style.height    = totalH + 'px';
    }
  }

  function resizeCanvas() {
    setLayoutHeight();
    const wrap = canvas.parentElement;
    const w = wrap.offsetWidth  || window.innerWidth;
    const h = wrap.offsetHeight || parseInt(document.getElementById('main')?.style.height || '0');
    if (w > 10 && h > 10) {
      canvas.width  = Math.floor(w);
      canvas.height = Math.floor(h);
    }
  }

  const _ro = new ResizeObserver(() => { resizeCanvas(); if (!gameRunning) drawIdle(); });
  _ro.observe(document.body);
  _ro.observe(canvas.parentElement);

  window.addEventListener('resize', () => { resizeCanvas(); if (!gameRunning) drawIdle(); });

  // Set height immediately and on a few retries — Slopsmith finishes
  // laying out asynchronously so the first call may be too early
  setLayoutHeight();
  resizeCanvas();
  [100, 300, 800, 2000].forEach(ms =>
    setTimeout(() => { resizeCanvas(); if (!gameRunning) drawIdle(); }, ms)
  );

  /* ═══════════════════════════════════════════
     FRETBOARD DIAGRAM RENDERER
     Draws a 6-string guitar chord diagram onto a canvas context.
     frets: array[6] of int (-1 = muted, 0 = open, N = fret number)
     fingers: array[6] of int (0 = none / muted)
  ═══════════════════════════════════════════ */
  function drawDiagram(dCtx, chord, isCurrent) {
    const W  = dCtx.canvas.width;
    const H  = dCtx.canvas.height;
    dCtx.clearRect(0, 0, W, H);

    if (!chord) {
      dCtx.fillStyle = 'rgba(255,255,255,0.08)';
      dCtx.fillRect(0, 0, W, H);
      return;
    }

    const frets   = chord.frets;   // [6]
    const fingers = chord.fingers; // [6]

    // Find fret range to display
    const activeFrets = frets.filter(f => f > 0);
    const minFret = activeFrets.length ? Math.min(...activeFrets) : 1;
    const maxFret = activeFrets.length ? Math.max(...activeFrets) : 5;
    const displayMin = maxFret > 5 ? minFret : 1;
    const FRETS_SHOWN = Math.max(5, maxFret - displayMin + 1);

    // Layout
    const PAD_L  = 14;
    const PAD_R  = 10;
    const PAD_T  = 14;
    const PAD_B  = 14;
    const gridW  = W - PAD_L - PAD_R;
    const gridH  = H - PAD_T - PAD_B;
    const STRINGS = 6;
    const strGap  = gridW / (STRINGS - 1);
    const fretGap = gridH / FRETS_SHOWN;

    const sx = (s) => PAD_L + s * strGap;        // x for string s (0=low E)
    const fy = (f) => PAD_T + (f - displayMin + 0.5) * fretGap; // y for fret f

    // Background
    dCtx.fillStyle = '#0d0804';
    dCtx.fillRect(0, 0, W, H);

    // Nut / position marker
    const accentColor = isCurrent ? '#00ff88' : '#c8903a';
    if (displayMin <= 1) {
      dCtx.fillStyle = '#f0e8d0';
      dCtx.fillRect(PAD_L - 1, PAD_T - 4, gridW + 2, 4);
    } else {
      // Fret position number
      dCtx.fillStyle = accentColor;
      dCtx.font = '9px "Press Start 2P", monospace';
      dCtx.textAlign = 'left';
      dCtx.textBaseline = 'middle';
      dCtx.fillText(displayMin + 'fr', 0, PAD_T + fretGap * 0.5);
    }

    // Fret lines
    dCtx.strokeStyle = '#3a2808';
    dCtx.lineWidth = 1;
    for (let f = 0; f <= FRETS_SHOWN; f++) {
      const y = PAD_T + f * fretGap;
      dCtx.beginPath();
      dCtx.moveTo(PAD_L, y);
      dCtx.lineTo(PAD_L + gridW, y);
      dCtx.stroke();
    }

    // String lines
    dCtx.lineWidth = 1;
    for (let s = 0; s < STRINGS; s++) {
      const isMuted = frets[s] === -1;
      dCtx.strokeStyle = isMuted ? '#2a1808' : '#8a7050';
      dCtx.beginPath();
      dCtx.moveTo(sx(s), PAD_T);
      dCtx.lineTo(sx(s), PAD_T + gridH);
      dCtx.stroke();
    }

    // Mute / open circles above nut
    for (let s = 0; s < STRINGS; s++) {
      const x = sx(s);
      const y = PAD_T - 8;
      if (frets[s] === -1) {
        // Muted
        dCtx.strokeStyle = '#cc4444';
        dCtx.lineWidth = 1.5;
        dCtx.beginPath();
        dCtx.moveTo(x - 4, y - 4); dCtx.lineTo(x + 4, y + 4);
        dCtx.moveTo(x + 4, y - 4); dCtx.lineTo(x - 4, y + 4);
        dCtx.stroke();
      } else if (frets[s] === 0) {
        // Open
        dCtx.strokeStyle = '#8a8860';
        dCtx.lineWidth = 1.5;
        dCtx.beginPath();
        dCtx.arc(x, y, 4, 0, Math.PI * 2);
        dCtx.stroke();
      }
    }

    // Fingering dots
    // Detect barre chords (same fret, same finger, multiple strings)
    const fretFingerMap = {};
    for (let s = 0; s < STRINGS; s++) {
      if (frets[s] > 0 && fingers[s] > 0) {
        const key = `${frets[s]}_${fingers[s]}`;
        if (!fretFingerMap[key]) fretFingerMap[key] = [];
        fretFingerMap[key].push(s);
      }
    }

    const drawn = new Set();
    for (let s = 0; s < STRINGS; s++) {
      if (frets[s] <= 0) continue;
      const key = `${frets[s]}_${fingers[s]}`;
      if (drawn.has(key)) continue;
      const strings = fretFingerMap[key] || [s];
      drawn.add(key);

      const y = fy(frets[s]);
      const r = Math.min(strGap, fretGap) * 0.38;

      if (strings.length > 1) {
        // Barre — draw rounded bar
        const x1 = sx(strings[0]);
        const x2 = sx(strings[strings.length - 1]);
        dCtx.fillStyle = accentColor;
        dCtx.beginPath();
        dCtx.roundRect(Math.min(x1,x2) - r, y - r, Math.abs(x2-x1) + r*2, r*2, r);
        dCtx.fill();
        // Finger number
        dCtx.fillStyle = '#000';
        dCtx.font = `bold ${Math.max(7, r * 1.2)}px monospace`;
        dCtx.textAlign = 'center';
        dCtx.textBaseline = 'middle';
        if (fingers[s] > 0) dCtx.fillText(fingers[s], (x1 + x2) / 2, y);
      } else {
        // Single dot
        dCtx.fillStyle = accentColor;
        dCtx.beginPath();
        dCtx.arc(sx(strings[0]), y, r, 0, Math.PI * 2);
        dCtx.fill();
        dCtx.fillStyle = '#000';
        dCtx.font = `bold ${Math.max(7, r * 1.1)}px monospace`;
        dCtx.textAlign = 'center';
        dCtx.textBaseline = 'middle';
        if (fingers[s] > 0) dCtx.fillText(fingers[s], sx(strings[0]), y);
      }
    }
  }

  function updateDiagrams() {
    const curEntry  = chordQueue[queueHead]     || null;
    const nextEntry = chordQueue[queueHead + 1] || null;

    const currentName = curEntry  ? curEntry.name  : null;
    const nextName    = nextEntry ? nextEntry.name  : null;

    const currentChord = chordPool.find(c => c.name === currentName) || null;
    const nextChord    = chordPool.find(c => c.name === nextName)    || null;

    // Show repeat indicator if this is not the first strum of the chord
    const curRepeat  = curEntry  && curEntry.strum_index  > 0;
    const nextRepeat = nextEntry && nextEntry.strum_index > 0;

    cfCurrentName.textContent = currentName
      ? (curRepeat  ? '↻ ' + currentName : currentName)
      : '—';
    cfNextName.textContent    = nextName
      ? (nextRepeat ? '↻ ' + nextName    : nextName)
      : '—';

    drawDiagram(dcCtx, currentChord, true);
    drawDiagram(dnCtx, nextChord,    false);

    hudQueue.textContent = chordQueue.length
      ? `${queueHead}/${chordQueue.length}`
      : '0/0';
  }

  /* ═══════════════════════════════════════════
     SOURCE LOADING
  ═══════════════════════════════════════════ */
  function applySourceData(data) {
    if (!data || !data.chords) return;
    sourceTitle  = data.title  || '';
    sourceArtist = data.artist || '';
    chordPool    = data.chords || [];
    ebeats       = data.ebeats  || [];
    // queue entries are {name, strum_index, num_strums} from backend
    const rawQueue = data.queue || [];

    // If queue is empty (lead/bass XMLs with no chord data), build a
    // fallback of single-strum entries from the pool
    if (rawQueue.length === 0 && chordPool.length > 0) {
      const reps = Math.max(20, Math.ceil(60 / chordPool.length));
      for (let i = 0; i < reps; i++) {
        chordPool.forEach(c => rawQueue.push({ name: c.name, strum_index: 0, num_strums: 1 }));
      }
    }
    chordQueue = rawQueue;

    queueHead = 0;
    renderChordPanel();
    updateDiagrams();
    refreshScorerChords();

    statusMsg.textContent = `??? | ${chordQueue.length} STRUMS IN QUEUE`;
  }

  async function loadFromDLCPath(path) {
    if (!path) return;
    statusMsg.textContent = 'LOADING...';
    try {
      const res  = await fetch(`/api/rock_n_rolla/source?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      applySourceData(data);
      overlayBody.textContent = 'Arrangement loaded — can you name that tune? Hit START!';
      overlay.style.display = 'flex';
    } catch (e) {
      statusMsg.textContent = 'LOAD FAILED';
    }
  }

  async function loadFromFile(file) {
    statusMsg.textContent = 'PARSING...';
    const form = new FormData();
    form.append('file', file);
    try {
      const res  = await fetch('/api/rock_n_rolla/upload', { method: 'POST', body: form });
      const data = await res.json();
      applySourceData(data);
      overlayBody.textContent = 'Arrangement loaded — can you name that tune? Hit START!';
      overlay.style.display = 'flex';
    } catch (e) {
      statusMsg.textContent = 'UPLOAD FAILED';
    }
  }

  async function refreshDLCSources() {
    dlcSelect.innerHTML = '<option value="">— scanning… —</option>';
    try {
      const res  = await fetch('/api/rock_n_rolla/sources');
      const data = await res.json();
      dlcSelect.innerHTML = '<option value="">— pick an arrangement —</option>';
      (data.sources || []).forEach(src => {
        const opt = document.createElement('option');
        opt.value       = src.path;
        opt.textContent = src.label;
        dlcSelect.appendChild(opt);
      });
      if (!data.sources?.length) {
        dlcSelect.innerHTML = '<option value="">— no XMLs found in DLC —</option>';
      }
    } catch (e) {
      dlcSelect.innerHTML = '<option value="">— DLC scan failed —</option>';
    }
  }

  /* ═══════════════════════════════════════════
     SIDEBAR CHORD PANEL
  ═══════════════════════════════════════════ */
  function renderChordPanel() {
    chordPanel.innerHTML = '';
    if (!chordPool.length) {
      chordPanel.innerHTML = '<div style="font-family:VT323,monospace;font-size:14px;color:#666;text-align:center;padding:20px">Load a source first</div>';
      return;
    }
    chordPool.forEach(chord => {
      const strums = chordQueue.filter(e => e.name === chord.name).length;
      const inQueue = strums > 0;
      const chip = document.createElement('div');
      chip.className = 'chord-chip' + (inQueue ? ' active' : '');
      chip.innerHTML = `<span>${chord.name}</span>${inQueue ? `<span class="chip-check" title="${strums} strums">×${strums}</span>` : ''}`;
      chordPanel.appendChild(chip);
    });
  }

  /* ═══════════════════════════════════════════
     GAME LOGIC
  ═══════════════════════════════════════════ */
  function startGame() {
    if (!chordQueue.length) {
      overlayTitle.textContent = '⚠ NO SOURCE';
      overlayBody.textContent  = 'Load an arrangement XML first!';
      overlay.style.display    = 'flex';
      return;
    }
    overlay.style.display = 'none';
    overlayScore.style.display = 'none';
    barrels      = [];
    score        = 0;
    streak       = 0;
    lives        = LIVES_MAX;
    level        = 1;
    queueHead    = 0;
    spawnTimer   = 0;
    gameRunning      = true;
    lastTs           = null;
    _gameStartTime   = performance.now();
    missParticles    = [];
    comboPopups      = [];
    _hasMissed       = false;
    _gorillaChestBeat = false;
    _kongModeActive  = false;
    _kongModeEndTime = 0;
    _nextBeatIdx     = 0;
    statusMsg.textContent = `??? | ${chordQueue.length} STRUMS IN QUEUE`;
    updateHUD();
    updateDiagrams();
    scheduleMetronome(performance.now());
    if (detectActive) startChordScorer();
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(gameLoop);
  }

  function spawnInterval() {
    const mult = parseFloat(speedSel.value);
    return Math.max(700, 2400 - (level - 1) * 140) / mult;
  }

  function fallSpeed() {
    const mult = parseFloat(speedSel.value);
    return (1.4 + (level - 1) * 0.28) * mult;
  }

  function spawnBarrel() {
    if (queueHead >= chordQueue.length) {
      queueHead = 0;  // loop
    }
    const entry     = chordQueue[queueHead];
    const chordName = entry ? entry.name : null;
    const chord     = chordPool.find(c => c.name === chordName);
    if (!chord) { queueHead++; return; }

    const isRepeat = entry && entry.strum_index > 0;

    queueHead++;
    _gorillaThrowing  = true;
    _gorillaThrowTime = performance.now();
    updateDiagrams(); // advance the display to show next chord

    // Barrels start at the top of the hill and roll down
    barrels.push({
      id: nextBarrelId++,
      chord,
      isRepeat,
      col: 0,
      t: 0.0,            // hill parameter: 0=top, 1=base
      x: 0, y: 0,        // computed each frame from t
      vy: fallSpeed(),   // reused as hill speed (t units/frame)
      rollAngle: 0,
      hit: false,
      hitTime: 0,
      missed: false,
      fire:            level >= 3 && Math.random() < 0.25,
      firePhase:       Math.random() * Math.PI * 2,
      trail:           [],
      launching:       true,
      launchStartTime: performance.now(),
      launchDuration:  320,
      launchX0:        canvas.width  * 0.91,
      launchY0:        canvas.height * 0.10 - 18,
    });
  }

  function gameLoop(ts) {
    if (!gameRunning) return;
    const dt = lastTs ? Math.min(ts - lastTs, 100) : 16.67;
    lastTs   = ts;

    spawnTimer += dt;
    if (spawnTimer >= spawnInterval()) {
      spawnBarrel();
      spawnTimer = 0;
    }

    const floorY = canvas.height * FLOOR_Y_RAT;

    // Hill geometry constants (must match hillGeom() / draw())
    // Flipped: gorilla top-RIGHT, player bottom-LEFT
    const hillTopX  = canvas.width  * 0.92;
    const hillTopY  = canvas.height * 0.10;
    const hillBaseX = canvas.width  * 0.08;
    const hillBaseY = canvas.height * 0.82;
    const hillLen   = Math.hypot(hillBaseX - hillTopX, hillBaseY - hillTopY);
    const hitLineY  = canvas.height * HIT_ZONE_Y_RAT;
    const hitT      = (hitLineY - hillTopY) / (hillBaseY - hillTopY);

    // Beat detection for STRUM line pulse
    const _gameElapsedSec = (performance.now() - _gameStartTime) / 1000;
    while (_nextBeatIdx < ebeats.length && ebeats[_nextBeatIdx].time <= _gameElapsedSec) {
      _lastBeatPulseTime  = performance.now();
      _lastBeatIsDownbeat = ebeats[_nextBeatIdx].is_downbeat;
      _nextBeatIdx++;
    }

    // Kong Mode expiry
    if (_kongModeActive && performance.now() > _kongModeEndTime) {
      _kongModeActive = false;
    }

    for (const b of barrels) {
      if (b.hit) continue;

      // Launch arc — barrel flies from gorilla to hilltop before rolling
      if (b.launching) {
        const launchProg = Math.min(1, (performance.now() - b.launchStartTime) / b.launchDuration);
        if (launchProg >= 1) {
          b.launching = false;
        } else {
          const gx = b.launchX0 - BARREL_W / 2;
          const gy = b.launchY0 - BARREL_H / 2;
          b.x = gx + (hillTopX - BARREL_W / 2 - gx) * launchProg;
          b.y = gy + (hillTopY - BARREL_H / 2 - gy) * launchProg - Math.sin(launchProg * Math.PI) * 40;
          b.rollAngle -= 0.06;
          b.trail.unshift({ x: b.x + BARREL_W / 2, y: b.y + BARREL_H / 2 });
          if (b.trail.length > 6) b.trail.length = 6;
          continue;
        }
      }

      // Advance along hill (t units per frame, scaled by dt)
      const speed = b.vy / hillLen * (dt / 16.67);
      b.t += speed;

      // Compute world position from t
      b.x = hillTopX + (hillBaseX - hillTopX) * b.t - BARREL_W / 2;
      b.y = hillTopY + (hillBaseY - hillTopY) * b.t - BARREL_H / 2;

      // Roll angle: rotate proportional to distance travelled
      b.rollAngle -= speed * hillLen * 0.08;  // CCW: rolling left-downhill

      // Trail update
      b.trail.unshift({ x: b.x + BARREL_W / 2, y: b.y + BARREL_H / 2 });
      if (b.trail.length > 6) b.trail.length = 6;

      // Barrel reached base of hill → miss
      if (b.t >= 1.0 && !b.missed) {
        b.missed  = true;
        b.hit     = true;
        b.hitTime = ts;
        spawnMissDebris(b.x + BARREL_W / 2, b.y + BARREL_H / 2, chordColor(b.chord.name));
        loseLife();
      }
    }

    barrels = barrels.filter(b => !b.hit || (ts - b.hitTime < 700));

    // Level up every 10 successful hits
    const newLevel = Math.max(1, Math.floor(score / (SCORE_HIT * 10)) + 1);
    if (newLevel !== level) { level = newLevel; hudLevel.textContent = level; }

    draw(ts);
    raf = requestAnimationFrame(gameLoop);
  }

  function loseLife() {
    _hasMissed = true;
    if (!infiniteLives) {
      lives = Math.max(0, lives - 1);
    }
    streak = 0;
    updateHUD();
    flash('miss');
    showTiming('✗ MISS', '#ff2244');
    if (!infiniteLives && lives <= 0) endGame();
  }

  function spawnMissDebris(x, y, col) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const speed = 2.5 + Math.random() * 3.5;
      missParticles.push({
        x, y,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed - 1.5,
        col,
        life:  1.0,
        decay: 0.022 + Math.random() * 0.018,
      });
    }
  }

  function hitBarrel(barrelId) {
    const b = barrels.find(b => b.id === barrelId && !b.hit);
    if (!b) return;

    // Timing via hill t parameter
    const _hTopY  = canvas.height * 0.10;
    const _hBaseY = canvas.height * 0.82;
    const _hitT   = (canvas.height * HIT_ZONE_Y_RAT - _hTopY) / (_hBaseY - _hTopY);
    const _hLen   = Math.hypot(canvas.width * 0.87, canvas.height * 0.70);
    const tOff    = b.t - _hitT;
    const pxPerMs = b.vy / 16.67;
    const msOff   = Math.abs(tOff * _hLen / pxPerMs);
    const isEarly = tOff < 0;

    let timingLabel, timingColor, timingBonus;
    if (msOff <= WINDOW_AMAZING) {
      timingLabel = '★ AMAZING!';  timingColor = '#00ffcc'; timingBonus = 150;
    } else if (msOff <= WINDOW_GOOD) {
      timingLabel = '✓ GOOD';      timingColor = '#00ff88'; timingBonus = 80;
    } else if (msOff <= WINDOW_OK) {
      timingLabel = '~ OK';        timingColor = '#f5c518'; timingBonus = 30;
    } else if (msOff <= WINDOW_LATE) {
      timingLabel = isEarly ? '◀ EARLY' : '▶ LATE'; timingColor = '#ff8844'; timingBonus = 0;
    } else {
      // Outside window entirely — still counts if barrel isn't missed yet
      timingLabel = isEarly ? '◀ EARLY' : '▶ LATE'; timingColor = '#ff4422'; timingBonus = 0;
    }

    b.hit     = true;
    b.hitTime = performance.now();
    _playerStrumTime = performance.now();
    const _fireMult = b.fire ? 2 : 1;
    const _kongMult = _kongModeActive ? 3 : 1;
    score    += (SCORE_HIT + timingBonus + streak * SCORE_COMBO_BONUS) * _fireMult * _kongMult;
    streak++;
    if (!_kongModeActive && streak >= KONG_STREAK) {
      _kongModeActive  = true;
      _kongModeEndTime = performance.now() + KONG_DURATION_MS;
    }
    updateHUD();
    flash('hit');
    showTiming(timingLabel, timingColor);
    triggerPlayerJump();
    if (streak >= 3) {
      const { topX, topY, baseX, baseY, H } = hillGeom();
      const _hly = H * HIT_ZONE_Y_RAT;
      const _hlx = topX + (baseX - topX) * ((_hly - topY) / (baseY - topY));
      const jumpArc = player.jumping ? Math.sin(player.jumpT * Math.PI) * 52 : 0;
      comboPopups.push({
        x:     _hlx + 20,
        y:     _hly - 44 - jumpArc,
        vy:    -1.8,
        text:  `×${streak}`,
        col:   streak >= 8 ? '#ff8844' : '#f5c518',
        life:  1.0,
        decay: 0.016,
      });
    }
  }

  function tryChordHit(chordName) {
    if (!gameRunning) return;

    // Verify the player is actually playing this chord via the SDK scorer
    if (_chordScorer) {
      const chord = chordPool.find(c => c.name === chordName);
      if (!chord) return;
      const notes = chord.frets
        .map((f, s) => f === -1 ? null : { s, f })
        .filter(Boolean);
      try {
        const result = _chordScorer.score({ notes, arrangement: 'guitar', tuning: [0, 0, 0, 0, 0, 0] });
        debugEvent('score()', { chord: chordName, hit: result.hit, score: result.score?.toFixed?.(3) });
        if (!result.hit) return;
      } catch(e) {
        debugEvent('score() err', { msg: e.message });
        return;
      }
    }

    const hitLineY = canvas.height * HIT_ZONE_Y_RAT;

    // Hill geometry
    const _hillTopY  = canvas.height * 0.10;
    const _hillBaseY = canvas.height * 0.82;
    const _hitLineY  = canvas.height * HIT_ZONE_Y_RAT;
    const _hitT      = (_hitLineY - _hillTopY) / (_hillBaseY - _hillTopY);
    const _hillLen   = Math.hypot(canvas.width * 0.84, canvas.height * 0.72);

    // Find the barrel of this chord closest to hitT, within timing window
    let best = null, bestDist = Infinity;
    for (const b of barrels) {
      if (b.hit) continue;
      if (b.chord.name !== chordName) continue;
      const tOff    = b.t - _hitT;                        // negative = early
      const pxPerMs = b.vy / 16.67;                       // hill-speed px/ms
      const msOff   = (tOff * _hillLen) / pxPerMs;
      const winMult = b.fire ? 0.6 : 1;
      if (msOff >= -(WINDOW_LATE * 2 * winMult) && msOff <= WINDOW_LATE * winMult) {
        const dist = Math.abs(tOff);
        if (dist < bestDist) { bestDist = dist; best = b; }
      }
    }

    if (best) {
      hitBarrel(best.id);
    } else {
      // Check if there's a barrel of this chord at all (too early = ignore silently)
      const hasChord = barrels.some(b => !b.hit && b.chord.name === chordName);
      if (!hasChord) {
        // Wrong chord entirely
        streak = 0;
        updateHUD();
        flash('miss');
        showTiming('✗ WRONG', '#ff2244');
      }
      // else: barrel exists but too early — silent ignore, don't penalise
    }
  }

  function endGame() {
    gameRunning       = false;
    _gorillaChestBeat = true;
    _kongModeActive   = false;
    const revealLabel   = sourceArtist
      ? `${sourceArtist} — ${sourceTitle}`
      : (sourceTitle || 'Unknown');
    const perfectClear  = queueHead >= chordQueue.length && !_hasMissed;
    if (perfectClear) {
      overlayTitle.textContent = '★ PERFECT CLEAR! ★';
      overlayBody.textContent  = `FLAWLESS! ${revealLabel}`;
      celebratePerfectClear();
    } else {
      overlayTitle.textContent = 'GAME OVER';
      overlayBody.textContent  = `That was: ${revealLabel}`;
    }
    overlayScore.style.display  = 'block';
    overlayScore.textContent    = score.toString().padStart(6, '0');
    overlay.style.display       = 'flex';
    statusMsg.textContent       = `${revealLabel} | ${chordQueue.length} STRUMS`;
    cancelMetronome();
    stopChordScorer();
    if (window.slopsmithMinigames) {
      try { window.slopsmithMinigames.end({ score, durationMs: performance.now() - _gameStartTime, meta: { streak } }); } catch(e) {}
    }
    if (raf) { cancelAnimationFrame(raf); raf = null; }
  }

  function celebratePerfectClear() {
    const cx = canvas.width / 2, cy = canvas.height / 2;
    for (let i = 0; i < 60; i++) {
      const angle = (i / 60) * Math.PI * 2;
      const speed = 3 + Math.random() * 5;
      missParticles.push({
        x: cx, y: cy,
        vx:    Math.cos(angle) * speed,
        vy:    Math.sin(angle) * speed - 2,
        col:   RS_STRING_COLORS[i % RS_STRING_COLORS.length],
        life:  1.0,
        decay: 0.006 + Math.random() * 0.006,
      });
    }
    ['PERFECT!', '★★★', 'FLAWLESS!'].forEach((text, i) => {
      comboPopups.push({
        x:     cx + (i - 1) * 100,
        y:     cy - 20,
        vy:    -2.5 - i * 0.4,
        text,
        col:   i === 1 ? '#f5c518' : '#00ffcc',
        life:  1.0,
        decay: 0.006,
      });
    });
  }

  /* ═══════════════════════════════════════════
     HUD
  ═══════════════════════════════════════════ */
  function updateHUD() {
    const scoreStr = score.toString().padStart(6, '0');
    const livesStr = '❤️'.repeat(lives) + '🖤'.repeat(LIVES_MAX - lives);
    // Hidden topbar elements (kept for compat)
    hudScore.textContent  = scoreStr;
    hudStreak.textContent = streak;
    hudLives.textContent  = livesStr;
    hudLevel.textContent  = level;
    hudQueue.textContent  = chordQueue.length
      ? `${Math.min(queueHead, chordQueue.length)}/${chordQueue.length}`
      : '0/0';
    // Visible inline HUD in source-row
    const si = document.getElementById('hud-score-inline');
    const sti = document.getElementById('hud-streak-inline');
    const li = document.getElementById('hud-lives-inline');
    const lvi = document.getElementById('hud-level-inline');
    if (si)  si.textContent  = scoreStr;
    if (sti) sti.textContent = `STK:${streak}`;
    if (li)  li.textContent  = livesStr;
    if (lvi) lvi.textContent = `LVL:${level}`;
  }

  /* ═══════════════════════════════════════════
     FLASH
  ═══════════════════════════════════════════ */
  let flashTimeout = null;
  function flash(type) {
    flashEl.className = type;
    if (flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => { flashEl.className = ''; }, 180);
  }

  let timingTimeout = null;
  function showTiming(label, color) {
    timingPopup.textContent  = label;
    timingPopup.style.color  = color;
    timingPopup.classList.add('show');
    if (timingTimeout) clearTimeout(timingTimeout);
    timingTimeout = setTimeout(() => timingPopup.classList.remove('show'), 600);
  }

  /* ═══════════════════════════════════════════
     GAME RENDERER
  ═══════════════════════════════════════════ */
  // Hash chord name into the Rocksmith string-colour palette so each
  // chord gets a distinct, musically-familiar colour family.
  function chordColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return RS_STRING_COLORS[h % RS_STRING_COLORS.length];
  }

  /* ─────────────────────────────────────────────
     BARREL — end-on circular face (wheel view)
     Pass 1: rotating face — radial stave wedges + grain rings + bung
     Pass 2: metal hoop ring drawn on top of clip
     Pass 3: upright chord label (never rotates)
  ───────────────────────────────────────────── */
  function drawBarrel(b) {
    const cx  = b.x + BARREL_W / 2;
    const cy  = b.y + BARREL_H / 2;
    // Use smaller dimension so the circle fits within the bounding box
    const R   = Math.min(BARREL_W, BARREL_H) / 2;
    const col = _kongModeActive ? '#f5c518' : chordColor(b.chord.name);
    const STAVES = 8;

    ctx.save();
    ctx.translate(cx, cy);

    // ── Pass 1: rotating face (clipped to circle) ──
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R - 2, 0, Math.PI * 2);   // clip just inside the hoop
    ctx.clip();

    // Base fill
    ctx.fillStyle = shadeHex(col, -12);
    ctx.beginPath();
    ctx.arc(0, 0, R + 2, 0, Math.PI * 2);
    ctx.fill();

    // Radial stave wedges — rotate with rollAngle
    for (let i = 0; i < STAVES; i++) {
      const a0 = b.rollAngle + (i       / STAVES) * Math.PI * 2;
      const a1 = b.rollAngle + ((i + 1) / STAVES) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R + 4, a0, a1);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? shadeHex(col, 22) : shadeHex(col, -16);
      ctx.fill();
    }

    // Concentric grain rings
    ctx.lineWidth = 1;
    [R * 0.42, R * 0.70].forEach(r => {
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Centre bung
    ctx.fillStyle = shadeHex(col, -38);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.16, 0, Math.PI * 2);
    ctx.fill();

    // 3D depth overlay — bright highlight upper-left, shadow lower-right
    const depthGrad = ctx.createRadialGradient(-R * 0.35, -R * 0.35, 0, 0, 0, R * 1.2);
    depthGrad.addColorStop(0,    'rgba(255,255,255,0.26)');
    depthGrad.addColorStop(0.45, 'rgba(255,255,255,0.04)');
    depthGrad.addColorStop(1,    'rgba(0,0,0,0.38)');
    ctx.fillStyle = depthGrad;
    ctx.beginPath();
    ctx.arc(0, 0, R + 2, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();   // remove clip

    // ── Pass 2: metal hoop ring (sits on top) ──
    ctx.strokeStyle = '#d4c840';
    ctx.lineWidth   = 4.5;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();

    // Inner hoop edge highlight
    ctx.strokeStyle = 'rgba(210,190,25,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R - 4, 0, Math.PI * 2);
    ctx.stroke();

    // Scoring-window glow ring — appears when barrel enters the ±100ms hit window
    const _hTopY  = canvas.height * 0.10;
    const _hBaseY = canvas.height * 0.82;
    const _hitT   = (canvas.height * HIT_ZONE_Y_RAT - _hTopY) / (_hBaseY - _hTopY);
    if (Math.abs(b.t - _hitT) < 0.13) {
      const pulse = 0.35 + 0.35 * Math.sin(performance.now() / 80);
      ctx.strokeStyle = b.fire ? `rgba(255,80,0,${pulse.toFixed(2)})` : `rgba(0,255,136,${pulse.toFixed(2)})`;
      ctx.lineWidth   = 3.5;
      ctx.beginPath();
      ctx.arc(0, 0, R + 7, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();   // remove translate

    // ── Pass 2.5: fire flames ──
    if (b.fire) {
      ctx.save();
      ctx.translate(cx, cy);
      const _flT = performance.now();
      for (let _fi = 0; _fi < 4; _fi++) {
        const _fxOff   = (_fi - 1.5) * (R * 0.45);
        const _fBase   = -R - 1;
        const _fHeight = R * (0.5 + 0.4 * Math.sin(_flT / 60 + _fi * 1.3 + (b.firePhase || 0)));
        const _flGrad  = ctx.createLinearGradient(_fxOff, _fBase, _fxOff, _fBase - _fHeight);
        _flGrad.addColorStop(0,   '#ff8800');
        _flGrad.addColorStop(0.5, '#ff3300');
        _flGrad.addColorStop(1,   'rgba(255,180,0,0)');
        ctx.fillStyle = _flGrad;
        ctx.beginPath();
        ctx.moveTo(_fxOff - R * 0.14, _fBase);
        ctx.quadraticCurveTo(_fxOff + R * 0.10, _fBase - _fHeight * 0.6, _fxOff, _fBase - _fHeight);
        ctx.quadraticCurveTo(_fxOff - R * 0.10, _fBase - _fHeight * 0.6, _fxOff + R * 0.14, _fBase);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    // ── Pass 3: upright chord label (never rotates) ──
    ctx.save();
    ctx.translate(cx, cy);

    const name     = b.chord.name;
    const fontSize = name.length > 7 ? 6 : name.length > 5 ? 8 : 10;
    ctx.font         = `bold ${fontSize}px "Press Start 2P", monospace`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    ctx.strokeStyle = 'rgba(0,0,0,0.92)';
    ctx.lineWidth   = 4;
    ctx.strokeText(name, 0, b.isRepeat ? 2 : 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, 0, b.isRepeat ? 2 : 0);

    if (b.isRepeat) {
      ctx.font        = `bold 6px "Press Start 2P", monospace`;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.lineWidth   = 3;
      ctx.strokeText('↻', 0, -10);
      ctx.fillStyle   = '#f5c518';
      ctx.fillText('↻', 0, -10);
    }

    ctx.restore();
  }

  // Shade a hex colour by delta (-255..255)
  function shadeHex(hex, delta) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.max(0, (n >> 16) + delta));
    const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + delta));
    const b = Math.min(255, Math.max(0, (n & 0xff) + delta));
    return `rgb(${r},${g},${b})`;
  }


  const RS_STRING_COLORS = [
    '#ff2222',  // 0 low E  — red
    '#ffcc00',  // 1 A      — yellow
    '#3399ff',  // 2 D      — blue
    '#ff6600',  // 3 G      — orange
    '#66cc33',  // 4 B      — green
    '#cc44cc',  // 5 high e — purple
  ];

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x+r, y);
    c.lineTo(x+w-r, y);   c.quadraticCurveTo(x+w, y,   x+w, y+r);
    c.lineTo(x+w, y+h-r); c.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
    c.lineTo(x+r, y+h);   c.quadraticCurveTo(x,   y+h, x,   y+h-r);
    c.lineTo(x, y+r);     c.quadraticCurveTo(x,   y,   x+r, y);
    c.closePath();
  }

  /* ─────────────────────────────────────────────
     HILL GEOMETRY  (flipped: gorilla top-RIGHT, player bottom-LEFT)
     hillTop  = top-right  (gorilla throws from here)
     hillBase = bottom-left (player stands here)
  ───────────────────────────────────────────── */
  function hillGeom() {
    const W = canvas.width, H = canvas.height;
    return {
      W, H,
      topX:  W * 0.92,   topY:  H * 0.10,   // gorilla ledge top-right
      baseX: W * 0.08,   baseY: H * 0.82,   // player ledge bottom-left
    };
  }

  /* ─────────────────────────────────────────────
     MAIN DRAW
  ───────────────────────────────────────────── */
  function draw(ts) {
    const now = performance.now();
    const { W, H, topX, topY, baseX, baseY } = hillGeom();

    // ── Sky gradient ──
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#060810');
    sky.addColorStop(1, '#0e1a30');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // ── Stars (static pixel dots) ──
    ctx.fillStyle = '#ffffff';
    // deterministic from W+H so they don't flicker on resize
    const seed = W * 7 + H * 13;
    for (let i = 0; i < 60; i++) {
      const sx = ((seed * (i + 1) * 2654435761) >>> 0) % W;
      const sy = ((seed * (i + 1) * 2246822519) >>> 0) % Math.round(H * 0.55);
      ctx.fillRect(sx, sy, i % 3 === 0 ? 2 : 1, i % 3 === 0 ? 2 : 1);
    }

    // ── Hill polygon ──
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(baseX, baseY);
    ctx.lineTo(0, H);
    ctx.lineTo(W, H);
    ctx.lineTo(W, topY);
    ctx.closePath();
    const hillGrad = ctx.createLinearGradient(baseX, baseY, topX, topY);
    if (_kongModeActive) {
      hillGrad.addColorStop(0,   '#3a2800');
      hillGrad.addColorStop(0.5, '#5a4000');
      hillGrad.addColorStop(1,   '#3a3000');
    } else {
      hillGrad.addColorStop(0,   '#1a3a08');
      hillGrad.addColorStop(0.5, '#2a5a14');
      hillGrad.addColorStop(1,   '#1e4010');
    }
    ctx.fillStyle = hillGrad;
    ctx.fill();

    // Hill surface edge
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(baseX, baseY);
    ctx.strokeStyle = '#5aaa2a';
    ctx.lineWidth   = 5;
    ctx.stroke();
    ctx.restore();

    // Construction ramp girder rungs — lines perpendicular to slope direction,
    // clipped to the hill polygon so they respect the hill boundary.
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(topX, topY);
    ctx.lineTo(baseX, baseY);
    ctx.lineTo(0, H);
    ctx.lineTo(W, H);
    ctx.lineTo(W, topY);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha  = 0.13;
    ctx.strokeStyle  = '#88cc44';
    ctx.lineWidth    = 2;
    const _sdx = baseX - topX, _sdy = baseY - topY;
    const _sl  = Math.hypot(_sdx, _sdy);
    const _px  = -_sdy / _sl;   // unit vector perpendicular to slope
    const _py  =  _sdx / _sl;
    const GIRDER_GAP = 30;
    const nGirders   = Math.floor(_sl / GIRDER_GAP);
    for (let i = 1; i < nGirders; i++) {
      const t  = i / nGirders;
      const mx = topX + _sdx * t;
      const my = topY + _sdy * t;
      ctx.beginPath();
      ctx.moveTo(mx + _px * 320, my + _py * 320);
      ctx.lineTo(mx - _px * 320, my - _py * 320);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // ── Gorilla ledge (top-right) ──
    const ledgeW = W * 0.18;
    ctx.fillStyle = '#c8903a';
    ctx.fillRect(W - ledgeW, topY - 20, ledgeW, 20);
    ctx.fillStyle = '#f5c518';
    for (let rx = W - ledgeW + 10; rx < W - 6; rx += 28) {
      ctx.beginPath(); ctx.arc(rx, topY - 10, 3, 0, Math.PI * 2); ctx.fill();
    }

    // ── Player ledge (bottom-left) ──
    const pLedgeW = W * 0.20;
    ctx.fillStyle = '#c8903a';
    ctx.fillRect(0, baseY - 20, pLedgeW, 20);
    ctx.fillStyle = '#f5c518';
    for (let rx = 10; rx < pLedgeW - 6; rx += 28) {
      ctx.beginPath(); ctx.arc(rx, baseY - 10, 3, 0, Math.PI * 2); ctx.fill();
    }

    // ── Hit zone line — pulses on beat ──
    const hitLineY = H * HIT_ZONE_Y_RAT;
    const hitT_    = (hitLineY - topY) / (baseY - topY);
    const hitLineX = topX + (baseX - topX) * hitT_;
    ctx.save();
    const _beatAge   = now - _lastBeatPulseTime;
    const _beatPulse = Math.max(0, 1 - _beatAge / 200);
    const _strumAlpha = 0.55 + 0.40 * _beatPulse;
    const _strumWidth = _lastBeatIsDownbeat ? (2 + 3 * _beatPulse) : (1.5 + 1.5 * _beatPulse);
    ctx.strokeStyle = `rgba(0,255,136,${_strumAlpha.toFixed(2)})`;
    ctx.lineWidth   = _strumWidth;
    ctx.setLineDash([10, 6]);
    ctx.beginPath();
    ctx.moveTo(hitLineX - 60, hitLineY - 4);
    ctx.lineTo(hitLineX + 60, hitLineY + 4);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle    = `rgba(0,255,136,${(0.6 + 0.3 * _beatPulse).toFixed(2)})`;
    ctx.font         = '7px "Press Start 2P", monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('STRUM', hitLineX, hitLineY - 10);
    ctx.restore();

    // ── Player character ──
    if (player.jumping) {
      const elapsed = now - player.lastJumpTime;
      player.jumpT  = elapsed / player.jumpDuration;
      if (player.jumpT >= 1) { player.jumping = false; player.jumpT = 0; }
    }
    const jumpArc = player.jumping ? Math.sin(player.jumpT * Math.PI) * 52 : 0;
    // Player stands just to the right of the hit line
    const playerX = hitLineX + 20;
    const playerY = hitLineY - jumpArc;
    drawPlayer(playerX, playerY, player.jumping);

    // ── Chord diagrams above player ──
    // NEXT chord directly above player head, AFTER NEXT above that
    drawChordAbovePlayer(playerX, playerY);

    // ── Barrels ──
    for (const b of barrels) {
      if (b.hit) {
        const age = (now - b.hitTime) / 700;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - age);
        ctx.translate(b.x + BARREL_W/2, b.y + BARREL_H/2);
        const sc = b.missed ? (1 - age * 0.4) : (1 + age * 0.9);
        ctx.scale(sc, sc);
        ctx.translate(-(b.x + BARREL_W/2), -(b.y + BARREL_H/2));
        drawBarrel(b);
        ctx.restore();
      } else {
        // Shadow on slope
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle   = '#000';
        ctx.beginPath();
        ctx.ellipse(b.x + BARREL_W/2 + 8, b.y + BARREL_H/2 + 10, BARREL_W/2 + 2, 7, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // Speed-smear trail
        if (b.trail && b.trail.length > 1) {
          for (let _ti = 1; _ti < b.trail.length; _ti++) {
            const _tp = b.trail[_ti];
            ctx.save();
            ctx.globalAlpha = 0.18 * (1 - _ti / b.trail.length);
            ctx.fillStyle   = chordColor(b.chord.name);
            ctx.beginPath();
            ctx.arc(_tp.x, _tp.y, (BARREL_W / 2) * (1 - _ti / b.trail.length) * 0.7, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
          }
        }
        drawBarrel(b);
      }
    }

    // ── Gorilla (top-right) ──
    const _gorillaShakeX = (_kongModeActive || _gorillaChestBeat) ? Math.sin(now / 30) * 3 : 0;
    drawGorilla(W - W * 0.09 + _gorillaShakeX, topY - 18);

    // ── Kong Mode overlay ──
    if (_kongModeActive) {
      ctx.save();
      ctx.globalAlpha  = 0.85 + 0.15 * Math.sin(now / 80);
      ctx.font         = `bold ${Math.round(W * 0.055)}px "Press Start 2P", monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.lineWidth    = 6;
      ctx.strokeStyle  = '#000';
      ctx.strokeText('KONG MODE!', W / 2, H * 0.04);
      ctx.fillStyle    = '#f5c518';
      ctx.fillText('KONG MODE!', W / 2, H * 0.04);
      ctx.restore();
    }

    // ── Song progress bar ──
    const _songProg = chordQueue.length ? Math.min(1, queueHead / chordQueue.length) : 0;
    const _pbH = 5;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, H - _pbH, W, _pbH);
    ctx.fillStyle = _kongModeActive ? '#f5c518' : '#00cc66';
    ctx.fillRect(0, H - _pbH, W * _songProg, _pbH);

    // ── Miss debris particles ──
    missParticles = missParticles.filter(p => p.life > 0);
    for (const p of missParticles) {
      p.x   += p.vx;
      p.y   += p.vy;
      p.vy  += 0.20;
      p.life -= p.decay;
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle   = p.col;
      ctx.fillRect(Math.round(p.x - 2), Math.round(p.y - 2), 4, 4);
    }

    // ── Streak combo popups ──
    comboPopups = comboPopups.filter(p => p.life > 0);
    for (const p of comboPopups) {
      p.y    += p.vy;
      p.life -= p.decay;
      ctx.save();
      ctx.globalAlpha  = Math.max(0, p.life);
      ctx.font         = `bold 20px "Press Start 2P", monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeStyle  = 'rgba(0,0,0,0.85)';
      ctx.lineWidth    = 5;
      ctx.strokeText(p.text, p.x, p.y);
      ctx.fillStyle    = p.col;
      ctx.fillText(p.text, p.x, p.y);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /* ─────────────────────────────────────────────
     CHORD DIAGRAMS ABOVE PLAYER
     Replaces the fixed floating panels — diagrams
     float above the player's head in-world.
  ───────────────────────────────────────────── */
  function drawChordAbovePlayer(px, py) {
    const DW   = 130;   // diagram width
    const DH   = 140;   // diagram height
    const GAP  = 22;    // gap between diagrams
    const HEAD = Math.round(canvas.height * 0.10);  // 10% of canvas height above player

    // Find the two nearest active barrels (by t — closest to player = highest t)
    const active = barrels.filter(b => !b.hit).sort((a, b2) => b2.t - a.t);
    const nearestBarrel  = active[0] || null;
    const secondBarrel   = active[1] || null;

    // Fall back to queue if no barrels yet spawned
    const nextEntry  = nearestBarrel
      ? { name: nearestBarrel.chord.name,  strum_index: nearestBarrel.isRepeat ? 1 : 0 }
      : (chordQueue[queueHead] || null);
    const afterEntry = secondBarrel
      ? { name: secondBarrel.chord.name,   strum_index: secondBarrel.isRepeat ? 1 : 0 }
      : (chordQueue[queueHead + 1] || null);

    const nextChord  = nextEntry  ? chordPool.find(c => c.name === nextEntry.name)  : null;
    const afterChord = afterEntry ? chordPool.find(c => c.name === afterEntry.name) : null;

    // Pulse the NEXT diagram border when the barrel is imminent (t > 0.80)
    const nearT  = nearestBarrel ? nearestBarrel.t : 0;
    const urgent = nearT > 0.80;

    // NEXT diagram: directly above player head
    const nextX = px - DW / 2;
    const nextY = py - HEAD - DH;
    drawInWorldDiagram(nextX, nextY, DW, DH, nextChord,
      nextEntry  ? nextEntry.name  : null,
      nextEntry  && nextEntry.strum_index > 0,
      true, urgent);

    // AFTER diagram: above NEXT
    const afterX = px - DW / 2;
    const afterY = nextY - GAP - DH;
    drawInWorldDiagram(afterX, afterY, DW, DH, afterChord,
      afterEntry ? afterEntry.name : null,
      afterEntry && afterEntry.strum_index > 0,
      false, false);
  }

  function drawInWorldDiagram(x, y, w, h, chord, name, isRepeat, isCurrent, urgent) {
    const accentCol = isCurrent ? '#00ff88' : '#c8903a';

    // Pulse the border alpha and width when the NEXT barrel is imminent
    const borderAlpha = (isCurrent && urgent)
      ? (0.6 + 0.4 * Math.sin(performance.now() / 120)).toFixed(2)
      : '1';
    const borderCol = isCurrent
      ? `rgba(0,255,136,${borderAlpha})`
      : '#c8903a';

    // Background box
    ctx.fillStyle = 'rgba(6,3,0,0.92)';
    roundRect(ctx, x, y, w, h, 4);
    ctx.fill();

    // Border
    ctx.strokeStyle = borderCol;
    ctx.lineWidth   = (isCurrent && urgent) ? 4 : (isCurrent ? 3 : 2);
    roundRect(ctx, x, y, w, h, 4);
    ctx.stroke();

    // Label bar
    const labelH = 18;
    ctx.fillStyle = isCurrent ? 'rgba(0,255,136,0.18)' : 'rgba(200,144,58,0.18)';
    ctx.fillRect(x + 2, y + 2, w - 4, labelH);

    // Label text
    ctx.font         = '6px "Press Start 2P", monospace';
    ctx.fillStyle    = isCurrent ? '#00ff88' : '#c8903a';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(isCurrent ? '▶ NEXT' : '▷ AFTER', x + 6, y + 2 + labelH / 2);

    // Chord name
    const displayName = name ? (isRepeat ? '↻ ' + name : name) : '—';
    const nfs = displayName.length > 8 ? 7 : displayName.length > 5 ? 9 : 11;
    ctx.font         = `bold ${nfs}px "Press Start 2P", monospace`;
    ctx.fillStyle    = isCurrent ? '#00ff88' : '#f0e8d0';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayName, x + w / 2, y + labelH + 12);

    if (!chord) return;

    // Fretboard
    const frets   = chord.frets;
    const fingers = chord.fingers;
    const PAD_L = x + 10, PAD_R = x + w - 10;
    const PAD_T = y + labelH + 26, PAD_B = y + h - 8;
    const gridW = PAD_R - PAD_L;
    const gridH = PAD_B - PAD_T;
    const STRINGS = 6;

    const activeFrets = frets.filter(f => f > 0);
    const minFret = activeFrets.length ? Math.min(...activeFrets) : 1;
    const maxFret = activeFrets.length ? Math.max(...activeFrets) : 4;
    const displayMin  = maxFret > 5 ? minFret : 1;
    const FRETS_SHOWN = Math.max(4, maxFret - displayMin + 1);

    const strGap  = gridW / (STRINGS - 1);
    const fretGap = gridH / FRETS_SHOWN;
    const sx = s  => PAD_L + s * strGap;
    const fy = fr => PAD_T + (fr - displayMin + 0.5) * fretGap;

    // Nut
    if (displayMin <= 1) {
      ctx.fillStyle = '#f0e8d0';
      ctx.fillRect(PAD_L - 1, PAD_T - 3, gridW + 2, 3);
    } else {
      ctx.font = '6px monospace';
      ctx.fillStyle = accentCol;
      ctx.textAlign = 'left';
      ctx.fillText(displayMin + 'fr', x + 1, PAD_T + fretGap * 0.4);
    }

    // Fret lines
    ctx.strokeStyle = '#3a2808'; ctx.lineWidth = 1;
    for (let f = 0; f <= FRETS_SHOWN; f++) {
      const fy2 = PAD_T + f * fretGap;
      ctx.beginPath(); ctx.moveTo(PAD_L, fy2); ctx.lineTo(PAD_R, fy2); ctx.stroke();
    }

    // String lines + mute/open markers — Rocksmith colours
    for (let s = 0; s < STRINGS; s++) {
      const isMuted = frets[s] === -1;
      const sc = RS_STRING_COLORS[s];
      ctx.strokeStyle = isMuted ? 'rgba(80,40,40,0.5)' : sc;
      ctx.lineWidth   = isMuted ? 1 : 2;
      ctx.beginPath(); ctx.moveTo(sx(s), PAD_T); ctx.lineTo(sx(s), PAD_B); ctx.stroke();

      const mx = sx(s), my = PAD_T - 7;
      if (frets[s] === -1) {
        ctx.strokeStyle = '#884444'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(mx-3,my-3); ctx.lineTo(mx+3,my+3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(mx+3,my-3); ctx.lineTo(mx-3,my+3); ctx.stroke();
      } else if (frets[s] === 0) {
        ctx.strokeStyle = sc; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI*2); ctx.stroke();
      }
    }

    // Finger dots
    const fretFingerMap = {};
    for (let s = 0; s < STRINGS; s++) {
      if (frets[s] > 0 && fingers[s] > 0) {
        const key = `${frets[s]}_${fingers[s]}`;
        if (!fretFingerMap[key]) fretFingerMap[key] = [];
        fretFingerMap[key].push(s);
      }
    }
    const drawn = new Set();
    for (let s = 0; s < STRINGS; s++) {
      if (frets[s] <= 0) continue;
      const key = `${frets[s]}_${fingers[s]}`;
      if (drawn.has(key)) continue;
      const strings = fretFingerMap[key] || [s];
      drawn.add(key);
      const dotY = fy(frets[s]);
      const r    = Math.min(strGap, fretGap) * 0.36;
      if (strings.length > 1) {
        const x1 = sx(strings[0]), x2 = sx(strings[strings.length-1]);
        // Barre: white outline only, no fill
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.roundRect(Math.min(x1,x2)-r, dotY-r, Math.abs(x2-x1)+r*2, r*2, r);
        ctx.stroke();
      } else {
        ctx.fillStyle = RS_STRING_COLORS[strings[0]];
        ctx.beginPath(); ctx.arc(sx(strings[0]), dotY, r, 0, Math.PI*2); ctx.fill();
        if (fingers[s] > 0) {
          ctx.fillStyle='#000'; ctx.font=`bold ${Math.max(6,r)}px monospace`;
          ctx.textAlign='center'; ctx.textBaseline='middle';
          ctx.fillText(fingers[s], sx(strings[0]), dotY);
        }
      }
    }
  }

  // ── Player character state ──
  const player = {
    x: 0, y: 0,
    jumping: false,
    jumpT: 0,
    jumpDuration: 380,
    lastJumpTime: 0,
  };

  function triggerPlayerJump() {
    if (player.jumping) return;
    player.jumping      = true;
    player.jumpT        = 0;
    player.lastJumpTime = performance.now();
  }

  function drawGorilla(x, y) {
    // Pixel-art gorilla, facing left (throwing toward player)
    const p = (dx, dy, w, h, col) => {
      ctx.fillStyle = col; ctx.fillRect(x+dx, y+dy, w, h);
    };
    const isThrowing = _gorillaThrowing && (performance.now() - _gorillaThrowTime < 300);
    if (!isThrowing) _gorillaThrowing = false;
    // body
    p(-14, 4, 28, 26, '#1a1008');
    // head
    p(-10, -14, 20, 16, '#1a1008');
    // brow ridge
    p(-10, -14, 20, 4, '#0a0804');
    // eyes
    p(-7, -10, 4, 4, '#f5c518');
    p( 3, -10, 4, 4, '#f5c518');
    // snout
    p(-5, -4, 10, 6, '#3a2010');
    // arms — chest beat (game over) / throw / idle
    if (_gorillaChestBeat) {
      const _cbPhase = Math.floor(performance.now() / 150) % 2 === 0;
      if (_cbPhase) {
        p(-20, -2, 14, 9, '#1a1008');
        p(  6, -2, 14, 9, '#1a1008');
      } else {
        p(-32, -4, 18, 9, '#1a1008');
        p( 14, -4, 18, 9, '#1a1008');
      }
    } else if (isThrowing) {
      p(-30, -4,  14, 8,  '#1a1008');
      p(-42, -8,  10, 10, '#1a1008');
      p( 14,  4,  12, 10, '#1a1008');
    } else {
      p(-26, -8,  12, 10, '#1a1008');
      p(-32, -16, 10, 10, '#1a1008');
      p( 14,  4,  12, 10, '#1a1008');
    }
    // legs
    p(-12, 30, 10, 8, '#1a1008');
    p( 2,  30, 10, 8, '#1a1008');
  }

  function drawPlayer(px, py, jumping) {
    // Pixel-art guitarist, facing right (toward incoming barrels)
    const p = (dx, dy, w, h, col) => {
      ctx.fillStyle = col; ctx.fillRect(px+dx, py+dy, w, h);
    };
    // head
    p(-5, -32, 12, 12, '#f0c890');
    // hair
    p(-5, -32, 12, 4, '#3a1a08');
    // body / shirt
    p(-7, -20, 14, 16, '#d63b2f');
    // arms — right arm drops on strum
    const _isStrumming = (performance.now() - _playerStrumTime) < 180;
    p(-13, -18, 6, 10, '#f0c890');
    p(  7, _isStrumming ? -12 : -18, 6, 10, '#f0c890');
    // legs
    ctx.fillStyle = '#1a4a8a';
    if (!jumping) {
      ctx.fillRect(px-7, py-4,  6, 14);
      ctx.fillRect(px+1, py-4,  6, 14);
      // boots
      ctx.fillStyle = '#2a1a08';
      ctx.fillRect(px-8, py+8,  8, 6);
      ctx.fillRect(px,   py+8,  8, 6);
    } else {
      // tucked jump
      ctx.fillRect(px-9, py-10, 7, 9);
      ctx.fillRect(px+2, py-10, 7, 9);
      ctx.fillStyle = '#2a1a08';
      ctx.fillRect(px-10, py-3, 8, 5);
      ctx.fillRect(px+2,  py-3, 8, 5);
    }
    // guitar body (left side, player faces right)
    p(-18, -16, 10, 12, '#c8903a');
    p(-16, -18, 6,  3,  '#a07020');
    // guitar neck
    p(-14, -26, 3, 12, '#7a4a10');
    // strings hint
    ctx.fillStyle = '#c0c0a0';
    ctx.fillRect(px-13, py-25, 1, 10);
    ctx.fillRect(px-12, py-25, 1, 10);
  }

  function drawIdle() { draw(0); }


  /* ═══════════════════════════════════════════
     MINIGAMES SDK INTEGRATION
     Uses window.slopsmithMinigames.scoring.createChord()
     which wraps note_detect and handles its own audio
     pipeline — no song on the highway required.

     Falls back to legacy notedetect:* event listening
     when the SDK is not available (Docker/older builds).
  ═══════════════════════════════════════════ */

  // Debug panel
  const debugLines  = document.getElementById('debug-lines');
  const debugPanel  = document.getElementById('debug-panel');
  const DEBUG_MAX   = 6;
  let   debugLog    = [];

  function debugEvent(label, data) {
    debugLog.unshift({ ts: performance.now().toFixed(0), label, data: JSON.stringify(data, null, 0).slice(0, 180) });
    if (debugLog.length > DEBUG_MAX) debugLog.pop();
    if (!debugPanel) return;
    debugLines.innerHTML = debugLog.map((e, i) =>
      `<div class="debug-line ${i === 0 ? 'fresh' : ''}">` +
      `<span style="color:#888">[${e.ts}ms]</span> ` +
      `<span style="color:#f5c518">${e.label}</span><br>${e.data}</div>`
    ).join('');
  }

  // Active SDK chord scorer instance
  let _chordScorer   = null;
  let _scorerPollId  = null;

  function startChordScorer() {
    stopChordScorer();
    const sdk = window.slopsmithMinigames;
    if (!sdk || !sdk.scoring || !sdk.scoring.createChord) {
      debugEvent('SDK', 'not available — falling back to events');
      startLegacyDetect();
      return;
    }
    try {
      _chordScorer = sdk.scoring.createChord();
      _chordScorer.start();
      _scorerPollId = setInterval(_pollScorer, 60);
      debugEvent('SDK', 'createChord started OK');
    } catch(e) {
      debugEvent('SDK error', { msg: e.message });
      startLegacyDetect();
    }
  }

  function stopChordScorer() {
    if (_scorerPollId) { clearInterval(_scorerPollId); _scorerPollId = null; }
    if (_chordScorer)  { try { _chordScorer.stop(); } catch(e) {} _chordScorer = null; }
    stopLegacyDetect();
  }

  function _pollScorer() {
    if (!gameRunning || !detectActive || !_chordScorer) return;
    const _hTopY = canvas.height * 0.10;
    const _hBaseY = canvas.height * 0.82;
    const _hitT  = (canvas.height * HIT_ZONE_Y_RAT - _hTopY) / (_hBaseY - _hTopY);
    let best = null, bestDist = Infinity;
    for (const b of barrels) {
      if (b.hit) continue;
      const d = Math.abs(b.t - _hitT);
      if (d < bestDist) { bestDist = d; best = b; }
    }
    if (best && bestDist < 0.15) {
      tryChordHit(best.chord.name);
    }
  }

  // Update chord pool in scorer when source changes (no-op for execution-on-demand path)
  function refreshScorerChords() {
    if (_chordScorer && _chordScorer.setChords) {
      try {
        _chordScorer.setChords(chordPool.map(c => ({ name: c.name, frets: c.frets, fingers: c.fingers })));
      } catch(e) {}
    }
  }

  /* ── Legacy event fallback (older Slopsmith / Docker) ── */
  let _legacyBound = false;

  function _legacyHandler(e) {
    debugEvent(e.type, e.detail);
    if (!gameRunning || !detectActive) return;
    const d = e.detail || {};
    const chordName = d.chordName || d.note?.chordName || d.chord?.name || null;
    const verdict   = d.verdict || d.result || '';
    if (e.type === 'notedetect:hit' || e.type === 'notedetect:chord') {
      if (chordName) tryChordHit(chordName);
    } else if (e.type === 'notedetect:judgment') {
      if ((verdict === 'HIT' || verdict === 'CLEAN') && chordName) tryChordHit(chordName);
    }
  }

  const LEGACY_EVENTS = ['notedetect:judgment', 'notedetect:hit', 'notedetect:chord'];

  function startLegacyDetect() {
    if (_legacyBound) return;
    _legacyBound = true;
    LEGACY_EVENTS.forEach(ev => window.addEventListener(ev, _legacyHandler));
    debugEvent('legacy', 'listening for notedetect:* events');
  }

  function stopLegacyDetect() {
    if (!_legacyBound) return;
    _legacyBound = false;
    LEGACY_EVENTS.forEach(ev => window.removeEventListener(ev, _legacyHandler));
  }

  /* ── Register with the Minigames SDK ── */
  const _mgSpec = {
    id: 'rock_n_rolla',

    start: ({ container, modifiers, sdk }) => {
      if (modifiers?.speed)  speedSel.value = { easy:'1', normal:'1.5', hard:'2.2', insane:'3' }[modifiers.speed] || '1.5';
      if (modifiers?.lives)  infiniteLives  = modifiers.lives === 'infinite';
      // Overlay the plugin's own screen div over the minigames stage without
      // navigating away (navigation fires screen:changed which triggers SDK teardown).
      const screenDiv = document.getElementById('plugin-rock_n_rolla');
      if (screenDiv) {
        screenDiv.dataset.mgActive = '1';
        screenDiv.style.cssText    = 'display:block; position:fixed; inset:0; z-index:200;';
      }
      resizeCanvas();
      startGame();
    },

    stop: () => {
      gameRunning = false;
      stopChordScorer();
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      const screenDiv = document.getElementById('plugin-rock_n_rolla');
      if (screenDiv) {
        delete screenDiv.dataset.mgActive;
        screenDiv.style.cssText = '';
      }
    },
  };

  // Safe late-binding registration — SDK may load before or after us
  if (window.slopsmithMinigames) {
    window.slopsmithMinigames.register(_mgSpec);
    debugEvent('SDK', 'registered immediately');
  } else {
    (window.__slopsmithMinigamesPending = window.__slopsmithMinigamesPending || []).push(_mgSpec);
    debugEvent('SDK', 'queued for when SDK loads');
  }
  window.addEventListener('slopsmith-minigames-ready', () => {
    if (window.slopsmithMinigames) window.slopsmithMinigames.register(_mgSpec);
    debugEvent('SDK', 'registered on ready event');
  });

  /* ═══════════════════════════════════════════
     FALLBACK: canvas click → strum lowest barrel in lane
  ═══════════════════════════════════════════ */
  canvas.addEventListener('click', (e) => {
    if (!gameRunning) return;
    const rect = canvas.getBoundingClientRect();
    const mx   = (e.clientX - rect.left) * (canvas.width / rect.width);
    const col  = Math.floor(mx / (canvas.width / SPAWN_COLS));
    let best = null, bestY = -Infinity;
    for (const b of barrels) {
      if (b.hit || b.col !== col) continue;
      if (b.y > bestY) { bestY = b.y; best = b; }
    }
    if (best) hitBarrel(best.id);
  });

  /* ═══════════════════════════════════════════
     BUTTON / INPUT HANDLERS
  ═══════════════════════════════════════════ */
  document.getElementById('btn-start').addEventListener('click', startGame);

  document.getElementById('btn-detect').addEventListener('click', function () {
    detectActive = !detectActive;
    this.classList.toggle('active-detect', detectActive);
    this.textContent = detectActive ? '🎙 DETECT ON' : '🎙 DETECT';
    if (detectActive && gameRunning) startChordScorer();
    else if (!detectActive) stopChordScorer();
  });

  document.getElementById('btn-refresh-dlc').addEventListener('click', refreshDLCSources);

  dlcSelect.addEventListener('change', () => {
    const path = dlcSelect.value;
    if (path) loadFromDLCPath(path);
  });

  document.getElementById('btn-upload').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (file) loadFromFile(file);
    fileInput.value = '';
  });


  /* ═══════════════════════════════════════════
     METRONOME — Web Audio API
     Beat times come from the ebeats array (real song timestamps).
     We schedule oscillator pings in advance using AudioContext time.
     The metronome starts when the game starts and uses the ebeat
     timestamps offset by the game-start wall-clock time.
  ═══════════════════════════════════════════ */
  let audioCtx       = null;
  let metronomeNodes = [];   // keep refs to cancel
  let metronomeOn    = true;

  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function scheduleMetronome(gameStartWallTime) {
    cancelMetronome();
    if (!metronomeOn || !ebeats.length) return;
    ensureAudio();

    // audioCtx.currentTime when the game started
    const audioStartTime = audioCtx.currentTime + 0.05; // small scheduling buffer

    ebeats.forEach(eb => {
      const audioTime  = audioStartTime + eb.time;
      if (audioTime < audioCtx.currentTime) return;

      const osc  = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (eb.is_downbeat) {
        // Accented downbeat — higher pitch, louder, slightly longer
        osc.frequency.value = 1200;
        gain.gain.setValueAtTime(0.55, audioTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioTime + 0.06);
        osc.start(audioTime);
        osc.stop(audioTime + 0.07);
      } else {
        // Soft off-beat tick — lower pitch, quieter, shorter
        osc.frequency.value = 800;
        gain.gain.setValueAtTime(0.18, audioTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioTime + 0.03);
        osc.start(audioTime);
        osc.stop(audioTime + 0.04);
      }

      metronomeNodes.push(osc);
    });
  }

  function cancelMetronome() {
    metronomeNodes.forEach(n => { try { n.stop(); } catch(e) {} });
    metronomeNodes = [];
  }

  // Metronome toggle button (added to footer in HTML)
  document.getElementById('btn-metro').addEventListener('click', function() {
    metronomeOn = !metronomeOn;
    this.classList.toggle('active-detect', metronomeOn);
    this.textContent = metronomeOn ? '🥁 METRO ON' : '🥁 METRO';
    if (!metronomeOn) cancelMetronome();
  });

  document.getElementById('btn-infinite').addEventListener('click', function() {
    infiniteLives = !infiniteLives;
    this.classList.toggle('active-detect', infiniteLives);
    this.textContent = infiniteLives ? '∞ LIVES ON' : '∞ LIVES';
    if (infiniteLives) {
      lives = LIVES_MAX;
      updateHUD();
    }
  });

  /* ═══════════════════════════════════════════
     INIT
  ═══════════════════════════════════════════ */
  resizeCanvas();
  drawIdle();
  updateHUD();
  updateDiagrams();
  overlay.style.display = 'flex';

  // Auto-load random content/ arrangement, then scan DLC sources
  (async () => {
    statusMsg.textContent = 'LOADING...';
    try {
      const res  = await fetch('/api/rock_n_rolla/random');
      const data = await res.json();
      if (data.error === 'no_content') {
        statusMsg.textContent = 'NO BUILT-IN CONTENT — LOAD AN XML';
      } else {
        applySourceData(data);
        overlayBody.textContent = `Arrangement loaded — can you name that tune? Hit START!`;
      }
    } catch(e) {
      statusMsg.textContent = 'FAILED TO LOAD CONTENT';
    }
    refreshDLCSources();
  })();

})();
