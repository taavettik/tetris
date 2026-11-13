'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game, COLS, ROWS, framesPerCell, firstLevelUpLines, entryDelay } = require('../src/tetris.js');

const BUTTONS = ['left', 'right', 'up', 'down', 'a', 'b', 'start', 'select'];

// Drives a game with a held-button set, computing "pressed" edges like the
// browser shell does.
function driver(game) {
  let prev = {};
  return function frame(...heldButtons) {
    const held = {};
    for (const b of BUTTONS) held[b] = heldButtons.includes(b);
    const pressed = {};
    for (const b of BUTTONS) pressed[b] = held[b] && !prev[b];
    prev = held;
    game.step({ held, pressed });
  };
}

// Deterministic game whose first piece is the given type.
function gameWith(type, level = 0) {
  const order = ['T', 'J', 'Z', 'O', 'S', 'L', 'I'];
  const r = (order.indexOf(type) + 0.5) / 8;
  return new Game(level, () => r);
}

test('first piece spawns at x=5, y=0', () => {
  const g = gameWith('T');
  assert.equal(g.cur.type, 'T');
  assert.deepEqual([g.cur.x, g.cur.y, g.cur.rot], [5, 0, 0]);
  assert.equal(g.stats.T, 1);
});

test('DAS: immediate shift, then 16 frames, then every 6 frames', () => {
  const g = gameWith('T');
  const frame = driver(g);
  const xs = [];
  for (let i = 0; i < 30; i++) {
    frame('right');
    xs.push(g.cur.x);
  }
  // Frame 1: shift. Frame 17: first auto-shift. Frame 23: next. Then wall.
  assert.equal(xs[0], 6);
  assert.equal(xs[15], 6);
  assert.equal(xs[16], 7);
  assert.equal(xs[21], 7);
  assert.equal(xs[22], 8);
  assert.equal(xs[28], 8); // T spans x-1..x+1, so 8 is the right wall
});

test('DAS: hitting the wall fully charges the counter', () => {
  const g = gameWith('T');
  const frame = driver(g);
  for (let i = 0; i < 40; i++) frame('left');
  assert.equal(g.cur.x, 1);
  assert.equal(g.autorepeatX, 16);
});

test('DAS: a fresh tap resets the counter', () => {
  const g = gameWith('T');
  const frame = driver(g);
  for (let i = 0; i < 10; i++) frame('right');
  assert.equal(g.autorepeatX, 9);
  frame();
  frame('right');
  assert.equal(g.autorepeatX, 0);
});

test('DAS: counter carries over to the next piece', () => {
  const g = gameWith('O');
  const frame = driver(g);
  for (let i = 0; i < 40; i++) frame('right');
  assert.equal(g.autorepeatX, 16);
  // Lock the piece by letting it fall while still holding right.
  while (g.state === 'play') frame('right');
  while (g.state !== 'play') frame('right');
  assert.equal(g.autorepeatX, 16);
  frame('right');
  assert.equal(g.cur.x, 6, 'charged DAS shifts the new piece on its first frame');
});

test('holding down blocks horizontal movement', () => {
  const g = gameWith('T');
  const frame = driver(g);
  frame('down');
  frame('down', 'right');
  assert.equal(g.cur.x, 5);
});

test('first piece hangs for 96 frames before gravity', () => {
  const g = gameWith('T');
  const frame = driver(g);
  for (let i = 0; i < 96; i++) frame();
  assert.equal(g.cur.y, 0);
  frame();
  assert.equal(g.cur.y, 1);
  for (let i = 0; i < 47; i++) frame();
  assert.equal(g.cur.y, 1);
  frame();
  assert.equal(g.cur.y, 2);
});

test('soft drop moves one cell every 2 frames and scores per cell', () => {
  const g = gameWith('T');
  const frame = driver(g);
  frame('down');
  const y0 = g.cur.y;
  for (let i = 0; i < 10; i++) frame('down');
  assert.equal(g.cur.y - y0, 5);
  while (g.state === 'play') frame('down');
  assert.equal(g.score, 18); // T lands with origin at y=18
});

