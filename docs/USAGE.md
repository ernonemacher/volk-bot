# Using Volk

Volk answers one question, live in a Discord channel: **which objective is next**.

Squad's RAAS, RVAAS, Invasion and RINV layers draw a random route from main to
main at match start. Nothing public reports which one was drawn, so Volk starts
with every possible route and removes the ones ruled out as objectives are
confirmed. Confirming is the only manual part, and it is manual because no
public source carries capture state. See [Limits](#limits).

---

## Reading the panel

The panel is two messages, edited in place: the text with the controls on top,
the map on its own below.

### The text

| Field | Means |
|---|---|
| Title | The server, and the layer it is playing right now |
| Teams | The two factions |
| Players | Current and maximum |
| Match time | Minutes since the round started |
| Next layer | What the server rotates to next, when it reports one |
| Routes left | How many of the layer's possible routes survive the confirmations so far |
| Lane | The objectives confirmed, in order |
| Objective N | The candidates for the next objective, with their odds |

### The map

**Objective circles.** The number inside is how many objectives deep that point
sits, counting from the main you are playing from. The colour follows the same
number, which is what makes a lane readable at a glance.

| Look | Means |
|---|---|
| Solid green | Confirmed. This objective is on the route. |
| Solid red | A candidate for the **next** objective |
| Coloured ring, faint centre | Still possible, further along. Green is 2, blue 3, yellow 4, cyan 5, pink 6, orange 7. |
| Gone from the map | Ruled out by a confirmation |

A point the randomiser can place at more than one depth shows all of them
joined by a dot, such as `2·3`.

**The percentage under a circle** is the chance that point is the objective at
that depth. Every candidate route counts equally, and points sharing a route
split its share. The percentages at one depth add up to 100%.

**The white line** is the chain through the confirmed objectives, starting at
your main. Only objectives adjacent in the chain are joined: confirming
objective 1 and objective 4 draws two separate legs, never one line across the
map, because the route between them has not been confirmed. The enemy main
joins the chain only once the deepest objective is confirmed.

**Around each main:** a red dashed circle is the protection zone, and the wider
orange dashed circle is where deployables are locked out.

**The darkened border** is outside the playable area. Thin white outlines on the
objectives are their capture zones. Grid squares are 300 m keypads, lettered and
numbered in the frame.

---

## Operating the panel

Anyone in the channel can drive it, unless an admin restricted it to a role.

**Server.** Which Squad server the panel watches. Pinned servers are marked with
a star and stay listed even while offline; the rest are servers currently in a
match.

**Team.** Appears only for RAAS and RVAAS, and only before the first
confirmation. Those modes are symmetric, so the numbering depends on which main
you count from. Invasion does not ask: the attacker is fixed, so there is
nothing to choose. Options carry the faction and the unit it is running.

**Objective N.** The candidates for the next objective, most likely first, with
their keypad and odds. Confirming one narrows the board. When only one candidate
remains for a depth, Volk confirms it for you and carries on, so a route with no
branch resolves in one step.

**Refresh now** forces a pass instead of waiting for the cycle. Clicks made
while a refresh is running are refused with a short notice rather than queued:
two passes editing the same two messages would tear the panel.

**Undo** drops the last confirmation. **Reset** clears them all. Both reappear
only once something has been confirmed. Confirmations also reset on their own
when the server changes layer, because a new match means a new route.

---

## Setting it up

Invite the bot with **both** the `bot` and `applications.commands` scopes:

```
https://discord.com/oauth2/authorize?client_id=<application id>&permissions=2251799813811200&scope=bot+applications.commands
```

Without the `bot` scope the authorisation still reports success, but no bot
joins the server and no commands appear. Then, in each server:

```
/volk setup                     # uses the current channel
/volk setup channel:#some-channel
```

The panel channel needs View Channel, Send Messages, Embed Links, Attach Files,
Read Message History and Manage Messages. Setup refuses a channel missing any of
them and names what is missing, rather than saving a channel it cannot publish
to. Moving the panel to another channel clears the old one.

Every setting below is per server, so two communities running the same bot do
not share anything except which servers are currently in a match.

| Command | What it does |
|---|---|
| `/volk config` | Everything currently configured, plus the servers in the menu right now |
| `/volk roles` | Which roles configure the bot, and which operate the panel |
| `/volk auto` | Automatic refresh on or off, and the interval (30 to 3600s) |
| `/volk language` | Panel language: de, en, fr, pt, ru, uk, zh |
| `/volk pin` / `unpin` | Pin a server so it stays in the menu even while offline |
| `/volk discovery` | Include servers currently in a match, with a minimum player count |
| `/volk search` | Find a server id by name |
| `/volk republish` | Post the panel again, for when it was deleted or got stuck |
| `/volk guide` | Post the Portuguese usage guide from `docs/guia/` in a channel other than the panel's, pin its index (when the bot has Pin Messages there), and replace the previous copy |

Commands work from any channel, so configuring does not clutter the panel.

### Permissions

Two levels, because they answer different questions:

| Level | Covers | Default |
|---|---|---|
| `admin` | Settings that outlive the match | Anyone with **Manage Server** |
| `operator` | Driving the panel | **Anyone in the channel** |

Operating is open on purpose: a squad calling objectives mid-match should not
wait on someone with Manage Server. The restriction only exists once an admin
names at least one operator role:

```
/volk roles action:allow level:operator role:@Squad Leader
/volk roles action:allow level:admin    role:@Staff
/volk roles action:list
```

Manage Server always counts as admin, so a fresh install works before anything
is configured, and admins can always operate.

---

## When something looks wrong

**The panel stopped updating.** Volk only refreshes while its process is
running. If it is hosted on someone's machine, check that machine first.

**The panel says the server is offline or seeding.** The map pauses because
there is no drawable match, but the controls stay, so you can switch servers
from the panel itself.

**The panel is stuck or was deleted.** A deleted message comes back on the next
pass. If it does not, `/volk republish` deletes and posts a fresh pair.

**A click did nothing.** A refresh was in flight and the click was refused. Try
again once the panel has updated.

**Two objectives share a name.** Some layers reuse a display name for unrelated
locations. The keypad in the menu tells them apart.

---

## Limits

Public data carries the layer, the next layer, factions, player counts and
playtime. It does **not** carry tickets, captured objectives or player
positions, and no public source does: SquadStats and MySquadStats are SquadJS
plugins a server admin installs on their own server. That is why objectives are
confirmed by hand.

How fresh the data is depends on how often the upstream polls a given server:
around 30 seconds for busy ones, and much worse for quiet ones. The default
60 second refresh is sized against the good case.
