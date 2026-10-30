import {
  Position, START_FEN, WHITE, BLACK, KNIGHT, BISHOP, ROOK, QUEEN,
  moveFrom, moveTo, movePromo, moveFlags, FLAG_EP, squareName, mateIn,
} from './src/engine.js';

// U+FE0E asks for the text glyph, so ♟ never turns into an emoji.
const GLYPH = ['', '♟︎', '♞︎', '♝︎', '♜︎', '♛︎', '♚︎'];
const PIECE_NAME = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const LEVELS = {
  cub: { name: 'Cub', timeMs: 250, maxDepth: 2 },
  grizzly: { name: 'Grizzly', timeMs: 900, maxDepth: 64 },
  kodiak: { name: 'Kodiak', timeMs: 2500, maxDepth: 64 },
};
const HINT_TIME_MS = 1200;
const MIN_REPLY_MS = 350;

const $ = (id) => document.getElementById(id);
const boardEl = $('board');

const state = {
  pos: new Position(START_FEN),
  history: [],        // [{ uci, san }]
  lastMove: 0,
  player: WHITE,
  flipped: false,
  level: 'grizzly',
  selected: -1,
  targets: [],        // legal moves from the selected square
  legal: [],
  hint: null,         // [from, to]
  thinking: false,
  pending: null,      // 'move' | 'hint'
  searchId: 0,
  searchStarted: 0,
  over: null,
};

const prefs = loadPrefs();
if (LEVELS[prefs.level]) state.level = prefs.level;
if (prefs.player === BLACK) state.player = BLACK;
state.flipped = state.player === BLACK;

let worker = createWorker();
function createWorker() {
  const w = new Worker(new URL('./src/worker.js', import.meta.url), { type: 'module' });
  w.onmessage = onWorkerMessage;
  return w;
}

// --- Board ---------------------------------------------------------------

const cells = [];
for (let i = 0; i < 64; i++) {
  const el = document.createElement('div');
  el.setAttribute('role', 'gridcell');
  boardEl.appendChild(el);
  cells.push(el);
}

function squareAt(index) {
  const row = index >> 3, col = index & 7;
  const rank = state.flipped ? row : 7 - row;
  const file = state.flipped ? 7 - col : col;
  return rank * 16 + file;
}

const canMove = () => !state.thinking && !state.over && state.pos.side === state.player;

function render() {
  const { pos } = state;
  const checkSq = pos.inCheck() ? pos.kings[pos.side] : -1;
  const movable = canMove();
  for (let i = 0; i < 64; i++) {
    const sq = squareAt(i), el = cells[i];
    const rank = sq >> 4, file = sq & 7;
    const p = pos.board[sq];
    const cls = ['sq', (rank + file) % 2 ? 'light' : 'dark'];
    if (state.lastMove && (sq === moveFrom(state.lastMove) || sq === moveTo(state.lastMove))) cls.push('last');
    if (sq === state.selected) cls.push('sel');
    if (state.hint && state.hint.includes(sq)) cls.push('hinted');
    if (sq === checkSq) cls.push('check');
    const target = state.targets.find((m) => moveTo(m) === sq);
    if (target) cls.push('target', p || moveFlags(target) & FLAG_EP ? 'capture' : 'quiet');
    if (movable && p && p >> 3 === state.player) cls.push('movable');
    el.className = cls.join(' ');
    el.dataset.sq = sq;

    let html = p ? `<span class="piece ${p >> 3 ? 'b' : 'w'}">${GLYPH[p & 7]}</span>` : '';
    if ((i >> 3) === 7) html += `<span class="coord file">${'abcdefgh'[file]}</span>`;
    if ((i & 7) === 0) html += `<span class="coord rank">${rank + 1}</span>`;
    el.innerHTML = html;
    el.setAttribute('aria-label', squareName(sq) + (p ? `, ${p >> 3 ? 'black' : 'white'} ${PIECE_NAME[p & 7]}` : ''));
  }
  $('evalbar').classList.toggle('flipped', state.flipped);
}

function select(sq) {
  state.selected = sq;
  state.targets = state.legal.filter((m) => moveFrom(m) === sq);
  render();
}

