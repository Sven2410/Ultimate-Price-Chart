/**
 * Nordpool Price Chart — Home Assistant Custom Card
 * @version 1.0.0
 * @author Sven2410
 */

const VERSION = '1.2.0';
console.info(
  `%c NORDPOOL-PRICE-CHART %c v${VERSION} `,
  'background:#026FA1;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:bold',
  'background:#333;color:#fff;padding:2px 6px;border-radius:0 4px 4px 0'
);

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const fmt = (d) => {
  if (!(d instanceof Date)) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const roundRect = (ctx, x, y, w, h, r) => {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
};

// ─────────────────────────────────────────────
//  EDITOR
// ─────────────────────────────────────────────
class NordpoolPriceChartEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass   = null;
    this._ready  = false;
  }

  set hass(h) {
    this._hass = h;
    if (this._ready) {
      const f = this.querySelector('ha-form');
      if (f) f.hass = h;
    } else {
      this._init();
    }
  }

  setConfig(c) {
    this._config = {
      entity: 'sensor.current_electricity_market_price',
      title:  'Energieprijzen',
      ...c,
    };
    if (this._ready) {
      const f = this.querySelector('ha-form');
      if (f) f.data = this._data();
    } else {
      this._init();
    }
  }

  _data() {
    return {
      entity: this._config.entity || 'sensor.current_electricity_market_price',
      title:  this._config.title  || 'Energieprijzen',
    };
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } },
      bubbles: true,
      composed: true,
    }));
  }

  _init() {
    if (!this._hass || this._ready) return;
    this._ready = true;
    this.innerHTML = '<ha-form></ha-form>';
    const form = this.querySelector('ha-form');
    form.hass   = this._hass;
    form.schema = [
      { name: 'entity', selector: { entity: { domain: 'sensor' } }, label: 'Nordpool sensor' },
      { name: 'title',  selector: { text: {} },                     label: 'Kaart titel'      },
    ];
    form.data = this._data();
    form.addEventListener('value-changed', (e) => {
      const v = e.detail.value || {};
      let changed = false;
      for (const k of Object.keys(this._config)) {
        if (v[k] !== undefined && v[k] !== this._config[k]) {
          this._config[k] = v[k];
          changed = true;
        }
      }
      if (changed) this._fire();
    });
  }
}

// ─────────────────────────────────────────────
//  CARD
// ─────────────────────────────────────────────
class NordpoolPriceChart extends HTMLElement {

  static getConfigElement() {
    return document.createElement('nordpool-price-chart-editor');
  }

  static getStubConfig() {
    return { entity: 'sensor.current_electricity_market_price', title: 'Energieprijzen' };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config   = {};
    this._hass     = null;
    this._domBuilt = false;
    this._allIn    = false;
    this._barData  = [];
    this._nowScrolled = false;
  }

