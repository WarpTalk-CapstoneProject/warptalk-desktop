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

This remote build does not package the Next.js standalone output. The installed app
opens `https://app.warptalk.io.vn/desktop-login`, so website deployments update
the desktop UI automatically.

To point a development desktop window at another web URL, on PowerShell:

```powershell
$env:WARPTALK_WEB_URL="https://app.warptalk.io.vn/desktop-login"
npm run dev:desktop
```

or on macOS and Linux:

```bash
WARPTALK_WEB_URL="https://app.warptalk.io.vn/desktop-login" npm run dev:desktop
```

### macOS

```bash
npm run typecheck
npm run build:mac:remote
```

This writes four artifacts to `release/`, because `macos-latest` runners are
Apple Silicon and a host-arch-only build produces a `.dmg` that refuses to
launch on Intel Macs:

| File | Runs on |
|------|---------|
| `WarpTalk-<version>-arm64.dmg` / `-arm64-mac.zip` | Apple Silicon |
| `WarpTalk-<version>.dmg` / `-mac.zip` | Intel |

The `.zip` pair is what `electron-updater` consumes; the `.dmg` pair is what the
download page links.

**Gatekeeper.** Until `MAC_CERTIFICATE_P12` is added as a repo secret the builds
are unsigned and unnotarized. There are two different failure modes here and
they are worth keeping apart, because only one of them is survivable:

| Bundle state | What the user sees | Way past it |
|--------------|--------------------|-------------|
| Half-signed (no `afterPack` hook) | *"WarpTalk is damaged and can't be opened."* | none — the dialog offers only Move to Trash |
| Ad-hoc signed, unnotarized (today) | *"Apple could not verify WarpTalk is free of malware."* | Open Anyway, System Settings › Privacy & Security |
| Developer ID + notarized | opens | — |

v0.3.2 shipped in the first state. Electron's prebuilt binaries arrive
linker-signed; electron-builder then rewrites `Info.plist` and copies
`extraResources` in, invalidating that signature, and with no certificate
configured it skips signing entirely instead of re-sealing the bundle. The
result claims resources it does not seal, which Gatekeeper reads as tampering:

```console
$ codesign -dv WarpTalk.app
Identifier=Electron      Info.plist=not bound      Sealed Resources=none
$ spctl -a -t exec WarpTalk.app
WarpTalk.app: code has no resources but signature indicates they must be present
```

`scripts/adhoc-sign-mac.js` (wired as `afterPack` in both builder configs) now
re-seals the bundle with an ad-hoc signature, moving releases into the second
row. Verify any mac artifact with:

```bash
codesign --verify --deep --strict --verbose=2 release/mac-arm64/WarpTalk.app
```

`valid on disk` plus `satisfies its Designated Requirement` is the pass.

To skip the Open Anyway step on a team machine, strip the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /Applications/WarpTalk.app
```

Do not put that command next to a public download button — it teaches users to
disarm Gatekeeper. It is a workaround for the team until the app is signed and
notarized.

**Getting to the third row.** Ad-hoc signing is the ceiling without money: the
"Open Anyway" prompt exists because macOS has no way to learn who built the app.
Apps that open silently — Chrome, Zoom, Docker — are all signed with a paid
Developer ID *and* notarized. Reaching that state is a purchase plus three
mechanical steps, none of which need code changes here:

1. Join the Apple Developer Program (99 USD/year) and create a **Developer ID
   Application** certificate. Export it as a `.p12`.
2. Add repo secrets `MAC_CERTIFICATE_P12` (base64 of the `.p12`),
   `MAC_CERTIFICATE_PASSWORD`, plus `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`
   and `APPLE_TEAM_ID` for the notary service. The release workflow already
   exports the first two on its own; the notary three need adding to it.
3. Set `mac.notarize` in both builder configs. Leave it unset until the
   credentials exist — electron-builder fails the build if it is on without
   them, which is why it is not pre-wired.

`scripts/adhoc-sign-mac.js` steps aside on its own once `CSC_LINK` is set, so
nothing has to be removed. Until then the ad-hoc signature is what keeps the
build openable at all, and `npm run check:mac-signing` fails the release if a
builder config ever loses the hook.

Note that a local build on a machine with a Developer ID in its keychain is
signed with that identity, so it will behave differently from the unsigned
artifacts CI produces. Test the CI artifacts, not a local build, when checking
the download experience.

The older local-packaged mode is still available if a standalone desktop bundle
is needed. Use this when you want to install and test the current local
`warptalk-web` UI before it has been deployed:

```bash
npm run typecheck
npm run build:win
```

`npm run build:win` builds `warptalk-web` first, copies the standalone Next.js
output into Electron resources, and writes the Windows installer to `release/`.
Because that installer contains `resources/warptalk-web/server.js`, the desktop
runtime uses the packaged local UI automatically.

If you intentionally need the older local-packaged production mode, copy
`.env.production.example` to `.env.production.local`, fill the public LiveKit
and Google values, then run:

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
- **`package-lock.json` must be committed** because the workflow uses `npm ci`,
  **and it must carry every platform's native binaries.** Rollup, which
  electron-vite builds on, ships its compiled core as one optional dependency per
  platform. npm records only the ones the generating machine needed, so a lockfile
  refreshed on Windows contains no `@rollup/rollup-darwin-arm64` and the macOS and
  Linux jobs both die with `Cannot find module`. That is exactly what happened on
  the first attempt at v0.3.0. Regenerate with `npm install --package-lock-only`
  and check the result covers all three before committing:

  ```bash
  grep -c 'node_modules/@rollup/rollup-' package-lock.json
  ```

  Twenty-five entries is right; two means the file is platform-local.
- **`src/renderer/index.html` must exist.** electron-vite infers its config
  from the `src/main` + `src/preload` + `src/renderer/index.html` layout.
- `npm run typecheck` must pass; it gates the build.
- **The release must not be left as a draft.** electron-builder publishes a draft
  by default, and a draft is invisible to `GET /releases/latest` — the endpoint the
  download page calls — so the page keeps saying "coming soon" after a fully green
  build. Both electron-builder configs set `publish.releaseType: release`; do not
  remove it. To check a release actually went public:

  ```bash
  gh api repos/WarpTalk-CapstoneProject/warptalk-desktop/releases/latest --jq .tag_name
  ```

  A 404 there means every release is still a draft.

Builds are **unsigned** until `MAC_CERTIFICATE_P12` / `WIN_CERTIFICATE_PFX` are
added as repo secrets. Unsigned builds still install, but macOS Gatekeeper and
Windows SmartScreen show warnings.

The workflow exports the signing variables only when the corresponding secret is
non-empty. This is not tidiness: an absent secret expands to the empty string, and
an empty `WIN_CSC_LINK` is still *set*, so electron-builder reads `""` as a
certificate path and fails the job outright rather than falling back to an
unsigned build. Do not move these back into the build step's `env:` block.

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
