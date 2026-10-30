# Kodiak

A chess engine I wrote from scratch in JavaScript. You can play it in the browser here: **https://burthebear.github.io/kodiak/**

![CI](https://github.com/BurTheBear/kodiak/actions/workflows/ci.yml/badge.svg)

<img src="assets/screenshot.png" alt="Kodiak in the middle of a game" width="760">

It knows all the rules, including castling, en passant, promotion, threefold repetition and the fifty-move rule. On my laptop it searches about 2 million positions a second and gets 10 to 14 moves deep in two seconds. There are no dependencies and no build step. The engine is one file, `src/engine.js`, about 900 lines.

## How it works

The board is a 0x88 array: 128 slots where only 64 are real squares. A square is off the board exactly when `square & 0x88` is non-zero, so checking for edges while generating moves is a single bit test.

The search is negamax alpha-beta with iterative deepening. It searches depth 1, then 2, then 3, until time runs out. Each pass stores the best move for every position in a transposition table, so the next pass tries the strongest moves first and alpha-beta can cut most of the tree. On top of that:

- Null-move pruning: if skipping my turn still leaves me winning, the position is good enough and the search moves on.
- Late-move reductions: quiet moves that the ordering ranked low get searched shallower, and only re-searched if they turn out to be good.
- Quiescence search: at the end of the search, captures keep being played out. Without this the engine stops in the middle of a trade and badly misjudges the position.

Move ordering goes: hash move first, then captures (most valuable victim, least valuable attacker), then "killer" moves that caused cutoffs at the same depth, then a history score.

The evaluation counts material and uses piece-square tables. These are blended from middlegame to endgame values as pieces come off, because the king should hide early and walk to the center late. It also knows about doubled, isolated and passed pawns, rooks on open files, and the bishop pair.

In the browser the engine runs in a Web Worker, so the board doesn't freeze while it thinks. The first few moves come from a small opening book (`src/book.js`) so games don't all look the same.

## Testing

```bash
npm test
```

The main test is **perft**: count every legal move sequence to a fixed depth and compare against known answers. If castling rights, en passant or pins are even slightly wrong, the numbers stop matching. These run in CI on every push:

| Position | Depth | Nodes |
|---|---:|---:|
| Start position | 4 | 197,281 |
| Kiwipete | 3 | 97,862 |
| Rook endgame | 5 | 674,624 |
| Promotions | 4 | 422,333 |
| Castling edge cases | 3 | 62,379 |
| Middlegame | 3 | 89,890 |

There are also tests for FEN parsing, hashing, move notation, draws and checkmate, the opening book, and a few search puzzles (mate in one, mate in two, winning a hanging queen).

`npm run bench` prints speed numbers. On an Apple Silicon MacBook with Node 26, move generation runs at about 10 million positions a second.

## Playing other engines

`uci.js` speaks UCI, the protocol chess GUIs use, so Kodiak can be loaded into Cute Chess, Arena or similar:

```bash
node uci.js
```

`tools/match.js` plays Kodiak against another UCI engine over 10 openings, each played with both colors. Against Stockfish 19 with its strength limited (`UCI_LimitStrength`):

| Stockfish setting | Time per move | Games | Kodiak wins / draws / losses | Score |
|---|---|---:|---|---:|
| 1500 | 0.1 s | 20 | 18 / 0 / 2 | 90% |
| 1800 | 0.2 s | 40 | 35 / 0 / 5 | 88% |
| 2100 | 0.2 s | 40 | 24 / 3 / 13 | 64% |
| 2100 | 1 s | 20 | 16 / 1 / 3 | 83% |
| 2400 | 0.2 s | 40 | 16 / 4 / 20 | 45% |

Stockfish's Elo setting is calibrated for much longer games than this, so these aren't real ratings. They're a check that the search and evaluation actually play decent chess.

```bash
node tools/match.js --opponent stockfish --elo 1800 --movetime 200 --rounds 2
```

## Running it

It's a static site, so any file server works:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Things I'd like to add

Automatic tuning of the evaluation weights from self-play, a proper time manager for the UCI mode, and a bigger opening book.

MIT license.
