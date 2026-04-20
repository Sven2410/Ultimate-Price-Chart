/**
 * Nordpool Price Chart — Home Assistant Custom Card
 * @version 1.3.0
 * @author Sven2410
 */

const VERSION = '1.3.0';
console.info(
  `%c NORDPOOL-PRICE-CHART %c v${VERSION} `,
  'background:#026FA1;color:#fff;padding:2px 6px;border-radius:4px 0 0 4px;font-weight:bold',
  'background:#333;color:#fff;padding:2px 6px;border-radius:0 4px 4px 0'
);

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────
const fmt = (d) => {
  if (!(d instanceof Date) || isNaN(d)) return '—';
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
};

const roundRect = (ctx, x, y, w, h, radii) => {
  const r = Array.isArray(radii) ? radii : [radii,radii,radii,radii];
  const [tl,tr,br,bl] = r.map(v => Math.min(v, Math.abs(w)/2, Math.abs(h)/2));
  ctx.beginPath();
  ctx.moveTo(x+tl, y);
  ctx.lineTo(x+w-tr, y);
  ctx.arcTo(x+w, y,   x+w, y+h, tr);
  ctx.lineTo(x+w, y+h-br);
  ctx.arcTo(x+w, y+h, x,   y+h, br);
  ctx.lineTo(x+bl, y+h);
  ctx.arcTo(x,   y+h, x,   y,   bl);
  ctx.lineTo(x, y+tl);
  ctx.arcTo(x,   y,   x+w, y,   tl);
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
    if (this._ready) { const f = this.querySelector('ha-form'); if (f) f.hass = h; }
    else this._init();
  }

  setConfig(c) {
    this._config = { entity: 'sensor.current_electricity_market_price', title: 'Energieprijzen', ...c };
    if (this._ready) { const f = this.querySelector('ha-form'); if (f) f.data = this._data(); }
    else this._init();
  }

  _data() {
    return {
      entity: this._config.entity || 'sensor.current_electricity_market_price',
      title:  this._config.title  || 'Energieprijzen',
    };
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config: { ...this._config } }, bubbles: true, composed: true,
    }));
  }

  _init() {
    if (!this._hass || this._ready) return;
    this._ready = true;
    this.innerHTML = '<ha-form></ha-form>';
    const form = this.querySelector('ha-form');
    form.hass   = this._hass;
    form.schema = [
      { name: 'entity', selector: { entity: { domain: 'sensor' } }, label: 'Energieprijs sensor' },
      { name: 'title',  selector: { text: {} },                     label: 'Kaart titel'          },
    ];
    form.data = this._data();
    form.addEventListener('value-changed', (e) => {
      const v = e.detail.value || {};
      let changed = false;
      for (const k of Object.keys(this._config)) {
        if (v[k] !== undefined && v[k] !== this._config[k]) { this._config[k] = v[k]; changed = true; }
      }
      if (changed) this._fire();
    });
  }
}

// ─────────────────────────────────────────────
//  CARD
// ─────────────────────────────────────────────
class NordpoolPriceChart extends HTMLElement {

  static getConfigElement() { return document.createElement('nordpool-price-chart-editor'); }
  static getStubConfig()    { return { entity: 'sensor.current_electricity_market_price', title: 'Energieprijzen' }; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config      = {};
    this._hass        = null;
    this._domBuilt    = false;
    this._allIn       = false;
    this._barData     = [];
    this._nowScrolled = false;
    this._lastPrices  = null;
    // Local config — no HA helpers needed, values persist per session
    this._inkoop    = 0.0;
    this._belasting = 0.0;
  }