function deselect() {
  state.selected = -1;
  state.targets = [];
  render();
}

// --- Input: click-to-move and drag-and-drop ------------------------------

let drag = null;

boardEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.sq');
  if (!el || e.button > 0 || !canMove()) return;
  const sq = +el.dataset.sq;
  if (state.selected >= 0 && state.targets.some((m) => moveTo(m) === sq)) {
    tryMove(state.selected, sq);
    return;
  }
  const p = state.pos.board[sq];
  if (!p || p >> 3 !== state.player) { deselect(); return; }

  const wasSelected = state.selected === sq;
  select(sq);
  const ghost = document.createElement('span');
  ghost.className = `ghost ${p >> 3 ? 'b' : 'w'}`;
  ghost.textContent = GLYPH[p & 7];
  ghost.style.setProperty('--ghost-size', `${boardEl.clientWidth * 0.096}px`);
  ghost.hidden = true;
  document.body.appendChild(ghost);
  drag = { from: sq, ghost, x: e.clientX, y: e.clientY, moved: false, wasSelected };
  boardEl.setPointerCapture(e.pointerId);
});

boardEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) {
    drag.moved = true;
    drag.ghost.hidden = false;
    cellFor(drag.from)?.querySelector('.piece')?.classList.add('lifted');
  }
  if (drag.moved) {
    drag.ghost.style.left = `${e.clientX}px`;
    drag.ghost.style.top = `${e.clientY}px`;
  }
});

boardEl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.ghost.remove();
  if (d.moved) {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sq');
    const to = el ? +el.dataset.sq : -1;
    if (state.targets.some((m) => moveTo(m) === to)) tryMove(d.from, to);
    else render();
  } else if (d.wasSelected) {
    deselect();
  }
});

boardEl.addEventListener('pointercancel', () => {
  if (!drag) return;
  drag.ghost.remove();
  drag = null;
  render();
});

function cellFor(sq) {
  return cells.find((c) => +c.dataset.sq === sq);
}

function tryMove(from, to) {
  const options = state.targets.filter((m) => moveFrom(m) === from && moveTo(m) === to);
  if (options.length > 1) askPromotion(options);
  else if (options.length === 1) playMove(options[0]);
}

function askPromotion(options) {
  const promo = $('promo');
  const color = state.player ? 'b' : 'w';
  promo.innerHTML = '<div class="promo-inner" role="dialog" aria-label="Choose promotion"></div>';
  for (const type of [QUEEN, ROOK, BISHOP, KNIGHT]) {
    const m = options.find((o) => movePromo(o) === type);
    const b = document.createElement('button');
    b.innerHTML = `<span class="piece ${color}">${GLYPH[type]}</span>`;
    b.setAttribute('aria-label', `Promote to ${PIECE_NAME[type]}`);
    b.onclick = () => { promo.hidden = true; playMove(m); };
    promo.firstChild.appendChild(b);
  }
  promo.hidden = false;
  promo.querySelector('button').focus();
}

// --- Game flow -------------------------------------------------------------

function playMove(m) {
  const { pos } = state;
  const san = pos.san(m, state.legal);
  const uci = pos.uci(m);
  pos.make(m);
  state.history.push({ uci, san });
  state.lastMove = m;
  afterPositionChange();
}

function afterPositionChange() {
  state.selected = -1;
  state.targets = [];
  state.hint = null;
  state.legal = state.pos.legalMoves();
  const status = state.pos.status();
  state.over = status.over ? status : null;
  render();
  renderMoves();
  updateStatus();
  saveToUrl();
  if (!state.over && state.pos.side !== state.player) think('move');
}

