# Deploying Volk

Volk is a gateway bot: it holds a WebSocket to Discord open and must run
continuously. That rules out serverless platforms entirely, whatever their
limits. What it needs is a small always-on Linux machine.

## What it actually costs

Measured, not estimated:

| | |
|---|---|
| Idle | ~84 MB resident, 0% CPU |
| CPU per 60s cycle | ~0.11 s |
| Peak while rendering | ~460 MB |
| Inbound ports | **none** |
| Disk | the repo, plus one JSON state file |

The peak is what sizes the host. A 256 MB instance will be killed; 512 MB is the
floor and 1 GB is comfortable. Nothing else about the workload is demanding.

Most of the traffic is with two places: Discord, which is behind Cloudflare and
therefore fast from anywhere, and the SquadCalc API, which is a single origin in
France with no CDN. The slow path is fetching a basemap, about 3.7 MB, and that
is cached in memory per map, so it happens on a map change rather than every
cycle.

## Oracle Cloud Always Free

The only genuinely free option without a cap. Two things to know before you
start, because neither is reversible:

- **Compute instances can only be created in your tenancy's home region**, and
  the home region is chosen at sign-up and cannot be changed afterwards.
- Free shapes run out. Oracle documents an `out of host capacity` error, and the
  remedy is another availability domain **in the same region**. Picking a heavily
  contended region is a bet you cannot unwind.

Pick a shape:

- `VM.Standard.A1.Flex` (ARM): 2 OCPU and 12 GB across the tenancy. Ample.
- `VM.Standard.E2.1.Micro` (AMD), up to two: 1 GB each. Tight against the 460 MB
  peak but workable, and `MALLOC_ARENA_MAX=2` below is what makes it so.

Use Ubuntu 24.04. `sharp` and `better-sqlite3` both ship prebuilt binaries for
`linux-arm64` and `linux-x64`, so nothing is compiled on the machine.

`better-sqlite3` is pinned to the `12.x` line on purpose: `13.x` requires Node
22, and this project supports Node 20. If `npm ci` starts compiling instead of
downloading, the prebuilt for your Node ABI is missing and a newer Node is the
fix, not `build-essential`.

**Do not open any inbound ports.** The bot connects out and listens on nothing.

## Setting it up

Node from the distribution is usually too old; the bot needs 20 or newer.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
```

A service account that owns nothing else:

```bash
sudo useradd --system --home /opt/volk --shell /usr/sbin/nologin volk
sudo git clone https://github.com/ernonemacher/volk.git /opt/volk
cd /opt/volk
sudo npm ci --omit=dev
sudo chown -R volk:volk /opt/volk
```

The install runs as root and ownership is handed over afterwards, because the
service account has no shell to run npm with.

`--omit=dev` matters: it skips Playwright, which only the asset tooling uses and
which would pull a browser onto the machine for nothing.

The token goes outside the repo, readable only by root and the service:

```bash
sudo install -m 0640 -o root -g volk /dev/null /etc/volk.env
sudo tee /etc/volk.env >/dev/null <<'EOF'
DISCORD_TOKEN=your-token-here
EOF
```

Then the service:

```bash
sudo cp /opt/volk/deploy/volk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now volk
```

## Checking it

```bash
systemctl status volk
journalctl -u volk -f
```

A healthy start logs the account, then one line per guild:

```
[BOT] connected as Volk#8385
[BOT] commands registered in <guild>
[BOT] guild <id>: panel on #<channel>
```

`Not in any guild` means the invite used the wrong scopes; see
[USAGE](USAGE.md#setting-it-up).

## Updating

```bash
cd /opt/volk
sudo git pull
sudo npm ci --omit=dev
sudo chown -R volk:volk /opt/volk
sudo systemctl restart volk
```

The panel is adopted rather than reposted on start, so a restart edits the
messages already in the channel instead of stacking new ones.

## State

Everything the bot remembers lives in one JSON file at
`/var/lib/volk/config.json`: which channel each guild publishes to, the watched
server, pinned servers, language, refresh interval and roles. systemd creates
that directory and keeps it writable while the rest of the filesystem is read
only to the service.

Beside it sits `volk_db`, the SQLite file holding usage and error events, which
is what `/volk stats` reads. It grows with activity rather than with time: a
busy guild writes on the order of a few thousand rows a day, a few megabytes a
year, and a daily sweep drops anything past `TELEMETRY_RETENTION_DAYS`
(default 90).

Both live in the same directory, so one copy takes both:

```bash
sudo cp -a /var/lib/volk ~/volk-backup
```

The database holds Discord user ids, so treat that backup as personal data:
keep it off shared storage, and see [What it records](../README.md#what-it-records).

On a host with an ephemeral disk, point `SQUADCALC_STORE` **and** `VOLK_DB` at a
mounted volume instead, or the bot forgets every guild on each deploy.
