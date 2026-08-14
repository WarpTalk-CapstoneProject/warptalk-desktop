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

## Releasing

`https://warptalk.vn/download` is generated from this repo. The page calls the
GitHub API for the **latest release** of
`WarpTalk-CapstoneProject/warptalk-desktop`, sorts the attached assets by
platform, and links them directly. A new GitHub Release is the publish step for
new desktop installers.

```bash
npm version minor        # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags   # triggers .github/workflows/release.yml
```

The workflow builds remote-web installers on macOS, Windows and Linux runners
in parallel and hands the artifacts to `electron-builder --publish always`,
which creates the GitHub Release named after the tag.

Requirements for it to succeed:

- **The repo must be public.** The download page links `browser_download_url`
  straight at the asset; on a private repo those URLs 404 for anyone not signed
  in to GitHub. If the repo has to stay private, mirror the artifacts to R2 and
  point the web app at a manifest instead. See `DESKTOP_RELEASE_MANIFEST_URL`
  in `warptalk-web/src/lib/desktop-releases.server.ts`.
- **`package-lock.json` must be committed** because the workflow uses `npm ci`.
- **`src/renderer/index.html` must exist.** electron-vite infers its config
  from the `src/main` + `src/preload` + `src/renderer/index.html` layout.
- `npm run typecheck` must pass; it gates the build.

Builds are **unsigned** until `MAC_CERTIFICATE_P12` / `WIN_CERTIFICATE_PFX` are
added as repo secrets. Unsigned builds still install, but macOS Gatekeeper and
Windows SmartScreen show warnings.

## Project Structure

```text
warptalk-desktop/
├── src/
│   ├── main/        # Electron main process
│   ├── preload/     # Secure bridge exposed to the deployed web app
│   └── renderer/    # Minimal fallback renderer built by electron-vite
├── resources/       # App icons and assets
├── electron-builder.yml
├── electron-builder.remote.yml
├── package.json
└── tsconfig.json
```
