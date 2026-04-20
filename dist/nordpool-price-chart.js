/**
 * Nordpool Price Chart — Home Assistant Custom Card
 * @version 1.4.0
 * @author Sven2410
 */

const VERSION = '1.4.0';
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

const rRect = (ctx, x, y, w, h, radii) => {
  const [tl,tr,br,bl] = (Array.isArray(radii) ? radii : [radii,radii,radii,radii])
    .map(r => Math.min(r, Math.abs(w)/2, Math.abs(h)/2));
  ctx.beginPath();
  ctx.moveTo(x+tl, y);
  ctx.lineTo(x+w-tr, y);        ctx.arcTo(x+w, y,   x+w, y+h, tr);
  ctx.lineTo(x+w,   y+h-br);   ctx.arcTo(x+w, y+h, x,   y+h, br);
  ctx.lineTo(x+bl,  y+h);      ctx.arcTo(x,   y+h, x,   y,   bl);
  ctx.lineTo(x,     y+tl);     ctx.arcTo(x,   y,   x+w, y,   tl);
  ctx.closePath();
};

// ─────────────────────────────────────────────
//  EDITOR
// ─────────────────────────────────────────────
class NordpoolPriceChartEditor extends HTMLElement {
  constructor() { super(); this._config={}; this._hass=null; this._ready=false; }

  set hass(h) {
    this._hass = h;
    if (this._ready) { const f=this.querySelector('ha-form'); if(f) f.hass=h; }
    else this._init();
  }

  setConfig(c) {
    this._config = { entity:'sensor.current_electricity_market_price', title:'Energieprijzen', ...c };
    if (this._ready) { const f=this.querySelector('ha-form'); if(f) f.data=this._data(); }
    else this._init();
  }

  _data() {
    return { entity: this._config.entity||'sensor.current_electricity_market_price',
             title:  this._config.title ||'Energieprijzen' };
  }

  _fire() {
    this.dispatchEvent(new CustomEvent('config-changed',
      { detail:{ config:{...this._config} }, bubbles:true, composed:true }));
  }

  _init() {
    if (!this._hass || this._ready) return;
    this._ready = true;
    this.innerHTML = '<ha-form></ha-form>';
    const form = this.querySelector('ha-form');
    form.hass   = this._hass;
    form.schema = [
      { name:'entity', selector:{ entity:{ domain:'sensor' } }, label:'Energieprijs sensor' },
      { name:'title',  selector:{ text:{} },                    label:'Kaart titel'          },
    ];
    form.data = this._data();
    form.addEventListener('value-changed', (e) => {
      const v = e.detail.value||{};
      let changed = false;
      for (const k of Object.keys(this._config))
        if (v[k]!==undefined && v[k]!==this._config[k]) { this._config[k]=v[k]; changed=true; }
      if (changed) this._fire();
    });
  }
}

// ─────────────────────────────────────────────
//  CARD
// ─────────────────────────────────────────────
class NordpoolPriceChart extends HTMLElement {

  static getConfigElement() { return document.createElement('nordpool-price-chart-editor'); }
  static getStubConfig()    { return { entity:'sensor.current_electricity_market_price', title:'Energieprijzen' }; }

  constructor() {
    super();
    this.attachShadow({ mode:'open' });
    this._config         = {};
    this._hass           = null;
    this._domBuilt       = false;
    this._allIn          = false;
    this._barData        = [];   // CSS px relative to bars-canvas
    this._lastPrices     = null;
    this._nowScrolled    = false;
    // Local price config values — source of truth
    this._inkoop         = 0;
    this._belasting      = 0;
    // Focus tracking — prevents HA from overwriting while user types
    this._inkoopFocused    = false;
    this._belastingFocused = false;
  }

