# LiveVODs

A TV guide for Twitch and YouTube.

Rows are **subjects**, not creators — "Retro Gaming", "Food & Drink" — and each one is
*programmed* like a cable channel rather than merely listing what happened. Anything live or
scheduled is an appointment at its real time; everything already published is a library that
fills the gaps around it, so a row is never blank. Clicking a row tunes in to whatever is on,
resumed at the point it has reached.

No login. No accounts. It reads public data with app-level API credentials and shows it.

---

## Quick start

```bash
npm install
cp .env.example .env             # then fill in your API credentials — see below
cp config/channels.example.yml config/channels.yml
$EDITOR config/channels.yml      # define your subjects

npm run channels:sync            # resolve channels, create the rows
npm run worker                   # ingest — leave this running
npm run build && npm start       # web UI on http://localhost:3000
```

Want to see the interface before setting up credentials?

```bash
npm run db:migrate && npx tsx scripts/seed-demo.ts && npm run dev
```

That fills the database with fixtures and needs no API keys at all.

---

## Getting API credentials

Both are free. Neither involves a user logging in — LiveVODs only ever reads public data.

### Twitch

1. Go to the [Twitch developer console](https://dev.twitch.tv/console/apps) and register an
   application. Any name; OAuth redirect URL `http://localhost` is fine, since it is never used.
2. Category: *Application Integration*.
3. Copy the **Client ID**, then **New Secret** and copy that.
4. Put both in `.env` as `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`.

### YouTube

1. Create a project at the [Google Cloud console](https://console.cloud.google.com).
2. Enable **YouTube Data API v3** under *APIs & Services → Library*.
3. *Credentials → Create credentials → API key*.
4. Put it in `.env` as `YOUTUBE_API_KEY`.

Either platform can be omitted. With only `TWITCH_*` set, YouTube channels are skipped and vice
versa; the guide runs on whatever it has.

---

## Defining the lineup

`config/channels.yml` is the one file you edit to change what the guide shows. It is
**gitignored** — it is personal configuration, like `.env`. `config/channels.example.yml` is the
committed template.

```yaml
subjects:
  - name: Speedrunning
    twitch:
      - GamesDoneQuick        # login, as in twitch.tv/<login>
      - SimpleFlips
    youtube:
      - "@SimpleFlips"        # handle, as in youtube.com/@<handle>

  - name: Coffee
    youtube:
      - "@jameshoffmann"
```

- Each subject is **one row**, in the order written here.
- Both platform lists are optional.
- A channel may appear in **several subjects**; its programmes show on every row it belongs to.
- Names are resolved once to stable platform ids, so a channel that later renames keeps its
  history.

### After editing

```bash
npm run channels:sync -- --dry-run   # hit the APIs, print what would change, write nothing
npm run channels:sync                # apply
```

Nothing needs restarting. The worker re-reads its channel list from the database on every tick,
and the web server reads per request and pushes updates to open tabs.

New channels have no programmes until the next ingest pass, though — up to 15 minutes for
YouTube, an hour for Twitch VODs. Every timer also fires once at startup, so to force it:

```bash
pkill -f "tsx worker/index.ts" && npm run worker
```

### What the sync does and does not touch

| Change in `channels.yml` | Effect |
|---|---|
| Add a subject | New row, at the position written |
| Reorder subjects | Rows reorder |
| Remove a subject | Row disappears; its channels' programmes are kept |
| Move a channel between subjects | Membership moves; programmes follow it |
| Remove a channel from every subject | It stops being polled; programmes are kept |
| Rename a subject | Treated as removing one and adding another |

Nothing is ever deleted from `programs` by a sync. Re-adding a channel picks its history straight
back up.

### Pick channels that suit a guide

Two things decide whether a row looks good:

- **YouTube channels earn a row through anything they publish** — streams, premieres and ordinary
  uploads all become programming. Any active channel works.
- **A row needs enough back catalogue to fill a day.** One creator posting weekly will repeat
  often. Two or three related channels per subject is roughly the point where a row stops looking
  repetitive. Twitch VODs are long (2–6 h), so a Twitch-heavy row fills with fewer, wider blocks.

---

## Running it

Two processes over one SQLite file. **The worker is the only writer**; the web app only reads.

```bash
npm run worker               # ingest loop — leave running
npm run build && npm start   # production web server, http://localhost:3000
```

For development, `npm run dev` instead of build/start. The worker is the same either way.

### Every command

| Command | What it does |
|---|---|
| `npm run channels:sync` | Reconcile `channels.yml` into the database. `-- --dry-run` to preview |
| `npm run worker` | Ingest loop. The only writer |
| `npm run dev` | Web UI with hot reload |
| `npm run build && npm start` | Production web UI |
| `npm run status` | What is in the database: rows, channels, what is live, quota spent |
| `npm test` | Test suite |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:migrate` | Apply migrations. The worker and sync do this on startup anyway |
| `npx tsx scripts/seed-demo.ts` | Fill with fixtures — no credentials needed |
| `npx tsx scripts/seed-demo.ts --clear` | Remove those fixtures |

`npm run status` is the first thing to reach for when something looks wrong. It answers: did the
channels resolve, is the worker actually ingesting, is anything live, and how much YouTube quota
has gone today.

---

## How a row gets filled

Programmes are ingested into a database; the *schedule* is computed when the page loads and is
never stored.

**Appointments** — anything live or scheduled — sit at their real times and nothing displaces
them. Everything else is **library**: Twitch VODs, finished YouTube streams, and ordinary
uploads. The library is scheduled into the gaps around the appointments, back to back.

Two properties this needs:

- **Deterministic.** The guide refetches whenever the worker writes. A random fill would reshuffle
  the whole grid every few seconds, so the running order is seeded from the subject and the date —
  the same day always programmes the same way.
- **Bounded.** Days are programmed whole, so the work does not grow with how much history exists,
  and scrolling into tomorrow shows the schedule tomorrow would have had.

Items are never stretched or trimmed: a bar always represents the real length of the thing. Where
two channels in a subject broadcast at once, the earlier start holds the row.

The guide window is 4 hours back and 12 hours forward (`GUIDE_PAST_MS` / `GUIDE_FUTURE_MS` in
`lib/guide.ts`).

---

## Things that will catch you out

**Twitch embeds require HTTPS on any host except `localhost`.** Served over plain HTTP from a LAN
IP or a real domain, the player silently refuses to start. The player pane detects this and says
so. Browsing via `localhost` works, or terminate TLS in front of the app. `TWITCH_EMBED_PARENTS`
only matters when the browser reaches the site under a hostname it does not report — a reverse
proxy — since the hostname you browse from is detected automatically.

**YouTube quota is 10,000 units a day**, resetting at midnight Pacific. LiveVODs never calls
`search.list` (100 units, so ~100 calls would exhaust a day), instead deriving each channel's
uploads playlist from its id and checking 50 videos per unit. Roughly 20 channels costs about a
third of the allowance. Spend is tracked in the database and survives restarts, because the
platform counts the real total and disagreeing with it gets the key cut off. `npm run status`
shows the day's usage.

**Backing up the database needs all three files.** WAL mode keeps recent writes in a sidecar, so
`cp data/livevods.db` alone silently produces a copy missing the newest data:

```bash
cp data/livevods.db data/livevods.db-wal data/livevods.db-shm /your/backup/
```

**A row can have gaps just before midnight.** Days are programmed independently, so the last slot
usually cannot fill exactly to the boundary. Tuning in during a gap plays the nearest programme.

**Repeats.** A row whose library is small will replay things within a day, and because each day is
shuffled independently a video can close one day and open the next. More channels per subject is
the fix; raising `DISCOVERY_DEPTH` in `lib/connectors/youtube.ts` from 15 to 50 also widens the
pool at no extra quota cost.

---

## Layout

```
config/channels.yml        the lineup (gitignored; .example.yml is the template)
drizzle/schema.ts          subjects, channels, programs, sync state, quota
lib/schedule.ts            programming a row — pure, deterministic
lib/ingest/reconcile.ts    scheduled/live/aired/missed state machine — pure
lib/connectors/            twitch.ts, youtube.ts
lib/guide.ts               builds subject rows for a time window
worker/index.ts            the ingest process; the only writer
app/                       Next.js UI and API routes
scripts/                   channels:sync, status, migrate, seed-demo
```

The two pure modules — `lib/schedule.ts` and `lib/ingest/reconcile.ts` — hold the logic worth
understanding. Neither touches the database, the network, or the clock, which is why both are
fully testable without credentials.

---

## Requirements

Node 22 or newer. Everything else installs with `npm install`; the database is a file.
