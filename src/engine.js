// Kodiak — a chess engine written from scratch in plain JavaScript.
//
// Board:  0x88 mailbox (128 squares, off-board squares have bit 0x88 set).
// Search: iterative deepening, principal-variation alpha-beta, transposition
//         table, null-move pruning, late-move reductions, check extension,
//         killer + history move ordering, capture-only quiescence search.
// Eval:   tapered middlegame/endgame material + piece-square tables, pawn
//         structure (doubled, isolated, passed) and rook files.

export const WHITE = 0;
export const BLACK = 1;
export const PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const FLAG_CAPTURE = 1, FLAG_EP = 2, FLAG_CASTLE = 4, FLAG_DOUBLE = 8;

const KNIGHT_OFFSETS = [33, 31, 18, 14, -14, -18, -31, -33];
const KING_OFFSETS = [17, 16, 15, 1, -1, -15, -16, -17];
const BISHOP_DIRS = [17, 15, -15, -17];
const ROOK_DIRS = [16, 1, -1, -16];

const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

// Moving from or to one of these squares removes the matching castling rights.
const CASTLE_MASK = new Uint8Array(128).fill(15);
CASTLE_MASK[0] = 15 & ~CASTLE_WQ;
CASTLE_MASK[7] = 15 & ~CASTLE_WK;
CASTLE_MASK[4] = 15 & ~(CASTLE_WK | CASTLE_WQ);
CASTLE_MASK[112] = 15 & ~CASTLE_BQ;
CASTLE_MASK[119] = 15 & ~CASTLE_BK;
CASTLE_MASK[116] = 15 & ~(CASTLE_BK | CASTLE_BQ);

// A move is one integer: from | to << 7 | promotion piece << 14 | flags << 17.
const encode = (from, to, promo, flags) => from | (to << 7) | (promo << 14) | (flags << 17);
export const moveFrom = (m) => m & 127;
export const moveTo = (m) => (m >> 7) & 127;
export const movePromo = (m) => (m >> 14) & 7;
export const moveFlags = (m) => m >>> 17;

export const squareName = (sq) => 'abcdefgh'[sq & 7] + ((sq >> 4) + 1);
export const squareFromName = (s) => (s.charCodeAt(0) - 97) + (s.charCodeAt(1) - 49) * 16;

const now = () => (globalThis.performance ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// Zobrist hashing: two independent 32-bit halves give a 64-bit position key
// without BigInt. The generator is seeded so hashes are stable between runs.

let seed = 0x2545f491;
function rand32() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed | 0;
}
const Z_PIECE_LO = new Int32Array(16 * 128), Z_PIECE_HI = new Int32Array(16 * 128);
for (let i = 0; i < Z_PIECE_LO.length; i++) { Z_PIECE_LO[i] = rand32(); Z_PIECE_HI[i] = rand32(); }
const Z_CASTLE_LO = new Int32Array(16), Z_CASTLE_HI = new Int32Array(16);
for (let i = 0; i < 16; i++) { Z_CASTLE_LO[i] = rand32(); Z_CASTLE_HI[i] = rand32(); }
const Z_EP_LO = new Int32Array(8), Z_EP_HI = new Int32Array(8);
for (let i = 0; i < 8; i++) { Z_EP_LO[i] = rand32(); Z_EP_HI[i] = rand32(); }
const Z_SIDE_LO = rand32(), Z_SIDE_HI = rand32();

// ---------------------------------------------------------------------------
// Position: board state, move generation and make/unmake.

export class Position {
  constructor(fen = START_FEN) {
    this.board = new Int8Array(128);
    this.kings = [0, 0];
    this.load(fen);
  }

