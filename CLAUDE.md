# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Discord bot that answers one question live in a channel: **which Squad objective is next**. It keeps **two messages per guild**, edited in place: an embed with match state and controls, and a bare image attachment below it (Discord renders loose attachments much larger than images embedded in an embed).

Everything runs off public data. The server's current layer comes from the SquadCalc API (fed by BattleMetrics); the lane graph comes from the layer endpoint. **No public source carries capture state, tickets or player positions**, so members confirm objectives by hand through a dropdown and the solver eliminates the routes that cannot carry them.

The project is a derivative work of [SquadCalc](https://github.com/sh4rkman/SquadCalc) and inherits its **non-commercial** licence. `docs/NOTICE.md` lists exactly what is copied and what is ported; keep it in sync when touching `lane-solver.js`, `layer.js`, `render-map.js` or `locales/_terms_*.json`.

## The game, in the terms the code uses

Squad layers are `<Map>_<Gamemode>_<version>`, e.g. `Yehorivka_RAAS_v2`. Only the gamemode decides lane behaviour:

- **AAS** (Advance and Secure): fixed chain of control points, known before the match.
- **RAAS** (Random AAS): same rules, but the chain is drawn at match start from several possible layouts. This is the mode the bot exists for.
- **Invasion / RINV**: one team attacks along a randomised route, the other defends; captured points cannot be retaken. Asymmetric.
- **Skirmish, Seed**: small fixed chains.
- **TC** (Territory Control, hexes), **Destruction** (caches), **TDM**: no lane at all.

Vocabulary inside the code: a **route** (lane) is one ordered path of clusters from main to main; a **cluster** is one step on that route holding N candidate points; a **step**/depth is the 1-based position along the route, which is the number drawn inside the flag on the map. A **flag** is a *capture point*, not a cluster. Positions are called out by **keypad** (`K10`), a 300 m grid square.

## Commands

```bash
npm start                                         # run the bot (node src/bot.js)
node src/render-map.js <Layer_Name>               # render a layer to preview-<Layer>.jpg
node src/render-map.js Manicouagan_RAAS_v1 "Logistics Center"   # with a flag confirmed
node src/render-map.js Yehorivka_RAAS_v2 --team2 --team1=PLA    # perspective and factions
node tools/render-emojis.mjs                      # rebuild assets/*.svg into PNGs (needs Playwright, local only)
node experiments/ws-test.mjs <sessionId>          # probe a SquadCalc websocket session
```

`src/render-map.js` is the main development loop: it prints gamemode, live flag count, next step and timing, and needs no Discord token. Flags can be named by display name or by short key (`B1`).

On a Mac, `Volk.command` starts the bot under a supervisor with a local page (`tools/control/`) to watch the log and stop or restart it; closing the window stops the bot, which `npm start` in a terminal does not.

**There is no test suite and no linter.** Verification is running `render-map.js` against a real layer, or the bot against a real server.

Requires Node ≥20 with ESM (`"type": "module"`). `.env` needs only `DISCORD_TOKEN`; `SQUADCALC_API` overrides the API base and `SQUADCALC_STORE` moves the state file off an ephemeral disk.

## Architecture

Data flows one way, and each module has a single upstream concern:

```
src/servers.js      /api/get/servers          -> which server, what layer is live
src/layer.js        /api/get/layer            -> flags, projector, gamemode rules, lane state
src/lane-solver.js  layer payload             -> route enumeration and probabilities
src/render-map.js   basemap + SVG overlay     -> JPEG buffer
src/panel.js        panel state               -> embed + components
src/store.js        config.json               -> per-guild persisted state
src/permissions.js  roles                     -> admin / operator
src/bot.js          Discord client            -> orchestrates the above
src/commands.js     /volk slash command       -> admin config, writes the store
src/i18n.js         locales/                  -> translator(lng)
```

**Two API bases, on purpose.** `layer.js` exports `API_URL` and defaults to `beta.squadcalc.app/api`; `servers.js` re-exports it rather than picking its own. Pointing them at different builds made every modded server look unplayable, because production reports `mapName: null` for modded layers while the layer endpoint has full data. Beta is the `dev` branch and can break without notice.

**No browser in the live path.** Rendering is a cached basemap plus an SVG composite flattened by sharp, a few hundred ms once cached. This is what makes free hosting viable. `experiments/session.js` (Playwright, persistent headless SquadCalc session) belongs to the **superseded** architecture and is not reachable from `src/bot.js`.

### The solver (src/lane-solver.js, src/layer.js)

`lane-solver.js` is a **verbatim copy** of SquadCalc's `squadLaneSolver.js`. Do not reimplement or "improve" it: any divergence shows up as the bot disagreeing with beta.squadcalc.app about the same match. Port fixes from upstream instead.

It enumerates every route from main to main up front (capped at `MAX_ROUTES` 2000; largest seen is 260 on Manicouagan RAAS v2), then treats each confirmed flag as a constraint removing the routes that cannot carry it. Consequences that shape the rest of the code:

- **Every point carries odds**, not just the next one, and confirmations are **unordered**: a flag learned at depth 6 narrows the board as much as the first one.
- Points are addressed by `objectName`, never `objectDisplayName` — 16 of 42 layers reuse a display name for unrelated locations, and Discord rejects a select menu with duplicate values. One flag can own several ids.
- `laneState` in `layer.js` wraps the solver: it pins a confirmed flag to the next open depth only when that depth is one of its options, cascades forced steps (when only one point can fill the next depth it confirms it for the user), and computes `routeComplete` from a confirmation pinned to the deepest step — *not* from "nothing left to confirm", which once drew a line to the enemy main across objectives nobody walked.
- `needsPerspective` is RAAS/RVAAS only: those are symmetric so either main is a valid viewpoint. Invasion is asymmetric, so offering the choice would be wrong. `reversed` numbers depths from the far main.
- A flag is a capture point and nearby points merge (`areLatLngsClose`, 3 units on a 256-unit map). Drawing cluster centres instead averaged two distant objectives into one marker in empty terrain.

### Rendering constraints

- Everything composes at `OUTPUT_WIDTH` 1600. Source textures are 4096²; shrinking *before* compositing cuts ~4.5 s to a fraction.
- The overlay and the basemap need **two separate sharp pipelines**: within one pipeline sharp applies `resize` before `composite`, which shrinks the basemap and rejects the overlay.
- Basemaps are cached at `BASEMAP_CACHE_SIZE` 4 and `sharp.cache`/`concurrency` are pinned low. Unbounded, following a rotation took the process from 60 MB to 423 MB. Peak render is ~460 MB, which is what sizes the host (512 MB floor).
- Styling deliberately mirrors SquadCalc's `mapObjectives.scss` so the two read as one tool. The intentional departure is labelling every live objective and its odds, since a static image has no hover.
- Capture zones (`createCapZone`), the playable-area spline (`createSplineBorders`) and protection zones are ported with Leaflet objects replaced by SVG. Capzones are drawn only for objectives still in play; all of them would bury the map.
- Faction badges are converted to PNG because librsvg will not decode a WebP behind a data URI.

### Discord plumbing gotchas

- The map is re-uploaded with a **fresh filename every time** (`map-${Date.now()}.jpg`): Discord's CDN caches by URL, so reusing a name leaves the stale image on screen.
- `lastRenderKey` (`layer|perspective|picked|factions`) skips re-uploading several hundred KB when the image would be identical. Reset it to `null` whenever the image must come back.
- Renders are serialised **per guild** through `enqueue`. Two passes editing the same two messages interleave badly; guilds do not share a queue so a slow one cannot stall everyone.
- `adoptMessages` claims the bot's own messages on boot and deletes leftovers; `reconcileMessages` notices ones a member deleted mid-match. The text message is identified by *having* an embed and the map by *not* having one, because offline the map message carries plain text and no file.
- If the text message is gone, the map message is deleted too: a new text message would land under the surviving map and invert the panel.
- `syncLayer` only **stages** a layer change; `commitLayer` closes it once the publish landed. Without the two steps, a refresh that adopted a new layer and then failed left the old map on screen until the next rotation.
- Select menus cap at 25 options; `listServers` and the flag menu both slice to that. The flag menu lists only candidates for the next depth even though the solver accepts any order.
- Picks are validated through `canPick` before being trusted: interactions arrive late for options a layer change already invalidated.
- `panel.rendering` blocks clicks mid-pass for everyone, admins included, but is cleared after `STALLED_MS` so a dead render cannot lock the panel until a restart.
- The invite needs **both** `bot` and `applications.commands` scopes; with only the latter the install reports success and does nothing.

### Permissions and config

Two levels in `permissions.js`: **admin** (settings that outlive the match; defaults to Manage Server) and **operator** (driving the panel; open to everyone unless an admin names at least one operator role). Discord gates the slash command, but nothing gates the panel's buttons, so `canOperate` is the only check there.

State lives in `config.json` (or `SQUADCALC_STORE`), written atomically through a temp file. Always go through `guildConfig`/`saveGuild`/`readDiscovery`/`saveDiscovery`; never write the file directly. The store is split three ways on purpose: `discovery` is global ("which servers are in a match right now" has one answer), `defaults` is what a new guild starts from, `guilds` is per guild. A version 1 file (single-guild, top-level settings) migrates into `defaults`.

Server list is two sources merged: **pinned** ids (always shown, even offline or seeding) and **discovery** (in-match servers above a player threshold). Auto-refresh defaults to 60 s, clamped to `AUTO_MIN`/`AUTO_MAX` (30–3600), sized against upstream freshness of roughly 30 s for actively polled servers.

## i18n

Two layers per language in `locales/`:

- `_terms_<lng>.json` — domain labels (`teams`, `players`, `Faction`, `Layer`) copied from SquadCalc itself, so the panel uses the same word the member sees in the app.
- `<lng>.json` — the bot's own phrases, which override the imported terms.

Missing keys fall back to `en`, then to the key itself, so an incomplete language degrades instead of breaking. Keys live under the English namespace (`panel.*`, `warn.*`, `reason.*`, `select.*`, `button.*`). Add every new key to all seven languages (`de en fr pt ru uk zh`); a missing one falls back to English and then to the raw key, which is what users see if you forget. Admin replies in `src/commands.js` are hardcoded Portuguese and bypass i18n entirely.

## Docs and legacy files

`docs/` carries USAGE (reading and operating the panel), DEPLOY (measured footprint, Oracle Always Free notes), NOTICE (third-party attribution, keep current) and EXPERIMENTS. `docs/PRODUCT.md`, `BACKLOG.md` and `COMPANION.md` are gitignored local working notes; read `BACKLOG.md` before designing anything that touches layer detection.

Not reachable from `src/bot.js`: `experiments/` holds superseded approaches (a persistent Playwright SquadCalc session, a bare WebSocket session client), and `tools/` holds asset generation, the Mac control panel and a read-only PowerShell analysis of the Squad client log.
