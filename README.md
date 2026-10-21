# cfocus

English | [中文](README.zh.md)

Switch between Claude Desktop subscription accounts on one Mac, and copy Code session indexes between them.

Claude Desktop reads `~/Library/Application Support/Claude`. Each account keeps its own login. Caches and the session directory are shared with symlinks, so each extra account does not duplicate about 1GB of runtime data. Transcripts live in `~/.claude/projects` and are shared. The commands leave them there.

macOS only. Requires Node.js `>= 22.18`.

## Language

Messages follow the system language. If `LC_ALL`, `LC_MESSAGES`, or `LANG` starts with `zh`, the interface is Chinese. Otherwise it is English.

```bash
cfocus --lang en account list
CFOCUS_LANG=zh cfocus account list
```

`CFOCUS_LANG=en` or `CFOCUS_LANG=zh` overrides the system language. Plan names stay Free, Pro, Max, Max 5x, Max 20x, Team, Enterprise, API, and API Team in both languages.

## Install

```bash
cd claude-focus
npm install
npm link
```

The executable name is `cfocus`. From the repository you can also run `node src/cli.ts`.

## Switch Desktop accounts

Log in with Claude Desktop, then record that account:

```bash
cfocus account init --yes
```

This quits Desktop, copies the current data directory to `~/Library/Application Support/cfocus/backup/initial`, turns caches and the session directory into shared links, reads the current account email, and opens Desktop again on the same account. The backup is about 1GB, and the command stays quiet while it copies. It is finished when it prints the current account.

Add the next account:

```bash
cfocus account add --yes
```

Desktop opens a blank login. After you sign in, the command reads the account UUID and email from the local config. If no new account appears within 10 minutes:

```bash
cfocus account adopt          # login already finished; save this account
cfocus account cancel --yes   # drop this login and restore the previous account
```

Switch later:

```bash
cfocus account list
cfocus switch --to <email> --yes
```

Switching swaps in the destination account's data directory. If Desktop is open, it quits and opens again afterward. If Desktop is already closed, it stays closed. If Desktop does not quit, no files are moved.

A switch can also copy session indexes. Child sessions recorded on that index are copied with it, including children of those children. An existing file at the destination is left in place. Add `--overwrite` to replace the selected indexes and their related child sessions.

```bash
cfocus switch --to <email> --session <session id> --yes
```

`--session` can be repeated. A session id is a bare UUID or the same id with a `local_` prefix. When an account has more than one organization that contains sessions, pass `--source-org` and `--dest-org`.

Quitting, backing up, adding, and switching require `--yes` when there is no terminal prompt.

## Accounts and usage

```bash
cfocus account list
cfocus account list --usage
cfocus account usage
cfocus account usage <email>
```

`account list` prints a table: status, email, plan, and login expiry. `--usage` adds the 5-hour usage, time left in that window, the 7-day usage, time left in the week, and Sonnet. In a terminal, the current account is green, its email is cyan, and the login expiry and time left are blue. The other account's status is dimmed. `NO_COLOR` keeps the alignment and drops the color.

`cfocus account list --usage` looks like this:

