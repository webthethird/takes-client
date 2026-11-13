# app

The Expo app: one codebase for the phone and the web (decided Oct 25, 2026). `app/` holds thin Expo Router route files over `@warpstack/ui` screens; `src/worker.ts` is the Cloudflare Worker that serves the API and the web export (`expo export -p web` into `dist/`) together, configured in `wrangler.jsonc`.

- `pnpm dev` exports the web build and runs the Worker locally; `pnpm web` runs Expo's dev server for the web against it; `pnpm ios` builds a development build.
- Route files parse params with `params.*` from `app-core` and render NotFound on failure. Links come from `routes.*`.
- Ops status is at `/_ops/status`.

## This project

This app was made with `create-warpstack-app`. The building blocks are npm packages
(`@warpstack/*`); this project holds only the app's routes, its Worker entry point and its
configuration.

- Change screens by editing or replacing the route files in `app/`. Never edit
  `node_modules`: update a package, or replace the screen.
- `@warpstack/protocol` and `@warpstack/wallet` are the sealed core: they sign for the user.
  Use them through their public APIs only.
- `pnpm typecheck` checks the app and the Worker. `.dev.vars` and `.env.deploy` hold secrets:
  never print, commit or paste them.
- Setting up a server: SETUP.md. Building the iPhone app needs Xcode and Rust:
  `pnpm run ios:release` builds the vault from source, then the app.
