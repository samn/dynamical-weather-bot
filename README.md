# dynamical-weather-bot

Personalized probabilistic weather digests powered by [dynamical.org](https://dynamical.org) GEFS ensemble data.

Enter a location (browser geolocation or US ZIP code) to get a 72-hour forecast showing temperature, precipitation, wind speed, and cloud cover with uncertainty ranges across 31 ensemble members.

## Prerequisites

- [mise](https://mise.jdx.dev) for toolchain management

## Setup

```sh
mise install          # install Node 24 and prek
npm install           # install dependencies
prek install          # install pre-commit hooks
```

## Development

```sh
npm run dev           # start Vite dev server
npm run build         # production build
npm run preview       # preview production build
```

## Checks

```sh
npm run check         # run all checks (fmt, typecheck, lint, test)
npm run fmt           # format with oxfmt
npm run fmt:check     # check formatting without writing
npm run typecheck     # type check with tsc
npm run lint          # lint with oxlint
npm test              # run tests with vitest
```
