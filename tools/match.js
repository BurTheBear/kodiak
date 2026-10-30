#!/usr/bin/env node
// Plays Kodiak against another UCI engine and estimates the rating difference.
// Each opening is played twice with colors swapped, so neither side gets the
// better half of the openings.
//
//   node tools/match.js --opponent stockfish --elo 1500 --movetime 200 --rounds 2
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Position, WHITE } from '../src/engine.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((a) => {
  const [k, ...v] = a.trim().split(/\s+/);
  return [k, v.join(' ') || true];
}));
const opponent = args.opponent || 'stockfish';
const elo = args.elo ? Number(args.elo) : null;
const movetime = Number(args.movetime || 200);
const rounds = Number(args.rounds || 1);
const concurrency = Number(args.concurrency || 4);

const OPENINGS = [
  'e2e4 e7e5 g1f3 b8c6', 'e2e4 c7c5 g1f3 d7d6', 'e2e4 e7e6 d2d4 d7d5', 'e2e4 c7c6 d2d4 d7d5',
  'd2d4 d7d5 c2c4 e7e6', 'd2d4 g8f6 c2c4 g7g6', 'd2d4 g8f6 c2c4 e7e6', 'c2c4 e7e5 b1c3 g8f6',
  'g1f3 d7d5 g2g3 g8f6', 'e2e4 e7e5 f1c4 g8f6',
];

class Engine {
  constructor(cmd, cmdArgs = []) {
    this.proc = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buffer = '';
    this.waiting = null;
    this.proc.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (this.waiting && line.startsWith(this.waiting.prefix)) {
          const w = this.waiting;
          this.waiting = null;
          w.resolve(line);
        }
      }
    });
  }

  send(line) { this.proc.stdin.write(`${line}\n`); }

  wait(prefix) { return new Promise((resolve) => { this.waiting = { prefix, resolve }; }); }

  async init(options = {}) {
    this.send('uci');
    await this.wait('uciok');
    for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
    await this.ready();
  }

  async ready() {
    const p = this.wait('readyok');
    this.send('isready');
    await p;
  }

  async move(moves) {
    this.send(moves.length ? `position startpos moves ${moves.join(' ')}` : 'position startpos');
    const p = this.wait('bestmove');
    this.send(`go movetime ${movetime}`);
    return (await p).split(/\s+/)[1];
  }

  quit() { this.send('quit'); }
}

async function playGame(kodiak, other, opening, kodiakIsWhite) {
  for (const e of [kodiak, other]) { e.send('ucinewgame'); await e.ready(); }
  const pos = new Position();
  const moves = opening.split(' ');
  for (const uci of moves) pos.make(pos.parseUci(uci));
  while (true) {
    const status = pos.status();
    if (status.over) {
      if (status.result === '1/2-1/2') return { score: 0.5, reason: status.reason, moves };
      const whiteWon = status.result === '1-0';
      return { score: whiteWon === kodiakIsWhite ? 1 : 0, reason: status.reason, moves };
    }
    if (moves.length >= 300) return { score: 0.5, reason: 'move limit', moves };
    const kodiakToMove = (pos.side === WHITE) === kodiakIsWhite;
    const uci = await (kodiakToMove ? kodiak : other).move(moves);
    const m = pos.parseUci(uci);
    if (!m) return { score: kodiakToMove ? 0 : 1, reason: `illegal move ${uci}`, moves };
    pos.make(m);
    moves.push(uci);
  }
}

function eloDiff(score) {
  const s = Math.min(Math.max(score, 0.001), 0.999);
  return -400 * Math.log10(1 / s - 1);
}

const games = [];
for (let r = 0; r < rounds; r++) for (const o of OPENINGS) games.push([o, true], [o, false]);

const kodiakPath = fileURLToPath(new URL('../uci.js', import.meta.url));
const results = [];
let next = 0;
async function worker() {
  const kodiak = new Engine(process.execPath, [kodiakPath]);
  const other = new Engine(opponent);
  await kodiak.init();
  await other.init(elo ? { Threads: 1, Hash: 16, UCI_LimitStrength: 'true', UCI_Elo: elo } : { Threads: 1, Hash: 16 });
  while (next < games.length) {
    const [opening, white] = games[next++];
    const r = await playGame(kodiak, other, opening, white);
    results.push(r);
    const mark = r.score === 1 ? 'win ' : r.score === 0 ? 'loss' : 'draw';
    console.log(`${String(results.length).padStart(3)}/${games.length}  ${mark}  as ${white ? 'white' : 'black'}  ${r.reason}, ${r.moves.length} plies`);
  }
  kodiak.quit();
  other.quit();
}

await Promise.all(Array.from({ length: Math.min(concurrency, games.length) }, worker));

const n = results.length;
const wins = results.filter((r) => r.score === 1).length;
const losses = results.filter((r) => r.score === 0).length;
const draws = n - wins - losses;
const score = (wins + draws / 2) / n;
const variance = results.reduce((s, r) => s + (r.score - score) ** 2, 0) / n;
const margin = 1.96 * Math.sqrt(variance / n);
const diff = eloDiff(score);
console.log(`\nKodiak vs ${opponent}${elo ? ` (UCI_Elo ${elo})` : ''}, ${movetime} ms per move`);
console.log(`+${wins} =${draws} -${losses}  score ${(score * 100).toFixed(1)}%  Elo difference ${diff >= 0 ? '+' : ''}${Math.round(diff)} (95% range ${Math.round(eloDiff(score - margin))} to ${Math.round(eloDiff(score + margin))})`);
