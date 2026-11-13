// Core NES Tetris game logic. Frame-driven: call step(input) once per NES frame
// (60.0988 Hz). No rendering or DOM access here so it can be tested in Node.
(function (root) {
  'use strict';

  const COLS = 10;
  const ROWS = 20;

  // NES piece order (also the order of the statistics panel).
  const PIECES = ['T', 'J', 'Z', 'O', 'S', 'L', 'I'];

  // Nintendo Rotation System: offsets [dx, dy] from the piece origin, y down.
  // Orientations are listed in clockwise order; index 0 is the spawn orientation.
  // No wall kicks. I, S and Z only have two states, as on the NES.
  const SHAPES = {
    T: [
      [[-1, 0], [0, 0], [1, 0], [0, 1]],
      [[0, -1], [-1, 0], [0, 0], [0, 1]],
      [[-1, 0], [0, 0], [1, 0], [0, -1]],
      [[0, -1], [0, 0], [1, 0], [0, 1]],
    ],
    J: [
      [[-1, 0], [0, 0], [1, 0], [1, 1]],
      [[0, -1], [0, 0], [-1, 1], [0, 1]],
      [[-1, -1], [-1, 0], [0, 0], [1, 0]],
      [[0, -1], [1, -1], [0, 0], [0, 1]],
    ],
    Z: [
      [[-1, 0], [0, 0], [0, 1], [1, 1]],
      [[1, -1], [0, 0], [1, 0], [0, 1]],
    ],
    O: [
      [[-1, 0], [0, 0], [-1, 1], [0, 1]],
    ],
    S: [
      [[0, 0], [1, 0], [-1, 1], [0, 1]],
      [[0, -1], [0, 0], [1, 0], [1, 1]],
    ],
    L: [
      [[-1, 0], [0, 0], [1, 0], [-1, 1]],
      [[-1, -1], [0, -1], [0, 0], [0, 1]],
      [[1, -1], [-1, 0], [0, 0], [1, 0]],
      [[0, -1], [0, 0], [0, 1], [1, 1]],
    ],
    I: [
      [[-2, 0], [-1, 0], [0, 0], [1, 0]],
      [[0, -2], [0, -1], [0, 0], [0, 1]],
    ],
  };

  // Block tile style: 0 = white centre with coloured border, 1 = solid colour 1,
  // 2 = solid colour 2.
  const STYLE = { T: 0, O: 0, I: 0, Z: 1, L: 1, J: 2, S: 2 };

  // Per-level [colour 1, colour 2]; repeats every 10 levels.
  const PALETTES = [
    ['#0058F8', '#3CBCFC'],
    ['#00A800', '#B8F818'],
    ['#D800CC', '#F878F8'],
    ['#0058F8', '#58D854'],
    ['#E40058', '#58F898'],
    ['#58F898', '#6888FC'],
    ['#F83800', '#7C7C7C'],
    ['#6844FC', '#A80020'],
    ['#0058F8', '#F83800'],
    ['#F83800', '#FCA044'],
  ];

  // Frames per gravity drop, levels 0-28. Level 29+ is 1 frame per cell.
  const GRAVITY = [
    48, 43, 38, 33, 28, 23, 18, 13, 8, 6,
    5, 5, 5, 4, 4, 4, 3, 3, 3,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  ];

  const LINE_SCORES = [0, 40, 100, 300, 1200];
  const MAX_SCORE = 999999;

  // Delayed Auto Shift: first auto-shift after 16 frames, then every 6 frames.
  const DAS_DELAY = 16;
  const DAS_REPEAT = 10;

  // The first piece of a game hangs for 96 frames unless down is pressed.
  const FIRST_PIECE_DELAY = -96;

  const SPAWN_X = 5;
  const SPAWN_Y = 0;

  // Pieces may extend this many rows above the visible field (NES checks
  // y + 2 < 22), which is what lets freshly spawned pieces rotate.
  const HIDDEN_ROWS = 2;

  function framesPerCell(level) {
    return level < GRAVITY.length ? GRAVITY[level] : 1;
  }

  function firstLevelUpLines(startLevel) {
    return Math.min(startLevel * 10 + 10, Math.max(100, startLevel * 10 - 50));
  }

  // Entry delay (ARE): 10 frames when locking in the bottom two rows, plus 2
  // frames for every 4 rows higher, up to 18.
  function entryDelay(lockY) {
    const height = ROWS - 1 - lockY;
    return 10 + 2 * Math.max(0, Math.min(4, Math.floor((height + 2) / 4)));
  }

  class Game {
    constructor(startLevel = 0, rng = Math.random) {
      this.rng = rng;
      this.startLevel = startLevel;
      this.level = startLevel;
      this.lines = 0;
      this.score = 0;
      this.nextLevelAt = firstLevelUpLines(startLevel);
      this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
      this.stats = Object.fromEntries(PIECES.map((p) => [p, 0]));

      this.autorepeatX = 0; // DAS counter
      this.autorepeatY = 0; // soft drop counter
      this.fallTimer = 0;
      this.holdDownPoints = 0;

      this.state = 'play'; // play | clear | are | topout | over
      this.timer = 0;
      this.clearRows = [];
      this.clearStep = 0;
      this.curtain = 0;
      this.lockY = 0;
      this.events = [];

      this.lastRoll = null;
      this.cur = null;
      this.next = this.roll();
      this.spawn();
      this.autorepeatY = FIRST_PIECE_DELAY;
    }

    // NES randomizer: roll 0-7; on 7 or a repeat of the last piece, reroll
    // once from 0-6 and accept whatever comes up.
    roll() {
      let i = Math.floor(this.rng() * 8);
      if (i === 7 || PIECES[i] === this.lastRoll) i = Math.floor(this.rng() * 7);
      this.lastRoll = PIECES[i];
      return PIECES[i];
    }

    collides(type, rot, x, y) {
      for (const [dx, dy] of SHAPES[type][rot]) {
        const cx = x + dx;
        const cy = y + dy;
        if (cx < 0 || cx >= COLS || cy < -HIDDEN_ROWS || cy >= ROWS) return true;
        if (cy >= 0 && this.board[cy][cx]) return true;
      }
      return false;
    }

    cells(piece = this.cur) {
      return SHAPES[piece.type][piece.rot].map(([dx, dy]) => [piece.x + dx, piece.y + dy]);
    }

    step(input) {
      switch (this.state) {
        case 'play':
          this.fallTimer++;
          this.shift(input);
          this.rotate(input);
          this.drop(input);
          break;
        case 'clear':
          this.timer++;
          if (this.timer % 4 === 0 && ++this.clearStep >= 5) this.finishClear();
          break;
        case 'are':
          if (--this.timer <= 0) this.spawn();
          break;
        case 'topout':
          this.timer++;
          if (this.timer % 4 === 0 && ++this.curtain >= ROWS) this.state = 'over';
          break;
      }
    }

    shift({ held, pressed }) {
      // Horizontal movement is ignored entirely while down is held.
      if (held.down) return;
      if (pressed.left || pressed.right) {
        this.autorepeatX = 0;
      } else if (held.left || held.right) {
        if (++this.autorepeatX < DAS_DELAY) return;
        this.autorepeatX = DAS_REPEAT;
      } else {
        return;
      }
      const dir = held.right ? 1 : -1;
      const p = this.cur;
      if (this.collides(p.type, p.rot, p.x + dir, p.y)) {
        // Blocked: DAS becomes fully charged ("wall charge").
        this.autorepeatX = DAS_DELAY;
      } else {
        p.x += dir;
        this.events.push('move');
      }
    }

    rotate({ pressed }) {
      let dir;
      if (pressed.a) dir = 1;
      else if (pressed.b) dir = -1;
      else return;
      const p = this.cur;
      const n = SHAPES[p.type].length;
      const rot = (p.rot + dir + n) % n;
      if (!this.collides(p.type, rot, p.x, p.y)) {
        p.rot = rot;
        this.events.push('rotate');
      }
    }

    drop({ held, pressed }) {
      const heldDownOnly = held.down && !held.left && !held.right && !held.up;
      const pressedDownOnly = pressed.down && !pressed.left && !pressed.right && !pressed.up;

      if (this.autorepeatY < 0) {
        if (!pressed.down) {
          this.autorepeatY++;
          return;
        }
        this.autorepeatY = 0;
      }

      if (this.autorepeatY > 0) {
        if (!heldDownOnly) {
          this.autorepeatY = 0;
          this.holdDownPoints = 0;
        } else if (++this.autorepeatY >= 3) {
          // Soft drop: one cell every 2 frames.
          this.autorepeatY = 1;
          this.holdDownPoints++;
          this.moveDown();
          return;
        }
      } else if (!held.left && !held.right && pressedDownOnly) {
        // Soft drop only starts on a fresh press; holding down through a
        // spawn does not carry over to the next piece.
        this.autorepeatY = 1;
      }

      if (this.fallTimer >= framesPerCell(this.level)) this.moveDown();
    }

    moveDown() {
      this.fallTimer = 0;
      const p = this.cur;
      if (this.collides(p.type, p.rot, p.x, p.y + 1)) this.lock();
      else p.y++;
    }

    lock() {
      const p = this.cur;
      // Blocks locked above the visible field are lost, as on the NES.
      for (const [x, y] of this.cells(p)) if (y >= 0) this.board[y][x] = p.type;
      // The locking soft-drop frame also counted, so the NES credits one less.
      this.score = Math.min(MAX_SCORE, this.score + Math.max(0, this.holdDownPoints - 1));
      this.holdDownPoints = 0;
      this.lockY = p.y;
      this.cur = null;
      this.events.push('lock');

      const full = [];
      this.board.forEach((row, y) => {
        if (row.every(Boolean)) full.push(y);
      });

      if (full.length) {
        this.state = 'clear';
        this.clearRows = full;
        this.clearStep = 0;
        this.timer = 0;
        this.events.push(full.length === 4 ? 'tetris' : 'clear');
      } else {
        this.state = 'are';
        this.timer = entryDelay(this.lockY);
      }
    }

    finishClear() {
      const n = this.clearRows.length;
      this.board = this.board.filter((_, y) => !this.clearRows.includes(y));
      for (let i = 0; i < n; i++) this.board.unshift(Array(COLS).fill(null));
      this.clearRows = [];

      this.lines += n;
      this.score = Math.min(MAX_SCORE, this.score + LINE_SCORES[n] * (this.level + 1));
      if (this.lines >= this.nextLevelAt) {
        this.level++;
        this.nextLevelAt += 10;
        this.events.push('levelup');
      }

      this.state = 'are';
      this.timer = entryDelay(this.lockY);
    }

    spawn() {
      // DAS (autorepeatX) intentionally carries over between pieces.
      this.cur = { type: this.next, rot: 0, x: SPAWN_X, y: SPAWN_Y };
      this.next = this.roll();
      this.stats[this.cur.type]++;
      this.fallTimer = 0;
      this.autorepeatY = 0;
      this.holdDownPoints = 0;
      this.state = 'play';

      if (this.collides(this.cur.type, this.cur.rot, this.cur.x, this.cur.y)) {
        this.state = 'topout';
        this.timer = 0;
        this.curtain = 0;
        this.events.push('gameover');
      }
    }
  }

  const api = {
    Game, COLS, ROWS, PIECES, SHAPES, STYLE, PALETTES,
    DAS_DELAY, DAS_REPEAT, framesPerCell, firstLevelUpLines, entryDelay,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tetris = api;
})(typeof window !== 'undefined' ? window : globalThis);