// The game lives in the URL hash (e.g. #e2e4-e7e5), so any game can be shared.
function saveToUrl() {
  const hash = state.history.map((h) => h.uci).join('-');
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

function loadFromUrl() {
  const pos = new Position(START_FEN);
  const moves = [];
  for (const uci of location.hash.slice(1).split('-').filter(Boolean)) {
    const m = pos.parseUci(uci);
    if (!m) break;
    moves.push({ uci, san: pos.san(m) });
    pos.make(m);
  }
  replay(moves);
}

function think(purpose) {
  const id = ++state.searchId;
  const level = LEVELS[state.level];
  state.thinking = purpose === 'move';
  state.pending = purpose;
  state.searchStarted = performance.now();
  worker.postMessage({
    type: 'go', id, fen: START_FEN,
    moves: state.history.map((h) => h.uci),
    timeMs: purpose === 'hint' ? HINT_TIME_MS : level.timeMs,
    maxDepth: purpose === 'hint' ? 64 : level.maxDepth,
    useBook: purpose === 'move',
  });
  $('engineState').textContent = purpose === 'hint' ? 'finding a hint…' : 'searching…';
  updateStatus();
  render();
}

function onWorkerMessage({ data }) {
  if (data.id !== state.searchId) return;
  if (data.book) $('engineState').textContent = 'book move';
  else showInfo(data);
  if (data.type !== 'bestmove') return;

  const purpose = state.pending;
  state.pending = null;
  if (!data.book) $('engineState').textContent = 'idle';
  const m = data.move ? state.pos.parseUci(data.move) : 0;
  if (purpose === 'hint') {
    if (m) state.hint = [moveFrom(m), moveTo(m)];
    render();
    return;
  }
  // A short pause so instant replies still read as a move being made.
  const wait = Math.max(0, MIN_REPLY_MS - (performance.now() - state.searchStarted));
  setTimeout(() => {
    if (data.id !== state.searchId) return;
    state.thinking = false;
    if (m) playMove(m); else updateStatus();
  }, wait);
}

function cancelSearch() {
  if (state.pending) {
    worker.terminate();
    worker = createWorker();
  }
  state.searchId++;
  state.thinking = false;
  state.pending = null;
  $('engineState').textContent = 'idle';
}

function replay(history) {
  state.pos = new Position(START_FEN);
  state.lastMove = 0;
  for (const h of history) {
    const m = state.pos.parseUci(h.uci);
    state.pos.make(m);
    state.lastMove = m;
  }
  state.history = history.slice();
}

function newGame() {
  cancelSearch();
  worker.postMessage({ type: 'new-game' });
  $('promo').hidden = true;
  state.flipped = state.player === BLACK;
  replay([]);
  setEval(0, null);
  for (const id of ['statDepth', 'statNodes', 'statSpeed', 'statEval']) $(id).textContent = '–';
  $('pv').textContent = '—';
  afterPositionChange();
}

function undo() {
  if (!state.history.length) return;
  cancelSearch();
  $('promo').hidden = true;
  let plies = state.pos.side === state.player ? 2 : 1;
  plies = Math.min(plies, state.history.length);
  replay(state.history.slice(0, state.history.length - plies));
  afterPositionChange();
}

function hint() {
  if (!canMove() || state.pending) return;
  think('hint');
}

// --- Panels --------------------------------------------------------------

function showInfo(data) {
  if (data.depth) $('statDepth').textContent = data.depth;
  if (data.nodes) $('statNodes').textContent = compact(data.nodes);
  if (data.nps) $('statSpeed').textContent = `${compact(data.nps)}/s`;
  if (data.score === undefined) return;
  const whiteScore = state.pos.side === WHITE ? data.score : -data.score;
  const mate = mateIn(whiteScore);
  setEval(whiteScore, mate);
  if (data.pv?.length) $('pv').textContent = pvToSan(data.pv);
}

function setEval(whiteScore, mate) {
  let pct, text;
  if (mate !== null) {
    pct = mate > 0 ? 100 : 0;
    text = `M${Math.abs(mate)}`;
  } else {
    pct = 50 + 50 * Math.tanh(whiteScore / 450);
    text = `${whiteScore > 0 ? '+' : ''}${(whiteScore / 100).toFixed(1)}`;
  }
  $('evalfill').style.height = `${pct}%`;
  $('evaltext').textContent = text.replace('+', '');
  $('statEval').textContent = text;
}

function pvToSan(pv) {
  const pos = new Position(state.pos.fen());
  const parts = [];
  for (const uci of pv.slice(0, 10)) {
    const m = pos.parseUci(uci);
    if (!m) break;
    const num = pos.side === WHITE ? `${pos.fullmove}. ` : parts.length ? '' : `${pos.fullmove}… `;
    parts.push(num + pos.san(m));
    pos.make(m);
  }
  return parts.join(' ') || '—';
}

function renderMoves() {
  const list = $('moves');
  if (!state.history.length) {
    list.innerHTML = '<li><span class="empty">No moves yet. White starts.</span></li>';
    return;
  }
  let html = '';
  for (let i = 0; i < state.history.length; i += 2) {
    const latest = (j) => (j === state.history.length - 1 ? ' latest' : '');
    html += `<li><span class="num">${i / 2 + 1}.</span><span class="mv${latest(i)}">${state.history[i].san}</span>`;
    html += `<span class="mv${latest(i + 1)}">${state.history[i + 1]?.san ?? ''}</span></li>`;
  }
  list.innerHTML = html;
  list.scrollTop = list.scrollHeight;
}

function updateStatus() {
  const banner = $('banner');
  $('thinking').hidden = !state.thinking;
  $('undo').disabled = !state.history.length;
  $('hint').disabled = !canMove();
  $('levelLabel').textContent = `· ${LEVELS[state.level].name}`;
  $('colorLabel').textContent = `· ${state.player === WHITE ? 'White' : 'Black'}`;

  if (state.over) {
    const { result, reason } = state.over;
    const playerWon = (result === '1-0' && state.player === WHITE) || (result === '0-1' && state.player === BLACK);
    const title = result === '1/2-1/2' ? 'Draw' : playerWon ? 'You win!' : 'Kodiak wins';
    $('bannerTitle').textContent = title;
    $('bannerText').textContent = `${result.replace('1/2-1/2', '½–½')} by ${reason}`;
    banner.hidden = false;
    $('status').textContent = title;
    return;
  }
  banner.hidden = true;
  if (state.thinking) $('status').textContent = 'Kodiak is thinking…';
  else if (state.pos.side === state.player) $('status').textContent = state.pos.inCheck() ? 'Check! Your move' : 'Your move';
  else $('status').textContent = '';
}

function pgn() {
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
  const engine = `Kodiak (${LEVELS[state.level].name})`;
  const result = state.over ? state.over.result : '*';
  const tags = [
    ['Event', 'Casual game'], ['Site', location.href], ['Date', date],
    ['White', state.player === WHITE ? 'You' : engine], ['Black', state.player === BLACK ? 'You' : engine], ['Result', result],
  ].map(([k, v]) => `[${k} "${v}"]`).join('\n');
  let moves = '';
  state.history.forEach((h, i) => { moves += (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + h.san + ' '; });
  return `${tags}\n\n${moves}${result}\n`;
}

const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem('kodiak-prefs')) || {}; } catch { return {}; }
}
function savePrefs() {
  try { localStorage.setItem('kodiak-prefs', JSON.stringify({ level: state.level, player: state.player })); } catch { /* storage unavailable */ }
}

