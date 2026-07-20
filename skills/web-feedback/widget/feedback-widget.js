/*
 * web-feedback-widget
 * ---------------------
 * Drop-in, DEV-ONLY visual feedback tool for Claude-generated web apps.
 *
 * Usage (served by the collector so the URL doubles as the server origin):
 *   <script src="http://localhost:4765/feedback-widget.js" defer></script>
 *
 * How it works for the user:
 *   - Hold SHIFT and click anywhere on the page.
 *   - A comment box opens at that spot. Type feedback, press Submit (or Ctrl/Cmd+Enter).
 *   - The widget screenshots the page (html2canvas), draws a numbered pin at the
 *     click point, and POSTs everything to the local collector, which writes a
 *     SQLite row + saves the annotated PNG.
 *   - A numbered marker stays pinned on the page; a floating badge shows the count.
 *
 * Everything the widget adds is marked data-html2canvas-ignore so it never
 * appears inside its own screenshots.
 */
(function () {
  'use strict';

  if (window.__webFeedbackLoaded) return;
  window.__webFeedbackLoaded = true;

  // ---- config -------------------------------------------------------------
  // Derive the collector origin from this <script>'s own src.
  const currentScript =
    document.currentScript ||
    Array.from(document.getElementsByTagName('script')).find((s) =>
      /feedback-widget\.js/.test(s.src)
    );
  const scriptOrigin = currentScript ? new URL(currentScript.src).origin : 'http://localhost:4765';

  const CONFIG = Object.assign(
    {
      server: scriptOrigin, // collector base URL
      project: location.host || 'app', // grouping key for the SQLite `project` column
      // Capture engines, all served by the collector (works even under a strict
      // app CSP that would block a CDN). snapdom is primary because it renders
      // via the browser, so modern CSS colors (oklch/oklab/lab/color()) — which
      // html2canvas 1.4.1 throws on — just work. html2canvas is the fallback.
      snapdom: scriptOrigin + '/vendor/snapdom.js',
      html2canvas: scriptOrigin + '/vendor/html2canvas.js',
      html2canvasFallback:
        'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
      maxConsoleLogs: 200, // ring-buffer caps for the debug capture
      maxNetworkLogs: 100,
    },
    window.FEEDBACK_CONFIG || {}
  );

  let count = 0; // markers placed this session

  // ---- debug capture: console logs + network requests ---------------------
  // Two ring buffers filled continuously from page load. A recent slice of each
  // is attached to every feedback submission so Claude can debug with the exact
  // console output and network activity that was live when the note was left.
  const consoleBuf = [];
  const networkBuf = [];

  function pushCapped(buf, entry, max) {
    buf.push(entry);
    if (buf.length > max) buf.splice(0, buf.length - max);
  }

  // Stringify a console argument compactly and safely (handles Errors, DOM
  // nodes, and circular objects without throwing).
  function stringifyArg(a) {
    try {
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (typeof a === 'string') return a;
      if (a instanceof Element) return `<${a.tagName.toLowerCase()}>`;
      if (typeof a === 'undefined') return 'undefined';
      if (typeof a === 'function') return `[function ${a.name || 'anonymous'}]`;
      const seen = new WeakSet();
      return JSON.stringify(a, (k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        return typeof v === 'bigint' ? String(v) : v;
      });
    } catch {
      try { return String(a); } catch { return '[unserializable]'; }
    }
  }

  function nowMs() {
    try { return performance.now(); } catch { return 0; }
  }

  // Patch console methods, preserving the originals so the page still logs.
  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = console[level] ? console[level].bind(console) : null;
    console[level] = function () {
      const args = Array.prototype.slice.call(arguments);
      pushCapped(
        consoleBuf,
        { level, time: new Date().toISOString(), message: args.map(stringifyArg).join(' ').slice(0, 2000) },
        CONFIG.maxConsoleLogs
      );
      if (orig) orig.apply(null, arguments);
    };
  });

  // Uncaught errors and unhandled promise rejections are the most useful signal.
  window.addEventListener('error', (e) => {
    pushCapped(
      consoleBuf,
      {
        level: 'error',
        time: new Date().toISOString(),
        message:
          (e.message || 'Uncaught error') +
          (e.filename ? ` (${e.filename}:${e.lineno || 0}:${e.colno || 0})` : '') +
          (e.error && e.error.stack ? `\n${e.error.stack}` : ''),
      },
      CONFIG.maxConsoleLogs
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    pushCapped(
      consoleBuf,
      {
        level: 'error',
        time: new Date().toISOString(),
        message: 'Unhandled promise rejection: ' + stringifyArg(r && r.stack ? r.stack : r),
      },
      CONFIG.maxConsoleLogs
    );
  });

  function recordNetwork(entry) {
    pushCapped(networkBuf, entry, CONFIG.maxNetworkLogs);
  }

  // Patch fetch — records method, URL, status, duration, and errors. Requests to
  // our own collector are skipped so the widget's traffic never pollutes the log.
  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (url.indexOf(CONFIG.server) === 0) return origFetch(input, init);
      const started = nowMs();
      const t = new Date().toISOString();
      return origFetch(input, init).then(
        (resp) => {
          recordNetwork({
            time: t, type: 'fetch', method: method.toUpperCase(), url: String(url).slice(0, 500),
            status: resp.status, ok: resp.ok, durationMs: Math.round(nowMs() - started),
          });
          return resp;
        },
        (err) => {
          recordNetwork({
            time: t, type: 'fetch', method: method.toUpperCase(), url: String(url).slice(0, 500),
            status: 0, ok: false, error: String((err && err.message) || err), durationMs: Math.round(nowMs() - started),
          });
          throw err;
        }
      );
    };
  }

  // Patch XMLHttpRequest for libraries (axios, older code) that don't use fetch.
  if (typeof window.XMLHttpRequest === 'function') {
    const XHR = window.XMLHttpRequest;
    const open = XHR.prototype.open;
    const sendXhr = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__wf = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), started: 0, time: '' };
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const meta = this.__wf;
      if (meta && meta.url.indexOf(CONFIG.server) !== 0) {
        meta.started = nowMs();
        meta.time = new Date().toISOString();
        this.addEventListener('loadend', () => {
          recordNetwork({
            time: meta.time, type: 'xhr', method: meta.method, url: meta.url.slice(0, 500),
            status: this.status, ok: this.status >= 200 && this.status < 400,
            durationMs: Math.round(nowMs() - meta.started),
          });
        });
      }
      return sendXhr.apply(this, arguments);
    };
  }

  // ---- styles -------------------------------------------------------------
  const style = document.createElement('style');
  style.setAttribute('data-html2canvas-ignore', 'true');
  style.textContent = `
    /* pointer-events:auto on every interactive widget element so it stays
       clickable even when the app disables the page with body{pointer-events:none}
       while a modal is open (the Radix/Vaul/Headless UI pattern) — that value
       inherits, so without this our own Submit button would be dead. */
    .wf-badge{position:fixed;right:16px;bottom:16px;z-index:2147483000;
      background:#4338ca;color:#fff;font:600 13px/1 system-ui,sans-serif;
      padding:10px 14px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.25);
      cursor:default;display:flex;align-items:center;gap:8px;user-select:none;
      pointer-events:auto}
    .wf-badge b{background:rgba(255,255,255,.22);border-radius:999px;padding:1px 7px}
    .wf-badge small{opacity:.85;font-weight:500}
    .wf-marker{position:absolute;z-index:2147482000;width:26px;height:26px;
      margin:-13px 0 0 -13px;border-radius:50%;background:#e11d48;color:#fff;
      font:700 13px/26px system-ui,sans-serif;text-align:center;cursor:pointer;
      box-shadow:0 2px 6px rgba(0,0,0,.4);border:2px solid #fff;pointer-events:auto}
    /* Rendered as a native <dialog> opened with showModal() so it sits in the
       browser top layer — above any app modal/sidebar — and makes the rest of
       the page inert, which stops focus-trap libraries from stealing focus. */
    dialog.wf-pop{position:fixed;z-index:2147483647;width:280px;max-width:calc(100vw - 16px);
      padding:0;border:0;margin:0;background:#fff;
      border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.28);
      font:14px system-ui,sans-serif;color:#111;overflow:hidden;pointer-events:auto}
    dialog.wf-pop::backdrop{background:transparent}
    .wf-pop header{background:#4338ca;color:#fff;font-weight:600;font-size:13px;
      padding:8px 12px;display:flex;justify-content:space-between;align-items:center}
    .wf-pop textarea{width:100%;box-sizing:border-box;border:0;resize:vertical;
      min-height:84px;padding:10px 12px;font:14px system-ui,sans-serif;outline:none}
    .wf-pop footer{display:flex;gap:8px;justify-content:flex-end;padding:8px 12px;
      border-top:1px solid #eee}
    .wf-pop button{font:600 13px system-ui,sans-serif;border-radius:7px;padding:6px 12px;
      border:0;cursor:pointer}
    .wf-pop .wf-cancel{background:#f1f1f4;color:#333}
    .wf-pop .wf-submit{background:#4338ca;color:#fff}
    .wf-pop .wf-submit:disabled{opacity:.5;cursor:progress}
    .wf-pop .wf-delete{background:#fee2e2;color:#b91c1c}
    .wf-pop .wf-resolve{background:#065f46;color:#fff}
    .wf-pop .wf-spacer{flex:1}
    .wf-hint{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);
      z-index:2147483000;background:rgba(17,17,17,.9);color:#fff;font:12px system-ui,sans-serif;
      padding:6px 12px;border-radius:6px;pointer-events:none;opacity:0;transition:opacity .2s}
    .wf-toast{position:fixed;right:16px;bottom:64px;z-index:2147483600;
      background:#065f46;color:#fff;font:600 13px system-ui,sans-serif;padding:9px 14px;
      border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.3);opacity:0;transform:translateY(6px);
      transition:opacity .2s,transform .2s}
    .wf-toast.show{opacity:1;transform:translateY(0)}
  `;

  const markerLayer = document.createElement('div');
  markerLayer.setAttribute('data-html2canvas-ignore', 'true');
  markerLayer.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;';

  const badge = document.createElement('div');
  badge.className = 'wf-badge';
  badge.setAttribute('data-html2canvas-ignore', 'true');
  badge.title = 'Drag to move';
  badge.innerHTML = `💬 <b>0</b> <small>Shift+click to add feedback</small>`;

  // The badge sits over the bottom-right corner, which can cover app buttons.
  // Make it draggable (and remember where it was left) so it can be moved aside.
  // NOTE: declared before ready() runs — ready() is invoked synchronously below
  // and calls restoreBadgePosition(), which reads this key (avoids a TDZ error).
  const BADGE_POS_KEY = 'wf-badge-pos';

  function ready() {
    document.head.appendChild(style);
    document.body.appendChild(markerLayer);
    document.body.appendChild(badge);
    restoreBadgePosition();
    makeDraggable(badge);
    refresh();
  }
  if (document.body) ready();
  else document.addEventListener('DOMContentLoaded', ready);

  function clampBadge(x, y) {
    const w = badge.offsetWidth || 160;
    const h = badge.offsetHeight || 40;
    return {
      x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    };
  }

  function restoreBadgePosition() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(BADGE_POS_KEY) || 'null'); } catch { /* ignore */ }
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
      const { x, y } = clampBadge(saved.x, saved.y);
      badge.style.right = 'auto';
      badge.style.bottom = 'auto';
      badge.style.left = x + 'px';
      badge.style.top = y + 'px';
    }
  }

  function makeDraggable(el) {
    let dragging = false;
    let moved = false;
    let sx = 0, sy = 0, ox = 0, oy = 0;
    el.style.cursor = 'grab';
    el.style.touchAction = 'none';

    el.addEventListener('pointerdown', (e) => {
      dragging = true;
      moved = false;
      const r = el.getBoundingClientRect();
      // Switch from right/bottom anchoring to left/top so we can move freely.
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      el.style.left = r.left + 'px';
      el.style.top = r.top + 'px';
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      el.style.cursor = 'grabbing';
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });

    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      const { x, y } = clampBadge(ox + dx, oy + dy);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    });

    function end(e) {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'grab';
      try { el.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (moved) {
        try {
          localStorage.setItem(
            BADGE_POS_KEY,
            JSON.stringify({ x: parseInt(el.style.left, 10), y: parseInt(el.style.top, 10) })
          );
        } catch { /* ignore */ }
      }
    }
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    // Keep the badge on-screen if the window is resized.
    window.addEventListener('resize', () => {
      if (badge.style.left) {
        const { x, y } = clampBadge(parseInt(badge.style.left, 10), parseInt(badge.style.top, 10));
        badge.style.left = x + 'px';
        badge.style.top = y + 'px';
      }
    });
  }

  // Pins belong to the URL they were left on. Match on the full href (minus any
  // trailing #hash) so a pin shows only on its own page and never leaks onto
  // another route — including SPA (client-side) navigations that don't reload.
  function normalizeUrl(u) {
    try { const x = new URL(u, location.href); x.hash = ''; return x.href; } catch { return u; }
  }

  let lastUrl = normalizeUrl(location.href);

  // Fetch project feedback: seed `count` for numbering AND (re)draw only the pins
  // that belong to the current URL. Clears any pins from a previous route first.
  function refresh() {
    markerLayer.replaceChildren(); // drop pins from the page we may have left
    fetch(CONFIG.server + '/feedback?project=' + encodeURIComponent(CONFIG.project) + '&limit=1000')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data || !data.feedback) return;
        count = data.feedback.reduce((m, f) => Math.max(m, f.number || 0), 0);
        badge.querySelector('b').textContent = count;
        const here = normalizeUrl(location.href);
        data.feedback
          .filter((f) => f.status === 'open' && normalizeUrl(f.url) === here)
          .forEach((f) => placeMarker({ id: f.id, number: f.number, text: f.text, x: f.page_x, y: f.page_y }));
      })
      .catch(() => {});
  }

  // Re-render when the URL changes without a full reload (SPA routing). We patch
  // pushState/replaceState and listen for popstate + hashchange.
  function onUrlMaybeChanged() {
    const now = normalizeUrl(location.href);
    if (now === lastUrl) return;
    lastUrl = now;
    refresh();
  }
  ['pushState', 'replaceState'].forEach((m) => {
    const orig = history[m];
    if (typeof orig === 'function') {
      history[m] = function () {
        const ret = orig.apply(this, arguments);
        window.dispatchEvent(new Event('wf-locationchange'));
        return ret;
      };
    }
  });
  window.addEventListener('wf-locationchange', onUrlMaybeChanged);
  window.addEventListener('popstate', onUrlMaybeChanged);
  window.addEventListener('hashchange', onUrlMaybeChanged);

  // ---- helpers ------------------------------------------------------------
  function cssSelector(el) {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let sel = node.nodeName.toLowerCase();
      if (node.id) {
        sel += '#' + CSS.escape(node.id);
        parts.unshift(sel);
        break;
      }
      const cls = (node.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
      if (cls.length) sel += '.' + cls.slice(0, 2).map((c) => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.nodeName === node.nodeName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function loadScript(src, isReady) {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = src;
      s.setAttribute('data-html2canvas-ignore', 'true');
      s.onload = () => resolve(isReady() || null);
      s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
  }

  // Load the capture engine. snapdom (bundled, served by the collector) is the
  // primary: it renders through the browser, so modern CSS colors just work.
  // html2canvas (local, then CDN) is the fallback for the rare case snapdom
  // can't load. Returns { engine: 'snapdom'|'html2canvas', lib } or null.
  let captureLoadError = null;
  async function loadCapturer() {
    if (window.snapdom) return { engine: 'snapdom', lib: window.snapdom };
    const snap = await loadScript(CONFIG.snapdom, () => window.snapdom);
    if (snap) return { engine: 'snapdom', lib: snap };

    if (window.html2canvas) return { engine: 'html2canvas', lib: window.html2canvas };
    let h2c = await loadScript(CONFIG.html2canvas, () => window.html2canvas);
    if (!h2c) h2c = await loadScript(CONFIG.html2canvasFallback, () => window.html2canvas);
    if (h2c) return { engine: 'html2canvas', lib: h2c };

    captureLoadError =
      'No capture engine could load from the collector (' + CONFIG.server +
      ') or the CDN — a Content-Security-Policy may be blocking it.';
    return null;
  }

  // Find the nearest opaque background color so the screenshot isn't transparent
  // (which renders as black). Falls back to white.
  function opaqueBackground() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && !/rgba?\([^)]*,\s*0\s*\)$/.test(bg) && bg !== 'transparent') return bg;
    }
    return '#ffffff';
  }

  // Draw the numbered pin onto a captured canvas at the click point (given in
  // CSS px). Engines differ in how their canvas maps to CSS px:
  //   - html2canvas (scale:1): canvas is 1:1 with CSS px, identity transform.
  //   - snapdom: canvas is devicePixelRatio-sized AND its 2D context already has
  //     a matching scale transform, so you draw in CSS px.
  // To stay correct for both, we convert the CSS point to the *device* pixel we
  // want, then divide by the context's current scale to get the coordinate to
  // pass into the (possibly pre-scaled) context.
  function drawPin(canvas, pageX, pageY, number, cssW, cssH) {
    const ctx = canvas.getContext('2d');
    const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : { a: 1, d: 1 };
    const sx = (cssW ? canvas.width / cssW : 1) / (m.a || 1);
    const sy = (cssH ? canvas.height / cssH : 1) / (m.d || 1);
    const cx = pageX * sx;
    const cy = pageY * sy;
    const r = 15 * sx;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#e11d48';
    ctx.fill();
    ctx.lineWidth = 3 * sx;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `700 ${18 * sx}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(number), cx, cy);
  }

  // Screenshot the full page and draw a numbered pin at the click point.
  // Returns { dataUrl, error } — error is a human-readable reason on failure so
  // the miss is never silent (the feedback still records without a screenshot).
  async function capture(pageX, pageY, number) {
    const cap = await loadCapturer();
    if (!cap) return { dataUrl: null, error: captureLoadError || 'capture engine failed to load.' };

    const de = document.documentElement;
    try {
      let canvas;
      if (cap.engine === 'snapdom') {
        // snapdom renders via the browser (oklch/oklab/lab/color() all work).
        // Exclude the widget's own DOM so it never appears in the shot.
        canvas = await cap.lib.toCanvas(de, {
          backgroundColor: opaqueBackground(),
          filter: (el) => !(el.nodeType === 1 && el.hasAttribute && el.hasAttribute('data-html2canvas-ignore')),
          exclude: ['[data-html2canvas-ignore]'],
        });
      } else {
        canvas = await cap.lib(de, {
          useCORS: true,
          logging: false,
          scale: 1,
          backgroundColor: opaqueBackground(),
          width: de.scrollWidth,
          height: de.scrollHeight,
          windowWidth: de.scrollWidth,
          windowHeight: de.scrollHeight,
        });
      }
      drawPin(canvas, pageX, pageY, number, de.scrollWidth, de.scrollHeight);
      return { dataUrl: canvas.toDataURL('image/png'), error: null };
    } catch (e) {
      const msg = String((e && e.message) || e);
      return {
        dataUrl: null,
        error: '[' + cap.engine + '] screenshot failed: ' + msg,
      };
    }
  }

  // pin: { id, number, text, x, y }  (x/y are page coordinates)
  function placeMarker(pin) {
    const m = document.createElement('div');
    m.className = 'wf-marker';
    m.setAttribute('data-html2canvas-ignore', 'true');
    m.style.left = pin.x + 'px';
    m.style.top = pin.y + 'px';
    m.textContent = pin.number;
    m.title = `#${pin.number}: ${pin.text}\n(click to edit, resolve, or delete)`;
    // Keep pin interactions from reaching the host app's document handlers
    // (e.g. click-outside-to-close), same as the dialogs.
    ['pointerdown', 'mousedown', 'touchstart'].forEach((t) =>
      m.addEventListener(t, (e) => e.stopPropagation())
    );
    m.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMarkerDetail(pin, m);
    });
    markerLayer.appendChild(m);
  }

  // Click an existing pin to view its text and edit / resolve / delete it.
  function openMarkerDetail(pin, markerEl) {
    closePop();
    const pop = document.createElement('dialog');
    pop.className = 'wf-pop';
    pop.setAttribute('data-html2canvas-ignore', 'true');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const vx = pin.x - window.scrollX;
    const vy = pin.y - window.scrollY;
    pop.style.left = Math.max(8, Math.min(vx, vw - 288)) + 'px';
    pop.style.top = Math.max(8, Math.min(vy + 8, vh - 240)) + 'px';
    pop.innerHTML = `
      <header><span>Feedback #${pin.number}</span><span style="cursor:pointer" data-wf-x>✕</span></header>
      <textarea autofocus></textarea>
      <footer>
        <button class="wf-delete" type="button">Delete</button>
        <span class="wf-spacer"></span>
        <button class="wf-resolve" type="button">Resolve</button>
        <button class="wf-submit wf-save" type="button">Save</button>
      </footer>`;
    showDialog(pop);

    const textarea = pop.querySelector('textarea');
    textarea.value = pin.text;
    requestAnimationFrame(() => textarea.focus());
    pop.querySelector('[data-wf-x]').onclick = closePop;

    pop.querySelector('.wf-save').onclick = async () => {
      const text = textarea.value.trim();
      if (!text) { textarea.focus(); return; }
      try {
        const r = await fetch(CONFIG.server + '/feedback/' + pin.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        pin.text = text;
        markerEl.title = `#${pin.number}: ${text}\n(click to edit, resolve, or delete)`;
        toast(`Feedback #${pin.number} updated`);
        closePop();
      } catch (err) {
        toast('Update failed — is the collector running?');
        console.warn('[web-feedback] edit failed:', err);
      }
    };

    pop.querySelector('.wf-delete').onclick = async () => {
      try {
        const r = await fetch(CONFIG.server + '/feedback/' + pin.id, { method: 'DELETE' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        markerEl.remove();
        toast(`Feedback #${pin.number} deleted`);
        closePop();
      } catch (err) {
        toast('Delete failed — is the collector running?');
        console.warn('[web-feedback] delete failed:', err);
      }
    };

    pop.querySelector('.wf-resolve').onclick = async () => {
      try {
        const r = await fetch(CONFIG.server + '/feedback/' + pin.id + '/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: 'Resolved from widget' }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        markerEl.remove(); // resolved pins are no longer shown
        toast(`Feedback #${pin.number} resolved`);
        closePop();
      } catch (err) {
        toast('Resolve failed — is the collector running?');
        console.warn('[web-feedback] resolve failed:', err);
      }
    };
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'wf-toast';
    t.setAttribute('data-html2canvas-ignore', 'true');
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    }, 2600);
  }

  // ---- comment popover ----------------------------------------------------
  let openPop = null;

  function closePop() {
    if (openPop) {
      try {
        if (openPop.open && typeof openPop.close === 'function') openPop.close();
      } catch { /* not a dialog / already closed */ }
      openPop.remove();
      openPop = null;
    }
  }

  // Stop interactions inside our dialog from reaching the host app's
  // document-level handlers (click-outside-to-close, focus guards, etc.). Without
  // this, an app modal/sidebar can swallow clicks on our Submit/Save buttons.
  function isolate(el) {
    ['pointerdown', 'mousedown', 'click', 'touchstart', 'keydown', 'keyup'].forEach((t) =>
      el.addEventListener(t, (e) => e.stopPropagation())
    );
  }

  // Append a <dialog>, put it in the top layer (above any app modal/sidebar),
  // isolate its events, and wire native close cleanup.
  function showDialog(pop) {
    document.body.appendChild(pop);
    openPop = pop;
    if (typeof pop.showModal === 'function') {
      try { pop.showModal(); } catch { pop.show && pop.show(); }
    } else if (typeof pop.show === 'function') {
      pop.show();
    }
    isolate(pop);
    pop.addEventListener('close', () => {
      if (openPop === pop) { pop.remove(); openPop = null; }
    });
  }

  function openComment(ev) {
    closePop();
    const pageX = ev.pageX;
    const pageY = ev.pageY;
    const targetEl = ev.target;
    const selector = cssSelector(targetEl);
    const elementText = (targetEl.textContent || '').trim().slice(0, 120);

    // A native <dialog> opened with showModal() sits in the browser top layer, so
    // it renders above any app modal/sidebar and makes the rest of the page inert —
    // which is what stops a focus-trap library from stealing focus from our input.
    const pop = document.createElement('dialog');
    pop.className = 'wf-pop';
    pop.setAttribute('data-html2canvas-ignore', 'true');
    // Position at the click, in VIEWPORT coordinates (dialog is position:fixed).
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    pop.style.left = Math.max(8, Math.min(ev.clientX, vw - 288)) + 'px';
    pop.style.top = Math.max(8, Math.min(ev.clientY + 8, vh - 224)) + 'px';
    pop.innerHTML = `
      <header><span>Feedback #${count + 1}</span><span style="cursor:pointer" data-wf-x>✕</span></header>
      <textarea placeholder="What's wrong or what would you change here?" autofocus></textarea>
      <footer>
        <button class="wf-cancel" type="button">Cancel</button>
        <button class="wf-submit" type="button">Submit</button>
      </footer>`;
    showDialog(pop);

    const textarea = pop.querySelector('textarea');
    const submitBtn = pop.querySelector('.wf-submit');
    // Focus after the dialog is in the top layer (next frame, so autofocus + inert
    // have settled and no app handler can pull focus back out).
    requestAnimationFrame(() => textarea.focus());

    pop.querySelector('[data-wf-x]').onclick = closePop;
    pop.querySelector('.wf-cancel').onclick = closePop;

    async function submit() {
      const text = textarea.value.trim();
      if (!text) {
        textarea.focus();
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';
      const number = count + 1;

      // Hide the popover before capture so it isn't in the screenshot.
      pop.style.visibility = 'hidden';
      const shot = await capture(pageX, pageY, number);
      pop.style.visibility = 'visible';
      if (shot.error) {
        console.warn('[web-feedback] screenshot capture failed:', shot.error);
      }

      try {
        const res = await fetch(CONFIG.server + '/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: CONFIG.project,
            url: location.href,
            text,
            selector,
            elementText,
            pageX,
            pageY,
            viewportX: pageX - window.scrollX,
            viewportY: pageY - window.scrollY,
            viewportW: window.innerWidth,
            viewportH: window.innerHeight,
            screenshot: shot.dataUrl,
            captureError: shot.error,
            consoleLogs: consoleBuf.slice(),
            networkLogs: networkBuf.slice(),
          }),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const saved = await res.json();
        count = saved.number;
        placeMarker({ id: saved.id, number: saved.number, text, x: pageX, y: pageY });
        badge.querySelector('b').textContent = count;
        toast(
          shot.error
            ? `Feedback #${saved.number} saved (no screenshot — see console)`
            : `Feedback #${saved.number} saved`
        );
        closePop();
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Retry';
        toast('Could not reach collector on ' + CONFIG.server);
        console.warn('[web-feedback] submit failed:', err);
      }
    }

    submitBtn.onclick = submit;
    textarea.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
      if (e.key === 'Escape') closePop();
    });
  }

  // ---- interaction --------------------------------------------------------
  document.addEventListener(
    'click',
    (ev) => {
      if (!ev.shiftKey) return;
      if (ev.target.closest('.wf-pop, .wf-badge, .wf-marker')) return;
      ev.preventDefault();
      ev.stopPropagation();
      openComment(ev);
    },
    true
  );

  // Visual hint while Shift is held.
  const hint = document.createElement('div');
  hint.className = 'wf-hint';
  hint.setAttribute('data-html2canvas-ignore', 'true');
  hint.textContent = 'Click anywhere to leave feedback';
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && document.body && !hint.parentNode) {
      document.body.appendChild(hint);
      requestAnimationFrame(() => (hint.style.opacity = '1'));
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') {
      hint.style.opacity = '0';
      setTimeout(() => hint.remove(), 200);
    }
  });

  console.info(
    `%c[web-feedback]%c active — Shift+click to leave feedback. Collector: ${CONFIG.server}`,
    'background:#4338ca;color:#fff;padding:1px 5px;border-radius:3px',
    'color:inherit'
  );
})();
