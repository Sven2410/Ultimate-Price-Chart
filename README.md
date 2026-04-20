# Nordpool Price Chart

A Home Assistant custom Lovelace card that displays a fully interactive quarter-hour energy price chart using data from the Nordpool integration.

---

## Features

- **15-minute bar chart** — shows all available data (today + tomorrow) in a scrollable canvas chart
- **Color-coded bars** — bottom 25% of prices are green (cheap), top 25% are red (expensive), middle range in accent color
- **Interactive tooltips** — hover or tap any bar to see the exact time window, market price, and All-In price
- **"Nu" (Now) indicator** — a vertical dashed line and badge marks the current time slot; the chart auto-scrolls to it on load
- **Average price line** — a horizontal dashed line with a label shows the average price across all displayed slots
- **Day separator** — a dashed vertical line and day label separates today's data from tomorrow's
- **Stats row** — shows the lowest and highest price (with time) at a glance in the format `18.4 ct/kWh om 14:00 uur`
- **All-In toggle** — switch between raw market price and a fully calculated All-In price
- **Price configuration** — when All-In mode is on, input fields appear to set `inkoopvergoeding` and `energiebelasting` (synced with HA helpers)
- **GUI editor** — configure via the Lovelace UI editor using native `ha-form`

---

## All-In Formula

```
All-In price = (market price + inkoopvergoeding + energiebelasting) × 1.21
```

VAT is fixed at 21% and cannot be changed by the user.

---

## Prerequisites

- **Nordpool integration** installed (provides `sensor.combined_nordpool_prices` or equivalent)
- **Two input_number helpers** created in Home Assistant:

  | Helper entity ID                  | Description                   | Suggested unit |
  |-----------------------------------|-------------------------------|----------------|
  | `input_number.inkoopvergoeding`   | Supplier purchase surcharge   | €/kWh          |
  | `input_number.energiebelasting`   | Energy tax                    | €/kWh          |

---

## Installation via HACS

1. Open HACS → Frontend → Custom repositories
2. Add `https://github.com/Sven2410/nordpool-price-chart` as a **Lovelace** repository
3. Install **Nordpool Price Chart**
4. Add the resource in Settings → Dashboards → Resources:
   ```
   /hacsfiles/nordpool-price-chart/dist/nordpool-price-chart.js
   ```
5. Clear browser cache and reload

---

## Manual Installation

1. Copy `dist/nordpool-price-chart.js` to `config/www/nordpool-price-chart/`
2. Add resource in Lovelace:
   ```yaml
   url: /local/nordpool-price-chart/nordpool-price-chart.js
   type: module
   ```

---

## Configuration

### Minimal (YAML)

```yaml
type: custom:nordpool-price-chart
entity: sensor.combined_nordpool_prices
```

### Full example

```yaml
type: custom:nordpool-price-chart
entity: sensor.combined_nordpool_prices
title: Energieprijzen
```

### Options

| Option   | Type   | Default                              | Description            |
|----------|--------|--------------------------------------|------------------------|
| `entity` | string | `sensor.combined_nordpool_prices`    | Nordpool sensor entity |
| `title`  | string | `Energieprijzen`                     | Card title             |

---

## Sensor attribute format

The card reads `attributes.data` from the configured sensor. Expected structure:

```yaml
data:
  - start_time: '2026-04-20T00:00:00+02:00'
    end_time:   '2026-04-20T00:15:00+02:00'
    price_per_kwh: 0.3071
  - ...
```

---

## License

MIT © Sven2410