  load(fen) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error(`Invalid FEN: ${fen}`);
    this.board.fill(0);
    const kingCount = [0, 0];
    let rank = 7, file = 0;
    for (const ch of parts[0]) {
      if (ch === '/') { rank--; file = 0; continue; }
      if (ch >= '1' && ch <= '8') { file += +ch; continue; }
      const type = 'pnbrqk'.indexOf(ch.toLowerCase()) + 1;
      if (!type || rank < 0 || file > 7) throw new Error(`Invalid FEN: ${fen}`);
      const color = ch === ch.toLowerCase() ? BLACK : WHITE;
      const sq = rank * 16 + file;
      this.board[sq] = type | (color << 3);
      if (type === KING) { this.kings[color] = sq; kingCount[color]++; }
      file++;
    }
    if (kingCount[0] !== 1 || kingCount[1] !== 1) throw new Error(`Invalid FEN (needs one king each): ${fen}`);
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    this.castling = 0;
    for (const ch of parts[2]) this.castling |= { K: CASTLE_WK, Q: CASTLE_WQ, k: CASTLE_BK, q: CASTLE_BQ }[ch] || 0;
    this.ep = parts[3] === '-' ? -1 : squareFromName(parts[3]);
    this.halfmove = parseInt(parts[4] ?? '0', 10) || 0;
    this.fullmove = parseInt(parts[5] ?? '1', 10) || 1;
    this.stack = [];
    this.computeHash();
    this.histLo = [this.hashLo];
    this.histHi = [this.hashHi];
  }

  fen() {
    let s = '';
    for (let rank = 7; rank >= 0; rank--) {
      let empty = 0;
      for (let file = 0; file < 8; file++) {
        const p = this.board[rank * 16 + file];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        const c = ' pnbrqk'[p & 7];
        s += p >> 3 === WHITE ? c.toUpperCase() : c;
      }
      if (empty) s += empty;
      if (rank) s += '/';
    }
    let castle = '';
    if (this.castling & CASTLE_WK) castle += 'K';
    if (this.castling & CASTLE_WQ) castle += 'Q';
    if (this.castling & CASTLE_BK) castle += 'k';
    if (this.castling & CASTLE_BQ) castle += 'q';
    const ep = this.ep < 0 ? '-' : squareName(this.ep);
    return `${s} ${this.side ? 'b' : 'w'} ${castle || '-'} ${ep} ${this.halfmove} ${this.fullmove}`;
  }

  computeHash() {
    let lo = 0, hi = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (p) { lo ^= Z_PIECE_LO[p * 128 + sq]; hi ^= Z_PIECE_HI[p * 128 + sq]; }
    }
    lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    if (this.side === BLACK) { lo ^= Z_SIDE_LO; hi ^= Z_SIDE_HI; }
    this.hashLo = lo;
    this.hashHi = hi;
  }

  // Is `sq` attacked by any piece of color `by`?
  attacked(sq, by) {
    const b = this.board;
    const pawn = PAWN | (by << 3);
    if (by === WHITE) {
      if (!((sq - 15) & 0x88) && b[sq - 15] === pawn) return true;
      if (!((sq - 17) & 0x88) && b[sq - 17] === pawn) return true;
    } else {
      if (!((sq + 15) & 0x88) && b[sq + 15] === pawn) return true;
      if (!((sq + 17) & 0x88) && b[sq + 17] === pawn) return true;
    }
    const knight = KNIGHT | (by << 3), king = KING | (by << 3);
    for (let i = 0; i < 8; i++) {
      let t = sq + KNIGHT_OFFSETS[i];
      if (!(t & 0x88) && b[t] === knight) return true;
      t = sq + KING_OFFSETS[i];
      if (!(t & 0x88) && b[t] === king) return true;
    }
    const rook = ROOK | (by << 3), bishop = BISHOP | (by << 3), queen = QUEEN | (by << 3);
    for (let i = 0; i < 4; i++) {
      const d = ROOK_DIRS[i];
      for (let t = sq + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (!p) continue;
        if (p === rook || p === queen) return true;
        break;
      }
    }
    for (let i = 0; i < 4; i++) {
      const d = BISHOP_DIRS[i];
      for (let t = sq + d; !(t & 0x88); t += d) {
        const p = b[t];
        if (!p) continue;
        if (p === bishop || p === queen) return true;
        break;
      }
    }
    return false;
  }

  inCheck() {
    return this.attacked(this.kings[this.side], this.side ^ 1);
  }

  // Pseudo-legal moves (may leave the king in check). With `tactical` set,
  // only captures and queen promotions are generated, for quiescence search.
  generate(moves = [], tactical = false) {
    const b = this.board, us = this.side, them = us ^ 1;
    for (let from = 0; from < 128; from++) {
      if (from & 0x88) { from += 7; continue; }
      const p = b[from];
      if (!p || p >> 3 !== us) continue;
      const type = p & 7;
      if (type === PAWN) { this.generatePawn(moves, from, tactical); continue; }
      if (type === KNIGHT || type === KING) {
        const offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (let i = 0; i < 8; i++) {
          const to = from + offsets[i];
          if (to & 0x88) continue;
          const q = b[to];
          if (!q) { if (!tactical) moves.push(encode(from, to, 0, 0)); }
          else if (q >> 3 === them) moves.push(encode(from, to, 0, FLAG_CAPTURE));
        }
        if (type === KING && !tactical) this.generateCastles(moves, from);
        continue;
      }
      const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : KING_OFFSETS;
      for (let i = 0; i < dirs.length; i++) {
        const d = dirs[i];
        for (let to = from + d; !(to & 0x88); to += d) {
          const q = b[to];
          if (!q) { if (!tactical) moves.push(encode(from, to, 0, 0)); continue; }
          if (q >> 3 === them) moves.push(encode(from, to, 0, FLAG_CAPTURE));
          break;
        }
      }
    }
    return moves;
  }

  generatePawn(moves, from, tactical) {
    const b = this.board, us = this.side;
    const dir = us === WHITE ? 16 : -16;
    const rank = from >> 4;
    const lastStep = us === WHITE ? 6 : 1;
    const start = us === WHITE ? 1 : 6;
    const one = from + dir;
    if (!b[one]) {
      if (rank === lastStep) this.pushPromotions(moves, from, one, 0, tactical);
      else if (!tactical) {
        moves.push(encode(from, one, 0, 0));
        if (rank === start && !b[one + dir]) moves.push(encode(from, one + dir, 0, FLAG_DOUBLE));
      }
    }
    for (let side = -1; side <= 1; side += 2) {
      const to = one + side;
      if (to & 0x88) continue;
      const q = b[to];
      if (q && q >> 3 !== us) {
        if (rank === lastStep) this.pushPromotions(moves, from, to, FLAG_CAPTURE, tactical);
        else moves.push(encode(from, to, 0, FLAG_CAPTURE));
      } else if (to === this.ep) {
        moves.push(encode(from, to, 0, FLAG_CAPTURE | FLAG_EP));
      }
    }
  }

  pushPromotions(moves, from, to, flags, tactical) {
    moves.push(encode(from, to, QUEEN, flags));
    if (tactical) return;
    moves.push(encode(from, to, KNIGHT, flags));
    moves.push(encode(from, to, ROOK, flags));
    moves.push(encode(from, to, BISHOP, flags));
  }

  generateCastles(moves, from) {
    const b = this.board, them = this.side ^ 1;
    if (this.side === WHITE) {
      if (from !== 4) return;
      if ((this.castling & CASTLE_WK) && !b[5] && !b[6] && b[7] === ROOK &&
          !this.attacked(4, them) && !this.attacked(5, them) && !this.attacked(6, them)) {
        moves.push(encode(4, 6, 0, FLAG_CASTLE));
      }
      if ((this.castling & CASTLE_WQ) && !b[3] && !b[2] && !b[1] && b[0] === ROOK &&
          !this.attacked(4, them) && !this.attacked(3, them) && !this.attacked(2, them)) {
        moves.push(encode(4, 2, 0, FLAG_CASTLE));
      }
    } else {
      if (from !== 116) return;
      const rook = ROOK | 8;
      if ((this.castling & CASTLE_BK) && !b[117] && !b[118] && b[119] === rook &&
          !this.attacked(116, them) && !this.attacked(117, them) && !this.attacked(118, them)) {
        moves.push(encode(116, 118, 0, FLAG_CASTLE));
      }
      if ((this.castling & CASTLE_BQ) && !b[115] && !b[114] && !b[113] && b[112] === rook &&
          !this.attacked(116, them) && !this.attacked(115, them) && !this.attacked(114, them)) {
        moves.push(encode(116, 114, 0, FLAG_CASTLE));
      }
    }
  }

  make(m) {
    const b = this.board, us = this.side;
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >>> 17;
    const piece = b[from];
    const capSq = flags & FLAG_EP ? to + (us === WHITE ? -16 : 16) : to;
    const captured = b[capSq];
    this.stack.push({ m, captured, castling: this.castling, ep: this.ep, halfmove: this.halfmove, lo: this.hashLo, hi: this.hashHi });

    let lo = this.hashLo ^ Z_CASTLE_LO[this.castling];
    let hi = this.hashHi ^ Z_CASTLE_HI[this.castling];
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }
    if (captured) {
      b[capSq] = 0;
      lo ^= Z_PIECE_LO[captured * 128 + capSq]; hi ^= Z_PIECE_HI[captured * 128 + capSq];
    }
    const placed = promo ? promo | (us << 3) : piece;
    b[from] = 0;
    b[to] = placed;
    lo ^= Z_PIECE_LO[piece * 128 + from] ^ Z_PIECE_LO[placed * 128 + to];
    hi ^= Z_PIECE_HI[piece * 128 + from] ^ Z_PIECE_HI[placed * 128 + to];

    if (flags & FLAG_CASTLE) {
      const [rf, rt] = rookCastleSquares(to);
      const rook = b[rf];
      b[rf] = 0;
      b[rt] = rook;
      lo ^= Z_PIECE_LO[rook * 128 + rf] ^ Z_PIECE_LO[rook * 128 + rt];
      hi ^= Z_PIECE_HI[rook * 128 + rf] ^ Z_PIECE_HI[rook * 128 + rt];
    }
    if ((piece & 7) === KING) this.kings[us] = to;

    this.castling &= CASTLE_MASK[from] & CASTLE_MASK[to];
    lo ^= Z_CASTLE_LO[this.castling]; hi ^= Z_CASTLE_HI[this.castling];
    this.ep = flags & FLAG_DOUBLE ? (from + to) >> 1 : -1;
    if (this.ep >= 0) { lo ^= Z_EP_LO[this.ep & 7]; hi ^= Z_EP_HI[this.ep & 7]; }

    this.halfmove = (piece & 7) === PAWN || captured ? 0 : this.halfmove + 1;
    if (us === BLACK) this.fullmove++;
    this.side = us ^ 1;
    this.hashLo = lo ^ Z_SIDE_LO;
    this.hashHi = hi ^ Z_SIDE_HI;
    this.histLo.push(this.hashLo);
    this.histHi.push(this.hashHi);
  }

  // Pass the turn without moving (used by null-move pruning).
  makeNull() {
    this.stack.push({ m: 0, captured: 0, castling: this.castling, ep: this.ep, halfmove: this.halfmove, lo: this.hashLo, hi: this.hashHi });
    if (this.ep >= 0) { this.hashLo ^= Z_EP_LO[this.ep & 7]; this.hashHi ^= Z_EP_HI[this.ep & 7]; }
    this.ep = -1;
    this.halfmove = 0; // repetition checks must not look past a null move
    if (this.side === BLACK) this.fullmove++;
    this.side ^= 1;
    this.hashLo ^= Z_SIDE_LO;
    this.hashHi ^= Z_SIDE_HI;
    this.histLo.push(this.hashLo);
    this.histHi.push(this.hashHi);
  }

  unmake() {
    const u = this.stack.pop();
    this.histLo.pop();
    this.histHi.pop();
    this.side ^= 1;
    const us = this.side, m = u.m, b = this.board;
    if (m) {
      const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >>> 17;
      const moved = promo ? PAWN | (us << 3) : b[to];
      b[from] = moved;
      if (flags & FLAG_EP) {
        b[to] = 0;
        b[to + (us === WHITE ? -16 : 16)] = u.captured;
      } else {
        b[to] = u.captured;
      }
      if (flags & FLAG_CASTLE) {
        const [rf, rt] = rookCastleSquares(to);
        b[rf] = b[rt];
        b[rt] = 0;
      }
      if ((moved & 7) === KING) this.kings[us] = from;
    }
    this.castling = u.castling;
    this.ep = u.ep;
    this.halfmove = u.halfmove;
    this.hashLo = u.lo;
    this.hashHi = u.hi;
    if (us === BLACK) this.fullmove--;
  }

  legalMoves() {
    const legal = [];
    const us = this.side;
    for (const m of this.generate([])) {
      this.make(m);
      if (!this.attacked(this.kings[us], us ^ 1)) legal.push(m);
      this.unmake();
    }
    return legal;
  }

  perft(depth) {
    if (depth === 0) return 1;
    const us = this.side;
    let nodes = 0;
    for (const m of this.generate([])) {
      this.make(m);
      if (!this.attacked(this.kings[us], us ^ 1)) nodes += depth === 1 ? 1 : this.perft(depth - 1);
      this.unmake();
    }
    return nodes;
  }

  // Has the current position occurred before since the last irreversible move?
  isRepetition() {
    const n = this.histLo.length;
    const limit = Math.max(0, n - 1 - this.halfmove);
    for (let i = n - 3; i >= limit; i -= 2) {
      if (this.histLo[i] === this.hashLo && this.histHi[i] === this.hashHi) return true;
    }
    return false;
  }

  repetitionCount() {
    const n = this.histLo.length;
    const limit = Math.max(0, n - 1 - this.halfmove);
    let count = 0;
    for (let i = n - 3; i >= limit; i -= 2) {
      if (this.histLo[i] === this.hashLo && this.histHi[i] === this.hashHi) count++;
    }
    return count;
  }

  insufficientMaterial() {
    let minors = 0;
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const t = this.board[sq] & 7;
      if (t === PAWN || t === ROOK || t === QUEEN) return false;
      if (t === KNIGHT || t === BISHOP) minors++;
    }
    return minors <= 1;
  }

  hasNonPawnMaterial(color) {
    for (let sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.board[sq];
      if (p && p >> 3 === color && (p & 7) !== PAWN && (p & 7) !== KING) return true;
    }
    return false;
  }

  status() {
    if (!this.legalMoves().length) {
      if (this.inCheck()) return { over: true, result: this.side === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
      return { over: true, result: '1/2-1/2', reason: 'stalemate' };
    }
    if (this.halfmove >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
    if (this.repetitionCount() >= 2) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
    if (this.insufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    return { over: false };
  }

  uci(m) {
    const promo = (m >> 14) & 7;
    return squareName(m & 127) + squareName((m >> 7) & 127) + (promo ? ' pnbrqk'[promo] : '');
  }

  parseUci(text) {
    return this.legalMoves().find((m) => this.uci(m) === text) || 0;
  }

  // Standard algebraic notation, e.g. "Nbd7", "exd6", "e8=Q+", "O-O-O#".
  san(m, legal = this.legalMoves()) {
    const from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flags = m >>> 17;
    const type = this.board[from] & 7;
    let s;
    if (flags & FLAG_CASTLE) {
      s = (to & 7) === 6 ? 'O-O' : 'O-O-O';
    } else if (type === PAWN) {
      s = flags & FLAG_CAPTURE ? 'abcdefgh'[from & 7] + 'x' : '';
      s += squareName(to);
      if (promo) s += '=' + ' PNBRQK'[promo];
    } else {
      s = ' PNBRQK'[type];
      const rivals = legal.filter((o) => o !== m && ((o >> 7) & 127) === to && (this.board[o & 127] & 7) === type);
      if (rivals.length) {
        const sameFile = rivals.some((o) => ((o & 127) & 7) === (from & 7));
        const sameRank = rivals.some((o) => ((o & 127) >> 4) === (from >> 4));
        if (!sameFile) s += 'abcdefgh'[from & 7];
        else if (!sameRank) s += (from >> 4) + 1;
        else s += squareName(from);
      }
      if (flags & FLAG_CAPTURE) s += 'x';
      s += squareName(to);
    }
    this.make(m);
    if (this.inCheck()) s += this.legalMoves().length ? '+' : '#';
    this.unmake();
    return s;
  }
}

function rookCastleSquares(kingTo) {
  if (kingTo === 6) return [7, 5];
  if (kingTo === 2) return [0, 3];
  if (kingTo === 118) return [119, 117];
  return [112, 115];
}

// ---------------------------------------------------------------------------
// Evaluation. Tables are written from White's point of view with rank 8 on
// top, so they read like a board diagram; Black looks them up mirrored.

const PAWN_MG = [
    0,   0,   0,   0,   0,   0,   0,   0,
   60,  60,  60,  60,  60,  60,  60,  60,
   20,  20,  30,  40,  40,  30,  20,  20,
    8,   8,  15,  30,  30,  15,   8,   8,
    2,   2,  10,  25,  25,  10,   2,   2,
    4,  -2,  -5,   5,   5,  -5,  -2,   4,
    5,  10,  10, -25, -25,  10,  10,   5,
    0,   0,   0,   0,   0,   0,   0,   0,
];
const PAWN_EG = [
    0,   0,   0,   0,   0,   0,   0,   0,
   90,  90,  90,  90,  90,  90,  90,  90,
   55,  55,  55,  55,  55,  55,  55,  55,
   30,  30,  30,  30,  30,  30,  30,  30,
   15,  15,  15,  15,  15,  15,  15,  15,
    5,   5,   5,   5,   5,   5,   5,   5,
    0,   0,   0,   0,   0,   0,   0,   0,
    0,   0,   0,   0,   0,   0,   0,   0,
];
const KNIGHT_PST = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20,   0,   5,   5,   0, -20, -40,
  -30,   5,  10,  15,  15,  10,   5, -30,
  -30,   0,  15,  20,  20,  15,   0, -30,
  -30,   5,  15,  20,  20,  15,   5, -30,
  -30,   0,  10,  15,  15,  10,   0, -30,
  -40, -20,   0,   0,   0,   0, -20, -40,
  -50, -35, -30, -30, -30, -30, -35, -50,
];
const BISHOP_PST = [
  -20, -10, -10, -10, -10, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,  10,  10,   5,   0, -10,
  -10,   5,   5,  10,  10,   5,   5, -10,
  -10,   0,  10,  10,  10,  10,   0, -10,
  -10,  10,  10,  10,  10,  10,  10, -10,
  -10,   5,   0,   0,   0,   0,   5, -10,
  -20, -10, -12, -10, -10, -12, -10, -20,
];
const ROOK_PST = [
    0,   0,   0,   0,   0,   0,   0,   0,
    5,  10,  10,  10,  10,  10,  10,   5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
   -5,   0,   0,   0,   0,   0,   0,  -5,
    0,   0,   0,   5,   5,   0,   0,   0,
];
const QUEEN_PST = [
  -20, -10, -10,  -5,  -5, -10, -10, -20,
  -10,   0,   0,   0,   0,   0,   0, -10,
  -10,   0,   5,   5,   5,   5,   0, -10,
   -5,   0,   5,   5,   5,   5,   0,  -5,
    0,   0,   5,   5,   5,   5,   0,  -5,
  -10,   5,   5,   5,   5,   5,   0, -10,
  -10,   0,   5,   0,   0,   0,   0, -10,
  -20, -10, -10,  -5,  -5, -10, -10, -20,
];
const KING_MG = [
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -30, -40, -40, -50, -50, -40, -40, -30,
  -20, -30, -30, -40, -40, -30, -30, -20,
  -10, -20, -20, -20, -20, -20, -20, -10,
   15,  15,   0,   0,   0,   0,  15,  15,
   20,  30,  10,   0,   0,  10,  30,  20,
];
const KING_EG = [
  -50, -40, -30, -20, -20, -30, -40, -50,
  -30, -20, -10,   0,   0, -10, -20, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  30,  40,  40,  30, -10, -30,
  -30, -10,  20,  30,  30,  20, -10, -30,
  -30, -30,   0,   0,   0,   0, -30, -30,
  -50, -30, -30, -30, -30, -30, -30, -50,
];

const MG_VALUE = [0, 100, 320, 330, 500, 950, 0];
const EG_VALUE = [0, 120, 300, 315, 540, 960, 0];
const PHASE_WEIGHT = [0, 0, 1, 1, 2, 4, 0];
const PST_MG = [null, PAWN_MG, KNIGHT_PST, BISHOP_PST, ROOK_PST, QUEEN_PST, KING_MG];
const PST_EG = [null, PAWN_EG, KNIGHT_PST, BISHOP_PST, ROOK_PST, QUEEN_PST, KING_EG];
const PASSED_MG = [0, 5, 10, 15, 25, 40, 60, 0];
const PASSED_EG = [0, 10, 20, 35, 60, 90, 130, 0];

export const PIECE_VALUE = MG_VALUE;

const pawnFiles = [new Int8Array(8), new Int8Array(8)];
const whiteLowest = new Int8Array(8);
const blackHighest = new Int8Array(8);

// Static evaluation in centipawns from the side to move's point of view.
export function evaluate(pos) {
  const b = pos.board;
  pawnFiles[0].fill(0);
  pawnFiles[1].fill(0);
  whiteLowest.fill(8);
  blackHighest.fill(-1);
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if ((p & 7) !== PAWN) continue;
    const file = sq & 7, rank = sq >> 4;
    if (p >> 3 === WHITE) {
      pawnFiles[0][file]++;
      if (rank < whiteLowest[file]) whiteLowest[file] = rank;
    } else {
      pawnFiles[1][file]++;
      if (rank > blackHighest[file]) blackHighest[file] = rank;
    }
  }

  let mg = 0, eg = 0, phase = 0, whiteBishops = 0, blackBishops = 0;
  for (let sq = 0; sq < 128; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const type = p & 7, color = p >> 3;
    const file = sq & 7, rank = sq >> 4;
    const idx = color === WHITE ? (7 - rank) * 8 + file : rank * 8 + file;
    let m = MG_VALUE[type] + PST_MG[type][idx];
    let e = EG_VALUE[type] + PST_EG[type][idx];
    phase += PHASE_WEIGHT[type];

    if (type === PAWN) {
      const own = pawnFiles[color];
      if (own[file] > 1) { m -= 8; e -= 15; }
      if ((file === 0 || !own[file - 1]) && (file === 7 || !own[file + 1])) { m -= 10; e -= 12; }
      let passed = true;
      for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
        if (color === WHITE ? blackHighest[f] > rank : whiteLowest[f] < rank) { passed = false; break; }
      }
      if (passed) {
        const rel = color === WHITE ? rank : 7 - rank;
        m += PASSED_MG[rel];
        e += PASSED_EG[rel];
      }
    } else if (type === BISHOP) {
      if (color === WHITE) whiteBishops++; else blackBishops++;
    } else if (type === ROOK && !pawnFiles[color][file]) {
      const open = !pawnFiles[color ^ 1][file];
      m += open ? 20 : 10;
      e += open ? 10 : 5;
    }

    if (color === WHITE) { mg += m; eg += e; } else { mg -= m; eg -= e; }
  }
  if (whiteBishops >= 2) { mg += 30; eg += 45; }
  if (blackBishops >= 2) { mg -= 30; eg -= 45; }

  if (phase > 24) phase = 24;
  const score = ((mg * phase + eg * (24 - phase)) / 24) | 0;
  return (pos.side === WHITE ? score : -score) + 10;
}

