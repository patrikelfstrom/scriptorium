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
- Keep GitHub Actions as validation-only CI

Set `VITE_API_BASE_URL` in the Cloudflare Pages build environment only if production uses a separate API hostname.
Leave it unset if Cloudflare routes the frontend and API under the same origin and the browser should call `/api/*` directly.

Set these secrets in the Cloudflare Worker runtime, not in GitHub Actions:

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

The scheduled catalog refresh workflow still reads Turso directly from GitHub Actions, so keep `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, and `GITHUB_TOKEN` configured as GitHub repository secrets for that job as well.

## Local development

Install dependencies with `pnpm install`.

Run the frontend:

```bash
pnpm dev
```

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

Point the frontend at the API during local development with:

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
- `GITHUB_TOKEN`: required GitHub token for repository stars/topics enrichment during sync
- `NPM_SYNC_LIMIT`: optional total number of npm packages to sync, defaults to `10000`
- `NPM_REGISTRY_BASE_URL`: optional npm registry API override, defaults to `https://registry.npmjs.org`
- `GITHUB_GRAPHQL_URL`: optional GitHub GraphQL API override, defaults to `https://api.github.com/graphql`
- `SCRIPTORIUM_DATA_DIR`: optional local fallback database directory
