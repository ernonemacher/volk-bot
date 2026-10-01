# Volk

**Live Squad objective intel in Discord.**

A bot that keeps a [Squad](https://joinsquad.com) map panel in a channel: the
layer a server is playing, which objectives are still possible, and how likely
each one is.

Built on [SquadCalc](https://github.com/sh4rkman/SquadCalc) and derived from its
code. See [NOTICE.md](docs/NOTICE.md) and [LICENSE](LICENSE): this project inherits
SquadCalc's **non-commercial** terms.

**[How to use Volk](docs/USAGE.md)** covers reading the panel, operating it and
setting it up. **[Deploying](docs/DEPLOY.md)** covers running it on a server.
What follows is about running it locally.

## What it does

Squad's RAAS, RVAAS, Invasion and RINV layers draw a random route from main to
main at match start. Nothing public reports which one was drawn, so the bot does
what a player does: as objectives are confirmed, it eliminates the routes that
cannot carry them.

- **Every point carries its odds**, not just the next one. A layer with five
  possible routes shows each objective's probability at each depth.
- **Confirmations are unordered.** Learning a flag at depth 6 is worth as much
  as learning the first one. On Manicouagan, confirming a single mid-match
  objective cuts five routes to one and resolves the rest of the match.
- **Forced steps resolve themselves.** When only one point can fill the next
  depth, the bot walks it, cascading.
- Linear modes (AAS, Seed, Skirmish) show their fixed chain; modes with no lane
  are drawn as they are.

The map is composed server-side with [sharp](https://sharp.pixelplumbing.com):
a cached basemap plus a hand-built SVG overlay. No browser is involved, which is
what keeps a render around half a second and the memory footprint small enough
for free hosting.

## Running it

```bash
npm install
cp .env.example .env     # add your bot token
npm start
```

On a Mac, double-click **`Volk.command`** instead: it starts the bot under a
supervisor and opens a local page to watch the log, see which channel each guild
publishes to, and stop or restart it. The same page reads the usage database, so
it also shows the failures of the last week, who has been clicking, how long a
render takes and which layer each guild is looking at — all of which survive a
restart, unlike the log. Closing its window stops the bot, which is the
difference between it and `npm start` in a terminal that later gets closed:
that leaves an orphan holding the gateway with its logs going nowhere.

Invite the bot with **both** the `bot` and `applications.commands` scopes
(`permissions=2251799813811200`). With only `applications.commands` the install reports
success and does nothing. Then, in each server:

```
/volk setup            # bind the channel the panel lives in
```

The panel channel needs View Channel, Send Messages, Embed Links, Attach Files,
Read Message History and Manage Messages. Setup refuses a channel missing any of
them rather than saving one it cannot publish to.

The panel publishes two messages and edits them in place: the text panel with
the controls, and the map image on its own below.

## Commands

`/volk setup`, `config`, `roles`, `auto`, `language`, `pin`, `unpin`,
`discovery`, `search`, `republish`, `stats`, `logchannel`, `forget`. All usable
from any channel, so configuring does not clutter the panel.
[What each one does](docs/USAGE.md#setting-it-up).

Access has two levels: `admin` covers settings that outlive the match and
defaults to Manage Server, `operator` covers driving the panel and defaults to
anyone in the channel. [Why](docs/USAGE.md#permissions).

## Configuration

Environment (see `.env.example`): `DISCORD_TOKEN` is the only required value.
`VOLK_DB` points persisted state and usage events somewhere other than
`./volk_db`, which matters on a host with an ephemeral disk. `SQUADCALC_API`
picks the SquadCalc backend, defaulting to the beta build because it carries the
modded layers.

Everything else is per guild and lives in the store: panel channel, watched
server, pinned servers, language, refresh interval and roles. Discovery settings
are global, since "which servers are in a match right now" has one answer.

State is a SQLite file. An existing `config.json` from an older build is
imported on first boot and renamed to `.migrated`, kept as a backup;
`SQUADCALC_STORE` still says where to look for it.

## What it records

The bot keeps a local usage log in `volk_db` (SQLite, moved with `VOLK_DB`): one
row per panel click, render, slash command and failure, carrying the **Discord
user id** of whoever acted, the guild, the watched server and the layer. It is
what `/volk stats` reads, and it never leaves the machine.

Rows are deleted after 90 days (`TELEMETRY_RETENTION_DAYS`), and
`/volk forget @member` erases one member's rows on request. Nothing is recorded
about members who never touch the panel, and no message content is ever stored.

`/volk logchannel` additionally forwards failures to a channel of your choosing.
It is off until you set it.

## Layout

| File | Role |
|---|---|
| `src/bot.js` | Discord client, one panel per guild, render queue, auto refresh |
| `src/panel.js` | Panel state and the embed and components it publishes |
| `src/layer.js` | Layer data, flag construction, lane state |
| `src/lane-solver.js` | Route enumeration and probabilities (copied from SquadCalc) |
| `src/render-map.js` | SVG-over-basemap composition |
| `src/store.js` | Persisted per-guild state |
| `src/permissions.js` | The two access levels |
| `src/commands.js` | Slash commands |
| `src/i18n.js`, `locales/` | Seven languages, with domain terms shared with SquadCalc |
| `docs/` | Usage, deployment, third-party notices and working notes |
| `tools/` | Asset generation and a Windows log diagnostic |
| `experiments/` | Abandoned approaches, kept for the record |

Render a map without Discord:

```bash
node src/render-map.js Manicouagan_RAAS_v1
node src/render-map.js Manicouagan_RAAS_v1 "Logistics Center" --team1=PLA --team2=USA
node src/render-map.js Yehorivka_RAAS_v2 --team2
```

## Limits

Public data carries the layer, the next layer, factions, player counts and
playtime. It does **not** carry ticket counts, captured objectives or player
positions, and no public source does: SquadStats and MySquadStats are SquadJS
plugins a server admin installs. That is why objectives are confirmed by hand.

Upstream freshness varies by server, measured at roughly 30 seconds for actively
polled ones and much worse for quiet ones, which is what the default 60 second
refresh is sized against.
