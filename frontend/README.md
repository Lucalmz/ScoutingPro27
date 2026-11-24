# ScoutingPro27 Frontend (`frontend/`)

Vue 3 + TypeScript 6 + Vite 8 (Rolldown) offline-first PWA frontend for ScoutingPro27.

- **Project Overview**: [README.md](../README.md) · [README_en.md](../README_en.md)
- **API, WebSocket, CRDT & JCEF Contract**: [CONTRACT.md](../CONTRACT.md)
- **User Guides**: [docs/USER_GUIDE.md](../docs/USER_GUIDE.md)

---

## Prerequisites

- **Node.js**: `^22.18.0 || >=24.12.0` (CI runs Node 24)
- **IDE (Recommended)**: VS Code + Vue (Official / Volar), with Vetur disabled

## Setup & Scripts

```sh
npm install
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start Vite dev server with HMR |
| `npm run type-check` | Run `vue-tsc --build` static type checking |
| `npm run build` | Type-check and build bundled assets into `Backend/src/main/resources/public/` |
| `npm run build:pwa` | Build standalone static PWA bundle into `frontend/dist-pwa/` |
| `npm test` | Run Vitest unit & component suite (`vitest run`, 95 files / 811 tests) |
| `npm run test:e2e` | Run all 4 canonical Puppeteer E2E suites sequentially |
| `npm run test:e2e:multi` | Run 12-step multi-host disaster-recovery E2E (`e2e/multi-client.e2e.js`; `test:e2e:ui` shows browser UI) |
| `npm run test:e2e:qr` | Run QR mobile join & single-handed wizard E2E (`e2e/qr-mobile-join.e2e.js`) |
| `npm run test:e2e:inbox` | Run Inbox outbox/delivery E2E (`e2e/inbox-lifecycle.e2e.js`) |
| `npm run test:e2e:interactive` | Run full-interaction E2E (`e2e/comprehensive-interactive.e2e.js`) |
| `npm run capture:userguide` | Regenerate 17 ZH + 17 EN annotated guide screenshots into `docs/images/userguide/` *(gitignored)* |
| `npm run export:userguide-pdf` | Export `docs/ScoutingPro27_UserGuide_ZH.pdf` & `_EN.pdf` *(gitignored)* |

## Directory Layout

- `src/` — Views, components (`ai/`, `pit/`, `rankings/`, `schedule/`, `scouting/`, `whiteboard/`, `customFields/`, `common/`, `history/`), Pinia stores, TinyBase CRDT/HLC + WebRTC + CalibratedClock services, i18n (`en.json` / `zh.json`, 1,430 keys each), and unit tests (`src/__tests__/`).
- `e2e/` — Canonical Puppeteer E2E suites and multi-JVM H2 cluster helpers (`e2e/helpers/`).
- `generators/` — Standalone visual capture, offline PDF export, and judge demo scripts (`capture-userguide-screens.js`, `export-userguide-pdf.js`, `capture-promo-screens.js`, `demo-judges.js`).
