# Takes

A Farcaster client for iPhone and the web, and its own server on Cloudflare, built from
[Warpstack](https://github.com/daemons404/warpstack)'s building blocks. Your keys stay on your
phone; Snapchain is the database.

## Run it here

```sh
cp .dev.vars.example .dev.vars    # then fill it in: openssl rand -hex 32 makes a key
pnpm dev                          # the server and web app on localhost, no Cloudflare account
```

## Your own server

[SETUP.md](SETUP.md): about ten minutes in a browser, then `pnpm run deploy --fid <your FID>`.

## The iPhone app

Needs Xcode and Rust. The first build compiles the vault from source, which takes a few
minutes. Set `CARGO_TARGET_DIR` to a folder outside `node_modules` to keep later builds fast.

```sh
EXPO_PUBLIC_API_URL=https://<your server> pnpm run ios:release
```
