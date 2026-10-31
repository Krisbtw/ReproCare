# Install and run

Status: these steps come from reading `package.json`, `scripts/migrate.mjs`, `startup.sh` and `src/lib/db.ts` on 2026-10-31. In the session that wrote this file there was **no network**, so `npm ci` could not be run again. The earlier session reported `npm ci`, 62 AnatomyBridge tests, `tsc --noEmit` and `vite build` passing. Treat the dev-server and sign-in steps below as **not re-verified**.

## Requirements

- Node.js 22 or newer (the tests use `node --experimental-strip-types`; 22.22.2 was present here).
- npm.
- No external database is needed for local work. Without `DATABASE_URL` the app uses embedded Postgres (PGlite) and applies `migrations/` itself at start.
- For a real Postgres, set `DATABASE_URL`. `npm run build` then runs `scripts/migrate.mjs`, which applies pending files once each in a transaction and records them in `_migrations`.

## Steps

```bash
npm ci
npm run dev            # Vite dev server on http://0.0.0.0:8080
```

Open http://localhost:8080 and sign in. Sign-in is wired to the workspace's auth broker (Google, X or email, via Better Auth). Outside that workspace the broker settings may need your own values:

| Variable | Used for |
|---|---|
| `DATABASE_URL` | Postgres connection. Omit for embedded PGlite. |
| `VITE_AUTH_ENABLED` | `false` turns sign-in off. |
| `BETTER_AUTH_URL` | Public base URL for auth callbacks. |
| `GROK_AUTH_ISSUER`, `GROK_AUTH_CLIENT_ID`, `GROK_AUTH_CLIENT_SECRET` | Auth broker. Defaults exist for the workspace preview. |

Whether the app signs in correctly on a plain laptop, with or without `VITE_AUTH_ENABLED=false`, was **not tested**. With auth off, check `src/lib/auth/middleware.ts` to see which user id server functions receive before trusting the per-user scoping.

No secret belongs in the repository. A plain-language rewrite uses a language model only if one is configured; otherwise the stored excerpt is shown and the screen says so. No model key is required to run anything else.

## Tests

```bash
npm test               # test:app (AnatomyBridge + app), then test:scaffold (platform checks)
npm run test:app       # only the AnatomyBridge and app tests
npm run typecheck
```

AnatomyBridge-only test run:

```bash
node --experimental-strip-types --test \
  src/lib/reprotrace/engine.test.ts src/lib/reprotrace/spans.test.ts \
  src/lib/imaging/surface.test.ts src/lib/imaging/phantom.test.ts \
  src/lib/imaging/pipeline.test.ts src/lib/imaging/lab.test.ts \
  src/lib/imaging/finding-link.test.ts src/lib/clinic/lab-version.test.ts \
  src/lib/dicom/codec.test.ts src/lib/dicom/pixels.test.ts \
  src/lib/dicom/series-loader.test.ts src/lib/dicom/series-loader.parser.test.ts \
  src/lib/dicom/series-groups.test.ts
```

Last result (2026-10-31): `npm run test:app` 133 pass, 0 fail. `npm run test:scaffold` 183 of 197 pass; the 14 failures are platform template checks (sample app name, auth off; 11 of 14 read) that this project's changes break, so `npm test` ends with a non-zero exit after the app tests have passed.

## Deploy

`vercel.json` is present. `npm run build` runs Vite then the migrator. Not deployed or tested in this session.

## Using real data

- Do not load identifiable patient scans. Use the UMD dataset (CC BY 4.0 per its figshare record; check the licence page yourself before download) or the built-in synthetic sample.
- The Volume lab reads **uncompressed** DICOM only. UMD ships DICOM and NIfTI; use the DICOM series. Whether every UMD case passes the series checks is **untested**. Expect some to report gaps or mixed geometry.
- Nothing is uploaded. Pixels stay in the browser.

## Optional: Python imaging service

```bash
cd imaging-service
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m pytest -q        # 25 pass on synthetic data (2026-10-31)
uvicorn app.main:app --port 8100
```

It is independent of the web app. No model weights are included; `/segment/nnunet_umd` answers 503 until you supply them (see `imaging-service/README.md`).

To score your own predictions against UMD labels after downloading UMD under its licence: `python -m app.score pred.nii.gz ref.nii.gz --label <value>`.
