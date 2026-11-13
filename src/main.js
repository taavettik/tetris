// Browser shell: input, audio, rendering and the fixed-rate frame loop.
(function () {
  'use strict';

  const { Game, COLS, ROWS, PIECES, SHAPES, STYLE, PALETTES, DAS_DELAY, DAS_REPEAT } = window.Tetris;

  const W = 256;
  const H = 224;
  const FRAME_MS = 1000 / 60.0988; // NTSC NES frame rate

  const COLOR = {
    white: '#FCFCFC',
    black: '#000000',
    red: '#F83800',
    orange: '#FC9838',
    green: '#58D854',
    bg: '#2E2E34',
    bgLine: '#232328',
    frameLight: '#A4B4CC',
    frameDark: '#3C4C6C',
    curtain: '#7C7C7C',
    dim: '#7C7C7C',
  };

  // ---------------------------------------------------------------- storage

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('nes-tetris:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('nes-tetris:' + key, JSON.stringify(value));
      } catch {
        // Storage unavailable (private mode etc.) - settings just won't persist.
      }
    },
  };

  let topScore = store.get('top', 10000);
  let showDas = store.get('das', true);
  let muted = store.get('muted', false);

  // ------------------------------------------------------------------ audio

  const Sound = {
    ctx: null,
    unlock() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) this.ctx = new AC();
      }
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },
    tone(freq, dur, when = 0, type = 'square', vol = 0.04, endFreq = 0) {
      if (muted || !this.ctx) return;
      const t = this.ctx.currentTime + when;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
      gain.gain.setValueAtTime(vol, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    },
    seq(freqs, step, dur, vol) {
      freqs.forEach((f, i) => this.tone(f, dur, i * step, 'square', vol));
    },
    play(ev) {
      switch (ev) {
        case 'move': this.tone(1200, 0.025, 0, 'square', 0.025); break;
        case 'rotate': this.tone(1500, 0.04, 0, 'square', 0.025, 1000); break;
        case 'lock': this.tone(180, 0.08, 0, 'triangle', 0.15, 70); break;
        case 'clear': this.seq([523, 659, 784], 0.05, 0.08, 0.04); break;
        case 'tetris': this.seq([523, 659, 784, 1047, 1319, 1568], 0.045, 0.1, 0.05); break;
        case 'levelup': this.seq([784, 988, 1175, 1568], 0.07, 0.12, 0.04); break;
        case 'gameover': this.seq([392, 330, 262, 196, 147], 0.16, 0.2, 0.05); break;
        case 'menu': this.tone(900, 0.03, 0, 'square', 0.03); break;
        case 'start': this.seq([659, 988], 0.06, 0.1, 0.04); break;
        case 'pause': this.tone(440, 0.08, 0, 'square', 0.04); break;
      }
    },
  };

  // ------------------------------------------------------------------ input

  const KEYMAP = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
    KeyX: 'a', // rotate clockwise
    KeyK: 'a',
    KeyZ: 'b', // rotate counter-clockwise
    KeyJ: 'b',
    Enter: 'start',
    ShiftLeft: 'select',
    ShiftRight: 'select',
  };
  const BUTTONS = ['left', 'right', 'up', 'down', 'a', 'b', 'start', 'select'];

  const keysDown = new Set();
  // Keys pressed since the last frame: guarantees taps shorter than a frame
  // still register as a press.
  const keysLatched = new Set();
  let prevHeld = {};

  addEventListener('keydown', (e) => {
    Sound.unlock();
    if (KEYMAP[e.code]) {
      e.preventDefault();
      if (!e.repeat) {
        keysDown.add(e.code);
        keysLatched.add(e.code);
      }
      return;
    }
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyD') {
      showDas = !showDas;
      store.set('das', showDas);
    } else if (e.code === 'KeyM') {
      muted = !muted;
      store.set('muted', muted);
      Sound.play('menu');
    }
  });

  addEventListener('keyup', (e) => {
    if (KEYMAP[e.code]) {
      e.preventDefault();
      keysDown.delete(e.code);
    }
  });

  function releaseAll() {
    keysDown.clear();
    keysLatched.clear();
    autoPause();
  }
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  function readGamepads(held) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      const btn = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
      const ax = pad.axes[0] || 0;
      const ay = pad.axes[1] || 0;
      if (btn(14) || ax < -0.5) held.left = true;
      if (btn(15) || ax > 0.5) held.right = true;
      if (btn(12) || ay < -0.5) held.up = true;
      if (btn(13) || ay > 0.5) held.down = true;
      // NES layout: A is the right face button, B the bottom/left one.
      if (btn(1) || btn(3)) held.a = true;
      if (btn(0) || btn(2)) held.b = true;
      if (btn(9)) held.start = true;
      if (btn(8)) held.select = true;
    }
  }

  function sampleInput() {
    const held = {};
    for (const b of BUTTONS) held[b] = false;
    for (const code of keysDown) held[KEYMAP[code]] = true;
    for (const code of keysLatched) held[KEYMAP[code]] = true;
    keysLatched.clear();
    readGamepads(held);

    const pressed = {};
    for (const b of BUTTONS) pressed[b] = held[b] && !prevHeld[b];
    prevHeld = held;
    return { held, pressed };
  }

  // ------------------------------------------------------------ game scenes

  let scene = 'menu';
  let menuLevel = store.get('level', 0);
  let game = null;
  let paused = false;
  let showNext = true;
  let frameCount = 0;

  function autoPause() {
    if (scene === 'game' && game && ['play', 'clear', 'are'].includes(game.state)) paused = true;
  }

  function tick() {
    frameCount++;
    const input = sampleInput();
    if (scene === 'menu') tickMenu(input);
    else tickGame(input);
  }

  function tickMenu({ held, pressed }) {
    const before = menuLevel;
    if (pressed.left && menuLevel % 5 > 0) menuLevel--;
    if (pressed.right && menuLevel % 5 < 4) menuLevel++;
    if (pressed.up && menuLevel >= 5) menuLevel -= 5;
    if (pressed.down && menuLevel < 5) menuLevel += 5;
    if (menuLevel !== before) Sound.play('menu');

    if (pressed.start) {
      store.set('level', menuLevel);
      // As on the NES, holding A while pressing Start adds 10 levels.
      game = new Game(menuLevel + (held.a ? 10 : 0));
      scene = 'game';
      paused = false;
      showNext = true;
      Sound.play('start');
    }
  }

  function tickGame(input) {
    const { pressed } = input;
    if (game.state === 'over') {
      if (pressed.start) scene = 'menu';
      return;
    }
    if (pressed.start && game.state !== 'topout') {
      paused = !paused;
      Sound.play('pause');
    }
    if (paused) return;
    if (pressed.select) showNext = !showNext;

    game.step(input);
    for (const ev of game.events) Sound.play(ev);
    game.events.length = 0;

    if (game.score > topScore && (game.state === 'topout' || game.state === 'over')) {
      topScore = game.score;
      store.set('top', topScore);
    }
  }

  // -------------------------------------------------------------- rendering

  const canvas = document.getElementById('screen');
  const ctx = canvas.getContext('2d');
  let S = 1; // device pixels per NES pixel
  const spriteCache = new Map();

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    S = Math.max(1, Math.floor(Math.min((innerWidth * dpr) / W, (innerHeight * dpr) / H)));
    canvas.width = W * S;
    canvas.height = H * S;
    canvas.style.width = (W * S) / dpr + 'px';
    canvas.style.height = (H * S) / dpr + 'px';
    ctx.imageSmoothingEnabled = false;
    spriteCache.clear();
  }
  addEventListener('resize', resize);
  resize();

  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x * S, y * S, w * S, h * S);
  }

  function text(str, x, y, color = COLOR.white, size = 8) {
    ctx.fillStyle = color;
    ctx.font = `${size * S}px "Press Start 2P", monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(str, x * S, y * S);
  }

  const pad = (n, width) => String(n).padStart(width, '0');

  // A framed panel; (x, y, w, h) is the black interior.
  function panel(x, y, w, h) {
    rect(x - 3, y - 3, w + 6, h + 6, COLOR.frameDark);
    rect(x - 2, y - 2, w + 4, h + 4, COLOR.frameLight);
    rect(x - 1, y - 1, w + 2, h + 2, COLOR.frameDark);
    rect(x, y, w, h, COLOR.black);
  }

  function background(flash) {
    rect(0, 0, W, H, flash ? '#B8B8B8' : COLOR.bg);
    if (flash) return;
    for (let y = 7; y < H; y += 8) rect(0, y, W, 1, COLOR.bgLine);
    for (let x = 7; x < W; x += 8) rect(x, 0, 1, H, COLOR.bgLine);
  }

  // Pre-rendered block tiles. Full tiles are 8px (7px block + 1px gap), mini
  // tiles for the statistics panel are 6px.
  function sprite(style, color, size) {
    const key = `${style}|${color}|${size}`;
    let c = spriteCache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = size * S;
    const g = c.getContext('2d');
    const px = (x, y, w, h, col) => {
      g.fillStyle = col;
      g.fillRect(x * S, y * S, w * S, h * S);
    };
    const b = size - 1;
    px(0, 0, b, b, color);
    if (style === 0) {
      px(1, 1, b - 2, b - 2, COLOR.white);
      px(0, 0, 1, 1, COLOR.white);
    } else if (style === 'curtain') {
      px(0, 0, b, 1, '#BCBCBC');
      px(0, 3, b, 1, '#3C3C3C');
    } else {
      px(0, 0, 1, 1, COLOR.white);
      px(1, 1, size === 8 ? 2 : 1, 1, COLOR.white);
      if (size === 8) px(1, 2, 1, 1, COLOR.white);
    }
    spriteCache.set(key, c);
    return c;
  }

  function block(type, level, x, y, size = 8) {
    const pal = PALETTES[level % PALETTES.length];
    const style = STYLE[type];
    const color = style === 2 ? pal[1] : pal[0];
    ctx.drawImage(sprite(style, color, size), x * S, y * S);
  }

  // Draw a piece in spawn orientation centred on (cx, cy).
  function pieceCentered(type, level, cx, cy, size) {
    const shape = SHAPES[type][0];
    const xs = shape.map((c) => c[0]);
    const ys = shape.map((c) => c[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const w = (Math.max(...xs) - minX + 1) * size;
    const h = (Math.max(...ys) - minY + 1) * size;
    const ox = Math.round(cx - w / 2);
    const oy = Math.round(cy - h / 2);
    for (const [dx, dy] of shape) block(type, level, ox + (dx - minX) * size, oy + (dy - minY) * size, size);
  }

  const FIELD_X = 96;
  const FIELD_Y = 40;

  function drawGame() {
    const g = game;
    const flash = g.state === 'clear' && g.clearRows.length === 4 && Math.floor(g.timer / 4) % 2 === 0;
    background(flash);

    panel(20, 16, 56, 16);
    text('A-TYPE', 24, 20);

    panel(FIELD_X, 16, COLS * 8, 16);
    text(`LINES-${pad(g.lines, 3)}`, 100, 20);

    // Statistics
    panel(8, 48, 80, 152);
    text('STATISTICS', 8, 54, COLOR.white);
    PIECES.forEach((type, i) => {
      const y = 70 + i * 18;
      pieceCentered(type, g.level, 32, y + 6, 6);
      text(pad(g.stats[type], 3), 56, y + 2, COLOR.red);
    });

    // Score
    panel(192, 24, 56, 56);
    text('TOP', 196, 28);
    text(pad(Math.max(topScore, 0), 6), 196, 38);
    text('SCORE', 196, 54);
    text(pad(g.score, 6), 196, 64);

    // Next
    panel(192, 96, 48, 48);
    text('NEXT', 200, 100);
    if (showNext && g.next) pieceCentered(g.next, g.level, 216, 128, 8);

    // Level
    panel(192, 160, 48, 32);
    text('LEVEL', 196, 164);
    text(pad(g.level, 2), 208, 178);

    // Playfield
    panel(FIELD_X, FIELD_Y, COLS * 8, ROWS * 8);
    if (paused) {
      text('PAUSE', FIELD_X + 20, FIELD_Y + 72);
    } else {
      drawField(g);
    }

    if (showDas) drawDasMeter(g);
  }

  function drawField(g) {
    const hidden = (x, y) =>
      g.state === 'clear' && g.clearRows.includes(y) &&
      g.clearStep > 0 && x >= 5 - g.clearStep && x <= 4 + g.clearStep;

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const t = g.board[y][x];
        if (t && !hidden(x, y)) block(t, g.level, FIELD_X + x * 8, FIELD_Y + y * 8);
      }
    }

    if (g.cur && (g.state === 'play' || g.state === 'topout')) {
      for (const [x, y] of g.cells()) {
        if (y >= 0 && y < ROWS) block(g.cur.type, g.level, FIELD_X + x * 8, FIELD_Y + y * 8);
      }
    }

    if (g.state === 'topout' || g.state === 'over') {
      const tile = sprite('curtain', COLOR.curtain, 8);
      for (let y = 0; y < g.curtain; y++) {
        for (let x = 0; x < COLS; x++) ctx.drawImage(tile, (FIELD_X + x * 8) * S, (FIELD_Y + y * 8) * S);
      }
    }

    if (g.state === 'over') {
      rect(FIELD_X + 4, FIELD_Y + 56, 72, 56, COLOR.black);
      text('GAME', FIELD_X + 24, FIELD_Y + 64);
      text('OVER', FIELD_X + 24, FIELD_Y + 76);
      if ((frameCount >> 5) % 2 === 0) text('ENTER', FIELD_X + 20, FIELD_Y + 96, COLOR.orange);
    }
  }

  // DAS counter: 16 segments. Green once the counter is at or above the
  // repeat value, meaning a held direction will auto-shift within 6 frames.
  function drawDasMeter(g) {
    const y = 209;
    text('DAS', 66, y - 1, COLOR.dim);
    rect(FIELD_X - 1, y - 1, COLS * 8 + 2, 8, COLOR.black);
    const charged = g.autorepeatX >= DAS_REPEAT;
    for (let i = 0; i < DAS_DELAY; i++) {
      const on = i < g.autorepeatX;
      const color = on ? (charged ? COLOR.green : COLOR.red) : '#202020';
      rect(FIELD_X + i * 5, y, 4, 6, color);
    }
    text(pad(g.autorepeatX, 2), 184, y - 1, charged ? COLOR.green : COLOR.dim);
  }

  function drawMenu() {
    background(false);

    const title = 'TETRIS';
    const colors = ['#F83800', '#FC9838', '#F8D878', '#58D854', '#3CBCFC', '#D800CC'];
    [...title].forEach((ch, i) => text(ch, 56 + i * 24, 24, colors[i], 24));

    panel(56, 72, 144, 56);
    text('LEVEL', 108, 76);
    for (let lvl = 0; lvl < 10; lvl++) {
      const col = lvl % 5;
      const row = Math.floor(lvl / 5);
      const x = 68 + col * 24 + 8;
      const y = 94 + row * 18;
      if (lvl === menuLevel && (frameCount >> 3) % 2 === 0) rect(x - 4, y - 4, 16, 16, COLOR.orange);
      text(String(lvl), x, y);
    }

    text(`TOP ${pad(topScore, 6)}`, 88, 140);

    panel(16, 158, 224, 58);
    const help = [
      'ARROWS  MOVE / SOFT DROP',
      'X ROTATE RIGHT  Z LEFT',
      'ENTER   START / PAUSE',
      'SHIFT   NEXT PIECE',
      `D DAS METER ${showDas ? 'ON ' : 'OFF'} M ${muted ? 'MUTE' : 'SND '}`,
      'HOLD X + ENTER: LEVEL+10',
    ];
    help.forEach((line, i) => text(line, 20, 162 + i * 9, i === 5 ? COLOR.orange : COLOR.white));
  }

  function render() {
    if (scene === 'menu') drawMenu();
    else drawGame();
  }

  // ------------------------------------------------------------- main loop

  let acc = 0;
  let last = performance.now();

  function loop(now) {
    acc += Math.min(now - last, 250);
    last = now;
    let steps = 0;
    while (acc >= FRAME_MS && steps < 10) {
      tick();
      acc -= FRAME_MS;
      steps++;
    }
    render();
    requestAnimationFrame(loop);
  }

  if (document.fonts && document.fonts.load) document.fonts.load('8px "Press Start 2P"');
  requestAnimationFrame(loop);
})();