  setConfig(config) {
    if (!config.entity) throw new Error('Geen entiteit geconfigureerd');
    this._config = { entity:'sensor.current_electricity_market_price', title:'Energieprijzen', ...config };
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  // ── Data parsing ─────────────────────────────────────────────────────

  _getPriceData() {
    const state = this._hass?.states[this._config.entity];
    if (!state) return [];
    const attr = state.attributes||{};

    const toDate = (v) => v ? new Date(v) : null;
    const ok     = (d) =>
      d.start instanceof Date && !isNaN(d.start) &&
      d.end   instanceof Date && !isNaN(d.end)   &&
      typeof d.price === 'number' && isFinite(d.price);
    const autoDiv = (sample) => (typeof sample==='number' && sample>1 ? 1000 : 1);

    // Format 1 — Frank Energie / Tibber: .prices [{from,till,price}]
    if (Array.isArray(attr.prices) && attr.prices.length)
      return attr.prices
        .map(d=>({ start:toDate(d.from??d.start??d.start_time), end:toDate(d.till??d.end??d.end_time), price:d.price??d.value??0 }))
        .filter(ok).sort((a,b)=>a.start-b.start);

    // Format 2 — Template sensor: .data [{start_time,end_time,price_per_kwh}]
    if (Array.isArray(attr.data) && attr.data.length)
      return attr.data
        .map(d=>({ start:toDate(d.start_time??d.start), end:toDate(d.end_time??d.end), price:d.price_per_kwh??d.price??0 }))
        .filter(ok).sort((a,b)=>a.start-b.start);

    // Format 3 — Native Nordpool: .raw_today / .raw_tomorrow [{start,end,value}]
    const combined = [...(attr.raw_today||attr.prices_today||[]), ...(attr.raw_tomorrow||attr.prices_tomorrow||[])];
    if (combined.length) {
      const div = autoDiv(combined.find(d=>(d.value??0)>0)?.value??0);
      return combined
        .map(d=>({ start:toDate(d.start??d.start_time), end:toDate(d.end??d.end_time), price:(d.value??d.price??0)/div }))
        .filter(ok).sort((a,b)=>a.start-b.start);
    }

    // Format 4 — Float arrays: .today / .tomorrow
    const tA = attr.today||[], tmA = attr.tomorrow||[];
    if (tA.length||tmA.length) {
      const result = [];
      const build = (arr, base) => {
        const div = autoDiv(arr.find(v=>v>0)??0);
        arr.forEach((p,i) => {
          const s=new Date(base); s.setHours(i,0,0,0);
          const e=new Date(s); e.setHours(i+1);
          result.push({ start:s, end:e, price:(typeof p==='number'?p:0)/div });
        });
      };
      const today=new Date(); today.setHours(0,0,0,0);
      const tom=new Date(today); tom.setDate(tom.getDate()+1);
      build(tA,today); build(tmA,tom);
      return result.filter(ok);
    }
    return [];
  }

  _getHelper(id) { return parseFloat(this._hass?.states[id]?.state)||0; }
  _toAllIn(p)    { return (p + this._inkoop + this._belasting) * 1.21; }
  _disp(item)    { return this._allIn ? this._toAllIn(item.price) : item.price; }

  // ── DOM lifecycle ─────────────────────────────────────────────────────

  _render() {
    if (!this._domBuilt) { this._buildDOM(); this._domBuilt=true; }
    this._updateDOM();
  }

  _buildDOM() {
    this.shadowRoot.innerHTML = `
<style>
  :host { display:block; }
  ha-card { padding:16px 14px 14px; box-sizing:border-box; overflow:visible!important; }

  /* Header */
  .header { display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:12px; gap:8px; }
  .title-group { display:flex; flex-direction:column; gap:3px; min-width:0; }
  .title { font-size:1rem; font-weight:700; color:var(--primary-text-color); }
  .avg-label { font-size:0.76rem; color:var(--secondary-text-color); }

  /* Toggle */
  .toggle-row { display:flex; align-items:center; gap:8px; flex-shrink:0; padding-top:2px; }
  .toggle-label { font-size:0.76rem; font-weight:600; color:var(--secondary-text-color); transition:color 0.2s; white-space:nowrap; }
  .toggle-label.active { color:var(--primary-color); }
  .toggle { position:relative; width:46px; height:26px; cursor:pointer; touch-action:manipulation; -webkit-tap-highlight-color:transparent; flex-shrink:0; }
  .toggle input { opacity:0; width:0; height:0; position:absolute; }
  .toggle-track { position:absolute; inset:0; border-radius:13px; background:var(--divider-color); transition:background 0.25s; }
  .toggle input:checked~.toggle-track { background:var(--primary-color); }
  .toggle-thumb { position:absolute; top:3px; left:3px; width:20px; height:20px; border-radius:50%; background:#fff; box-shadow:0 1px 5px rgba(0,0,0,0.35); transition:transform 0.25s cubic-bezier(.4,0,.2,1); }
  .toggle input:checked~.toggle-thumb { transform:translateX(20px); }

  /* Chart layout — two-canvas: sticky Y-axis + scrollable bars */
  .chart-wrapper { display:flex; align-items:flex-start; margin-bottom:4px; position:relative; }
  #yaxis-canvas { display:block; flex-shrink:0; }
  .chart-scroll {
    flex:1; min-width:0;
    overflow-x:scroll;       /* always show scrollbar */
    overflow-y:hidden;
    -webkit-overflow-scrolling:touch;
    scrollbar-width:thin;
    scrollbar-color:var(--primary-color) rgba(128,128,128,0.12);
    cursor:crosshair;
  }
  .chart-scroll::-webkit-scrollbar { height:6px; }
  .chart-scroll::-webkit-scrollbar-track { background:rgba(128,128,128,0.1); border-radius:3px; }
  .chart-scroll::-webkit-scrollbar-thumb { background:var(--primary-color); border-radius:3px; opacity:0.8; }
  #bars-canvas { display:block; }

  /* Tooltip — positioned relative to .chart-wrapper */
  .tooltip {
    position:absolute; top:0; left:0;
    background:var(--card-background-color,rgba(18,18,28,0.97));
    border:1px solid var(--divider-color); border-radius:10px;
    padding:9px 13px; font-size:0.78rem; color:var(--primary-text-color);
    pointer-events:none; opacity:0; transition:opacity 0.1s;
    white-space:nowrap; z-index:300; box-shadow:0 6px 24px rgba(0,0,0,0.45);
  }
  .tooltip.visible { opacity:1; }
  .tt-time   { font-weight:700; color:var(--primary-color); margin-bottom:4px; font-size:0.82rem; }
  .tt-market { color:var(--primary-text-color); }
  .tt-allin  { color:var(--secondary-text-color); font-size:0.73rem; margin-top:3px; }
  .tt-sep    { height:1px; background:var(--divider-color); margin:5px 0; }

  /* Stats */
  .stats { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:12px; margin-top:8px; }
  .stat-card { padding:10px 12px; border-radius:12px; background:var(--secondary-background-color); border:1px solid var(--divider-color); }
  .stat-label { font-size:0.68rem; text-transform:uppercase; letter-spacing:0.6px; color:var(--secondary-text-color); margin-bottom:4px; display:flex; align-items:center; gap:5px; }
  .dot { width:7px; height:7px; border-radius:50%; display:inline-block; flex-shrink:0; }
  .stat-value { font-size:1.05rem; font-weight:700; color:var(--primary-text-color); line-height:1.2; }
  .stat-time  { font-size:0.7rem; color:var(--secondary-text-color); margin-top:2px; }

  /* Price config */
  .price-config { border-top:1px solid var(--divider-color); padding-top:12px; display:none; }
  .price-config.visible { display:block; }
  .config-title { font-size:0.7rem; font-weight:700; text-transform:uppercase; letter-spacing:0.6px; color:var(--secondary-text-color); margin-bottom:10px; }
  .config-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .config-field { display:flex; flex-direction:column; gap:4px; }
  .config-field label { font-size:0.72rem; color:var(--secondary-text-color); }
  .config-field input {
    background:var(--secondary-background-color); border:1.5px solid var(--divider-color);
    border-radius:8px; padding:8px 10px; font-size:0.92rem; color:var(--primary-text-color);
    width:100%; box-sizing:border-box; min-height:44px;
    touch-action:manipulation; -webkit-tap-highlight-color:transparent;
    outline:none; transition:border-color 0.2s; -moz-appearance:textfield;
  }
  .config-field input::-webkit-outer-spin-button,
  .config-field input::-webkit-inner-spin-button { -webkit-appearance:none; }
  .config-field input:focus { border-color:var(--primary-color); }
</style>

<ha-card>
  <div class="header">
    <div class="title-group">
      <div class="title" id="card-title">Energieprijzen</div>
      <div class="avg-label" id="avg-label">Gemiddeld: — ct/kWh</div>
    </div>
    <div class="toggle-row">
      <span class="toggle-label" id="toggle-label">Marktprijs</span>
      <label class="toggle" title="Schakel All-In prijs in/uit">
        <input type="checkbox" id="allin-toggle">
        <div class="toggle-track"></div>
        <div class="toggle-thumb"></div>
      </label>
    </div>
  </div>

  <div class="chart-wrapper" id="chart-wrapper">
    <canvas id="yaxis-canvas"></canvas>
    <div class="chart-scroll" id="chart-scroll">
      <canvas id="bars-canvas"></canvas>
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
        <input type="number" id="inp-inkoop" step="0.0001" min="0" placeholder="0.0000">
      </div>
      <div class="config-field">
        <label for="inp-belasting">Energiebelasting (€/kWh)</label>
        <input type="number" id="inp-belasting" step="0.0001" min="0" placeholder="0.0000">
      </div>
    </div>
  </div>
</ha-card>`;

    this._bindEvents();
  }

  // ── Event binding ─────────────────────────────────────────────────────

  _bindEvents() {
    // Toggle
    this.shadowRoot.getElementById('allin-toggle').addEventListener('change', (e) => {
      this._allIn = e.target.checked;
      this._updateDOM();
    });

    // ── Inkoop input ──
    // Focus/blur: only save to HA on blur, never let HA overwrite while focused
    const inpInkoop = this.shadowRoot.getElementById('inp-inkoop');
    inpInkoop.addEventListener('focus', () => { this._inkoopFocused = true; });
    inpInkoop.addEventListener('blur',  () => {
      this._inkoopFocused = false;
      this._saveHelper('input_number.inkoopvergoeding', this._inkoop);
    });
    inpInkoop.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this._inkoop = isNaN(v) ? 0 : v;
      this._redrawChart();
    });

