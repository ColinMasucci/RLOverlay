# RLOverlay

## For players

RLOverlay is a Windows companion app for Rocket League. It displays a customizable
in-game scoreboard and status window, records match history on your computer, and
can show ball-location, possession, and touch-share heatmaps. It also includes the
RL Imposter party game, which can be played in a browser or from the desktop app.

### Install

1. Open the [RLOverlay Releases page](https://github.com/ColinMasucci/RLOverlay/releases).
2. Download the latest `RLOverlay-Setup-<version>.exe` installer.
3. Run the installer and follow its prompts. Windows may show a SmartScreen warning
   because the installer is not code-signed; only download it from the official
   Releases page.
4. Launch RLOverlay. The desktop scoreboard connects to the Rocket League telemetry
   service on your computer. If the status window says it is disconnected, check
   that Rocket League is running and enable the API connection with **F9**.

### Update

In the installed app, open Settings and choose the **App** tab. Select **Check for
updates**; if an update is found and downloaded, choose **Restart and install**.
You can also download and run a newer installer from the
[Releases page](https://github.com/ColinMasucci/RLOverlay/releases). The in-app
updater is available in the installed app, not when running from source.

### Basic controls

The default keyboard shortcuts are:

| Key | Action |
| --- | --- |
| `F8` | Toggle the in-game overlay |
| `F9` | Toggle the Rocket League API connection |
| `F10` | Open or hide Settings |
| `F11` | Switch between the scoreboard and match history |

You can change these shortcuts on the **Controls** tab. Controller buttons can
also be bound there. The default controller overlay button shows the overlay while
held; while holding it, press the history button to switch views. You can also
bind a controller button to open or hide Settings. Controller bindings can vary
by device.

### Settings and match history

- **Overlay:** Adjust size and position, show or hide the status window and heatmap,
  choose the heatmap style, and select which scoreboard statistics are visible.
- **Controls:** Change keyboard shortcuts and bind or clear controller buttons.
- **Rocket League Stats API:** Choose the telemetry update rate from 1 to 120
  updates per second. RLOverlay initializes a missing `PacketSendRate` to 10 on
  first launch, but leaves an existing rate unchanged. Restart Rocket League
  after changing the rate.
- **Match History:** Choose the player to track. RLOverlay can automatically select
  a likely player when that player appears in every one of at least three saved
  matches. Match history and settings are stored locally on your computer.
- **App:** Check the installed version and install available updates.

The three-zone heatmap shows team possession by field area. It also shows how each
field third contributes to your team's recorded ball touches.

#### Rocket League telemetry rate

The **Controls** tab lets you change how often the Rocket League Stats API sends
updates. RLOverlay checks the Rocket League config folder in your Windows
Documents location:

```text
Documents\My Games\Rocket League\TAGame\Config
```

It updates `TAStatsAPI.ini` when that file exists; otherwise it uses
`DefaultStatsAPI.ini`, creating the latter if neither file exists. A missing
`PacketSendRate` is initialized to 10, and any existing rate is preserved on
startup. Before changing an existing file, RLOverlay keeps its original contents
in a `.RLOverlay.bak` file next to it.

If you need to set the value manually, open the existing `TAStatsAPI.ini` or
`DefaultStatsAPI.ini` and set `PacketSendRate` under
`[TAGame.MatchStatsExporter_TA]`, for example:

```ini
[TAGame.MatchStatsExporter_TA]
Port=49123
WebPort=49124
PacketSendRate=10

[IniVersion]
0=1785886389.000000
```

If neither file exists, create `DefaultStatsAPI.ini` in the folder above with
that content. Restart Rocket League after editing the file.

### RL Imposter game

RL Imposter is a social game to play with the other people in your Rocket League
lobby. One or more players receive a secret role; safe players get a shared
challenge or speed target while imposters try to blend in. Players discuss the
round, then vote on who they think the imposter is. The host can configure the
round settings, including the game mode and optional anonymous chat. The game
also supports a speed-target mode with configurable units and target ranges.

Open the deployed RLOverlay website and choose **Host** or **Join** to play in a
browser. The desktop app's **Imposter** tab uses the same Supabase lobbies and
lets you host or join with a lobby code. During a round, your personal role and
task appear in a compact card at the top-left of your screen. Players do not need
Rocket League telemetry to play; challenges are self-reported.

## For developers

### Run locally

Install Node.js, clone the repository, then run:

```powershell
npm ci
npm start
```

To work on the browser game, run `npm run dev` and open
`http://localhost:5173/` (or `http://localhost:5173/party.html`). Run the desktop
Imposter WebSocket service separately with `npm run imposter-server` when testing
the desktop game's server workflow.

### Supabase and Vercel

The browser game uses Supabase Database RPCs for lobby actions and Supabase
Realtime Broadcast for live updates. Set up an empty Supabase project in this
order from its SQL Editor:

1. Run [`supabase/schema.sql`](./supabase/schema.sql).
2. Run [`supabase/migrations/20261107000000_speed_mode_and_chat.sql`](./supabase/migrations/20261107000000_speed_mode_and_chat.sql).
3. Run [`supabase/migrations/20261107010000_restore_lobby_rpc_permissions.sql`](./supabase/migrations/20261107010000_restore_lobby_rpc_permissions.sql).
4. Run [`supabase/migrations/20261108000000_weighted_imposter_ranges_and_challenges.sql`](./supabase/migrations/20261108000000_weighted_imposter_ranges_and_challenges.sql).
5. Run [`supabase/migrations/20261108010000_allow_all_players_as_imposters.sql`](./supabase/migrations/20261108010000_allow_all_players_as_imposters.sql).

For Vercel, import the repository with the repository root (`.`) as the **Root
Directory**. Use `npm run build` as the build command and `dist` as the output
directory. Set these environment variables for Production, Preview, and
Development, then redeploy:

- `VITE_SUPABASE_URL`: the Supabase project URL.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable key (or legacy anon
  key). This key is intended to be visible in the website; never use the
  `service_role` key in a client-side environment variable.

For local development, create `.env.local` in the repository root with these
same two values. Use `npm run dev` for the browser game or `npm start` for the
desktop app. Vite embeds the public URL and publishable key into the renderer at
build time. For GitHub desktop releases, add both as repository Actions
variables under **Settings → Secrets and variables → Actions → Variables**.
The release workflow verifies that they are configured before building. The
browser and desktop games use anonymous lobby sessions. Roles and secret votes
are only returned by token-checked database functions; review the SQL policies
and RPCs before changing the access model.

### Build, test, and publish

Run the test suite with:

```powershell
npm test
```

Build the website and desktop renderer with:

```powershell
npm run build
```

To build a Windows installer locally, run:

```powershell
npm run dist:win
```

The unsigned NSIS installer is written to
`release/RLOverlay-Setup-<version>.exe`.

To publish a release, update the version in `package.json`, push the change, then
create and push a matching version tag (for example, `v1.0.1`). The GitHub Actions
workflow builds and publishes the installer as a GitHub Release. GitHub Actions
must be enabled for the repository. For the first release of a version, push the
matching tag after the repository is on GitHub.

### Local data and architecture

Electron settings and match history are stored in the user's application-data
directory, outside the repository. Do not commit generated user data, installer
artifacts, or secrets. The browser game uses Supabase; the desktop Imposter game
uses the Node WebSocket service. The desktop overlay connects to the local Rocket
League telemetry WebSocket at `ws://127.0.0.1:49124`.
