#!/usr/bin/env node
// UCI (Universal Chess Interface) front end, so Kodiak can be loaded into chess
// GUIs like Cute Chess or Arena and play other engines.
//
//   node uci.js
import { createInterface } from 'node:readline';
import { Position, Search, mateIn, START_FEN } from './src/engine.js';

const search = new Search(22);
let pos = new Position();
const out = (line) => process.stdout.write(`${line}\n`);

function setPosition(args) {
  const movesAt = args.indexOf('moves');
  const head = movesAt < 0 ? args : args.slice(0, movesAt);
  pos = new Position(head[0] === 'fen' ? head.slice(1).join(' ') : START_FEN);
  if (movesAt < 0) return;
  for (const uci of args.slice(movesAt + 1)) {
    const m = pos.parseUci(uci);
    if (!m) break;
    pos.make(m);
  }
}

// How long to think. With a clock, spend about a thirtieth of the remaining
// time plus most of the increment, and never more than a third of the clock.
function budget(opts) {
  if (opts.movetime) return opts.movetime;
  const time = pos.side === 0 ? opts.wtime : opts.btime;
  const inc = (pos.side === 0 ? opts.winc : opts.binc) || 0;
  if (time === undefined) return opts.infinite || opts.depth ? 24 * 3600 * 1000 : 1000;
  const movesLeft = opts.movestogo || 30;
  return Math.max(10, Math.min(time / movesLeft + inc * 0.8, time / 3) - 20);
}

function go(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'infinite') opts.infinite = true;
    else if (args[i + 1] !== undefined) opts[args[i]] = Number(args[++i]);
  }
  const result = search.search(pos, {
    timeMs: budget(opts),
    maxDepth: opts.depth || 64,
    onInfo: (info) => {
      const mate = mateIn(info.score);
      const score = mate === null ? `cp ${info.score}` : `mate ${mate}`;
      out(`info depth ${info.depth} score ${score} nodes ${info.nodes} nps ${info.nps} time ${Math.round(info.time)} pv ${info.pv.map((m) => pos.uci(m)).join(' ')}`);
    },
  });
  out(`bestmove ${result.move ? pos.uci(result.move) : '0000'}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const [cmd, ...args] = line.trim().split(/\s+/);
  switch (cmd) {
    case 'uci':
      out('id name Kodiak 1.0');
      out('id author Atharv Sharma');
      out('uciok');
      break;
    case 'isready': out('readyok'); break;
    case 'ucinewgame': search.clear(); pos = new Position(); break;
    case 'position': setPosition(args); break;
    case 'go': go(args); break;
    case 'd': out(pos.fen()); break;
    case 'quit': process.exit(0);
  }
});
