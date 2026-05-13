# Camathern — Catchment Data Explorer

Environmental intelligence dashboard for West Wales catchment monitoring. Built for Carmarthenshire County Council and Aberystwyth University.

## Overview

Real-time water quality monitoring across river and coastal sites in West Wales. The dashboard joins secure device telemetry (Kuner sensors) with council-managed location records, applying quality control checks before publishing data.

### Features

- **Dashboard** — KPI metrics (flow rate, pH, dissolved oxygen, temperature) with live sync
- **Map** — Official NRW/Ceredigion catchment maps with sensor overlay and station detail panels
- **Sites** — Sensor registry with device status, access notes, and deployment readiness
- **Data** — Catchment analysis with parameter trends, threshold compliance, and detailed readings
- **Bilingual** — Full English / Welsh (Cymraeg) support

## Quick Start

```bash
cd assets
node scripts/serve.mjs
```

Open [http://localhost:4173](http://localhost:4173)

## Run Tests

```bash
node --test tests/*.mjs
```

## Project Structure

```
├── api/
│   └── openapi.yaml          # REST API contract
├── assets/
│   ├── index.html             # Single-page application shell
│   ├── src/
│   │   ├── app.js             # Navigation, state, rendering
│   │   ├── styles.css         # Design system (Inter, glassmorphism)
│   │   ├── data.js            # Site registry & sensor payloads
│   │   ├── i18n.js            # EN/CY translations
│   │   ├── dashboard-model.js # QC logic & dashboard snapshot
│   │   └── water-flow.js      # Canvas background animation
│   └── scripts/
│       └── serve.mjs          # Development server
├── tests/
│   ├── dashboard-model.test.mjs
│   ├── ui-copy.test.mjs
│   └── i18n.test.mjs
└── package.json
```

## Data Architecture

Device payloads carry sensor ID only — no coordinates. Locations are joined from the council's SharePoint registry at render time, ensuring operational site data stays in the secure registry.

Quality control flags tidal exposure (`sensorDepthM < 0.12`) and out-of-water signatures (`DO > 13 mg/L`) before data reaches the public view.

## Partners

- Carmarthenshire County Council
- Aberystwyth University
- Natural Resources Wales (NRW)

## Licence

Copyright © 2025-2026 EMWAC Programme. All rights reserved.