// ---------------------------------------------------------------------------
// Search.

export const INF = 32000;
export const MATE = 31000;
const MATE_BOUND = MATE - 512;
const TT_EXACT = 1, TT_LOWER = 2, TT_UPPER = 3;
const MAX_PLY = 96;

export class Search {
  constructor(ttBits = 20) {
    const size = 1 << ttBits;
    this.ttMask = size - 1;
    this.ttLo = new Int32Array(size);
    this.ttHi = new Int32Array(size);
    this.ttMove = new Int32Array(size);
    this.ttScore = new Int16Array(size);
    this.ttDepth = new Int8Array(size);
    this.ttFlag = new Uint8Array(size);
    this.history = new Int32Array(16 * 128);
    this.killers = new Int32Array(MAX_PLY * 2);
  }

  clear() {
    this.ttFlag.fill(0);
    this.ttMove.fill(0);
  }

  // Iterative deepening driver. Returns the best move found within the limits.
  search(pos, { timeMs = 1000, maxDepth = 64, onInfo } = {}) {
    this.start = now();
    this.deadline = this.start + timeMs;
    this.nodes = 0;
    this.stopped = false;
    this.history.fill(0);
    this.killers.fill(0);

    const legal = pos.legalMoves();
    if (!legal.length) return { move: 0, score: pos.inCheck() ? -MATE : 0, depth: 0, nodes: 0, pv: [] };

    let best = { move: legal[0], score: 0, depth: 0, nodes: 0, pv: [legal[0]] };
    for (let depth = 1; depth <= Math.min(maxDepth, MAX_PLY - 8); depth++) {
      this.iterationDepth = depth;
      this.rootBest = 0;
      const score = this.negamax(pos, depth, -INF, INF, 0, false);
      if (this.stopped) break;
      const pv = this.principalVariation(pos, depth);
      const elapsed = now() - this.start;
      best = { move: this.rootBest || pv[0] || best.move, score, depth, nodes: this.nodes, pv, time: elapsed };
      if (onInfo) onInfo({ ...best, nps: Math.round(this.nodes / Math.max(elapsed, 1) * 1000) });
      if (Math.abs(score) >= MATE_BOUND && MATE - Math.abs(score) <= depth) break;
      if (legal.length === 1 && depth >= 4) break;
      if (elapsed > timeMs * 0.55) break; // the next iteration would not finish in time
    }
    best.nodes = this.nodes;
    best.time = now() - this.start;
    return best;
  }

