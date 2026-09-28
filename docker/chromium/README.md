# Chromium render engine

Obscura is Norish's default rendered-page engine. Some shops run apps that
Obscura cannot execute: MM Mega Market's Magento storefront fails on Obscura's
shared `HTML*Element` constructor, its lazy script loading and its missing CSS
object model. For those, Norish can render with a real headless Chromium
([chromedp/headless-shell](https://github.com/chromedp/docker-headless-shell))
instead.

## What changes when you switch

- **Private network.** Obscura refuses loopback, RFC1918 and link-local
  targets itself. Chromium refuses nothing, so with `RENDER_ENGINE=chromium`
  Norish checks every request a page makes and aborts any whose host resolves
  to a private address (`packages/api/src/parser/private-network.ts`). The
  check resolves the name before Chromium does, so a host that answers
  differently the second time (DNS rebinding) is not covered.
- **Host header.** Chromium's DevTools server answers only an IP address or
  `localhost`, so Norish resolves a service name in `OBSCURA_ENDPOINT` to its
  address before it connects.
- **Stealth and memory.** Chromium has none of Obscura's anti-bot features,
  and it uses several hundred megabytes more memory.

## Local

`pnpm docker:up` starts the `chromium` service on `127.0.0.1:9223`. In
`.env.local`:

```env
RENDER_ENGINE=chromium
OBSCURA_ENDPOINT=http://localhost:9223
```

## Railway

1. In the project, click **+ Create**, then **Docker Image**, and enter
   `chromedp/headless-shell:151.0.7922.109`. (Or create the service from this
   repository and set its **Config file path** to
   `docker/chromium/railway.json`; the image is the same.)
2. Rename the service to `chromium`.
3. Do not generate a public domain for it. Anyone who reaches the DevTools
   port can drive the browser.
4. On the Norish service, set:

   ```env
   RENDER_ENGINE=chromium
   OBSCURA_ENDPOINT=http://${{chromium.RAILWAY_PRIVATE_DOMAIN}}:9222
   ```

5. Deploy both services. You can then remove the Obscura service.

The image listens on IPv4 only, so Norish prefers the IPv4 address of the
service name when it connects.
