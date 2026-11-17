---
name: orca-wave
description: 'Supervised parallel delivery for Scrap Rally: the orchestrator session takes ready tickets from the ClickUp list scrap-rally, starts one Claude worker per ticket in its own new Orca workspace, each worker loops until every acceptance criterion is verified and commits to its own local branch (never pushes), a reviewer worker reviews the branch, and the orchestrator merges locally, flips ClickUp and cleans up. Use for /orca-wave, run the next wave, dispatch a worker, work the board.'
---

# orca-wave — Scrap Rally

Adapted from MarianLearning's orca-wave (validated pilot 2026-10-04) for local merges (no
GitHub PRs, no CI). Reviewed by the Fable 5.2 advisor 2026-11-14 (sound with changes, folded
in). Read Orca's guide once per session before the first command: `orca skills get orchestration`.

Constants: repo `id:91004af0-a72a-49a5-90e9-b64ded81bd15` (~/DEV/scrap-rally), ClickUp list
`1200210000012904` (statuses: to do, in progress, in review, ready for qa test, complete).

## Hard gates (never autonomous)

- Push to GitHub, deploy, hosting/DNS/account or billing changes: only on the user's go-ahead.
- New plans or significant plan changes: Fable 5.2 advisor review, then the user approves,
  before any ticket for them is dispatched.
- Subjective feel (handling, visuals, sound, game balance): stage the branch with screenshots
  or a short how-to-try; merge only after the user's verdict.
- Merge only when: the worker's evidence shows `npm run check` and `npm test` green on its
  branch head, AND the reviewer's verdict is `APPROVE` (docs-only or test-only changes need no
  reviewer), AND `npm run check && npm test` pass on main after the local merge.

## 0. Preflight (each wave)

```text
orca status --json
git -C ~/DEV/scrap-rally status --porcelain     # clean except team/ (committed before merges)
```

`team/STATE.md` and `team/DECISIONS.md` are orchestration docs: the orchestrator edits them in
the main checkout and commits them on main (`chore(team): ...`) before every merge.

## 1. Pick the wave

From the ClickUp list take `to do` tickets whose dependencies ("Depends on: <id>") are
complete. **At most 2 author workers at a time** (user decision 2026-11-14; reviewers do not
count). Never two workers on the same files; most features touch server/room.ts or
client/game.ts, so sequence those.

## 2. Start a worker

Write the spec to `tmp/spec-<slug>.md` (gitignored), then:

```text
orca orchestration worker-start --spec-file tmp/spec-<slug>.md --task-title "<ticket name>" \
  --worktree new-top-level --repo id:91004af0-a72a-49a5-90e9-b64ded81bd15 \
  --base-branch main --name <slug> --agent claude --json
```

Always pass `--base-branch` (local `main`, or a parked local branch): without it Orca uses the
repo's default base, which may be origin and miss local-only commits. The new workspace gets
its own branch; the worker commits on it.

In a later message than the start (never type an ID not yet seen in a tool result), record in
`team/STATE.md`: run ID, dispatch ID, ticket ID, workspace path, branch, assigned port. Flip
the ticket to `in progress`.

### Worker spec template (self-contained)

```text
You are a supervised Orca worker on Scrap Rally (browser multiplayer top-down racer,
TypeScript, Node 24 + ws, Vite, Canvas). ClickUp ticket <id>: "<name>".
TICKET (goal, acceptance criteria, out of scope): <full ticket body>
OWNERSHIP: you may edit only <files/areas>; do not touch <boundaries>.
READ FIRST: CLAUDE.md, then only <PLAN*.md sections / files>.

STEP 0: stay on the branch your workspace was created with (report `git branch
  --show-current`); <optional: git merge <ref>>; npm ci --ignore-scripts (install scripts are
  not approved in this project; nothing needs them).
STEP 1 (goal-loop, no confirmation popup — the acceptance criteria are pre-approved): turn each
  criterion into a binary checklist item with a verification method; iterate code -> test ->
  verify until every item is ticked WITH evidence (command output, file:line). Max 20
  iterations; at 2 failed attempts on one item build a diagnostic instead of guessing. For a
  real question use the preamble's `ask` command, never a local popup.
STEP 2 (ship): `npm run check` and `npm test` green. Commit in small commits (end messages with
  the Co-Authored-By line from your system prompt). DO NOT push, DO NOT merge into main, DO NOT
  deploy. Leave `git status --porcelain` empty.
STEP 3: worker_done with --outcome succeeded|failed, a 3-sentence summary, branch name, head
  SHA, per-criterion evidence, what you did NOT test, and --files-modified. Then stop.
RULES: never fabricate values; `npm run dev`/`npm start` only on PORT=<3001|3002> (3000 is the
  user's; `npm test` uses free ports itself); stop only processes you started, by PID, never
  pkill/killall by pattern (it kills the user's dev server); agent-browser sessions named after
  your slug; keep the game original.
```

## 3. Supervise

Start every worker of the wave, then end the turn: Orca wakes the orchestrator with each
message. Never poll or run watch scripts (a script's `check` would take the mail).

- **question** → answer from the ticket/plan/docs with `orchestration reply`; if only the user
  can decide, record it in `team/STATE.md` and ask the user.
- **worker_done** → verify against reality, not the summary: `git -C ~/DEV/scrap-rally log -1
  <branch>` matches the reported SHA, `git diff --stat main...<branch>` matches the reported
  files, and the workspace is clean (`git -C <workspace> status --porcelain`). Flip the ticket
  to `in review`.
- **escalation** → follow Orca's guide (steer with `send`, retry, or tell the user). Silence is
  never proof a worker died: `orca orchestration worker-list --run <run> --json`, act on its
  `nextAction`. On resume after a restart: `run-use` the run from STATE.md, then `worker-list`.

## 4. Review, merge, close

Reviewer (runs in the orchestrator's workspace; it only reads):
`worker-start --spec-file tmp/review-<slug>.md --worktree current --agent claude --json`, spec:
"Review branch <branch> against main (`git diff main...<branch>`) with /code-review for
correctness; stay inside the ticket's scope (the parking rule in your instructions). Do not edit
anything. Report in worker_done: first line `REVIEW VERDICT: APPROVE` or
`REVIEW VERDICT: REQUEST_CHANGES`, then findings with file:line."
REQUEST_CHANGES → `send` the findings to the author worker once; a second REQUEST_CHANGES goes
to the user.

Merge (gates above), in ~/DEV/scrap-rally on main, after committing team/ docs:
1. `git merge --no-ff <branch>`.
   - Conflict: `git merge --abort`, then `send` the author: "merge main into your branch,
     re-run check and test, report again".
2. `npm run check && npm test`.
   - Red: `git reset --hard ORIG_HEAD` (safe: nothing is pushed), then the same `send`.
3. Ticket → `ready for qa test` when it has something for the user to try, else `complete`,
   with a comment (branch, merge SHA, evidence). Update and commit `team/STATE.md`.

Any other in-flight branch is now behind main; its worker merges main before its own merge.

Cleanup per finished ticket: `orca orchestration worker-release --dispatch <id>` for the author
(and reviewer if still open), confirm `git -C <workspace> status --porcelain` is empty, then from
the main checkout run a script file containing
`orca worktree rm --worktree "path:<workspace>" --delete-branch --json`
(it deletes the branch only when Orca can prove it merged).

## 5. Next wave / stop

Recompute ready tickets and go to 1. Stop when nothing is ready or everything left waits on the
user. Report per ticket: outcome, merge SHA, evidence, what needs the user.