  setConfig(config) {
    if (!config.entity) throw new Error('Geen entiteit geconfigureerd');
    this._config = {
      entity: 'sensor.current_electricity_market_price',
      title:  'Energieprijzen',
      ...config,
    };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  // ── Data helpers ──────────────────────────

  _getPriceData() {
    const state = this._hass?.states[this._config.entity];
    if (!state) return [];
    const attr = state.attributes || {};

    // ── Helpers ──
    const toDate = (v) => v ? new Date(v) : null;
    const validEntry = (d) => d.start instanceof Date && !isNaN(d.start)
                           && d.end   instanceof Date && !isNaN(d.end)
                           && typeof d.price === 'number';
    // Auto-detect €/MWh vs €/kWh: values > 1 (excl. negatives) indicate MWh
    const autoDiv = (arr, key) => {
      const pos = arr.find((d) => (d[key] ?? 0) > 1);
      return pos ? 1000 : 1;
    };

    // ── Format 1 (Frank Energie / Tibber style) ──
    // attributes.prices: [{from, till, price}]  — price already in €/kWh
    if (Array.isArray(attr.prices) && attr.prices.length) {
      return attr.prices
        .map((d) => ({
          start: toDate(d.from  ?? d.start ?? d.start_time),
          end:   toDate(d.till  ?? d.end   ?? d.end_time),
          price: d.price ?? d.value ?? 0,
        }))
        .filter(validEntry)
        .sort((a, b) => a.start - b.start);
    }

    // ── Format 2: combined template sensor ──
    // attributes.data: [{start_time, end_time, price_per_kwh}]
    if (Array.isArray(attr.data) && attr.data.length) {
      return attr.data
        .map((d) => ({
          start: toDate(d.start_time ?? d.start),
          end:   toDate(d.end_time   ?? d.end),
          price: d.price_per_kwh ?? d.price ?? 0,
        }))
        .filter(validEntry)
        .sort((a, b) => a.start - b.start);
    }

    // ── Format 3: native Nordpool (raw_today / raw_tomorrow) ──
    // attributes.raw_today: [{start, end, value}]
    const rawToday    = attr.raw_today    || attr.prices_today    || [];
    const rawTomorrow = attr.raw_tomorrow || attr.prices_tomorrow || [];
    const combined    = [...rawToday, ...rawTomorrow];

    if (combined.length) {
      const div = autoDiv(combined, 'value');
      return combined
        .map((d) => ({
          start: toDate(d.start ?? d.start_time),
          end:   toDate(d.end   ?? d.end_time),
          price: (d.value ?? d.price ?? 0) / div,
        }))
        .filter(validEntry)
        .sort((a, b) => a.start - b.start);
    }

    // ── Format 4: simple today/tomorrow float arrays ──
    // attributes.today: [0.307, 0.289, ...]  (one float per hour from 00:00)
    const todayArr    = attr.today    || [];
    const tomorrowArr = attr.tomorrow || [];

    if (todayArr.length || tomorrowArr.length) {
      const result = [];
      const buildSlots = (arr, baseDate) => {
        const div = autoDiv(arr.map((v) => ({ p: v })), 'p');
        arr.forEach((price, i) => {
          const start = new Date(baseDate);
          start.setHours(i, 0, 0, 0);
          const end = new Date(start);
          end.setHours(i + 1);
          result.push({ start, end, price: (typeof price === 'number' ? price : 0) / div });
        });
      };
      const today    = new Date(); today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      buildSlots(todayArr,    today);
      buildSlots(tomorrowArr, tomorrow);
      return result.filter(validEntry);
    }

    return [];
  }

  _getHelper(entityId) {
    const s = this._hass?.states[entityId];
    return s ? (parseFloat(s.state) || 0) : 0;
  }

  _toAllIn(marketEuro) {
    const inkoop    = this._getHelper('input_number.inkoopvergoeding');
    const belasting = this._getHelper('input_number.energiebelasting');
    return (marketEuro + inkoop + belasting) * 1.21;
  }

  _displayPrice(item) {
    return this._allIn ? this._toAllIn(item.price) : item.price;
  }

  // ── DOM lifecycle ─────────────────────────

  _render() {
    if (!this._domBuilt) {
      this._buildDOM();
      this._domBuilt = true;
    }
    this._updateDOM();
  }

  _buildDOM() {
    this.shadowRoot.innerHTML = `
<style>
  :host { display: block; }

  ha-card {
    padding: 16px 16px 14px;
    box-sizing: border-box;
    overflow: visible !important;
  }

  /* ── Header ─────────────────────── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 14px;
  }
  .title {
    font-size: 1rem;
    font-weight: 700;
    color: var(--primary-text-color);
    letter-spacing: 0.2px;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .toggle-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--secondary-text-color);
    transition: color 0.2s;
  }
  .toggle-label.active { color: var(--primary-color); }

  /* ── Toggle switch ───────────────── */
  .toggle {
    position: relative;
    width: 46px;
    height: 26px;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    flex-shrink: 0;
  }
  .toggle input { opacity:0; width:0; height:0; position:absolute; }
  .toggle-track {
    position: absolute;
    inset: 0;
    border-radius: 13px;
    background: var(--divider-color);
    transition: background 0.25s ease;
  }
  .toggle input:checked ~ .toggle-track { background: var(--primary-color); }
  .toggle-thumb {
    position: absolute;
    top: 3px; left: 3px;
    width: 20px; height: 20px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 5px rgba(0,0,0,0.35);
    transition: transform 0.25s cubic-bezier(.4,0,.2,1);
  }
  .toggle input:checked ~ .toggle-thumb { transform: translateX(20px); }

  /* ── Chart area ──────────────────── */
  .chart-wrapper {
    position: relative;
    width: 100%;
    margin-bottom: 12px;
  }
  .chart-scroll {
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: var(--divider-color) transparent;
    cursor: crosshair;
  }
  .chart-scroll::-webkit-scrollbar { height: 3px; }
  .chart-scroll::-webkit-scrollbar-thumb {
    background: var(--divider-color);
    border-radius: 2px;
  }
  canvas { display: block; }

  /* ── Tooltip ─────────────────────── */
  .tooltip {
    position: absolute;
    top: 0; left: 0;
    background: var(--card-background-color, rgba(24,24,36,0.96));
    border: 1px solid var(--divider-color);
    border-radius: 10px;
    padding: 9px 13px;
    font-size: 0.76rem;
    color: var(--primary-text-color);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s, transform 0.12s;
    transform: translateY(4px);
    white-space: nowrap;
    z-index: 200;
    box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  }
  .tooltip.visible { opacity:1; transform:translateY(0); }
  .tt-time  { font-weight: 700; color: var(--primary-color); margin-bottom:3px; }
  .tt-market{ color: var(--primary-text-color); }
  .tt-allin { color: var(--secondary-text-color); font-size:0.7rem; margin-top:2px; }
  .tt-sep   { height:1px; background:var(--divider-color); margin: 5px 0; }

  /* ── Stats ───────────────────────── */
  .stats {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 12px;
  }
  .stat-card {
    padding: 10px 13px;
    border-radius: 12px;
    background: var(--secondary-background-color);
    border: 1px solid var(--divider-color);
  }
  .stat-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--secondary-text-color);
    margin-bottom: 4px;
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    display: inline-block;
    flex-shrink: 0;
  }
  .stat-value {
    font-size: 1.05rem;
    font-weight: 700;
    color: var(--primary-text-color);
    line-height: 1.2;
  }
  .stat-time {
    font-size: 0.7rem;
    color: var(--secondary-text-color);
    margin-top: 2px;
  }

  /* ── Price config ────────────────── */
  .price-config {
    border-top: 1px solid var(--divider-color);
    padding-top: 12px;
    display: none;
  }
  .price-config.visible { display: block; }
  .config-title {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--secondary-text-color);
    margin-bottom: 10px;
  }
  .config-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .config-field { display:flex; flex-direction:column; gap:4px; }
  .config-field label {
    font-size: 0.7rem;
    color: var(--secondary-text-color);
  }
  .config-field input {
    background: var(--secondary-background-color);
    border: 1.5px solid var(--divider-color);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.88rem;
    color: var(--primary-text-color);
    width: 100%;
    box-sizing: border-box;
    min-height: 44px;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    outline: none;
    transition: border-color 0.2s;
    -moz-appearance: textfield;
  }
  .config-field input::-webkit-outer-spin-button,
  .config-field input::-webkit-inner-spin-button { -webkit-appearance: none; }
  .config-field input:focus { border-color: var(--primary-color); }
  .config-note {
    font-size: 0.65rem;
    color: var(--secondary-text-color);
    margin-top: 9px;
    opacity: 0.65;
    line-height: 1.5;
  }
</style>

<ha-card>
  <!-- Header -->
  <div class="header">
    <div class="title" id="card-title">Energieprijzen</div>
    <div class="toggle-row">
      <span class="toggle-label" id="toggle-label">Marktprijs</span>
      <label class="toggle" title="Schakel All-In prijs in/uit">
        <input type="checkbox" id="allin-toggle">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
    </div>
  </div>

  <!-- Chart -->
  <div class="chart-wrapper">
    <div class="chart-scroll" id="chart-scroll">
      <canvas id="chart-canvas"></canvas>
    </div>
    <div class="tooltip" id="tooltip">
      <div class="tt-time"   id="tt-time"></div>
      <div class="tt-sep"></div>
      <div class="tt-market" id="tt-market"></div>
      <div class="tt-allin"  id="tt-allin"></div>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat-card">
      <div class="stat-label">
        <span class="dot" style="background:#22c55e"></span>
        Laagste prijs
      </div>
      <div class="stat-value" id="stat-low-val">—</div>
      <div class="stat-time"  id="stat-low-time">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">
        <span class="dot" style="background:#ef4444"></span>
        Hoogste prijs
      </div>
      <div class="stat-value" id="stat-high-val">—</div>
      <div class="stat-time"  id="stat-high-time">—</div>
    </div>
  </div>

  <!-- Price config -->
  <div class="price-config" id="price-config">
    <div class="config-title">Prijsconfiguratie</div>
    <div class="config-grid">
      <div class="config-field">
        <label for="inp-inkoop">Inkoopvergoeding (€/kWh)</label>
        <input type="number" id="inp-inkoop" step="0.0001" min="0" placeholder="0.0000">
      </div>
      <div class="config-field">
        <label for="inp-belasting">Energiebelasting (€/kWh)</label>
        <input type="number" id="inp-belasting" step="0.0001" min="0" placeholder="0.0000">
      </div>
    </div>
    <div class="config-note">
      Formule: (marktprijs + inkoopvergoeding + energiebelasting) × 1,21 &nbsp;|&nbsp; BTW: 21% (vast)
    </div>
  </div>
</ha-card>`;

    this._bindEvents();
  }

  // ── Event binding ─────────────────────────

  _bindEvents() {
    // Toggle
    const toggle = this.shadowRoot.getElementById('allin-toggle');
    toggle.addEventListener('change', () => {
      this._allIn = toggle.checked;
      this._updateDOM();
    });

    // Helper inputs — debounced service call on change
    const debounce = (fn, ms) => {
      let t;
      return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
    };

    const inpInkoop    = this.shadowRoot.getElementById('inp-inkoop');
    const inpBelasting = this.shadowRoot.getElementById('inp-belasting');

    inpInkoop.addEventListener('change', debounce(() => {
      const v = parseFloat(inpInkoop.value);
      if (!isNaN(v) && this._hass) {
        this._hass.callService('input_number', 'set_value', {
          entity_id: 'input_number.inkoopvergoeding',
          value: v,
        });
      }
    }, 500));

    inpBelasting.addEventListener('change', debounce(() => {
      const v = parseFloat(inpBelasting.value);
      if (!isNaN(v) && this._hass) {
        this._hass.callService('input_number', 'set_value', {
          entity_id: 'input_number.energiebelasting',
          value: v,
        });
      }
    }, 500));

    // Canvas tooltip interactions
    this._bindCanvasTooltip();
  }

  _bindCanvasTooltip() {
    const canvas  = this.shadowRoot.getElementById('chart-canvas');
    const tooltip = this.shadowRoot.getElementById('tooltip');
    const scroll  = this.shadowRoot.getElementById('chart-scroll');

    let touchStartX = 0, touchStartY = 0, isDragging = false;

    const getBarAtX = (canvasAbsX) => {
      return this._barData.find((b) => canvasAbsX >= b.x && canvasAbsX < b.x + b.w) || null;
    };

    const showTip = (canvasAbsX, relY) => {
      const bar = getBarAtX(canvasAbsX);
      if (!bar) { hideTip(); return; }

      const ttTime   = this.shadowRoot.getElementById('tt-time');
      const ttMarket = this.shadowRoot.getElementById('tt-market');
      const ttAllin  = this.shadowRoot.getElementById('tt-allin');

      ttTime.textContent   = `${fmt(bar.start)} – ${fmt(bar.end)} uur`;
      ttMarket.textContent = `Marktprijs: ${(bar.market * 100).toFixed(2)} ct/kWh`;

      if (this._allIn) {
        ttAllin.textContent = `All-In: ${(bar.allin * 100).toFixed(2)} ct/kWh`;
        ttAllin.style.display = 'block';
      } else {
        ttAllin.style.display = 'none';
      }

      tooltip.classList.add('visible');

      // Position after next paint
      requestAnimationFrame(() => {
        const wrapW  = scroll.clientWidth;
        const barScr = bar.x - scroll.scrollLeft + bar.w / 2; // bar center in viewport
        const tipW   = tooltip.offsetWidth;
        const tipH   = tooltip.offsetHeight;
        let tx = barScr - tipW / 2;
        let ty = relY - tipH - 12;

        tx = Math.max(4, Math.min(wrapW - tipW - 4, tx));
        if (ty < 4) ty = relY + 20;

        tooltip.style.left = `${tx}px`;
        tooltip.style.top  = `${ty}px`;
      });
    };

    const hideTip = () => tooltip.classList.remove('visible');

    // Mouse
    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      showTip(
        e.clientX - rect.left + scroll.scrollLeft,
        e.clientY - rect.top
      );
    });
    canvas.addEventListener('mouseleave', hideTip);

