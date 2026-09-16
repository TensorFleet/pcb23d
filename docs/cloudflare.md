# Cloudflare deployment

PCB23D is a static-assets Worker (`apps/web/dist`) with a small script in front
(`apps/web/src/worker.ts`): host canonicalisation, `/api/models/*`, which converts KiCad
library WRL models to pcb23d's mesh format and caches them in the R2 bucket `pcb23d-models`
(created 2026-09-16; shared by local, staging, and production), and `/img/{gh|cb|gl}/*`, which
renders GitHub, Codeberg, and GitLab boards into the bucket shared with pcbfiddle.com. No KV or cron.

| Binding / var | Local + staging | Production |
| --- | --- | --- |
| `MODELS` (R2) | `pcb23d-models` | `pcb23d-models` |
| `RENDERS` (R2, pcbFiddle's git-snapshot bucket) | `fabplane-opensource-staging` | `fabplane-opensource` |
| `PCBFIDDLE_ORIGIN` | `https://pcbfiddle-staging.floral-lab-08df.workers.dev` | `https://pcbfiddle.com` |

`RENDERS` is owned by pcbFiddle; this Worker only writes `…/{sha}/renders/*` objects under
snapshots pcbFiddle created. The buckets already exist (pcbFiddle creates them). `nodejs_compat`
is on for the JPEG encoder, and `cpu_ms` is raised to 60 s because a large board can take a
few seconds to rasterise.

| Config | Worker | Hosts |
| --- | --- | --- |
| `wrangler.jsonc` | `pcb23d` (local `wrangler dev`) | localhost |
| `wrangler.staging.jsonc` | `pcb23d-staging` | `pcb23d-staging.<subdomain>.workers.dev` |
| `wrangler.production.jsonc` | `pcb23d` | `pcbto3d.com` (primary), `www.pcbto3d.com`, `pcb23d.com`, `www.pcb23d.com` |

Production sets `PRIMARY_HOST=pcbto3d.com` and `run_worker_first: true`, so every request
on the other three hosts gets a 301 to `https://pcbto3d.com<path>`. Staging and local have
no `PRIMARY_HOST`, so the script just serves assets.

## Deploy

Wrangler 4 needs Node 22+. With nvm: `nvm use 24` (or prefix `PATH=~/.nvm/versions/node/v24.10.0/bin:$PATH`).

```bash
bunx wrangler login
bun run --cwd apps/web deploy:staging
bun run --cwd apps/web deploy:production
```

## Domains (done 2026-09-16)

Both domains are registered at Namecheap. Zones were added to the `Matt@tensorfleet.net`
Cloudflare account on the Free plan; the Namecheap parking A/CNAME records were dropped
during import so the Workers custom domains could attach, the `eforward` MX and SPF TXT
records were kept.

Zones activate once Namecheap's nameservers are replaced with Cloudflare's:

| Zone | Cloudflare nameservers |
| --- | --- |
| `pcbto3d.com` | `bethany.ns.cloudflare.com`, `nico.ns.cloudflare.com` |
| `pcb23d.com` | `bethany.ns.cloudflare.com`, `nico.ns.cloudflare.com` (same pair) |

Namecheap: Domain List → Manage → Nameservers → Custom DNS → paste the two names → save.
Propagation is usually under an hour; Cloudflare emails when the zone is active and the
custom-domain certificates issue automatically after that.

## Workers Builds (optional, deploy on push)

Connect the `pcb23d` Worker to `TensorFleet/pcb23d` in **Workers & Pages → pcb23d → Settings →
Build** with build command `bun install --frozen-lockfile && bun run --cwd apps/web build`
and deploy command `cd apps/web && bunx wrangler deploy --config wrangler.production.jsonc`,
production branch `main`. Do the same for `pcb23d-staging` with the staging config and
non-production branch builds enabled for PR previews. Until then, deploys are manual.
