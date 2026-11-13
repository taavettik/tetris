# NES Tetris

Classic NES-style Tetris in the browser. No build step or dependencies.

```bash
npm start   # serves on http://localhost:8000
npm test    # frame-accurate mechanics tests (Node 18+)
```

## Controls

| Key | NES | Action |
| --- | --- | --- |
| ← → | D-pad | Move (with DAS) |
| ↓ | D-pad | Soft drop |
| X / K | A | Rotate clockwise |
| Z / J | B | Rotate counter-clockwise |
| Enter | Start | Start / pause |
| Shift | Select | Toggle next-piece preview |
| D | | Toggle DAS meter |
| M | | Mute |

Hold **X** while pressing Enter on the level screen to start at level +10.
Gamepads are also supported.

## Mechanics

- Runs at 60.0988 fps, fixed step; all timings are in NES frames.
- **DAS**: a press shifts at once, auto-shift starts after 16 frames, then
  repeats every 6. Hitting a wall fully charges the counter, and the charge
  carries over to the next piece. While down is held, left/right is ignored.
- Nintendo Rotation System, no wall kicks, no hard drop, no hold, no lock delay.
- NES gravity table (48 frames/cell at level 0, 1 frame/cell from level 29).
- Soft drop moves 1 cell every 2 frames, needs a fresh press for each piece,
  and scores 1 point per cell.
- Entry delay of 10–18 frames depending on lock height, plus the line clear
  animation (5 steps, 4 frames each).
- NES randomizer (a roll of 0–7, rerolled once on a repeat).
- Scoring 40 / 100 / 300 / 1200 × (level + 1). Level-up thresholds follow the NES
  start-level rules.
