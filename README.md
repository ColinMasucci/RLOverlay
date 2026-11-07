# RLOverlay

Rocket League scoreboard and match-history overlay for Windows.  
## How To Install:
Go to [Releases](https://github.com/ColinMasucci/RLOverlay/releases) on the right hand side and you can view and download the latest installer for RLOverlay.
The only file you need to download is **RLOverlay-Setup-\<version\>.exe**.

## Run from source

Install Node.js, then run:

```powershell
npm ci
npm start
```

## Build the Windows installer

```powershell
npm ci
npm run dist:win
```

The unsigned NSIS installer is written to `release/RLOverlay-Setup-<version>.exe`.
Windows may display a SmartScreen warning because the installer is not code-signed.
Only install builds downloaded from this repository's official Releases page.

## Publish releases and update the app

Go to [Releases](https://github.com/ColinMasucci/RLOverlay/releases) on the right hand side and you can view and download the latest installer for RLOverlay.
The only file you need to download is **RLOverlay-Setup-\<version\>.exe**.

The app's Settings window can check public GitHub Releases and download an update.
The updater does not fetch or execute source files from Git; it downloads the
Windows installer update metadata and artifacts published for this repository.
Updates are available only in the packaged app, not when running with `npm start`.

Note for Dev:
To publish a new Windows release, update the version in `package.json`, commit and
push the change, then create and push a matching version tag (for example,
`v1.0.1`). The GitHub Actions workflow builds the installer and publishes it as a
GitHub Release. Friends install the executable once and can use **Check for
updates** in Settings afterward; they do not need Git or Node.js.

For the first release of the current `1.0.0` version, push the `v1.0.0` tag after
the repository is on GitHub. GitHub Actions must be enabled for the repository.

## Imposter game

The browser game is served at `/`, `/index.html`, and `/party.html`. Locally, run `npm run dev`
and open `http://localhost:5173/` (or `http://localhost:5173/party.html`).
The browser version uses Supabase
Database RPCs for lobby actions and Supabase Realtime Broadcast for live
updates. The existing Electron game continues to use the Node WebSocket service
(`npm run imposter-server`); the desktop overlay page is built separately as
`dist/overlay.html`.

### Set up Supabase and Vercel

1. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql).
   It creates the lobby, player, private session, and secret-vote tables plus
   the RPC functions the browser uses. Player roles and votes are not directly
   readable by the public browser key. Lobbies are removed after 24 hours of
   inactivity when a new lobby is created.
2. Then run [`supabase/migrations/20261107000000_speed_mode_and_chat.sql`](./supabase/migrations/20261107000000_speed_mode_and_chat.sql)
   to add speed mode, round chat, and settings locking. Existing Supabase
   projects should run this migration; it upgrades the existing tables in
   place without deleting lobby data.
3. Run [`supabase/migrations/20261107010000_restore_lobby_rpc_permissions.sql`](./supabase/migrations/20261107010000_restore_lobby_rpc_permissions.sql)
   to ensure the public game client can execute the ready, end-voting, and
   next-round functions.
4. In Vercel, import this repository and set **Root Directory** to the
   repository root (`.`), not `renderer`. The Vite configuration builds the
   website to `dist`; use `npm run build` as the build command and `dist` as
   the output directory.
5. Add these Vercel environment variables for the Production, Preview, and
   Development environments, then redeploy:
   - `VITE_SUPABASE_URL`: the project URL from Supabase.
   - `VITE_SUPABASE_PUBLISHABLE_KEY`: the project's publishable (or legacy
     anon) key. This key is public in a browser build; never use the
     `service_role` key here.
6. For local browser development, copy `.env.example` to `.env.local`, fill in
   the same two values, then run `npm run dev`.

The website uses anonymous lobby sessions rather than Supabase user accounts.
Each browser gets a random session token; clearing that browser's local storage
will end its ability to resume its lobby seat. Roles and secret votes are only
returned by token-checked database functions. The publishable key is expected
to be visible to website visitors, so do not add a service-role key to Vercel
client-side environment variables.

Web players self-report challenges because a website cannot read Rocket League
match data. The Electron desktop game can use its selected in-game player to
automatically track own goals, three demos, and no-goals-at-match-end challenges
when the Rocket League API is connected; it still uses the separate WebSocket
service for now. Browser lobbies also support a manually reported speed-target
mode, anonymous round chat, and settings that lock after the first round starts.
In hidden-imposter speed rounds, the imposter gets a different target and chat
uses neutral player labels; hints are disabled so the imposter is not exposed.

## Local data and public repository

Settings and match history are written to Electron's per-user application data
directory, outside the repository. Do not commit those generated user-data files,
installation artifacts, or secrets. This repository does not need a GitHub access
token in the app: release metadata is read from the public repository.