  checkTime() {
    if (this.iterationDepth > 1 && now() >= this.deadline) this.stopped = true;
  }

  negamax(pos, depth, alpha, beta, ply, allowNull) {
    if ((++this.nodes & 2047) === 0) this.checkTime();
    if (this.stopped) return 0;
    const root = ply === 0;

    if (!root) {
      if (pos.halfmove >= 100 || pos.isRepetition() || pos.insufficientMaterial()) return 0;
      // Mate distance pruning: no line from here can beat a mate already found.
      alpha = Math.max(alpha, -MATE + ply);
      beta = Math.min(beta, MATE - ply - 1);
      if (alpha >= beta) return alpha;
      if (ply >= MAX_PLY - 1) return evaluate(pos);
    }

    const inCheck = pos.inCheck();
    if (inCheck) depth++;
    if (depth <= 0) return this.quiesce(pos, alpha, beta, ply);

    const pvNode = beta - alpha > 1;
    const slot = pos.hashLo & this.ttMask;
    let ttMove = 0;
    if (this.ttFlag[slot] && this.ttLo[slot] === pos.hashLo && this.ttHi[slot] === pos.hashHi) {
      ttMove = this.ttMove[slot];
      if (!root && !pvNode && this.ttDepth[slot] >= depth) {
        const s = scoreFromTT(this.ttScore[slot], ply);
        const flag = this.ttFlag[slot];
        if (flag === TT_EXACT || (flag === TT_LOWER && s >= beta) || (flag === TT_UPPER && s <= alpha)) return s;
      }
    }

    // Null move: if passing still beats beta, a real move will too.
    if (allowNull && !pvNode && !inCheck && depth >= 3 && pos.hasNonPawnMaterial(pos.side) && evaluate(pos) >= beta) {
      const r = depth > 6 ? 3 : 2;
      pos.makeNull();
      const s = -this.negamax(pos, depth - 1 - r, -beta, -beta + 1, ply + 1, false);
      pos.unmake();
      if (this.stopped) return 0;
      if (s >= beta) return s >= MATE_BOUND ? beta : s;
    }

    const moves = pos.generate([]);
    const scores = this.orderScores(pos, moves, ttMove, ply);
    const us = pos.side;
    const alphaStart = alpha;
    let bestScore = -INF, bestMove = 0, legal = 0;

    for (let i = 0; i < moves.length; i++) {
      pickNext(moves, scores, i);
      const m = moves[i];
      const flags = m >>> 17;
      const quiet = !(flags & FLAG_CAPTURE) && !((m >> 14) & 7);
      pos.make(m);
      if (pos.attacked(pos.kings[us], us ^ 1)) { pos.unmake(); continue; }
      legal++;

      let s;
      if (legal === 1) {
        s = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      } else {
        // Late-move reduction for quiet moves that ordering ranked low.
        let r = 0;
        if (depth >= 3 && legal > 4 && quiet && !inCheck && !pos.inCheck()) r = legal > 12 ? 2 : 1;
        s = -this.negamax(pos, depth - 1 - r, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && r) s = -this.negamax(pos, depth - 1, -alpha - 1, -alpha, ply + 1, true);
        if (s > alpha && s < beta) s = -this.negamax(pos, depth - 1, -beta, -alpha, ply + 1, true);
      }
      pos.unmake();
      if (this.stopped) return 0;

      if (s > bestScore) {
        bestScore = s;
        bestMove = m;
        if (root) this.rootBest = m;
        if (s > alpha) {
          alpha = s;
          if (s >= beta) {
            if (quiet) {
              if (this.killers[ply * 2] !== m) {
                this.killers[ply * 2 + 1] = this.killers[ply * 2];
                this.killers[ply * 2] = m;
              }
              const h = pos.board[m & 127] * 128 + ((m >> 7) & 127);
              this.history[h] += depth * depth;
              if (this.history[h] > 400000) for (let k = 0; k < this.history.length; k++) this.history[k] >>= 1;
            }
            break;
          }
        }
      }
    }

    if (!legal) return inCheck ? -MATE + ply : 0;

    const flag = bestScore <= alphaStart ? TT_UPPER : bestScore >= beta ? TT_LOWER : TT_EXACT;
    this.ttLo[slot] = pos.hashLo;
    this.ttHi[slot] = pos.hashHi;
    this.ttMove[slot] = bestMove;
    this.ttScore[slot] = scoreToTT(bestScore, ply);
    this.ttDepth[slot] = depth;
    this.ttFlag[slot] = flag;
    return bestScore;
  }

