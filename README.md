# WarpTalk Desktop

Desktop shell for WarpTalk, built with Electron and the production UI from
`warptalk-web`.

## UI Source

Production desktop builds load the deployed web app at
`https://app.warptalk.io.vn/desktop-login`.

Development still loads the Next.js app from `../warptalk-web` by default. The
desktop entry route is `/desktop-login`, so the desktop app skips the public
landing page and starts at the login flow.

After authentication, the web app redirects into `/workspace` and the dashboard
uses the same UI/UX as `warptalk-web`.

`warptalk-web` is the source of truth for desktop UI/UX. Do not duplicate or
redesign dashboard screens inside `warptalk-desktop`; update and deploy the
shared web app instead.

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

For the recommended remote-web desktop build:

```bash
npm run typecheck
npm run build:win:remote
```

This build does not package the Next.js standalone output. The installed app
opens `https://app.warptalk.io.vn/desktop-login`, so website deployments update
the desktop UI automatically.

To point a development desktop window at another web URL:

```bash
$env:WARPTALK_WEB_URL="https://app.warptalk.io.vn/desktop-login"
npm run dev:desktop
```

The older local-packaged mode is still available if a standalone desktop bundle
is needed:

```bash
npm run typecheck
npm run build:win
```

`npm run build:win` builds `warptalk-web` first, copies the standalone Next.js
output into Electron resources, and writes the Windows installer to `release/`.

If you intentionally need the older local-packaged production mode, copy
`.env.production.example` to `.env.production.local`, fill the public LiveKit
and Google values, build the local bundle, and launch it with
`WARPTALK_DESKTOP_WEB_MODE=local`:

```bash
npm run build:win:production
```

Only public frontend values belong in `.env.production.local`. Backend secrets
such as database passwords, JWT secrets, OpenAI keys, and LiveKit API secrets
must stay on the server. Remote-web builds do not need this file because the
deployed website already owns those public frontend values.
