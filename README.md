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
