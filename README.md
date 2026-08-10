# WarpTalk Desktop

Desktop shell for WarpTalk, built with Electron and the production UI from
`warptalk-web`.

## UI Source

`warptalk-desktop` loads the Next.js app from `../warptalk-web`.
The desktop entry route is `/desktop-login`, so the desktop app skips the public
landing page and starts at the login flow.

After authentication, the web app redirects into `/workspace` and the dashboard
uses the same UI/UX as `warptalk-web`.

## Development

```bash
npm install
npm run dev
```

`npm run dev` starts `warptalk-web` and then opens Electron against the local
web UI. If the web app is already running, use:

```bash
npm run dev:desktop
```

## Build

```bash
npm run typecheck
npm run build:win
```

`npm run build:win` builds `warptalk-web` first, copies the standalone Next.js
output into Electron resources, and writes the Windows installer to `release/`.

For a production desktop installer that talks to the deployed API, copy
`.env.production.example` to `.env.production.local`, fill the public LiveKit
and Google values, then run:

```bash
npm run build:win:production
```

Only public frontend values belong in `.env.production.local`. Backend secrets
such as database passwords, JWT secrets, OpenAI keys, and LiveKit API secrets
must stay on the server.
