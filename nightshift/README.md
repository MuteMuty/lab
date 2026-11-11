# The night shift

Every night from 02:00 to 06:00, an autonomous loop on Erik's Mac keeps the lab's projects healthy, builds the next thing from the [idea queue](https://github.com/MuteMuty/lab/issues), and leaves a morning report in a T3 thread. Design: [`docs/superpowers/specs/2026-11-11-night-shift-design.md`](../docs/superpowers/specs/2026-11-11-night-shift-design.md).

## How a night works
1. **Wake:** T3 starts the scheduled task in the "BrightLoop Lab" project and the **director** follows [`DIRECTOR.md`](DIRECTOR.md).
2. **Pre-flight and maintenance:** `bin/preflight.mjs` decides the kind of night. `bin/maintain.mjs` does cheap chores, such as keeping Afterstep's puzzles 21 days ahead.
3. **Suggestions:** visitor ideas from lab.brightloopapps.com are screened by a model with no tools (`bin/screen.mjs`), and good ones become issues.
4. **Building:** for each task, a **builder** opens a PR ([brief](briefs/builder.md)), and an independent **playtester** checks it ([brief](briefs/playtester.md)). Only a PASS is merged and deployed (`bin/deploy.mjs`), and a failing live check rolls back automatically.
5. **Report:** the director posts the morning report and commits the night log to [`logs/`](logs/).

## Controls for Erik
| Want to… | Do this |
|---|---|
| Use less of the Claude plan for a while | `~/brightloop-lab/dial low --until monday` (levels: off, low, normal, high) |
| See the current setting | `~/brightloop-lab/dial` |
| Stop everything immediately | `touch ~/brightloop-lab/STOP` (delete the file to resume) |
| Pause the schedule | ask Claude in T3 to pause the "Night shift" scheduled task |
| See what was blocked | `cat ~/brightloop-lab/nightshift-blocked.jsonl` |

## Safety
[`SAFETY.md`](SAFETY.md) holds the rules. `bin/guard.mjs` enforces them as a Claude Code hook on every command. A scoped Cloudflare key means other domains can't be reached at all.

## Tests
`node --test nightshift/test/` (dial, pre-flight, log, guard, deploy, maintenance, screener).
