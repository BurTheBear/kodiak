// Measures move-generation speed (perft) and search speed on fixed positions.
// Usage: node bench.js
import { Position, Search, START_FEN } from './src/engine.js';

const now = () => performance.now();
const fmt = (n) => n.toLocaleString('en-US');

const perftCases = [
  ['start position, depth 5', START_FEN, 5],
  ['kiwipete, depth 4', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 4],
];
console.log('Move generation (perft)');
for (const [name, fen, depth] of perftCases) {
  const pos = new Position(fen);
  const t = now();
  const nodes = pos.perft(depth);
  const ms = now() - t;
  console.log(`  ${name.padEnd(26)} ${fmt(nodes).padStart(11)} nodes  ${(ms / 1000).toFixed(2)}s  ${fmt(Math.round(nodes / ms * 1000))} nodes/s`);
}

const searchCases = [
  ['opening', START_FEN],
  ['middlegame', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10'],
  ['endgame', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'],
];
console.log('\nSearch (2 seconds per position)');
for (const [name, fen] of searchCases) {
  const pos = new Position(fen);
  const r = new Search(20).search(pos, { timeMs: 2000 });
  console.log(`  ${name.padEnd(12)} depth ${String(r.depth).padStart(2)}  ${fmt(r.nodes).padStart(10)} nodes  ${fmt(Math.round(r.nodes / r.time * 1000))} nodes/s  best ${pos.san(r.move)}`);
}