    // ── Belasting input ──
    const inpBelasting = this.shadowRoot.getElementById('inp-belasting');
    inpBelasting.addEventListener('focus', () => { this._belastingFocused = true; });
    inpBelasting.addEventListener('blur',  () => {
      this._belastingFocused = false;
      this._saveHelper('input_number.energiebelasting', this._belasting);
    });
    inpBelasting.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      this._belasting = isNaN(v) ? 0 : v;
      this._redrawChart();
    });

    this._bindTooltip();
  }

  _saveHelper(entityId, value) {
    if (!this._hass) return;
    this._hass.callService('input_number', 'set_value', { entity_id: entityId, value });
  }

  // Sync from HA only when not focused and HA value actually differs
  _syncHelpers() {
    const inpInkoop    = this.shadowRoot.getElementById('inp-inkoop');
    const inpBelasting = this.shadowRoot.getElementById('inp-belasting');
    if (!inpInkoop || !inpBelasting) return;

    if (!this._inkoopFocused) {
      const haVal = this._getHelper('input_number.inkoopvergoeding');
      if (Math.abs(haVal - this._inkoop) > 0.000001) {
        this._inkoop = haVal;
        inpInkoop.value = haVal.toFixed(4);
      }
    }
    if (!this._belastingFocused) {
      const haVal = this._getHelper('input_number.energiebelasting');
      if (Math.abs(haVal - this._belasting) > 0.000001) {
        this._belasting = haVal;
        inpBelasting.value = haVal.toFixed(4);
      }
    }
  }

  // ── Tooltip ───────────────────────────────────────────────────────────

  _bindTooltip() {
    const barsCanvas = this.shadowRoot.getElementById('bars-canvas');
    const tooltip    = this.shadowRoot.getElementById('tooltip');
    const scroll     = this.shadowRoot.getElementById('chart-scroll');
    const wrapper    = this.shadowRoot.getElementById('chart-wrapper');

    const YAXIS_W = 46;
    let activeBar = null;
    let touchSX = 0, touchSY = 0, scrolling = false;

    // Convert clientX to CSS px within the bars canvas
    const cssXInBars = (clientX) => {
      const rect = barsCanvas.getBoundingClientRect();
      return clientX - rect.left;
    };

    const findBar = (clientX) => {
      const x = cssXInBars(clientX);
      return this._barData.find(b => x >= b.x && x < b.x + b.w) || null;
    };

    const positionTip = (bar, clientY) => {
      requestAnimationFrame(() => {
        if (!tooltip.classList.contains('visible')) return;
        const wrapRect = wrapper.getBoundingClientRect();
        const tipW     = tooltip.offsetWidth;
        const tipH     = tooltip.offsetHeight;
        const barsRect = barsCanvas.getBoundingClientRect();

        // Bar center relative to wrapper
        const barCenterInBars = bar.x + bar.w / 2;
        const barCenterX = (barsRect.left - wrapRect.left) + barCenterInBars;
        const relY = clientY - wrapRect.top;

        let tx = barCenterX - tipW / 2;
        let ty = relY - tipH - 12;

        const maxTx = wrapRect.width - tipW - 4;
        tx = Math.max(4, Math.min(maxTx, tx));
        if (ty < 4) ty = relY + 18;

        tooltip.style.left = `${tx}px`;
        tooltip.style.top  = `${ty}px`;
      });
    };

    const showTip = (bar, clientY) => {
      activeBar = bar;
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
      positionTip(bar, clientY);
    };

    const hideTip = () => {
      activeBar = null;
      tooltip.classList.remove('visible');
    };

    // ── Mouse ──
    barsCanvas.addEventListener('mousemove', (e) => {
      const bar = findBar(e.clientX);
      if (bar) showTip(bar, e.clientY);
      else hideTip();
    });
    barsCanvas.addEventListener('mouseleave', hideTip);

    // ── Touch — robust implementation ──
    barsCanvas.addEventListener('touchstart', (e) => {
      touchSX   = e.touches[0].clientX;
      touchSY   = e.touches[0].clientY;
      scrolling = false;
    }, { passive: true });

    barsCanvas.addEventListener('touchmove', (e) => {
      const dx = Math.abs(e.touches[0].clientX - touchSX);
      const dy = Math.abs(e.touches[0].clientY - touchSY);
      if (dx > 6) { scrolling = true; }
      if (dx > dy) e.preventDefault(); // let horizontal scroll work

      if (!scrolling) {
        const bar = findBar(e.touches[0].clientX);
        if (bar) showTip(bar, e.touches[0].clientY);
        else hideTip();
      } else {
        hideTip();
      }
    }, { passive: false });

    barsCanvas.addEventListener('touchend', (e) => {
      if (!scrolling) {
        const t   = e.changedTouches[0];
        const bar = findBar(t.clientX);
        if (bar) {
          showTip(bar, t.clientY);
          clearTimeout(this._tipTimer);
          this._tipTimer = setTimeout(hideTip, 3000);
        } else {
          hideTip();
        }
      } else {
        hideTip();
      }
    });

    // Hide when scrolling the container
    scroll.addEventListener('scroll', () => {
      if (activeBar) positionTip(activeBar, 0); // reposition if visible
    });
  }

  // ── Update DOM ────────────────────────────────────────────────────────

  _updateDOM() {
    if (!this._hass) return;

    // Sync helpers (respects focus)
    this._syncHelpers();

    // Header
    const q = (id) => this.shadowRoot.getElementById(id);
    q('card-title').textContent = this._config.title||'Energieprijzen';
    const lbl = q('toggle-label');
    lbl.textContent = this._allIn ? 'All-In' : 'Marktprijs';
    lbl.classList.toggle('active', this._allIn);
    q('allin-toggle').checked = this._allIn;
    q('price-config').classList.toggle('visible', this._allIn);

    const data = this._getPriceData();
    if (!data.length) return;

    this._lastPrices = data.map(d => ({ ...d, market: d.price }));
    this._applyAndDraw();
  }

  _applyAndDraw() {
    if (!this._lastPrices?.length) return;
    const prices = this._lastPrices.map(d => ({
      ...d,
      allin:   this._toAllIn(d.market),
      display: this._allIn ? this._toAllIn(d.market) : d.market,
    }));

    const minItem = prices.reduce((a,b) => b.display < a.display ? b : a);
    const maxItem = prices.reduce((a,b) => b.display > a.display ? b : a);
    const avgP    = prices.reduce((s,p) => s + p.display, 0) / prices.length;

    const q = (id) => this.shadowRoot.getElementById(id);
    q('avg-label').textContent      = `Gemiddeld: ${(avgP*100).toFixed(2)} ct/kWh`;
    q('stat-low-val').textContent   = `${(minItem.display*100).toFixed(1)} ct/kWh`;
    q('stat-low-time').textContent  = `om ${fmt(minItem.start)} uur`;
    q('stat-high-val').textContent  = `${(maxItem.display*100).toFixed(1)} ct/kWh`;
    q('stat-high-time').textContent = `om ${fmt(maxItem.start)} uur`;

    this._drawChart(prices);
  }

  _redrawChart() {
    this._applyAndDraw();
  }

  // ── Canvas drawing ────────────────────────────────────────────────────

  _drawChart(prices) {
    const yCtx = this.shadowRoot.getElementById('yaxis-canvas')?.getContext('2d');
    const bCtx = this.shadowRoot.getElementById('bars-canvas')?.getContext('2d');
    const scroll = this.shadowRoot.getElementById('chart-scroll');
    if (!yCtx || !bCtx || !scroll) return;

    const dpr      = window.devicePixelRatio || 1;
    const CSS_H    = 220;
    const YAXIS_W  = 46;
    const count    = prices.length;
    const BAR_W    = count > 40 ? 10 : 14;
    const BAR_GAP  = 2;
    const PAD_TOP  = 28;
    const PAD_BOT  = 42;
    const BAR_L    = 2;   // small left gap inside bars canvas
    const PAD_R    = 14;

    const barsW = BAR_L + count * (BAR_W + BAR_GAP) + PAD_R;
    const drawH = CSS_H - PAD_TOP - PAD_BOT;

    // Resize canvases (HiDPI)
    const setCanvas = (canvas, cw, ch) => {
      canvas.width        = cw * dpr;
      canvas.height       = ch * dpr;
      canvas.style.width  = `${cw}px`;
      canvas.style.height = `${ch}px`;
    };
    setCanvas(this.shadowRoot.getElementById('yaxis-canvas'), YAXIS_W, CSS_H);
    setCanvas(this.shadowRoot.getElementById('bars-canvas'),  barsW,   CSS_H);

    yCtx.scale(dpr, dpr); bCtx.scale(dpr, dpr);
    yCtx.clearRect(0, 0, YAXIS_W, CSS_H);
    bCtx.clearRect(0, 0, barsW,   CSS_H);

    // Theme colours
    const cs      = getComputedStyle(this);
    const PRIMARY = cs.getPropertyValue('--primary-color').trim()        || '#026FA1';
    const TXT_SEC = cs.getPropertyValue('--secondary-text-color').trim() || '#9ca3af';
    const DIV     = cs.getPropertyValue('--divider-color').trim()        || 'rgba(128,128,128,0.2)';

    // Price range — always include 0
    const allP     = prices.map(p => p.display);
    const minP     = Math.min(...allP);
    const maxP     = Math.max(...allP);
    const rangeMin = Math.min(minP, 0);
    const rangeMax = Math.max(maxP, 0);
    const range    = (rangeMax - rangeMin) || 0.001;
    const avgP     = allP.reduce((s,v) => s+v, 0) / allP.length;
    const hasNeg   = minP < 0;

    const sorted   = [...prices].sort((a,b) => a.display - b.display);
    const cheapThr = sorted[Math.floor(sorted.length * 0.25)]?.display ?? rangeMin;
    const expThr   = sorted[Math.floor(sorted.length * 0.75)]?.display ?? rangeMax;

    const pY = (p) => PAD_TOP + drawH - ((p - rangeMin) / range) * drawH;
    const zeroY = pY(0);
    const avgY  = pY(avgP);

    // ── Y-AXIS canvas ──
    yCtx.font = '10px system-ui,sans-serif';

    for (let i = 0; i <= 5; i++) {
      const p = rangeMin + range * (1 - i/5);
      const y = PAD_TOP + drawH * (i/5);
      // Tiny tick connecting to bars area
      yCtx.strokeStyle = DIV; yCtx.lineWidth = 0.5;
      yCtx.beginPath(); yCtx.moveTo(YAXIS_W-3, y); yCtx.lineTo(YAXIS_W, y); yCtx.stroke();
      yCtx.fillStyle = TXT_SEC; yCtx.textAlign = 'right';
      yCtx.fillText(`${(p*100).toFixed(0)}`, YAXIS_W-5, y+3.5);
    }

    // Unit label
    yCtx.save();
    yCtx.translate(9, PAD_TOP + drawH/2);
    yCtx.rotate(-Math.PI/2);
    yCtx.fillStyle = TXT_SEC; yCtx.font = '9px system-ui,sans-serif'; yCtx.textAlign = 'center';
    yCtx.fillText('ct/kWh', 0, 0);
    yCtx.restore();

    // Zero label on y-axis when negatives present
    if (hasNeg) {
      yCtx.fillStyle = 'rgba(255,255,255,0.45)';
      yCtx.font = 'bold 9px system-ui,sans-serif'; yCtx.textAlign = 'right';
      yCtx.fillText('0', YAXIS_W-5, zeroY+3.5);
    }

    // Average dashed line on y-axis
    yCtx.save();
    yCtx.strokeStyle = PRIMARY; yCtx.lineWidth = 1.5; yCtx.globalAlpha = 0.5;
    yCtx.setLineDash([5,5]);
    yCtx.beginPath(); yCtx.moveTo(0, avgY); yCtx.lineTo(YAXIS_W, avgY); yCtx.stroke();
    yCtx.setLineDash([]); yCtx.restore();

    // ── BARS canvas ──

    // Horizontal grid lines (full width)
    bCtx.lineWidth = 0.5; bCtx.setLineDash([3,4]);
    for (let i = 0; i <= 5; i++) {
      const y = PAD_TOP + drawH * (i/5);
      bCtx.strokeStyle = DIV;
      bCtx.beginPath(); bCtx.moveTo(0, y); bCtx.lineTo(barsW, y); bCtx.stroke();
    }
    bCtx.setLineDash([]);

    // Zero line
    if (hasNeg) {
      bCtx.save();
      bCtx.strokeStyle = 'rgba(255,255,255,0.22)'; bCtx.lineWidth = 1;
      bCtx.beginPath(); bCtx.moveTo(0, zeroY); bCtx.lineTo(barsW, zeroY); bCtx.stroke();
      bCtx.restore();
    }

    // Average dashed line (no label — shown in header)
    bCtx.save();
    bCtx.strokeStyle = PRIMARY; bCtx.lineWidth = 1.5; bCtx.globalAlpha = 0.45;
    bCtx.setLineDash([5,5]);
    bCtx.beginPath(); bCtx.moveTo(0, avgY); bCtx.lineTo(barsW, avgY); bCtx.stroke();
    bCtx.setLineDash([]); bCtx.restore();

    // ── Bars ──
    const now = new Date();
    this._barData = []; // CSS pixels relative to bars canvas

    prices.forEach((item, i) => {
      const x     = BAR_L + i * (BAR_W + BAR_GAP);
      const isCur = item.start <= now && now < item.end;
      const isNeg = item.display < 0;
      const topY  = isNeg ? zeroY : pY(item.display);
      const botY  = isNeg ? pY(item.display) : zeroY;
      const barH  = Math.max(3, Math.abs(botY - topY));

      let color;
      if      (isNeg)                    color = '#06b6d4';
      else if (item.display <= cheapThr) color = '#22c55e';
      else if (item.display >= expThr)   color = '#ef4444';
      else                               color = PRIMARY;

      bCtx.save();
      bCtx.globalAlpha = isCur ? 1.0 : 0.82;
      bCtx.fillStyle   = color;
      if (isCur) { bCtx.shadowColor = color; bCtx.shadowBlur = 14; }
      rRect(bCtx, x, topY, BAR_W, barH, isNeg ? [0,0,2,2] : [2,2,0,0]);
      bCtx.fill();
      bCtx.restore();

      // Store in CSS pixels (relative to bars canvas left edge)
      this._barData.push({
        x, w: BAR_W + BAR_GAP,
        start: item.start, end: item.end,
        market: item.market, allin: item.allin, display: item.display,
      });
    });

    // ── "Nu" indicator ──
    const nowIdx = prices.findIndex(p => p.start <= now && now < p.end);
    if (nowIdx >= 0) {
      const nowX = BAR_L + nowIdx * (BAR_W + BAR_GAP) + BAR_W / 2;
      bCtx.save();
      bCtx.strokeStyle = '#fff'; bCtx.lineWidth = 1.5; bCtx.globalAlpha = 0.75;
      bCtx.setLineDash([3,3]);
      bCtx.beginPath(); bCtx.moveTo(nowX, PAD_TOP-4); bCtx.lineTo(nowX, PAD_TOP+drawH+4); bCtx.stroke();
      bCtx.setLineDash([]);
      bCtx.globalAlpha = 1;
      const badge = 'Nu';
      bCtx.font = 'bold 9px system-ui,sans-serif'; bCtx.textAlign = 'center';
      const bw = bCtx.measureText(badge).width + 7;
      bCtx.fillStyle = '#fff';
      rRect(bCtx, nowX-bw/2, PAD_TOP-16, bw, 13, 3); bCtx.fill();
      bCtx.fillStyle = '#222'; bCtx.fillText(badge, nowX, PAD_TOP-6.5);
      bCtx.restore();

      if (!this._nowScrolled) {
        this._nowScrolled = true;
        requestAnimationFrame(() => {
          scroll.scrollLeft = Math.max(0, nowX - scroll.clientWidth/2);
        });
      }
    }

    // ── X-axis labels (every 4h) + day separators ──
    let lastDay = null, lastLabelH = -1;

    prices.forEach((item, i) => {
      const x   = BAR_L + i * (BAR_W + BAR_GAP) + BAR_W/2;
      const day = item.start.getDate();
      const h   = item.start.getHours();
      const m   = item.start.getMinutes();

      if (lastDay !== null && day !== lastDay) {
        const sx = BAR_L + i * (BAR_W + BAR_GAP) - BAR_GAP/2;
        bCtx.save();
        bCtx.strokeStyle = 'rgba(255,255,255,0.15)'; bCtx.lineWidth = 1;
        bCtx.setLineDash([4,4]);
        bCtx.beginPath(); bCtx.moveTo(sx, PAD_TOP-4); bCtx.lineTo(sx, PAD_TOP+drawH+32); bCtx.stroke();
        bCtx.setLineDash([]);
        const dayStr = item.start.toLocaleDateString('nl-NL',{weekday:'short',day:'numeric',month:'short'});
        bCtx.fillStyle = TXT_SEC; bCtx.font = 'bold 9px system-ui,sans-serif';
        bCtx.textAlign = 'left'; bCtx.globalAlpha = 0.85;
        bCtx.fillText(dayStr, sx+4, PAD_TOP+drawH+38);
        bCtx.restore();
        lastLabelH = -1;
      }

      if (m === 0 && h % 4 === 0 && h !== lastLabelH) {
        lastLabelH = h;
        bCtx.fillStyle  = TXT_SEC;
        bCtx.font       = '10px system-ui,sans-serif';
        bCtx.textAlign  = 'center'; bCtx.globalAlpha = 1;
        bCtx.fillText(`${String(h).padStart(2,'0')}:00`, x, PAD_TOP+drawH+14);
        bCtx.strokeStyle = DIV; bCtx.lineWidth = 0.5;
        bCtx.beginPath(); bCtx.moveTo(x, PAD_TOP+drawH+2); bCtx.lineTo(x, PAD_TOP+drawH+6); bCtx.stroke();
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
