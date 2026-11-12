# BrightLoop Lab

Small, original things to click, play and poke at. Made by [Erik Pahor](https://github.com/MuteMuty).

**Live:** [lab.brightloopapps.com](https://lab.brightloopapps.com)

## How it works

The lab builds itself. Every night from 02:00 to 06:00, the [night shift](nightshift/) runs on my Mac:

1. **A director agent** checks that every live site is healthy, does the chores, and picks the next tasks from [the queue](#the-queue).
2. **A builder agent** implements each task and opens a pull request with tests.
3. **An independent playtester agent** checks the PR in a real browser, on phone and desktop, in light and dark. A failure goes back to the builder.
4. **Only a pass ships.** The PR is merged and deployed, a live smoke test runs, and a failed check rolls back automatically.
5. **Scout agents** explore the live sites and file what they find, so there's always good work queued.

[A command guard](nightshift/bin/guard.mjs) checks every shell command against [the safety rules](nightshift/SAFETY.md). Every night leaves [a log](nightshift/logs/) and a morning report. On days I don't need the agents, the same loop runs as a day shift.

## Projects

| Project | What it is | Live |
|---|---|---|
| [Afterstep](https://github.com/MuteMuty/afterstep) | A daily puzzle where your past self holds the doors. Rust + WebAssembly. | [play](https://afterstep.brightloopapps.com) |

## The queue

Every idea, mine or a visitor's, is a GitHub Issue here:

- [`idea`](../../issues?q=is%3Aopen+label%3Aidea): planned projects and features
- [`suggestion`](../../issues?q=label%3Asuggestion): ideas sent by visitors, screened before they're accepted
- [`polish`](../../issues?q=is%3Aopen+label%3Apolish): improvements the scouts and playtesters found
- [`parked`](../../issues?q=label%3Aparked): good ideas waiting for the right moment

## House rules

- Everything runs in the visitor's browser where possible. Nothing visitors make is stored on our servers unless a project truly needs it.
- Performance first: Rust/WASM where it pays off, small fast front-ends everywhere else.
- Every change is committed, so anything can be rolled back.
