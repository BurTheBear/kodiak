// A tiny opening book: a few common, sound replies for the first moves, so
// Kodiak doesn't play the exact same game every time. Keys are the moves so
// far (UCI, space separated) from the starting position.
const BOOK = {
  '': ['e2e4', 'd2d4', 'c2c4', 'g1f3'],
  'e2e4': ['e7e5', 'c7c5', 'e7e6', 'c7c6'],
  'e2e4 e7e5': ['g1f3', 'b1c3'],
  'e2e4 e7e5 g1f3': ['b8c6', 'g8f6'],
  'e2e4 e7e5 g1f3 b8c6': ['f1b5', 'f1c4', 'd2d4'],
  'e2e4 e7e5 b1c3': ['g8f6', 'b8c6'],
  'e2e4 c7c5': ['g1f3', 'b1c3'],
  'e2e4 c7c5 g1f3': ['d7d6', 'b8c6', 'e7e6'],
  'e2e4 e7e6': ['d2d4'],
  'e2e4 e7e6 d2d4': ['d7d5'],
  'e2e4 c7c6': ['d2d4'],
  'e2e4 c7c6 d2d4': ['d7d5'],
  'd2d4': ['d7d5', 'g8f6'],
  'd2d4 d7d5': ['c2c4', 'g1f3'],
  'd2d4 d7d5 c2c4': ['e7e6', 'c7c6'],
  'd2d4 g8f6': ['c2c4', 'g1f3'],
  'd2d4 g8f6 c2c4': ['e7e6', 'g7g6'],
  'c2c4': ['e7e5', 'g8f6', 'c7c5'],
  'c2c4 e7e5': ['b1c3', 'g2g3'],
  'g1f3': ['d7d5', 'g8f6'],
  'g1f3 d7d5': ['d2d4', 'g2g3'],
};

// Returns a book move for this game, or null once the game has left the book.
export function bookMove(moves, random = Math.random) {
  const options = BOOK[moves.join(' ')];
  return options ? options[Math.floor(random() * options.length)] : null;
}
