# RLOverlay

Rocket League scoreboard and match-history overlay for Windows.

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

The app's Settings window can check public GitHub Releases and download an update.
The updater does not fetch or execute source files from Git; it downloads the
Windows installer update metadata and artifacts published for this repository.
Updates are available only in the packaged app, not when running with `npm start`.

To publish a new Windows release, update the version in `package.json`, commit and
push the change, then create and push a matching version tag (for example,
`v1.0.1`). The GitHub Actions workflow builds the installer and publishes it as a
GitHub Release. Friends install the executable once and can use **Check for
updates** in Settings afterward; they do not need Git or Node.js.

For the first release of the current `1.0.0` version, push the `v1.0.0` tag after
the repository is on GitHub. GitHub Actions must be enabled for the repository.

## Local data and public repository

Settings and match history are written to Electron's per-user application data
directory, outside the repository. Do not commit those generated user-data files,
installation artifacts, or secrets. This repository does not need a GitHub access
token in the app: release metadata is read from the public repository.
