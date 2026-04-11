# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Probabilistic weather forecast web app that fetches GEFS ensemble data from dynamical.org's Zarr stores and renders interactive charts showing uncertainty ranges (median, p10-p90, min-max).

## Setup

Run `mise install` to set up the project toolchain (Node 24, prek). Then run `prek install` to install pre-commit hooks. See `mise.toml`.

## Commands

- `npm run dev` — Start Vite dev server
- `npm run build` — Production build
- `npm run check` — Run all checks (fmt:check + typecheck + lint + test)
- `npm run fmt` — Format with oxfmt
- `npm run fmt:check` — Check formatting without writing
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`)
- `npm run lint` — Lint with oxlint (`oxlint src/ --deny-warnings`)
- `npm test` — Run tests (`vitest run`)
- `npm run test:watch` — Run tests in watch mode
- `npx vitest run --coverage` — Run tests with coverage (must meet 90% threshold for statements, branches, functions, and lines)

Pre-commit hooks run oxlint, typecheck, and tests on all commits.

## Pre-commit Checks

**IMPORTANT:** Before every commit, you MUST run `npm run check` and fix all errors. This runs formatting, type checking, linting, and tests. Do not commit until all checks pass. Do not skip or bypass these checks (e.g. never use `--no-verify`).

**Workflow:** After making ANY code change, immediately run `npm run check` to verify correctness. Fix all failures before committing. Never commit without a passing `npm run check` first. When adding or modifying code that has test coverage, run `npx vitest run --coverage` to verify that coverage thresholds (90% for statements, branches, functions, and lines) are still met.

## Architecture

**Data flow:** User provides location (geolocation or ZIP) → fetch GEFS forecast from dynamical.org Zarr stores → compute ensemble statistics → detect aberrations within forecast data → render canvas charts.

Key modules in `src/`:
- **types.ts** — Shared interfaces: `LatLon`, `ForecastPoint` (ensemble stats per timestep), `ForecastData`, `Aberration`
- **weather.ts** — Zarr data fetching via `zarrita`. Reads forecast (5D: init_time, ensemble_member, lead_time, lat, lon) stores. Computes percentiles across 31 ensemble members for 72-hour forecasts at 3-hour intervals
- **aberrations.ts** — Detects anomalies within the forecast data visible on the charts; flags temperature swings, precipitation, wind, cloud cover trends
- **geo.ts** — Browser geolocation API and ZIP code lookup (zippopotam.us API); longitude normalization for GEFS grid
- **chart.ts** — Canvas 2D rendering of probabilistic forecast charts with uncertainty bands
- **main.ts** — DOM wiring and event handlers

## Key Details

- GEFS grid is 0.25° resolution. Lat index: `(90 - lat) / 0.25`, Lon index: `(lon + 180) / 0.25`
- Zarr coordinate arrays may be BigInt64Array (int64 seconds since epoch) — `coordToNumbers()` in weather.ts handles conversion
- Units: temperature in °C, precipitation converted from kg/m²/s to mm/hr, wind from u/v components to speed in m/s, cloud cover from percent to fraction
- Deploys to Cloudflare Pages (wrangler.toml)
- Linter is oxlint (not eslint) with `--deny-warnings` — all warnings are errors
- TypeScript strict mode with `noUncheckedIndexedAccess`
