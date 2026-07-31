# WarpTalk Desktop

Desktop client for WarpTalk, built with Electron, React, and TypeScript.

## Quick Start

```bash
npm install
npm run dev
```

## Build

```bash
npm run typecheck
npm run build:win
```

The Windows installer and portable build are written to `release/`.

## UI Boundary

`warptalk-desktop` owns its own renderer UI in `src/renderer`.
It does not build, copy, or load `warptalk-web`.

Only sync UI with `warptalk-web` when that is explicitly requested.

## Project Structure

```text
warptalk-desktop/
|-- resources/                # App icons and native build assets
|-- scripts/                  # Packaging hooks
|-- src/
|   |-- main/                 # Electron main process
|   |-- preload/              # Secure renderer bridge
|   |-- renderer/             # React desktop UI
|   `-- shared/               # Shared types
|-- electron-builder.yml
|-- package.json
`-- tsconfig.json
```
