import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Position, Search, START_FEN, mateIn } from '../src/engine.js';

// Perft counts every legal move sequence to a fixed depth. The expected
// numbers are the published reference values for these positions, so a
// single bug in castling, en passant, promotion or check handling shows up.
const PERFT = [
  ['start position', START_FEN, [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['rook endgame', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624]],
  ['promotions', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333]],
  ['tricky castling', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['middlegame', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];

for (const [name, fen, counts] of PERFT) {
  test(`perft: ${name}`, () => {
    const pos = new Position(fen);
    counts.forEach((expected, i) => assert.equal(pos.perft(i + 1), expected, `depth ${i + 1}`));
    assert.equal(pos.fen(), new Position(fen).fen(), 'make/unmake restores the position');
  });
}

test('FEN round-trips', () => {
  for (const [, fen] of PERFT) assert.equal(new Position(fen).fen(), fen);
});

test('incremental hash matches a fresh hash after moves', () => {
  const pos = new Position(PERFT[1][1]);
  for (const uci of ['e2a6', 'b4c3', 'e1c1', 'h3g2', 'd5e6']) {
    pos.make(pos.parseUci(uci));
    const fresh = new Position(pos.fen());
    assert.equal(pos.hashLo, fresh.hashLo, uci);
    assert.equal(pos.hashHi, fresh.hashHi, uci);
  }
});

test('SAN covers disambiguation, castling, promotion and mate', () => {
  const pos = new Position('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const san = (uci) => pos.san(pos.parseUci(uci));
  assert.equal(san('e1g1'), 'O-O');
  assert.equal(san('e1c1'), 'O-O-O');
  assert.equal(san('c3b5'), 'Nb5');
  assert.equal(san('d5e6'), 'dxe6');
  assert.equal(san('e5d7'), 'Nxd7');

  const rooks = new Position('4k3/8/8/8/8/8/4K3/R6R w - - 0 1');
  assert.equal(rooks.san(rooks.parseUci('a1d1')), 'Rad1');

  const promo = new Position('8/P7/8/8/8/8/8/k6K w - - 0 1');
  assert.equal(promo.san(promo.parseUci('a7a8q')), 'a8=Q+');

  const mate = new Position('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  assert.equal(mate.san(mate.parseUci('a1a8')), 'Ra8#');
});

test('game status: checkmate, stalemate, repetition, insufficient material', () => {
  assert.equal(new Position('R5k1/5ppp/8/8/8/8/8/6K1 b - - 0 1').status().reason, 'checkmate');
  assert.equal(new Position('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').status().reason, 'stalemate');
  assert.equal(new Position('8/8/4k3/8/8/3NK3/8/8 w - - 0 1').status().reason, 'insufficient material');

  const pos = new Position();
  for (const uci of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) pos.make(pos.parseUci(uci));
  assert.equal(pos.status().reason, 'threefold repetition');
});

test('search finds mate in one', () => {
  const pos = new Position('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
  const result = new Search(16).search(pos, { timeMs: 2000, maxDepth: 4 });
  assert.equal(pos.uci(result.move), 'a1a8');
  assert.equal(mateIn(result.score), 1);
});

test('search finds a forced mate in two', () => {
  // 1. Nf6+ gxf6 2. Bxf7#
  const pos = new Position('r2qkb1r/pp2nppp/3p4/2pNN1B1/2BnP3/3P4/PPP2PPP/R2bK2R w KQkq - 1 1');
  const result = new Search(16).search(pos, { timeMs: 5000, maxDepth: 6 });
  assert.equal(mateIn(result.score), 2);
});

test('search wins hanging material', () => {
  // Black's queen on d4 is undefended and attacked by the knight on f3.
  const pos = new Position('rnb1kbnr/pppp1ppp/8/4p3/3q4/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 3');
  const result = new Search(16).search(pos, { timeMs: 3000, maxDepth: 5 });
  assert.equal(pos.uci(result.move), 'f3d4');
});

test('search leaves the position unchanged', () => {
  const pos = new Position(PERFT[5][1]);
  const before = pos.fen();
  new Search(16).search(pos, { timeMs: 300, maxDepth: 64 });
  assert.equal(pos.fen(), before);
});

test('every opening book move is legal', async () => {
  const { bookMove } = await import('../src/book.js');
  const walk = (moves) => {
    const pos = new Position();
    for (const uci of moves) pos.make(pos.parseUci(uci));
    for (let i = 0; i < 4; i++) {
      const pick = bookMove(moves, () => i / 4);
      if (!pick) return;
      assert.ok(pos.parseUci(pick), `${moves.join(' ')} -> ${pick}`);
      walk([...moves, pick]);
    }
  };
  walk([]);
});