    // Touch
    canvas.addEventListener('touchstart', (e) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      isDragging  = false;
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - touchStartX);
      const dy = Math.abs(e.touches[0].clientY - touchStartY);
      if (dx > 8) isDragging = true;
      if (dx > dy) e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      showTip(
        e.touches[0].clientX - rect.left + scroll.scrollLeft,
        e.touches[0].clientY - rect.top
      );
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (!isDragging) {
        const t    = e.changedTouches[0];
        const rect = canvas.getBoundingClientRect();
        showTip(t.clientX - rect.left + scroll.scrollLeft, t.clientY - rect.top);
        setTimeout(hideTip, 2000);
      } else {
        hideTip();
      }
    });
  }

  // ── DOM updates ───────────────────────────

  _updateDOM() {
    if (!this._hass) return;

    const data = this._getPriceData();

    // Title & toggle label
    const titleEl       = this.shadowRoot.getElementById('card-title');
    const toggleLabel   = this.shadowRoot.getElementById('toggle-label');
    const toggleEl      = this.shadowRoot.getElementById('allin-toggle');
    const priceConfigEl = this.shadowRoot.getElementById('price-config');

    if (titleEl)       titleEl.textContent = this._config.title || 'Energieprijzen';
    if (toggleLabel) {
      toggleLabel.textContent = this._allIn ? 'All-In' : 'Marktprijs';
      toggleLabel.classList.toggle('active', this._allIn);
    }
    if (toggleEl)       toggleEl.checked = this._allIn;
    if (priceConfigEl)  priceConfigEl.classList.toggle('visible', this._allIn);

    // Helper input values (only update if not focused)
    const inpInkoop    = this.shadowRoot.getElementById('inp-inkoop');
    const inpBelasting = this.shadowRoot.getElementById('inp-belasting');
    const sr           = this.shadowRoot;

    if (inpInkoop && sr.activeElement !== inpInkoop) {
      inpInkoop.value = this._getHelper('input_number.inkoopvergoeding').toFixed(4);
    }
    if (inpBelasting && sr.activeElement !== inpBelasting) {
      inpBelasting.value = this._getHelper('input_number.energiebelasting').toFixed(4);
    }

    if (!data.length) return;

    // Compute display prices
    const withDisplay = data.map((d) => ({
      ...d,
      market: d.price,
      allin:  this._toAllIn(d.price),
      display: this._displayPrice(d),
    }));

    // Stats: lowest & highest
    const minItem = withDisplay.reduce((a, b) => b.display < a.display ? b : a);
    const maxItem = withDisplay.reduce((a, b) => b.display > a.display ? b : a);

    const centStr = (v) => `${(v * 100).toFixed(1)} ct/kWh`;

    const el = (id) => this.shadowRoot.getElementById(id);
    el('stat-low-val').textContent  = centStr(minItem.display);
    el('stat-low-time').textContent = `om ${fmt(minItem.start)} uur`;
    el('stat-high-val').textContent = centStr(maxItem.display);
    el('stat-high-time').textContent= `om ${fmt(maxItem.start)} uur`;

    // Draw
    this._drawChart(withDisplay);
  }

  // ── Canvas chart ──────────────────────────

  _drawChart(prices) {
    const canvas = this.shadowRoot.getElementById('chart-canvas');
    if (!canvas) return;

    const BAR_W   = 7;
    const BAR_GAP = 1;
    const H_CHART = 230;
    const PAD_TOP = 28;
    const PAD_BOT = 46;
    const PAD_L   = 44;
    const PAD_R   = 12;

    const totalW = PAD_L + prices.length * (BAR_W + BAR_GAP) + PAD_R;
    canvas.width  = totalW;
    canvas.height = H_CHART;

    const ctx  = canvas.getContext('2d');
    const drawH = H_CHART - PAD_TOP - PAD_BOT;

    ctx.clearRect(0, 0, totalW, H_CHART);

    // CSS variables resolved from host element
    const cs          = getComputedStyle(this);
    const primaryColor = cs.getPropertyValue('--primary-color').trim()             || '#026FA1';
    const textColor    = cs.getPropertyValue('--secondary-text-color').trim()      || '#9ca3af';
    const dividerColor = cs.getPropertyValue('--divider-color').trim()             || 'rgba(128,128,128,0.25)';
    const primaryText  = cs.getPropertyValue('--primary-text-color').trim()        || '#e2e8f0';

    const minP   = Math.min(...prices.map((p) => p.display));
    const maxP   = Math.max(...prices.map((p) => p.display));
    // Add a little headroom above max and below min (but always include 0 in range)
    const rangeMin = Math.min(minP, 0);
    const rangeMax = Math.max(maxP, 0);
    const range    = (rangeMax - rangeMin) || 0.001;
    const avgP     = prices.reduce((s, p) => s + p.display, 0) / prices.length;
    const hasNeg   = minP < 0;

    // Thresholds: bottom 25% = cheap, top 25% = expensive
    const sorted   = [...prices].sort((a, b) => a.display - b.display);
    const cheapThr = sorted[Math.floor(sorted.length * 0.25)]?.display ?? rangeMin;
    const expThr   = sorted[Math.floor(sorted.length * 0.75)]?.display ?? rangeMax;

    // Y mapping — 0 is always in view
    const priceToY = (p) => PAD_TOP + drawH - ((p - rangeMin) / range) * drawH;
    const zeroY    = priceToY(0);

    // ── Grid lines & Y labels ──
    const gridSteps = 5;
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([3, 4]);

    for (let i = 0; i <= gridSteps; i++) {
      const frac = i / gridSteps;
      const p    = rangeMin + range * (1 - frac);
      const y    = PAD_TOP + drawH * frac;

      ctx.strokeStyle = dividerColor;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(totalW - PAD_R, y);
      ctx.stroke();

      ctx.fillStyle  = textColor;
      ctx.font       = '9px system-ui,sans-serif';
      ctx.textAlign  = 'right';
      ctx.fillText(`${(p * 100).toFixed(0)}`, PAD_L - 5, y + 3);
    }

    ctx.setLineDash([]);

    // ── Zero baseline (only when negative prices exist) ──
    if (hasNeg) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(PAD_L, zeroY);
      ctx.lineTo(totalW - PAD_R, zeroY);
      ctx.stroke();
      ctx.fillStyle  = 'rgba(255,255,255,0.5)';
      ctx.font       = 'bold 8px system-ui,sans-serif';
      ctx.textAlign  = 'right';
      ctx.fillText('0', PAD_L - 5, zeroY + 3);
      ctx.restore();
    }

    // Y-axis unit
    ctx.save();
    ctx.translate(10, PAD_TOP + drawH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle  = textColor;
    ctx.font       = '8px system-ui,sans-serif';
    ctx.textAlign  = 'center';
    ctx.fillText('ct/kWh', 0, 0);
    ctx.restore();

    // ── Average line ──
    const avgY = priceToY(avgP);
    ctx.save();
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth   = 1.5;
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(PAD_L, avgY);
    ctx.lineTo(totalW - PAD_R, avgY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Avg label bubble
    ctx.globalAlpha = 0.85;
    const avgLabel  = `⌀ ${(avgP * 100).toFixed(1)}`;
    ctx.font        = 'bold 8px system-ui,sans-serif';
    const lw        = ctx.measureText(avgLabel).width + 8;
    ctx.fillStyle   = primaryColor;
    roundRect(ctx, PAD_L + 3, avgY - 9, lw, 11, 3);
    ctx.fill();
    ctx.fillStyle   = '#fff';
    ctx.textAlign   = 'left';
    ctx.fillText(avgLabel, PAD_L + 7, avgY);
    ctx.restore();

    // ── Bars ──
    const now     = new Date();
    this._barData = [];

    prices.forEach((item, i) => {
      const x      = PAD_L + i * (BAR_W + BAR_GAP);
      const isCur  = item.start <= now && now < item.end;
      const isNeg  = item.display < 0;

      // Bar from zero line up (positive) or down (negative)
      const topY   = isNeg ? zeroY                 : priceToY(item.display);
      const botY   = isNeg ? priceToY(item.display) : zeroY;
      const barH   = Math.max(3, botY - topY);

      // Color: negative = bright cyan/teal (you get paid!), else normal scale
      let color;
      if      (isNeg)                        color = '#06b6d4'; // teal — negatief = gratis stroom
      else if (item.display <= cheapThr)     color = '#22c55e';
      else if (item.display >= expThr)       color = '#ef4444';
      else                                   color = primaryColor;

      ctx.save();
      ctx.globalAlpha = isCur ? 1.0 : 0.72;
      ctx.fillStyle   = color;

      if (isCur) {
        ctx.shadowColor = color;
        ctx.shadowBlur  = 10;
      }

      // Positive bars: round top; negative bars: round bottom
      if (isNeg) {
        roundRect(ctx, x, topY, BAR_W, barH, [0, 0, 2, 2]);
      } else {
        roundRect(ctx, x, topY, BAR_W, barH, [2, 2, 0, 0]);
      }
      ctx.fill();
      ctx.restore();

      this._barData.push({
        x, w: BAR_W + BAR_GAP,
        start: item.start, end: item.end,
        market: item.market, allin: item.allin,
        display: item.display,
      });
    });

    // ── "Nu" vertical line ──
    const nowIdx = prices.findIndex((p) => p.start <= now && now < p.end);
    if (nowIdx >= 0) {
      const nowX = PAD_L + nowIdx * (BAR_W + BAR_GAP) + Math.floor(BAR_W / 2);
      ctx.save();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.globalAlpha = 0.85;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(nowX, PAD_TOP - 4);
      ctx.lineTo(nowX, PAD_TOP + drawH + 4);
      ctx.stroke();
      ctx.setLineDash([]);

      // "Nu" badge
      ctx.globalAlpha = 1;
      ctx.fillStyle   = '#fff';
      ctx.font        = 'bold 8px system-ui,sans-serif';
      ctx.textAlign   = 'center';
      const badge     = 'Nu';
      const bw        = ctx.measureText(badge).width + 6;
      roundRect(ctx, nowX - bw / 2, PAD_TOP - 16, bw, 12, 3);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.fillText(badge, nowX, PAD_TOP - 7);
      ctx.restore();

      // Auto-scroll to "Nu" (only once per load)
      if (!this._nowScrolled) {
        this._nowScrolled = true;
        const scroll = this.shadowRoot.getElementById('chart-scroll');
        if (scroll) {
          requestAnimationFrame(() => {
            const target = nowX - scroll.clientWidth / 2;
            scroll.scrollLeft = Math.max(0, target);
          });
        }
      }
    }

    // ── X-axis: time labels & day separators ──
    ctx.fillStyle   = textColor;
    ctx.font        = '8px system-ui,sans-serif';
    ctx.strokeStyle = dividerColor;
    ctx.lineWidth   = 0.5;

    let lastDay  = null;
    let lastHour = -1;

    prices.forEach((item, i) => {
      const x   = PAD_L + i * (BAR_W + BAR_GAP) + Math.floor(BAR_W / 2);
      const day = item.start.getDate();
      const h   = item.start.getHours();
      const m   = item.start.getMinutes();

      // Day separator
      if (lastDay !== null && day !== lastDay) {
        ctx.save();
        ctx.strokeStyle = dividerColor;
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x - BAR_W, PAD_TOP - 2);
        ctx.lineTo(x - BAR_W, PAD_TOP + drawH + 28);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();

        // Day label
        const dayStr = item.start.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
        ctx.fillStyle  = textColor;
        ctx.font       = 'bold 8px system-ui,sans-serif';
        ctx.textAlign  = 'left';
        ctx.globalAlpha = 0.8;
        ctx.fillText(dayStr, x - BAR_W + 4, PAD_TOP + drawH + 38);
        ctx.globalAlpha = 1;
      }

      // Hour label every 3 hours, on the hour
      if (m === 0 && h !== lastHour && h % 3 === 0) {
        lastHour = h;
        ctx.fillStyle  = textColor;
        ctx.font       = '8px system-ui,sans-serif';
        ctx.textAlign  = 'center';
        ctx.fillText(`${String(h).padStart(2, '0')}:00`, x, PAD_TOP + drawH + 14);

        // tick
        ctx.beginPath();
        ctx.moveTo(x, PAD_TOP + drawH + 2);
        ctx.lineTo(x, PAD_TOP + drawH + 6);
        ctx.stroke();
      }

      lastDay = day;
    });
  }
}

// ─────────────────────────────────────────────
//  REGISTRATIE
// ─────────────────────────────────────────────
if (!customElements.get('nordpool-price-chart-editor')) {
  customElements.define('nordpool-price-chart-editor', NordpoolPriceChartEditor);
}
if (!customElements.get('nordpool-price-chart')) {
  customElements.define('nordpool-price-chart', NordpoolPriceChart);
}

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c.type === 'nordpool-price-chart')) {
  window.customCards.push({
    type:        'nordpool-price-chart',
    name:        'Nordpool Prijsgrafiek',
    description: 'Interactieve kwartiergrafiek voor Nordpool energieprijzen met All-In berekening',
    preview:     false,
  });
}
