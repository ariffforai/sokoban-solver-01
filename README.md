# Push-optimal Sokoban solver

[![sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/ariffforai/sokoban-solver-01/rank.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/ariffforai/sokoban-solver-01/reward.svg)](https://make.fun/c/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver for the [make.fun sokoban-solver-01-run-20261121 bounty](https://make.fun/c/sokoban-solver-01-run-20261121): one run answers all 5 instances of a set in push-optimal moves.

`main.ts` is the whole solver (Node 22, standard library only, no dependencies). It reads `/input/<id>/level.txt` (XSB) and writes `/output/<id>/solution.txt` (LURD moves: lowercase a step, uppercase a push).

## How it works

The generator lays a 1-wide hallway across the board with one to four rooms off it, each room holding 3–4 boxes and as many goals — and a box pushed out of its room through its door can never come back. So rooms are independent, and a level's push-optimal count is the sum of its rooms' optima.

- **Split into rooms** — cut the dead squares of the player's row (the hallway: a box there reaches no goal) out of the floor; each remaining part holding boxes is a room.
- **Push-optimal search per room** — breadth-first search over pushes. A state is the boxes' squares plus the player's reachable region; pushes are the only actions, so the first solved state met is push-optimal. Two prunings keep the search small without ever cutting a solvable state: dead squares (no pull-back path from any goal reaches them) and frozen 2×2 blocks (walls and boxes with a box off its goal).
- **Stitch** — the room solutions are joined with the player's walks between them; after a room is done its boxes stand on their goals and count as walls for the rooms still to come.
- **Fallbacks** — if the room split fails or a room order stalls, the solver retries the rooms in reverse order, then falls back to a push-optimal search over the whole level.
- **Deterministic** — the search budget is counted in states (250,000 per room), never in wall-clock time, and every tie is broken by fixed square order, so two runs on one input write byte-identical answers.

## Local results (practice set, kit grader)

| instance | boxes | P\* | pushes | points |
|----------|------:|----:|-------:|-------:|
| i001 | 3 | 13 | 13 | 1000 |
| i002 | 4 | 16 | 16 | 1000 |
| i003 | 8 | 29 | 29 | 1000 |
| i004 | 12 | 47 | 47 | 1000 |
| i005 | 16 | 60 | 60 | 1000 |

**Practice score: 1,000,000 / 1,000,000** (all 5 instances at P\*, L1 regrade reproduced byte for byte). The house baseline `plain-astar 1.0.0` scores 200,000 on the same practice set (only i001 solved).

Local run:

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
