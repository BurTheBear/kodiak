// Runs the search off the main thread so the board stays responsive.
import { Position, Search } from './engine.js';

const search = new Search(20);

self.onmessage = ({ data }) => {
  if (data.type === 'new-game') { search.clear(); return; }
  if (data.type !== 'go') return;
  const pos = new Position(data.fen);
  for (const uci of data.moves) {
    const m = pos.parseUci(uci);
    if (!m) break;
    pos.make(m);
  }
  const toUci = (moves) => moves.map((m) => pos.uci(m));
  const result = search.search(pos, {
    timeMs: data.timeMs,
    maxDepth: data.maxDepth,
    onInfo: (info) => self.postMessage({
      type: 'info', id: data.id, depth: info.depth, score: info.score,
      nodes: info.nodes, nps: info.nps, time: info.time, pv: toUci(info.pv),
    }),
  });
  self.postMessage({
    type: 'bestmove', id: data.id, move: result.move ? pos.uci(result.move) : null,
    score: result.score, depth: result.depth, nodes: result.nodes, pv: toUci(result.pv),
  });
};