// --- Controls --------------------------------------------------------------

function markOn(groupId, attr, value) {
  for (const b of $(groupId).querySelectorAll('button')) b.classList.toggle('on', b.dataset[attr] === String(value));
}

$('levels').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.level = b.dataset.level;
  markOn('levels', 'level', state.level);
  savePrefs();
  updateStatus();
});

$('colors').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  state.player = +b.dataset.color;
  markOn('colors', 'color', state.player);
  savePrefs();
  newGame();
});

$('newGame').onclick = newGame;
$('bannerNew').onclick = newGame;
$('undo').onclick = undo;
$('hint').onclick = hint;
$('flip').onclick = () => { state.flipped = !state.flipped; render(); };
$('copyPgn').onclick = async () => {
  try {
    await navigator.clipboard.writeText(pgn());
    $('copyPgn').textContent = 'Copied';
  } catch {
    $('copyPgn').textContent = 'Copy failed';
  }
  setTimeout(() => { $('copyPgn').textContent = 'Copy PGN'; }, 1500);
};

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey) return;
  if (e.key === 'Escape') { $('promo').hidden = true; deselect(); }
  else if (e.key === 'f') $('flip').click();
  else if (e.key === 'u') undo();
  else if (e.key === 'h') hint();
});

markOn('levels', 'level', state.level);
markOn('colors', 'color', state.player);
loadFromUrl();
afterPositionChange();