  setConfig(config) {
    if (!config.entity) throw new Error('Geen entiteit geconfigureerd');
    this._config = { entity: 'sensor.current_electricity_market_price', title: 'Energieprijzen', ...config };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  // ── Data parsing ─────────────────────────

  _getPriceData() {
    const state = this._hass?.states[this._config.entity];
    if (!state) return [];
    const attr = state.attributes || {};

    const toDate     = (v) => v ? new Date(v) : null;
    const validEntry = (d) =>
      d.start instanceof Date && !isNaN(d.start) &&
      d.end   instanceof Date && !isNaN(d.end)   &&
      typeof d.price === 'number' && isFinite(d.price);
    const autoDiv = (sample) => (typeof sample === 'number' && sample > 1 ? 1000 : 1);

    // Format 1 — Frank Energie / Tibber: attributes.prices [{from, till, price}]
    if (Array.isArray(attr.prices) && attr.prices.length) {
      return attr.prices
        .map((d) => ({
          start: toDate(d.from ?? d.start ?? d.start_time),
          end:   toDate(d.till ?? d.end   ?? d.end_time),
          price: d.price ?? d.value ?? 0,
        }))
        .filter(validEntry)
        .sort((a,b) => a.start - b.start);
    }

    // Format 2 — Template sensor: attributes.data [{start_time, end_time, price_per_kwh}]
    if (Array.isArray(attr.data) && attr.data.length) {
      return attr.data
        .map((d) => ({
          start: toDate(d.start_time ?? d.start),
          end:   toDate(d.end_time   ?? d.end),
          price: d.price_per_kwh ?? d.price ?? 0,
        }))
        .filter(validEntry)
        .sort((a,b) => a.start - b.start);
    }

    // Format 3 — Native Nordpool: raw_today / raw_tomorrow [{start, end, value}]
    const combined = [...(attr.raw_today || attr.prices_today || []),
                      ...(attr.raw_tomorrow || attr.prices_tomorrow || [])];
    if (combined.length) {
      const sample = combined.find(d => (d.value ?? 0) > 0)?.value ?? 0;
      const div    = autoDiv(sample);
      return combined
        .map((d) => ({
          start: toDate(d.start ?? d.start_time),
          end:   toDate(d.end   ?? d.end_time),
          price: (d.value ?? d.price ?? 0) / div,
        }))
        .filter(validEntry)
        .sort((a,b) => a.start - b.start);
    }

    // Format 4 — Simple float arrays: attributes.today / attributes.tomorrow
    const todayArr    = attr.today    || [];
    const tomorrowArr = attr.tomorrow || [];
    if (todayArr.length || tomorrowArr.length) {
      const result = [];
      const buildSlots = (arr, base) => {
        const div = autoDiv(arr.find(v => v > 0) ?? 0);
        arr.forEach((price, i) => {
          const start = new Date(base); start.setHours(i,0,0,0);
          const end   = new Date(start); end.setHours(i+1);
          result.push({ start, end, price: (typeof price === 'number' ? price : 0) / div });
        });
      };
      const today    = new Date(); today.setHours(0,0,0,0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
      buildSlots(todayArr, today);
      buildSlots(tomorrowArr, tomorrow);
      return result.filter(validEntry);
    }

    return [];
  }

  _toAllIn(marketEuro) {
    return (marketEuro + this._inkoop + this._belasting) * 1.21;
  }

  // ── DOM lifecycle ────────────────────────

  _render() {
    if (!this._domBuilt) { this._buildDOM(); this._domBuilt = true; }
    this._updateDOM();
  }

  _buildDOM() {
    this.shadowRoot.innerHTML = `
<style>
  :host { display: block; }

  ha-card {
    padding: 16px 14px 14px;
    box-sizing: border-box;
    overflow: visible !important;
  }

  /* Header */
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
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .toggle-label {
    font-size: 0.78rem;
    font-weight: 600;
    color: var(--secondary-text-color);
    transition: color 0.2s;
    white-space: nowrap;
  }
  .toggle-label.active { color: var(--primary-color); }

  /* Toggle switch */
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
    position: absolute; inset: 0;
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

  /* Chart */
  .chart-wrapper { position: relative; width: 100%; margin-bottom: 12px; }
  .chart-scroll {
    width: 100%;
    height: 220px;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: thin;
    scrollbar-color: var(--divider-color) transparent;
    cursor: crosshair;
  }
  .chart-scroll::-webkit-scrollbar { height: 3px; }
  .chart-scroll::-webkit-scrollbar-thumb { background: var(--divider-color); border-radius: 2px; }
  canvas { display: block; }

  /* Tooltip */
  .tooltip {
    position: absolute; top: 0; left: 0;
    background: var(--card-background-color, rgba(20,20,30,0.97));
    border: 1px solid var(--divider-color);
    border-radius: 10px;
    padding: 9px 13px;
    font-size: 0.78rem;
    color: var(--primary-text-color);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s;
    white-space: nowrap;
    z-index: 200;
    box-shadow: 0 6px 24px rgba(0,0,0,0.4);
  }
  .tooltip.visible { opacity: 1; }
  .tt-time   { font-weight: 700; color: var(--primary-color); margin-bottom: 4px; font-size: 0.82rem; }
  .tt-market { color: var(--primary-text-color); }
  .tt-allin  { color: var(--secondary-text-color); font-size: 0.73rem; margin-top: 3px; }
  .tt-sep    { height: 1px; background: var(--divider-color); margin: 5px 0; }

  /* Stats */
  .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .stat-card {
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--secondary-background-color);
    border: 1px solid var(--divider-color);
  }
  .stat-label {
    font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.6px;
    color: var(--secondary-text-color); margin-bottom: 4px;
    display: flex; align-items: center; gap: 5px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
  .stat-value { font-size: 1.05rem; font-weight: 700; color: var(--primary-text-color); line-height: 1.2; }
  .stat-time  { font-size: 0.7rem; color: var(--secondary-text-color); margin-top: 2px; }

  /* Price config */
  .price-config { border-top: 1px solid var(--divider-color); padding-top: 12px; display: none; }
  .price-config.visible { display: block; }
  .config-title {
    font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.6px; color: var(--secondary-text-color); margin-bottom: 10px;
  }
  .config-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .config-field { display: flex; flex-direction: column; gap: 4px; }
  .config-field label { font-size: 0.72rem; color: var(--secondary-text-color); }
  .config-field input {
    background: var(--secondary-background-color);
    border: 1.5px solid var(--divider-color);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 0.92rem;
    color: var(--primary-text-color);
    width: 100%; box-sizing: border-box; min-height: 44px;
    touch-action: manipulation; -webkit-tap-highlight-color: transparent;
    outline: none; transition: border-color 0.2s;
    -moz-appearance: textfield;
  }
  .config-field input::-webkit-outer-spin-button,
  .config-field input::-webkit-inner-spin-button { -webkit-appearance: none; }
  .config-field input:focus { border-color: var(--primary-color); }
</style>

<ha-card>
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

  <div class="stats">
    <div class="stat-card">
      <div class="stat-label"><span class="dot" style="background:#22c55e"></span>Laagste prijs</div>
      <div class="stat-value" id="stat-low-val">—</div>
      <div class="stat-time"  id="stat-low-time">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label"><span class="dot" style="background:#ef4444"></span>Hoogste prijs</div>
      <div class="stat-value" id="stat-high-val">—</div>
      <div class="stat-time"  id="stat-high-time">—</div>
    </div>
  </div>

  <div class="price-config" id="price-config">
    <div class="config-title">Prijsconfiguratie</div>
    <div class="config-grid">
      <div class="config-field">
        <label for="inp-inkoop">Inkoopvergoeding (€/kWh)</label>
        <input type="number" id="inp-inkoop" step="0.0001" min="0" placeholder="0.0000" value="0">
      </div>
      <div class="config-field">
        <label for="inp-belasting">Energiebelasting (€/kWh)</label>
        <input type="number" id="inp-belasting" step="0.0001" min="0" placeholder="0.0000" value="0">
      </div>
    </div>
  </div>
</ha-card>`;

    this._bindEvents();
  }

  _bindEvents() {
    // Toggle All-In
    this.shadowRoot.getElementById('allin-toggle').addEventListener('change', (e) => {
      this._allIn = e.target.checked;
      this._updateDOM();
    });

    // Inputs update local state immediately — HA is NOT involved
    this.shadowRoot.getElementById('inp-inkoop').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this._inkoop = isNaN(v) ? 0 : v;
      this._redrawChart();
    });

    this.shadowRoot.getElementById('inp-belasting').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this._belasting = isNaN(v) ? 0 : v;
      this._redrawChart();
    });

    this._bindCanvasTooltip();
  }

  _bindCanvasTooltip() {
    const canvas  = this.shadowRoot.getElementById('chart-canvas');
    const tooltip = this.shadowRoot.getElementById('tooltip');
    const scroll  = this.shadowRoot.getElementById('chart-scroll');

    let touchSX = 0, touchSY = 0, isDragging = false;

    const getBar = (clientX, canvasRect) => {
      // Convert clientX → physical pixels on canvas
      const dpr       = window.devicePixelRatio || 1;
      const physX     = (clientX - canvasRect.left) * dpr + scroll.scrollLeft * dpr;
      return this._barData.find(b => physX >= b.x && physX < b.x + b.w) || null;
    };

    const showTip = (bar, relY) => {
      if (!bar) { hideTip(); return; }
      this.shadowRoot.getElementById('tt-time').textContent   = `${fmt(bar.start)} – ${fmt(bar.end)} uur`;
      this.shadowRoot.getElementById('tt-market').textContent = `Marktprijs: ${(bar.market*100).toFixed(2)} ct/kWh`;
      const ttAllin = this.shadowRoot.getElementById('tt-allin');
      if (this._allIn) {
        ttAllin.textContent   = `All-In: ${(bar.allin*100).toFixed(2)} ct/kWh`;
        ttAllin.style.display = 'block';
      } else {
        ttAllin.style.display = 'none';
      }
      tooltip.classList.add('visible');
      requestAnimationFrame(() => {
        const wrapW  = scroll.clientWidth;
        const dpr    = window.devicePixelRatio || 1;
        const barScr = bar.x / dpr - scroll.scrollLeft + bar.w / dpr / 2;
        const tipW   = tooltip.offsetWidth;
        const tipH   = tooltip.offsetHeight;
        let tx = barScr - tipW / 2;
        let ty = relY - tipH - 14;
        tx = Math.max(4, Math.min(wrapW - tipW - 4, tx));
        if (ty < 4) ty = relY + 20;
        tooltip.style.left = `${tx}px`;
        tooltip.style.top  = `${ty}px`;
      });
    };

    const hideTip = () => tooltip.classList.remove('visible');

    canvas.addEventListener('mousemove', (e) => {
      showTip(getBar(e.clientX, canvas.getBoundingClientRect()), e.clientY - canvas.getBoundingClientRect().top);
    });
    canvas.addEventListener('mouseleave', hideTip);

    canvas.addEventListener('touchstart', (e) => {
      touchSX = e.touches[0].clientX; touchSY = e.touches[0].clientY; isDragging = false;
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - touchSX);
      const dy = Math.abs(e.touches[0].clientY - touchSY);
      if (dx > 8) isDragging = true;
      if (dx > dy) e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      showTip(getBar(e.touches[0].clientX, rect), e.touches[0].clientY - rect.top);
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      const t    = e.changedTouches[0];
      const rect = canvas.getBoundingClientRect();
      if (!isDragging) {
        showTip(getBar(t.clientX, rect), t.clientY - rect.top);
        setTimeout(hideTip, 2500);
      } else { hideTip(); }
    });
  }

  // ── Updates ──────────────────────────────

  _updateDOM() {
    if (!this._hass) return;

    const el = (id) => this.shadowRoot.getElementById(id);

    el('card-title').textContent = this._config.title || 'Energieprijzen';
    const lbl = el('toggle-label');
    lbl.textContent = this._allIn ? 'All-In' : 'Marktprijs';
    lbl.classList.toggle('active', this._allIn);
    el('allin-toggle').checked = this._allIn;
    el('price-config').classList.toggle('visible', this._allIn);

    // Never touch input values here — they belong to the user

    const data = this._getPriceData();
    if (!data.length) return;

    // Cache with market price; display/allin computed fresh each redraw
    this._lastPrices = data.map(d => ({ ...d, market: d.price }));

    const withDisp = this._lastPrices.map(d => ({
      ...d,
      allin:   this._toAllIn(d.market),
      display: this._allIn ? this._toAllIn(d.market) : d.market,
    }));

    const minItem = withDisp.reduce((a,b) => b.display < a.display ? b : a);
    const maxItem = withDisp.reduce((a,b) => b.display > a.display ? b : a);

    el('stat-low-val').textContent   = `${(minItem.display*100).toFixed(1)} ct/kWh`;
    el('stat-low-time').textContent  = `om ${fmt(minItem.start)} uur`;
    el('stat-high-val').textContent  = `${(maxItem.display*100).toFixed(1)} ct/kWh`;
    el('stat-high-time').textContent = `om ${fmt(maxItem.start)} uur`;

    this._drawChart(withDisp);
  }

  _redrawChart() {
    if (!this._lastPrices?.length) return;
    const el     = this.shadowRoot.getElementById;
    const prices = this._lastPrices.map(d => ({
      ...d,
      allin:   this._toAllIn(d.market),
      display: this._allIn ? this._toAllIn(d.market) : d.market,
    }));

    // Update stats too
    const minItem = prices.reduce((a,b) => b.display < a.display ? b : a);
    const maxItem = prices.reduce((a,b) => b.display > a.display ? b : a);
    const q = (id) => this.shadowRoot.getElementById(id);
    q('stat-low-val').textContent   = `${(minItem.display*100).toFixed(1)} ct/kWh`;
    q('stat-low-time').textContent  = `om ${fmt(minItem.start)} uur`;
    q('stat-high-val').textContent  = `${(maxItem.display*100).toFixed(1)} ct/kWh`;
    q('stat-high-time').textContent = `om ${fmt(maxItem.start)} uur`;

    this._drawChart(prices);
  }

  // ── Canvas drawing ────────────────────────

  _drawChart(prices) {
    const canvas = this.shadowRoot.getElementById('chart-canvas');
    const scroll = this.shadowRoot.getElementById('chart-scroll');
    if (!canvas || !scroll) return;

    const dpr    = window.devicePixelRatio || 1;
    const CSS_H  = 220;
    // Bar width: wider on mobile for touch, narrower when many bars
    const count  = prices.length;
    const BAR_W  = count > 40 ? 10 : 14;
    const BAR_GAP = 2;
    const PAD_TOP = 28;
    const PAD_BOT = 44;
    const PAD_L   = 46;
    const PAD_R   = 14;

    const cssW = PAD_L + count * (BAR_W + BAR_GAP) + PAD_R;

    // HiDPI canvas
    canvas.width        = cssW * dpr;
    canvas.height       = CSS_H * dpr;
    canvas.style.width  = `${cssW}px`;
    canvas.style.height = `${CSS_H}px`;

    const ctx   = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, CSS_H);

    const drawH = CSS_H - PAD_TOP - PAD_BOT;

    // Colours from host (shadow root gets HA CSS vars via :host)
    const cs      = getComputedStyle(this);
    const PRIMARY = cs.getPropertyValue('--primary-color').trim()        || '#026FA1';
    const TXT_SEC = cs.getPropertyValue('--secondary-text-color').trim() || '#9ca3af';
    const DIV     = cs.getPropertyValue('--divider-color').trim()        || 'rgba(128,128,128,0.2)';

    // Price range — always include 0 so negative bars are visible
    const allP    = prices.map(p => p.display);
    const minP    = Math.min(...allP);
    const maxP    = Math.max(...allP);
    const rangeMin = Math.min(minP, 0);
    const rangeMax = Math.max(maxP, 0);
    const range    = (rangeMax - rangeMin) || 0.001;
    const avgP     = allP.reduce((s,v) => s+v, 0) / allP.length;
    const hasNeg   = minP < 0;

    // Color thresholds: bottom 25% green, top 25% red
    const sorted   = [...prices].sort((a,b) => a.display - b.display);
    const cheapThr = sorted[Math.floor(sorted.length * 0.25)]?.display ?? rangeMin;
    const expThr   = sorted[Math.floor(sorted.length * 0.75)]?.display ?? rangeMax;

    const priceToY = (p) => PAD_TOP + drawH - ((p - rangeMin) / range) * drawH;
    const zeroY    = priceToY(0);

    // ── Grid lines ──
    ctx.lineWidth = 0.5;
    ctx.setLineDash([3,4]);
    for (let i = 0; i <= 5; i++) {
      const p = rangeMin + range * (1 - i/5);
      const y = PAD_TOP + drawH * (i/5);
      ctx.strokeStyle = DIV;
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(cssW - PAD_R, y); ctx.stroke();
      ctx.fillStyle  = TXT_SEC;
      ctx.font       = '10px system-ui,sans-serif';
      ctx.textAlign  = 'right';
      ctx.fillText(`${(p*100).toFixed(0)}`, PAD_L - 5, y + 3.5);
    }
    ctx.setLineDash([]);

    // Y-axis unit label
    ctx.save();
    ctx.translate(9, PAD_TOP + drawH/2);
    ctx.rotate(-Math.PI/2);
    ctx.fillStyle = TXT_SEC; ctx.font = '9px system-ui,sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('ct/kWh', 0, 0);
    ctx.restore();

    // ── Zero line (only when negatives present) ──
    if (hasNeg) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(PAD_L, zeroY); ctx.lineTo(cssW - PAD_R, zeroY); ctx.stroke();
      ctx.fillStyle  = 'rgba(255,255,255,0.4)';
      ctx.font       = 'bold 9px system-ui,sans-serif'; ctx.textAlign = 'right';
      ctx.fillText('0', PAD_L - 5, zeroY + 3.5);
      ctx.restore();
    }

    // ── Average line ──
    const avgY = priceToY(avgP);
    ctx.save();
    ctx.strokeStyle = PRIMARY; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.5;
    ctx.setLineDash([5,5]);
    ctx.beginPath(); ctx.moveTo(PAD_L, avgY); ctx.lineTo(cssW - PAD_R, avgY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 0.9;
    const avgLabel = `⌀ ${(avgP*100).toFixed(1)}`;
    ctx.font = 'bold 9px system-ui,sans-serif';
    const lw = ctx.measureText(avgLabel).width + 8;
    ctx.fillStyle = PRIMARY;
    roundRect(ctx, PAD_L + 3, avgY - 9, lw, 12, 3); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText(avgLabel, PAD_L + 7, avgY + 0.5);
    ctx.restore();

    // ── Bars ──
    const now     = new Date();
    this._barData = [];

    prices.forEach((item, i) => {
      const x     = PAD_L + i * (BAR_W + BAR_GAP);
      const isCur = item.start <= now && now < item.end;
      const isNeg = item.display < 0;

      const topY = isNeg ? zeroY                  : priceToY(item.display);
      const botY = isNeg ? priceToY(item.display)  : zeroY;
      const barH = Math.max(3, Math.abs(botY - topY));

      let color;
      if      (isNeg)                    color = '#06b6d4';
      else if (item.display <= cheapThr) color = '#22c55e';
      else if (item.display >= expThr)   color = '#ef4444';
      else                               color = PRIMARY;

      ctx.save();
      ctx.globalAlpha = isCur ? 1.0 : 0.8;
      ctx.fillStyle   = color;
      if (isCur) { ctx.shadowColor = color; ctx.shadowBlur = 14; }
      roundRect(ctx, x, topY, BAR_W, barH, isNeg ? [0,0,2,2] : [2,2,0,0]);
      ctx.fill();
      ctx.restore();

      // Store physical pixel coords for tooltip hit-testing
      this._barData.push({
        x: x * dpr, w: (BAR_W + BAR_GAP) * dpr,
        start: item.start, end: item.end,
        market: item.market, allin: item.allin, display: item.display,
      });
    });

    // ── "Nu" indicator ──
    const nowIdx = prices.findIndex(p => p.start <= now && now < p.end);
    if (nowIdx >= 0) {
      const nowX = PAD_L + nowIdx * (BAR_W + BAR_GAP) + BAR_W / 2;
      ctx.save();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.75;
      ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(nowX, PAD_TOP - 4); ctx.lineTo(nowX, PAD_TOP + drawH + 4); ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      const badge = 'Nu';
      ctx.font = 'bold 9px system-ui,sans-serif'; ctx.textAlign = 'center';
      const bw = ctx.measureText(badge).width + 7;
      ctx.fillStyle = '#fff';
      roundRect(ctx, nowX - bw/2, PAD_TOP - 16, bw, 13, 3); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.fillText(badge, nowX, PAD_TOP - 6.5);
      ctx.restore();

      if (!this._nowScrolled) {
        this._nowScrolled = true;
        requestAnimationFrame(() => {
          scroll.scrollLeft = Math.max(0, nowX - scroll.clientWidth / 2);
        });
      }
    }

    // ── X-axis: labels every 4h + day separators ──
    ctx.fillStyle   = TXT_SEC;
    ctx.font        = '10px system-ui,sans-serif';
    ctx.strokeStyle = DIV; ctx.lineWidth = 0.5;

    let lastDay = null, lastLabelH = -1;

    prices.forEach((item, i) => {
      const x   = PAD_L + i * (BAR_W + BAR_GAP) + BAR_W / 2;
      const day = item.start.getDate();
      const h   = item.start.getHours();
      const m   = item.start.getMinutes();

      // Day separator
      if (lastDay !== null && day !== lastDay) {
        const sx = PAD_L + i * (BAR_W + BAR_GAP) - BAR_GAP / 2;
        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
        ctx.setLineDash([4,4]);
        ctx.beginPath(); ctx.moveTo(sx, PAD_TOP - 4); ctx.lineTo(sx, PAD_TOP + drawH + 32); ctx.stroke();
        ctx.setLineDash([]);
        const dayStr = item.start.toLocaleDateString('nl-NL', { weekday:'short', day:'numeric', month:'short' });
        ctx.fillStyle = TXT_SEC; ctx.font = 'bold 9px system-ui,sans-serif';
        ctx.textAlign = 'left'; ctx.globalAlpha = 0.85;
        ctx.fillText(dayStr, sx + 4, PAD_TOP + drawH + 38);
        ctx.restore();
        lastLabelH = -1; // allow 00:00 at boundary
      }

      // Hour label every 4 hours on the hour: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00
      if (m === 0 && h % 4 === 0 && h !== lastLabelH) {
        lastLabelH = h;
        ctx.fillStyle  = TXT_SEC; ctx.font = '10px system-ui,sans-serif';
        ctx.textAlign  = 'center'; ctx.globalAlpha = 1;
        ctx.fillText(`${String(h).padStart(2,'0')}:00`, x, PAD_TOP + drawH + 14);
        ctx.strokeStyle = DIV;
        ctx.beginPath(); ctx.moveTo(x, PAD_TOP + drawH + 2); ctx.lineTo(x, PAD_TOP + drawH + 6); ctx.stroke();
      }

      lastDay = day;
    });
  }
}

// ─────────────────────────────────────────────
//  REGISTRATIE
// ─────────────────────────────────────────────
if (!customElements.get('nordpool-price-chart-editor')) customElements.define('nordpool-price-chart-editor', NordpoolPriceChartEditor);
if (!customElements.get('nordpool-price-chart'))        customElements.define('nordpool-price-chart',        NordpoolPriceChart);

window.customCards = window.customCards || [];
if (!window.customCards.find(c => c.type === 'nordpool-price-chart')) {
  window.customCards.push({
    type:        'nordpool-price-chart',
    name:        'Nordpool Prijsgrafiek',
    description: 'Interactieve energieprijsgrafiek met All-In berekening',
    preview:     false,
  });
}