  // Only captures (and queen promotions) until the position is quiet, so the
  // static evaluation is never taken in the middle of an exchange.
  quiesce(pos, alpha, beta, ply) {
    if ((++this.nodes & 2047) === 0) this.checkTime();
    if (this.stopped) return 0;
    const stand = evaluate(pos);
    if (stand >= beta) return stand;
    if (ply >= MAX_PLY - 1) return stand;
    if (stand > alpha) alpha = stand;

    const moves = pos.generate([], true);
    const scores = this.orderScores(pos, moves, 0, ply);
    const us = pos.side;
    let best = stand;
    for (let i = 0; i < moves.length; i++) {
      pickNext(moves, scores, i);
      const m = moves[i];
      const flags = m >>> 17;
      const victim = flags & FLAG_EP ? PAWN : pos.board[(m >> 7) & 127] & 7;
      // Delta pruning: even winning this piece cannot lift us to alpha.
      if (!((m >> 14) & 7) && stand + MG_VALUE[victim] + 200 < alpha) continue;
      pos.make(m);
      if (pos.attacked(pos.kings[us], us ^ 1)) { pos.unmake(); continue; }
      const s = -this.quiesce(pos, -beta, -alpha, ply + 1);
      pos.unmake();
      if (this.stopped) return 0;
      if (s > best) {
        best = s;
        if (s > alpha) {
          alpha = s;
          if (s >= beta) break;
        }
      }
    }
    return best;
  }

