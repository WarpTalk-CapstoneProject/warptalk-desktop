# WarpTalk Desktop

Cross-platform desktop client for WarpTalk — built with **Electron** + **React** + **TypeScript**.

## Features

- 🎤 Real-time audio capture & streaming via WebRTC
- 🌐 System-tray integration for always-on translation
- 📋 Live transcript overlay (floating window)
- 🔔 Native desktop notifications
- 🖥️ Screen sharing support
- 🔐 Auto-update via electron-updater

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run in development mode
npm run dev

# 3. Build for production
npm run build          # all platforms
npm run build:mac      # macOS (.dmg)
npm run build:win      # Windows (.exe, .msi)
npm run build:linux    # Linux (.AppImage, .deb)
```

## Releasing

`https://warptalk.vn/download` is generated from this repo. The page calls the GitHub API for
the **latest release** of `WarpTalk-CapstoneProject/warptalk-desktop`, sorts the attached
assets by platform, and links them directly — nothing about it is hand-maintained, so a new
release is the only step needed to publish a new build.

```bash
npm version minor        # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags   # triggers .github/workflows/release.yml
```

The workflow builds on macOS, Windows and Linux runners in parallel and hands the artifacts to
`electron-builder --publish always`, which creates the GitHub Release named after the tag.

Requirements for it to succeed:

- **The repo must be public.** The download page links `browser_download_url` straight at the
  asset; on a private repo those URLs 404 for anyone not signed in to GitHub. If the repo has
  to stay private, mirror the artifacts to R2 and point the web app at a manifest instead — see
  `DESKTOP_RELEASE_MANIFEST_URL` in `warptalk-web/src/lib/desktop-releases.server.ts`.
- **`package-lock.json` must be committed** — the workflow uses `npm ci`.
- **`src/renderer/index.html` must exist.** electron-vite infers its config from the
  `src/main` + `src/preload` + `src/renderer/index.html` layout; without the entry HTML the
  build fails with no config file to point at.
- `npm run typecheck` must pass; it gates the build.

Builds are **unsigned** until `MAC_CERTIFICATE_P12` / `WIN_CERTIFICATE_PFX` are added as repo
secrets. Unsigned builds still install, but macOS Gatekeeper shows "cannot be opened because
the developer cannot be verified" and Windows SmartScreen shows a blue warning — worth a note
next to the download buttons if the certificates are not bought before the demo.

## Project Structure

```
warptalk-desktop/
├── src/
│   ├── main/                 # Electron main process
│   │   ├── index.ts          # App entry point
│   │   ├── ipc-handlers.ts   # IPC communication
│   │   ├── tray.ts           # System tray
│   │   └── updater.ts        # Auto-update logic
│   ├── renderer/             # React UI (renderer process)
│   │   ├── App.tsx
│   │   ├── pages/
│   │   ├── components/
│   │   └── hooks/
│   ├── preload/              # Preload scripts (secure bridge)
│   │   └── index.ts
│   └── shared/               # Shared types & constants
│       └── types.ts
├── resources/                # App icons & assets
├── electron-builder.yml      # Build configuration
├── package.json
└── tsconfig.json
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Electron 28+ |
| UI | React 18 + TypeScript |
| Build | electron-vite |
| Packaging | electron-builder |
| Audio | Web Audio API + WebRTC |
| State | Zustand |
| IPC | contextBridge + ipcRenderer |
