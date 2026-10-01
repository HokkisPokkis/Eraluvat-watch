// ==UserScript==
// @name         Eraluvat kanalintu autovaraaja
// @namespace    https://www.eraluvat.fi/
// @version      1.4.2
// @description  Vesijako -> Evo, vain valitut paivat, 1 aikuinen / paiva.
// @match        https://www.eraluvat.fi/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      api.pushover.net
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    pollMs: 5000,
    productId: 5,
    areas: [
      { name: 'Vesijako', areaId: 983 },
      { name: 'Evo', areaId: 337 }
    ],
    dates: [
      '2026-09-27','2026-09-29','2026-10-04','2026-10-07','2026-10-09','2026-10-10','2026-10-11',
      '2026-10-16','2026-10-18','2026-10-22','2026-10-28','2026-10-29','2026-10-30','2026-10-31',
      '2026-11-01','2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'
    ],
    extraDatesByArea: {
      337: ['2026-10-03'] // Evo only
    }
  };

  const API = 'https://api.eraluvat.fi/orders/v1';
  const SESSION = 'https://www.eraluvat.fi/api/auth/session';
  const K_ENABLED = 'eraluvat_auto_enabled';
  const K_STATE = 'eraluvat_auto_state';
  const K_PUSH_USER = 'eraluvat_pushover_user';
  const K_PUSH_TOKEN = 'eraluvat_pushover_token';
  const K_DIAG = 'eraluvat_diag_log_v1';
  const TZ = 'Europe/Helsinki';

  let timer = null;
  let busy = false;
  let wakeLock = null;
  let lastCheck = null;
  let logLines = [];
  const lastFreeSignature = {};

  const on = () => localStorage.getItem(K_ENABLED) === '1';

  function loadState() {
    try {
      const x = JSON.parse(localStorage.getItem(K_STATE) || '{"reservations":[]}');
      if (!Array.isArray(x.reservations)) x.reservations = [];
      return x;
    } catch {
      return { reservations: [] };
    }
  }

  function saveState(x) {
    localStorage.setItem(K_STATE, JSON.stringify(x));
  }

  function activeReservations() {
    const x = loadState();
    const now = Date.now();
    x.reservations = x.reservations.filter(r => new Date(r.validTo || 0).getTime() > now - 60000);
    saveState(x);
    return x.reservations;
  }

  function remember(areaId, area, date, body) {
    const x = loadState();
    x.reservations = activeReservations();
    x.reservations.push({
      areaId, area, date,
      validTo: body?.validTo || new Date(Date.now() + 30*60*1000).toISOString(),
      orderId: body?.id || null
    });
    saveState(x);
  }

  function already(areaId, date) {
    return activeReservations().some(r => r.areaId === areaId && r.date === date);
  }

  function fiDate(k) {
    const [y,m,d] = k.split('-');
    return `${Number(d)}.${Number(m)}.${y}`;
  }

  function localDateKey(iso) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit'
      }).formatToParts(new Date(iso)).map(x => [x.type, x.value])
    );
    return `${p.year}-${p.month}-${p.day}`;
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString('fi-FI');
    logLines.unshift(`${t} ${msg}`);
    logLines = logLines.slice(0, 8);
    console.log('[Eraluvat]', msg);
    render();
  }

  function loadDiag() {
    try {
      const x = JSON.parse(localStorage.getItem(K_DIAG) || '[]');
      return Array.isArray(x) ? x : [];
    } catch {
      return [];
    }
  }

  function diag(msg) {
    const rows = loadDiag();
    const stamp = new Intl.DateTimeFormat('fi-FI', {
      timeZone: TZ,
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit'
    }).format(new Date());
    rows.push(`${stamp}  ${msg}`);
    if (rows.length > 500) rows.splice(0, rows.length - 500);
    localStorage.setItem(K_DIAG, JSON.stringify(rows));
    console.log('[Eraluvat DIAG]', msg);
  }

  function showDiag() {
    const old = document.getElementById('eraluvat-diag-modal');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = 'eraluvat-diag-modal';
    wrap.style.cssText = 'position:fixed;z-index:2147483647;inset:20px;background:#111;color:#fff;border:1px solid #777;border-radius:12px;padding:12px;display:flex;flex-direction:column;box-shadow:0 8px 30px #000a';

    const title = document.createElement('div');
    title.textContent = 'Eräluvat diagnostiikkaloki';
    title.style.cssText = 'font-weight:800;font-size:18px;margin-bottom:8px';

    const ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = loadDiag().join('\n');
    ta.style.cssText = 'flex:1;min-height:240px;background:#080808;color:#eee;border:1px solid #555;border-radius:8px;padding:8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace';

    const row = document.createElement('div');
    row.style.cssText = 'margin-top:8px';

    row.appendChild(button('KOPIOI', async () => {
      try {
        await navigator.clipboard.writeText(ta.value);
        log('Diagnostiikkaloki kopioitu.');
      } catch {
        ta.focus();
        ta.select();
      }
    }));

    row.appendChild(button('TYHJENNÄ', () => {
      if (confirm('Tyhjennetäänkö diagnostiikkaloki?')) {
        localStorage.removeItem(K_DIAG);
        ta.value = '';
        render();
      }
    }));

    row.appendChild(button('SULJE', () => wrap.remove(), true));

    wrap.appendChild(title);
    wrap.appendChild(ta);
    wrap.appendChild(row);
    document.documentElement.appendChild(wrap);
  }

  async function lockScreen() {
    if (!on() || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
    render();
  }

  function calendarUrl(areaId) {
    const q = new URLSearchParams({
      duration:'P1D',
      from:'2026-09-26T21:00:00.000Z',
      to:'2026-11-08T22:00:00.000Z'
    });
    return `${API}/areas/${areaId}/products/${CFG.productId}/calendar?${q}`;
  }

  async function getCalendar(areaId) {
    const r = await fetch(calendarUrl(areaId), {
      cache:'no-store',
      headers:{Accept:'application/json, text/plain, */*'}
    });
    if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
    return r.json();
  }

  async function getToken() {
    const r = await fetch(SESSION, {
      credentials:'include',
      cache:'no-store',
      headers:{Accept:'application/json'}
    });
    if (!r.ok) throw new Error(`session HTTP ${r.status}`);
    const s = await r.json();
    if (!s?.eraAccessToken) throw new Error('Ei eraAccessTokenia - kirjaudu uudelleen.');
    return s.eraAccessToken;
  }

  function pushConfigured() {
    return !!(localStorage.getItem(K_PUSH_USER) && localStorage.getItem(K_PUSH_TOKEN));
  }

  function configurePush() {
    const currentUser = localStorage.getItem(K_PUSH_USER) || '';
    const currentToken = localStorage.getItem(K_PUSH_TOKEN) || '';
    const user = prompt('Pushover User Key:', currentUser);
    if (user === null) return;
    const token = prompt('Pushover Application API Token:', currentToken);
    if (token === null) return;

    const u = user.trim();
    const t = token.trim();
    if (!u || !t) {
      localStorage.removeItem(K_PUSH_USER);
      localStorage.removeItem(K_PUSH_TOKEN);
      log('Pushover-asetukset poistettu.');
    } else {
      localStorage.setItem(K_PUSH_USER, u);
      localStorage.setItem(K_PUSH_TOKEN, t);
      log('Pushover-asetukset tallennettu vain tälle iPadille.');
    }
    render();
  }

  function sendPush(title, message) {
    return new Promise((resolve, reject) => {
      const user = localStorage.getItem(K_PUSH_USER);
      const token = localStorage.getItem(K_PUSH_TOKEN);
      if (!user || !token) {
        reject(new Error('Pushover User Key tai API Token puuttuu.'));
        return;
      }

      const body = new URLSearchParams({
        token,
        user,
        title,
        message,
        priority: '2',
        retry: '30',
        expire: '600',
        url: 'https://www.eraluvat.fi/',
        url_title: 'Avaa Eräluvat'
      }).toString();

      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.pushover.net/1/messages.json',
        headers: {'Content-Type':'application/x-www-form-urlencoded'},
        data: body,
        timeout: 15000,
        onload: response => {
          if (response.status >= 200 && response.status < 300) {
            resolve(true);
          } else {
            reject(new Error('Pushover HTTP ' + response.status + ': ' + (response.responseText || '')));
          }
        },
        onerror: () => reject(new Error('Pushover-verkkopyyntö epäonnistui.')),
        ontimeout: () => reject(new Error('Pushover-verkkopyyntö aikakatkaistiin.'))
      });
    });
  }

  async function testPush() {
    if (!pushConfigured()) {
      configurePush();
      if (!pushConfigured()) return;
    }
    try {
      await sendPush('Eräluvat TESTI', 'Pushover-ilmoitus toimii. Oikea hälytys tulee vain onnistuneesta autovarauksesta.');
      log('Pushover-testiviesti lähetetty.');
    } catch (e) {
      log('Pushover-testin lähetys epäonnistui: ' + e.message);
    }
  }

  async function reserve(area, cap, dateKey, token) {
    const payload = {
      areaId: area.areaId,
      locale: 'fi',
      priceVariations: {
        priceMatrixColumns: { ADULT: 1 },
        priceMatrixRow: 'P1D'
      },
      productId: CFG.productId,
      startDate: cap.from
    };

    diag(`POST START ${area.name} ${fiDate(dateKey)} available=${cap.available}`);

    const r = await fetch(`${API}/order`, {
      method:'POST',
      headers:{
        Accept:'application/json, text/plain, */*',
        Authorization:`Bearer ${token}`,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(payload)
    });

    const raw = await r.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch {}

    if (!r.ok) {
      const detail = body?.message || body?.error || raw || 'ei virhetekstiä';
      diag(`POST FAIL ${area.name} ${fiDate(dateKey)} HTTP=${r.status} detail=${String(detail).replace(/\s+/g,' ').slice(0,500)}`);
      throw new Error(`${area.name} ${fiDate(dateKey)}: HTTP ${r.status}`);
    }

    diag(`POST OK ${area.name} ${fiDate(dateKey)} HTTP=${r.status} orderId=${body?.id || '-'} validTo=${body?.validTo || '-'} rows=${Array.isArray(body?.orderRows) ? body.orderRows.length : '-'}`);
    remember(area.areaId, area.name, dateKey, body);
    log(`VARATTU: ${area.name} ${fiDate(dateKey)}`);
    return body;
  }

  async function candidates() {
    const out = [];

    for (const area of CFG.areas) {
      const wanted = new Set([
        ...CFG.dates,
        ...(CFG.extraDatesByArea?.[area.areaId] || [])
      ]);
      const data = await getCalendar(area.areaId);
      const caps = Array.isArray(data?.capacities) ? data.capacities : [];
      const mapped = caps.map(cap => ({ cap, date: localDateKey(cap.from) }));
      const rawFree = mapped
        .filter(x => wanted.has(x.date) && Number(x.cap.available) > 0)
        .sort((a,b) => a.date.localeCompare(b.date));

      const signature = rawFree.map(x => `${x.date}=${x.cap.available}`).join(',');
      if (signature !== lastFreeSignature[area.areaId]) {
        lastFreeSignature[area.areaId] = signature;
        if (rawFree.length) {
          diag(`FREE ${area.name}: ${rawFree.map(x => `${fiDate(x.date)}=${x.cap.available}`).join(', ')}`);
        } else {
          diag(`FREE ${area.name}: ei valittuja päiviä vapaana`);
        }
      }

      const found = rawFree.filter(x => !already(area.areaId, x.date));
      for (const x of found) out.push({ area, ...x });
    }

    return out; // Vesijako ensin, sitten Evo; lahin paiva ensin
  }

  async function check() {
    if (busy || !on()) return;
    busy = true;

    try {
      const list = await candidates();
      lastCheck = new Date();
      if (!list.length) return;

      log(`Loytyi ${list.length} haluttua vapaata paivaa.`);
      diag(`CANDIDATES order: ${list.map(x => `${x.area.name} ${fiDate(x.date)} avail=${x.cap.available}`).join(' | ')}`);
      const token = await getToken();
      const reservedNow = [];

      for (const x of list) {
        if (already(x.area.areaId, x.date)) continue;
        try {
          await reserve(x.area, x.cap, x.date, token);
          reservedNow.push(`${x.area.name} ${fiDate(x.date)}`);
        } catch (e) {
          log(`Ei onnistunut: ${e.message}`);
        }
      }

      if (reservedNow.length) {
        const msg = reservedNow.join('\n') + '\n\nLuvat ovat ostoskorissa. Maksa ne mahdollisimman pian.';
        if (pushConfigured()) {
          try {
            await sendPush('ERALUVAT: lupa varattu!', msg);
            log('Pushover-hälytys lähetetty.');
          } catch (e) {
            log('Pushover-hälytys epäonnistui: ' + e.message);
          }
        } else {
          log('VAROITUS: Pushover ei ole asetettu.');
        }
      }
    } catch (e) {
      log(`Virhe: ${e.message}`);
    } finally {
      busy = false;
      render();
      schedule();
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (!on()) return;
    timer = setTimeout(check, CFG.pollMs);
  }

  function setOn(v) {
    localStorage.setItem(K_ENABLED, v ? '1' : '0');
    if (v) {
      lockScreen();
      setTimeout(check, 200);
    } else {
      if (timer) clearTimeout(timer);
      timer = null;
      try { wakeLock?.release(); } catch {}
      wakeLock = null;
    }
    render();
  }

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;z-index:2147483647;top:160px;right:12px;width:min(390px,calc(100vw - 24px));max-height:calc(100vh - 110px);overflow:auto;background:#171b20;color:white;border-radius:12px;padding:12px;box-shadow:0 6px 22px #0008;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
  document.documentElement.appendChild(panel);

  function button(text, fn, primary=false) {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = `margin:6px 4px 0 0;padding:8px 10px;border-radius:8px;border:1px solid #777;background:${primary?'#1667d9':'#353b43'};color:#fff;font-weight:700`;
    b.onclick = fn;
    return b;
  }

  function render() {
    const active = activeReservations();
    panel.innerHTML = `
      <div style="font-size:17px;font-weight:800">Eraluvat kanalintu</div>
      <div style="margin:6px 0"><b style="color:${on()?'#68e57b':'#ff8080'}">${on()?'VAHTI PAALLA':'VAHTI POIS'}</b></div>
      <div style="font-size:12px;opacity:.9">
        Vesijako -> Evo<br>
        1 aikuinen / paiva<br>
        tarkistus noin 5 s<br>
        viimeisin: ${lastCheck ? lastCheck.toLocaleTimeString('fi-FI') : '-'}<br>
        muistissa: ${active.length}<br>
        Wake Lock: ${wakeLock ? 'paalla' : 'ei paalla'}<br>
        Pushover: ${pushConfigured() ? 'asetettu' : 'ei asetettu'}<br>
        diag: ${loadDiag().length} riviä
      </div>
      <div id="eraluvat-buttons"></div>
      <div style="margin-top:8px;font-size:11px;opacity:.8">${logLines.join('<br>')}</div>
    `;

    const box = panel.querySelector('#eraluvat-buttons');
    box.appendChild(button(on() ? 'PYSAYTA' : 'KAYNNISTA', () => setOn(!on()), true));
    box.appendChild(button('TARKISTA NYT', () => check()));
    box.appendChild(button('PUSH ASETUKSET', () => configurePush()));
    box.appendChild(button('TESTAA PUSH', () => testPush()));
    box.appendChild(button('DIAG LOKI', () => showDiag()));
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && on()) {
      lockScreen();
      setTimeout(check, 100);
    }
  });

  render();
  if (on()) {
    lockScreen();
    setTimeout(check, 500);
  }
})();