  orderScores(pos, moves, ttMove, ply) {
    const b = pos.board;
    const scores = new Int32Array(moves.length);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      const flags = m >>> 17;
      const promo = (m >> 14) & 7;
      if (m === ttMove) scores[i] = 3000000;
      else if (flags & FLAG_CAPTURE) {
        const victim = flags & FLAG_EP ? PAWN : b[(m >> 7) & 127] & 7;
        scores[i] = 2000000 + victim * 100 - (b[m & 127] & 7) + promo * 1000;
      } else if (promo) scores[i] = 1900000 + promo;
      else if (m === this.killers[ply * 2]) scores[i] = 1800000;
      else if (m === this.killers[ply * 2 + 1]) scores[i] = 1700000;
      else scores[i] = this.history[b[m & 127] * 128 + ((m >> 7) & 127)];
    }
    return scores;
  }

  // Walk the transposition table from the root to recover the expected line.
  principalVariation(pos, depth) {
    const line = [];
    const seen = new Set();
    while (line.length < depth) {
      const slot = pos.hashLo & this.ttMask;
      if (!this.ttFlag[slot] || this.ttLo[slot] !== pos.hashLo || this.ttHi[slot] !== pos.hashHi) break;
      const m = this.ttMove[slot];
      const key = `${pos.hashLo}:${pos.hashHi}`;
      if (!m || seen.has(key) || !pos.legalMoves().includes(m)) break;
      seen.add(key);
      pos.make(m);
      line.push(m);
    }
    for (let i = 0; i < line.length; i++) pos.unmake();
    if (this.rootBest && line[0] !== this.rootBest) return [this.rootBest];
    return line;
  }
}

function pickNext(moves, scores, start) {
  let best = start;
  for (let j = start + 1; j < moves.length; j++) if (scores[j] > scores[best]) best = j;
  if (best !== start) {
    const m = moves[start]; moves[start] = moves[best]; moves[best] = m;
    const s = scores[start]; scores[start] = scores[best]; scores[best] = s;
  }
}

function scoreToTT(score, ply) {
  if (score >= MATE_BOUND) return score + ply;
  if (score <= -MATE_BOUND) return score - ply;
  return score;
}

function scoreFromTT(score, ply) {
  if (score >= MATE_BOUND) return score - ply;
  if (score <= -MATE_BOUND) return score + ply;
  return score;
}

// Mate scores as "moves until mate" (positive: side to move mates), else null.
export function mateIn(score) {
  if (Math.abs(score) < MATE_BOUND) return null;
  const plies = MATE - Math.abs(score);
  return Math.sign(score) * Math.ceil(plies / 2);
}
