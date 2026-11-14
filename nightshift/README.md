# The night shift

Every night from 02:00 to 06:00, an autonomous loop on Erik's Mac keeps the lab's projects healthy, builds the next thing from the [idea queue](https://github.com/MuteMuty/lab/issues), and leaves a morning report in a T3 thread. Design: [`docs/superpowers/specs/2026-11-11-night-shift-design.md`](../docs/superpowers/specs/2026-11-11-night-shift-design.md).

## How a night works
1. **Wake:** T3 starts the scheduled task in the "BrightLoop Lab" project and the **director** follows [`DIRECTOR.md`](DIRECTOR.md).
2. **Pre-flight and maintenance:** `bin/preflight.mjs` decides the kind of night and reads the lab's like counts (`/api/likes`; `null` if that fails). `log.mjs start` records them in the night log, so the next run can tell what changed. Likes decide which project's polish goes first and which project the scout visits most ([`DIRECTOR.md`](DIRECTOR.md), lab#19). `bin/maintain.mjs` does cheap chores, such as keeping Afterstep's puzzles 21 days ahead.
3. **Suggestions:** visitor ideas from lab.brightloopapps.com are screened by a model with no tools (`bin/screen.mjs`), and good ones become issues.
4. **Scouting:** when the queue runs low, a **scout** explores a live project and the director files what it finds as `polish` issues ([brief](briefs/scout.md)), so a big dial never sits idle.
5. **Building:** for each task, a **builder** opens a PR ([brief](briefs/builder.md)), and an independent **playtester** checks it ([brief](briefs/playtester.md)). Only a PASS is merged and deployed (`bin/deploy.mjs`), and a failing live check rolls back automatically.
6. **Report:** the director posts the morning report and commits the night log to [`logs/`](logs/).

## Controls for Erik
| Want to… | Do this |
|---|---|
| Use less of the Claude plan for a while | `~/brightloop-lab/dial low --until monday` (levels: off, low, normal, high, max) |
| Use as much of the plan as the night allows | `~/brightloop-lab/dial max`: keeps building until 05:15, two tasks at once, Opus builders |
| See the current setting | `~/brightloop-lab/dial` |
| Give it a day you won't use the agents | Today: `~/brightloop-lab/dayshift` (works until 23:00), or `--until 18:00` / `--hours 5` / `--from 13:00`. Tomorrow, planned tonight: `dayshift --tomorrow` (06:30–23:00). Add `--rehearsal` for a dry run. Check with `dayshift status`; cancel with `dayshift stop` |
| Stop everything immediately | `touch ~/brightloop-lab/STOP` (delete the file to resume) |
| Pause the schedule | ask Claude in T3 to pause the "Night shift" scheduled task |
| See what was blocked | `cat ~/brightloop-lab/nightshift-blocked.jsonl` |

## Schedule
- **Day shifts:** T3 scheduled task **"Day shift"** (`scheduled-task:91eaf305-2a97-4ba5-b769-6480d483ffdf`), triggered only by its webhook. `bin/dayshift.mjs` writes the window to `~/brightloop-lab/dayshift.json`, keeps the Mac awake with `caffeinate` for the window, and calls the webhook, whose URL lives in `~/brightloop-lab/.secrets/dayshift-webhook`. Day shifts run 06:30–23:30 at most, so they never overlap the night. A long shift is split into blocks of about 5 hours (`dayShiftBlockHours`), each a fresh director run with its own report. A small background process started by the command starts each later block on time, but only once the previous run has marked its log finished. It notes what it did in `~/brightloop-lab/dayshift-firer.log`.
- **The task:** T3 scheduled task **"Night shift"** (`scheduled-task:c916a50d-b03d-4f86-88c5-653b5f55c052`) in the T3 project **BrightLoop Lab**, daily at 02:00 local time. Each run opens a new thread with the morning report.
- **The T3 project:** it is rooted at `~/brightloop-lab/lab`, because scheduled runs need a git checkout. The director works on `~/brightloop-lab/...` by full paths.
- **Keeping the Mac awake:** `pmset repeat wakeorpoweron 01:55` plus the LaunchAgent in [`launchd/`](launchd/) (caffeinate 01:56 → ~06:16). The lid must stay open and the Mac on power.
- **History:** first rehearsal and first supervised real run on 2026-11-11 (see `logs/2026-11-11.md`).

## Safety
[`SAFETY.md`](SAFETY.md) holds the rules. `bin/guard.mjs` enforces them as a Claude Code hook on every command. A scoped Cloudflare key means other domains can't be reached at all.

## Tests
`node --test nightshift/test/` (dial, pre-flight and likes, log, guard, deploy, maintenance, screener). The tests never reach the network.
