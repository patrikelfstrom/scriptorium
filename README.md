# scriptorium

scriptorium is a searchable frontend tooling catalog built as:

- a Vite React frontend in `src/`
- shared catalog contracts in `shared/`
- Turso/libSQL-backed catalog services in `server/`
- a Cloudflare Worker API in `worker/`

The production target is Cloudflare Pages for the frontend plus a separate Cloudflare Worker for `/api/search` and `/api/tags`, with Turso as the source of truth.

## Deployment

GitHub Actions validates every push and pull request.
Production deployment should be handled from Cloudflare:

- Cloudflare Pages for the frontend bundle in `dist/`
- Cloudflare Workers for the API defined in `wrangler.toml`

Recommended setup:

- Connect the Pages project to this GitHub repository in Cloudflare
- Connect the Worker to this GitHub repository with Workers Builds in Cloudflare
- Bind a Workers KV namespace as `CATALOG_CACHE` for persistent API response caching across regions
- Keep GitHub Actions as validation-only CI

Set `VITE_API_BASE_URL` in the Cloudflare Pages build environment only if production uses a separate API hostname.
Leave it unset if Cloudflare routes the frontend and API under the same origin and the browser should call `/api/*` directly.

Set these secrets in the Cloudflare Worker runtime, not in GitHub Actions:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

The scheduled catalog refresh workflow still reads Turso directly from GitHub Actions, so keep `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `GITHUB_TOKEN` configured as GitHub repository secrets for that job as well. The default workflow refreshes the top `30,000` packages in `14` stable shards, running `2` shards per day for full weekly coverage.

To enable the KV cache binding with Wrangler, add a namespace similar to:

```toml
[[kv_namespaces]]
binding = "CATALOG_CACHE"
id = "<production-namespace-id>"
preview_id = "<preview-namespace-id>"
```

## Local development

Install dependencies with `pnpm install`.

Run the frontend:

```bash
pnpm dev
```

`pnpm dev` only starts the Vite frontend on `http://127.0.0.1:5173`.
In local development, Vite proxies `/api/*` requests to `http://127.0.0.1:8787`, so the API also needs to be running.

Run the API locally:

```bash
pnpm dev:worker
```

This starts a Node-based local server on `http://127.0.0.1:8787` and uses `.data/scriptorium.db` automatically when `TURSO_DATABASE_URL` is unset.
If you specifically need to run the Cloudflare Worker runtime in development, use:

```bash
pnpm dev:worker:cf
```

If you need to prepare or migrate the database schema without starting the worker:

```bash
pnpm db:prepare
```

To destructively reset the catalog and recreate the current schema:

```bash
pnpm db:reset
```

If you want to bypass the Vite proxy and point the frontend at a different API origin during local development, use:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8787
```

If `TURSO_DATABASE_URL` is not set for scripts and tests, scriptorium falls back to a local libSQL database at `.data/scriptorium.db`.
For an existing Turso or local database created before the current schema, run `pnpm db:reset` once before using the worker.

## API

The public read API is:

- `GET /api/search?q&tags&limit&cursor`
- `GET /api/tags`

## Admin sync commands

- `pnpm sync:npm-catalog`

This command updates the database directly. It does not generate repo data files or commit changes.
It can also be sharded by setting `NPM_SYNC_TOP_PACKAGE_LIMIT`, `NPM_SYNC_SHARD_COUNT`, and `NPM_SYNC_SHARD_INDEX`.

## Build and validation

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build:app
pnpm build:worker
pnpm verify
```

## Environment variables

- `VITE_API_BASE_URL`: frontend API origin override for local or split-origin deployments
- `TURSO_DATABASE_URL`: Turso/libSQL database URL for the worker and sync scripts
- `TURSO_AUTH_TOKEN`: Turso auth token when using remote Turso
- `CATALOG_CACHE`: optional Workers KV binding for persistent cross-region caching of `/api/search` and `/api/tags`
- `GITHUB_TOKEN`: required GitHub token for repository stars/topics enrichment during sync
- `NPM_SYNC_LIMIT`: optional backward-compatible alias for `NPM_SYNC_TOP_PACKAGE_LIMIT`
- `NPM_SYNC_TOP_PACKAGE_LIMIT`: optional number of top download-count packages eligible for sync, defaults to `10000`
- `NPM_SYNC_SHARD_COUNT`: optional stable shard count for rolling syncs
- `NPM_SYNC_SHARD_INDEX`: optional zero-based shard index to sync from the selected top package set
- `NPM_REGISTRY_BASE_URL`: optional npm registry API override, defaults to `https://registry.npmjs.org`
- `GITHUB_GRAPHQL_URL`: optional GitHub GraphQL API override, defaults to `https://api.github.com/graphql`
- `SCRIPTORIUM_DATA_DIR`: optional local fallback database directory
