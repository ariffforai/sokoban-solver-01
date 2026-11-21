// Push-optimal Sokoban solver (make.fun sokoban-solver-01-run-20261121).
//
// One run answers every instance of a set (5 levels in /input/<id>/level.txt,
// XSB) and writes /output/<id>/solution.txt, a string of LURD moves
// (lowercase = a step, uppercase = a push). Node 22, standard library only,
// deterministic: the search budget is counted in states, never in wall-clock
// time, and every tie is broken by fixed square order, so two runs on one
// input write byte-identical answers.
//
// Why this shape wins: the generator lays a 1-wide hallway across the board
// with one to four rooms off it, each room holding 3-4 boxes and as many
// goals, and a box pushed out of its room through its door can never come
// back. So rooms are independent and a level's push-optimal count is the sum
// of its rooms' optima. Each room is tiny (at most 6x6), so a breadth-first
// search over pushes -- a state is the boxes' squares plus the player's
// reachable region, pushes are the only actions, and the first solved state
// met is push-optimal -- solves every room exactly. Two prunings keep the
// search small without ever cutting a solvable state: a dead square (no
// pull-back path from any goal reaches it, so a box there can never be
// pushed onto a goal) and a frozen 2x2 block (four squares of walls and
// boxes with a box off its goal). The room solutions are stitched with the
// player's walks between them: after a room is done its boxes stand on
// their goals and count as walls for the rooms still to come.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input \
//   MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up: work, never the clock. */
const MAX_STATES = 250_000;
/** Fallback budget for a whole-level search when the room split fails. */
const MAX_STATES_WHOLE = 1_000_000;

/** The four directions: dx, dy, the step's letter, the push's letter. */
const DIRS = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
] as const;

interface Board {
  w: number;
  h: number;
  /** 1 is a wall, 0 is open floor. */
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/**
 * A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal,
 * @ player, + player on a goal), one row a line. Short rows and squares
 * outside the text pad out as walls, and the outermost frame is a wall
 * whatever it shows: nothing leaves the board.
 */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/**
 * The squares from which a box can still be pushed onto some goal: pull
 * back from the goals over open floor. A box on a square outside this set
 * is dead and can never be solved, so such states are pruned.
 */
function liveSquares(board: Board): Uint8Array {
  const { w, wall, goals } = board;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      if (wall[y] === 0 && wall[y - d] === 0 && live[y] === 0) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * The squares the player reaches from `from` with the boxes in `occupied`
 * in the way, marked in `seen` with `stamp`; returns the lowest such
 * square, which names the region. `stack` is scratch space.
 */
function reachRegion(
  board: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = board;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes, one of them a box off its goal. Such a block
 * can never move again, so the state is dead.
 */
function frozenBlock(
  board: Board,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = board;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if ((wall[a] || occupied[a]) === 0) continue;
    if ((wall[b] || occupied[b]) === 0) continue;
    if ((wall[c] || occupied[c]) === 0) continue;
    if ((wall[d] || occupied[d]) === 0) continue;
    if (
      (occupied[a] === 1 && goal[a] === 0) ||
      (occupied[b] === 1 && goal[b] === 0) ||
      (occupied[c] === 1 && goal[c] === 0) ||
      (occupied[d] === 1 && goal[d] === 0)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The shortest walk from `from` to `to` around walls and the boxes in
 * `occupied`, in lowercase LURD letters (the first direction first on
 * ties). Throws when `to` is out of reach: the caller only asks for
 * squares the search has already shown reachable.
 */
function walkTo(
  board: Board,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (wall[q] === 1 || occupied[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The player's square after playing `moves` (LURD, case aside) from `from`. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/** A state's key: its region's lowest square, then the boxes' squares. */
function keyOf(boxes: number[], low: number, size: number): number {
  let k = low;
  for (const b of boxes) k = k * size + b;
  return k;
}

/**
 * The push-optimal solution of `board`, searching at most `maxStates`
 * states: { pushes, moves } (moves in LURD: a lowercase letter a step, an
 * uppercase one a push), or null when the search gives up (or the board
 * has no solution). Breadth-first over pushes, so the first solved state
 * met is push-optimal.
 */
function solvePushOptimal(
  board: Board,
  maxStates: number,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(board);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);
  if (board.boxes.some((b) => live[b] === 0)) return null;

  // The states in the order found: their boxes, the player's square after
  // the push that made them, their parent, and that push (from -> to).
  const statesBoxes: number[][] = [board.boxes];
  const statesPlayer: number[] = [board.player];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushTo: number[] = [-1];
  const index = new Map<number, number>();
  for (const b of board.boxes) occupied[b] = 1;
  index.set(
    keyOf(board.boxes, reachRegion(board, occupied, board.player, seen, ++stamp, stack), size),
    0,
  );
  for (const b of board.boxes) occupied[b] = 0;

  let found = solved(board.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    reachRegion(board, occupied, statesPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const t = b + d;
        // The player must be able to stand behind the box, and the box
        // must land on open, live floor.
        if (seen[b - d] !== here || wall[t] === 1 || occupied[t] === 1 || live[t] === 0) {
          continue;
        }
        occupied[b] = 0;
        occupied[t] = 1;
        if (frozenBlock(board, occupied, goal, t)) {
          occupied[t] = 0;
          occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        const key = keyOf(next, reachRegion(board, occupied, b, mark, ++stamp, stack), size);
        occupied[t] = 0;
        occupied[b] = 1;
        if (index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next);
        statesPlayer.push(b);
        parent.push(head);
        pushFrom.push(b);
        pushTo.push(t);
        if (solved(next)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = board.boxes;
  for (const s of path) {
    const nextBoxes = statesBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * w + dd.dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(board, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  squares: number[];
  boxes: number[];
  goals: number[];
  done: boolean;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when some part holds more or fewer
 * boxes than goals, a goal sits in the hallway, or a box starts in the
 * hallway: then the level is no set of rooms.
 */
function roomsOf(board: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = board;
  const live = liveSquares(board);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b] === 1)) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] === 1 || cut[s] === 1 || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const dir of DIRS) {
        const q = squares[i]! + dir.dy * w + dir.dx;
        if (wall[q] === 0 && cut[q] === 0 && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  }
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room, in the order given: each room's
 * push-optimal solution in turn, the other rooms' boxes standing as walls
 * (on their goals once their room is done), the player walking on from
 * where the last room left it. Null when a room's search gives up.
 */
function solveByRoomsInOrder(board: Board, rooms: Room[]): { pushes: number; moves: string } | null {
  let player = board.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = board.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: board.w,
      h: board.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushOptimal(sub, MAX_STATES);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(board.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/**
 * Solve one level. First room by room (scan order, then reversed: the
 * stitch can depend on the order, since the player ends each room inside
 * it). If the room split fails, fall back to a push-optimal search over
 * the whole level. Null only when every attempt gives up.
 */
function solveLevel(board: Board): { pushes: number; moves: string } | null {
  const rooms = roomsOf(board);
  if (rooms !== null) {
    const forward = solveByRoomsInOrder(board, rooms);
    if (forward !== null) return forward;
    for (const r of rooms) r.done = false;
    const reversed = solveByRoomsInOrder(board, [...rooms].reverse());
    if (reversed !== null) return reversed;
  }
  return solvePushOptimal(board, MAX_STATES_WHOLE);
}

function solve(text: string): string {
  const board = parseLevel(text);
  const solved = solveLevel(board);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  try {
    const moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
  } catch {
    // A level that fails to solve still gets a valid (empty) answer file,
    // so one bad level never takes the whole set down with it.
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), '\n');
  }
}