test('soft drop needs a fresh press after each spawn', () => {
  const g = gameWith('O');
  const frame = driver(g);
  frame('down');
  while (g.state === 'play') frame('down');
  while (g.state !== 'play') frame('down');
  for (let i = 0; i < 10; i++) frame('down');
  assert.equal(g.cur.y, 0);
});

test('every piece can rotate on its first frame after spawn', () => {
  for (const type of ['T', 'J', 'Z', 'O', 'S', 'L', 'I']) {
    for (const button of ['a', 'b']) {
      const g = gameWith(type);
      const frame = driver(g);
      frame(button);
      const n = g.cur.type === 'O' ? 1 : type === 'I' || type === 'S' || type === 'Z' ? 2 : 4;
      const expected = n === 1 ? 0 : button === 'a' ? 1 : n - 1;
      assert.equal(g.cur.rot, expected, `${type} rotate ${button}`);
    }
  }
});

test('pieces can extend at most two rows above the field', () => {
  const g = gameWith('I');
  assert.equal(g.collides('I', 1, 5, 0), false); // top block at y = -2
  assert.equal(g.collides('I', 1, 5, -1), true); // top block at y = -3
});

test('rotation has no wall kicks', () => {
  const g = gameWith('I');
  const frame = driver(g);
  g.cur.rot = 1;
  g.cur.x = 0;
  g.cur.y = 5;
  // Horizontal I needs x - 2 .. x + 1; against the left wall it is refused.
  frame('a');
  assert.equal(g.cur.rot, 1);
});

test('rotation fires on the first playable frame after the entry delay', () => {
  const g = gameWith('T');
  const frame = driver(g);
  frame('down');
  while (g.state === 'play') frame('down');
  while (g.state !== 'play') frame();
  frame('a');
  assert.equal(g.cur.rot, 1);
});

test('rotation cycles clockwise with A, counter-clockwise with B', () => {
  const g = gameWith('T');
  const frame = driver(g);
  g.cur.y = 5;
  frame('a');
  assert.equal(g.cur.rot, 1);
  frame();
  frame('b');
  assert.equal(g.cur.rot, 0);
  frame();
  frame('b');
  assert.equal(g.cur.rot, 3);
});

test('gravity table', () => {
  assert.equal(framesPerCell(0), 48);
  assert.equal(framesPerCell(9), 6);
  assert.equal(framesPerCell(18), 3);
  assert.equal(framesPerCell(19), 2);
  assert.equal(framesPerCell(29), 1);
});

test('level-up thresholds', () => {
  assert.equal(firstLevelUpLines(0), 10);
  assert.equal(firstLevelUpLines(9), 100);
  assert.equal(firstLevelUpLines(15), 100);
  assert.equal(firstLevelUpLines(18), 130);
  assert.equal(firstLevelUpLines(19), 140);
});

test('entry delay depends on lock height', () => {
  assert.equal(entryDelay(19), 10);
  assert.equal(entryDelay(18), 10);
  assert.equal(entryDelay(17), 12);
  assert.equal(entryDelay(0), 18);
});

test('tetris scores 1200 x (level + 1) and runs the clear animation', () => {
  const g = gameWith('I', 5);
  const frame = driver(g);
  for (let y = ROWS - 4; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) if (x !== 9) g.board[y][x] = 'O';
  }
  g.cur.rot = 1;
  g.cur.x = 9;
  g.cur.y = 2;
  frame('down');
  while (g.state === 'play') frame('down');
  assert.equal(g.state, 'clear');
  assert.equal(g.clearRows.length, 4);
  const pre = g.score;
  while (g.state === 'clear') frame();
  assert.equal(g.lines, 4);
  assert.equal(g.score - pre, 1200 * 6);
  assert.ok(g.board.every((row) => row.every((c) => c === null)));
});

test('top out when the spawn position is blocked', () => {
  const g = gameWith('T');
  const frame = driver(g);
  for (let x = 0; x < COLS; x++) g.board[1][x] = x === 0 ? null : 'O';
  g.board[1][5] = 'O';
  frame('down');
  while (g.state === 'play') frame('down');
  while (g.state === 'are') frame();
  assert.equal(g.state, 'topout');
});