```text
Desktop accounts  2

Status   Email              Plan  Login expires     5 hours  5h left       7 days  Week left    Sonnet
──────────────────────────────────────────────────────────────────────────────────────────────────────
Current  ada@example.com    Pro   2026-11-16 09:50  8%       2 hours left  13%     1 day left   —
         11111111-1111-4111-8111-111111111111   org aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa
Other    blake@example.com  Pro   2026-11-16 16:10  0%       30 min left   100%    5 days left  —
         22222222-2222-4222-8222-222222222222   org bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

A percentage is the share already used. Time left uses the largest unit: days, then hours, then minutes, for example `1 day left`, `2 hours left`, or `30 min left`. A window that has already reset shows `reset`. Sonnet and a missing time show —. The second line is the account UUID and the organization UUID.

The plan is the subscription on claude.ai, stored as `plan` in `state.json`. The labels are:

| Plan | Meaning |
| --- | --- |
| Free | Free |
| Pro | Pro |
| Max | Max, without a 5x or 20x tier |
| Max 5x | Max with 5x usage |
| Max 20x | Max with 20x usage |
| Team | Team |
| Enterprise | Enterprise |
| API | Individual API |
| API Team | Team API |

There is no Plus plan for individual subscriptions. The column shows — until a plan has been read. Pro is cyan, Max / Max 5x / Max 20x are magenta, Team and Enterprise are yellow, and Free is dimmed.

`account init` and `account add` store the plan when they read the email. An account that was saved before `plan` existed is looked up once on the next `account list`: the command reads the keychain, asks claude.ai, and remembers the id. Later `account list` runs use that saved plan and do not call the network. After a plan change, `cfocus account list --usage` or `cfocus account usage` refreshes the stored plan while it queries quota.

`--usage` and `account usage` query claude.ai at the time you run them, including saved accounts that are not the one currently open in Desktop. A percentage is how much of that window is already used. Under 70% is green, 70–89% is yellow, and 90% or more is red.

The query reads the keychain item "Claude Safe Storage". macOS asks for permission the first time. The decrypted password and cookies stay in memory. They are not written to disk and they are not printed. Quota numbers are not saved. The plan is saved. When a login is no longer valid, that row shows the error instead of an old quota number. A plan that was already remembered stays in the table until a successful query replaces it.

A parked login does not renew itself. After the session key expires or is revoked, sign in to that account in Desktop again, then run `cfocus account add`, or `cfocus account adopt` for the account that is open now.

## Copy session indexes

You can copy sidebar indexes without switching the login:

```bash
cfocus                              # pick accounts and sessions interactively
cfocus init                         # build the email map from local session directories
cfocus accounts
cfocus list [email] [--limit <n>]
cfocus sync --from <email> --to <email> --session <id> [--dry-run] [--overwrite]
```

The copied file is:

```text
~/Library/Application Support/Claude/claude-code-sessions/<account UUID>/<organization UUID>/local_*.json
```

The organization is the only directory that contains `local_*.json`. A destination file with the same name is skipped. `sync` refuses to write while Claude Desktop is running. A copied session brings its child sessions along. `--overwrite` replaces those child indexes too.

`cfocus list` prints the newest sessions for every account that has an email. Pass an email to list one account. Each organization shows 20 sessions unless you pass `--limit`. `--limit` takes a positive integer.

```bash
cfocus list
cfocus list ada@example.com --limit 50
```

Times are Shanghai time, newest first. In a terminal the active time is cyan and its status is green. An archived row is dim, with a yellow status. The project name is blue. The session id is on the next line. `NO_COLOR` keeps the alignment and drops the color.

`cfocus list --limit 2` looks like this when 86 sessions exist:

```text
ada@example.com  2 of 86
11111111-1111-4111-8111-111111111111   org aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa

Time              Status    Project  Title
─────────────────────────────────────────────────────────────────────────────────────
2026-10-18 21:11  Active    ujoy     failed import rows
                                     local_81d31fdc-abfe-4a8f-b60c-f938da388636
2026-10-16 15:26  Archived  ujoy     archived session
                                     local_11111111-1111-4111-8111-111111111111
```

The heading is `2 of 86` when the list is shorter than the full set. A complete list shows only the number of sessions.

`cfocus init` writes the email map used by session lists. `cfocus account init` saves the Desktop login.

The email map is `~/.config/claude-focus/accounts.json`. Account switching does not need this file. After an email is recognized, it is filled into the map so `cfocus list` can use it.

## Where data lives

| Path | Contents |
| --- | --- |
| `~/Library/Application Support/Claude` | Desktop data for the account that is logged in |
| `~/Library/Application Support/cfocus/backup/initial` | Full copy taken once, before the first `account init` |
| `~/Library/Application Support/cfocus/shared` | Shared caches, runtime data, and session directory |
| `~/Library/Application Support/cfocus/profiles/<account UUID>` | Data for accounts that are not logged in |
| `~/Library/Application Support/cfocus/state.json` | Email, organization, current account, and plan. Mode `0600`. No cookies or tokens |
| `~/.config/claude-focus/accounts.json` | Email and account UUID for session lists |
| `~/.claude/projects` | Transcripts, shared by every account |

Shared directories are `claude-code`, `claude-code-sessions`, `Cache`, `Code Cache`, the GPU caches, `Crashpad`, and `VideoDecodeStats`. Cookies, `config.json`, and the rest of the login and UI state stay with each account. If one of those names is already a real directory in both the account directory and the shared directory, the command stops and leaves both copies in place.

## Development

```bash
npm test
npm run check
```

`npm test` uses the Node.js test runner. It does not touch the Claude data directory on this machine. Tests pin `CFOCUS_LANG=zh`.
