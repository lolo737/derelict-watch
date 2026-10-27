import { EMPTY_BANDS, bandLabel } from './lib/banding.js';
import { COUNTIES, IRELAND_BOUNDS, normaliseReport, validateReport, escapeHtml, newClientId } from './lib/validation.js';
import { fileToCanvas, drawToCanvas, canvasToCleanJpeg, pixelateRegion } from './lib/image.js';
import { ReportQueue, MAX_ATTEMPTS } from './lib/queue.js';
import { createBackend } from './lib/api.js';

const L = window.L;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
const IRELAND_CENTRE = [53.35, -7.7];
const FLAGGED_KEY = 'dw-flagged';

const backend = createBackend(window.DERELICT_WATCH_CONFIG);
const queue = new ReportQueue();

const state = {
  photo: null,          // { base: ImageData, canvas, blurs: [] }
  stream: null,
  pin: null,            // { lat, lng }
  reports: [],
  reportsLoaded: false,
};

// ---------------------------------------------------------------- utilities
function banner(message, kind = 'info', ms = 6000) {
  const el = $('#banner');
  el.textContent = message;
  el.className = `banner ${kind === 'info' ? '' : kind}`;
  el.hidden = false;
  clearTimeout(banner.t);
  if (ms) banner.t = setTimeout(() => { el.hidden = true; }, ms);
}

function readFlagged() {
  try { return new Set(JSON.parse(localStorage.getItem(FLAGGED_KEY) || '[]')); } catch { return new Set(); }
}
function rememberFlagged(id) {
  try { const s = readFlagged(); s.add(id); localStorage.setItem(FLAGGED_KEY, JSON.stringify([...s])); } catch { /* private mode */ }
}

function describeUnits(r) {
  if (r.upstairs_empty && r.downstairs_empty) return 'Whole building empty';
  if (r.upstairs_empty) return 'Upstairs empty';
  if (r.downstairs_empty) return 'Ground floor empty';
  return '';
}

function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; }
}

function tileLayer() {
  return L.tileLayer(OSM_TILES, { maxZoom: 19, attribution: OSM_ATTRIBUTION });
}

// ------------------------------------------------------------------ routing
const views = ['report', 'map', 'list', 'about'];
function route() {
  const name = views.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'report';
  for (const v of views) $(`#view-${v}`).hidden = v !== name;
  for (const a of $$('.tabs a')) {
    if (a.dataset.tab === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (name === 'report') pickMap.invalidateSize();
  if (name === 'map') { showReportsMap(); }
  if (name === 'list') { loadReports().then(renderList); }
  if (name === 'about') renderOutbox();
  if (name !== 'report') stopCamera();
}
window.addEventListener('hashchange', () => { route(); $('#main').focus({ preventScroll: true }); });

// ------------------------------------------------------------- form set-up
function initForm() {
  const county = $('#county');
  const filter = $('#county-filter');
  for (const c of COUNTIES) {
    county.add(new Option(c, c));
    filter.add(new Option(c, c));
  }
  const chips = $('#band-chips');
  for (const b of EMPTY_BANDS) {
    const label = document.createElement('label');
    label.className = 'chip';
    label.innerHTML = `<input type="radio" name="empty_band" value="${b.id}"><span>${escapeHtml(b.label)}</span>`;
    chips.append(label);
  }
  const notes = $('#notes');
  notes.addEventListener('input', () => { $('#notes-count').textContent = notes.value.length; });
  $('#mode-note').textContent = backend.mode === 'demo'
    ? 'Demo mode: no Supabase configured, so reports are kept on this device only.'
    : 'Reports are public. Your name and device are never recorded.';
}

// ------------------------------------------------------------------- camera
async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    $('#photo-file').click();
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1440 } },
      audio: false,
    });
  } catch (err) {
    banner(`Camera unavailable (${err.name || 'error'}). You can choose a photo instead.`, 'warn');
    $('#photo-file').click();
    return;
  }
  const video = $('#camera-video');
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  $('#camera').hidden = false;
  $('#photo-buttons').hidden = true;
  $('#camera-shutter').focus();
}

function stopCamera() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  const cam = $('#camera');
  if (cam) cam.hidden = true;
  if (!state.photo) $('#photo-buttons').hidden = false;
}

function setPhotoCanvas(canvas) {
  const view = $('#photo-canvas');
  view.width = canvas.width;
  view.height = canvas.height;
  const ctx = view.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0);
  state.photo = { base: ctx.getImageData(0, 0, view.width, view.height), canvas: view, blurs: [] };
  $('#photo-preview').hidden = false;
  $('#photo-buttons').hidden = true;
  $('#blur-undo').disabled = true;
  showError('photo', '');
}

function takePhoto() {
  const video = $('#camera-video');
  if (!video.videoWidth) return;
  setPhotoCanvas(drawToCanvas(video, video.videoWidth, video.videoHeight));
  stopCamera();
}

async function onFileChosen(e) {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    setPhotoCanvas(await fileToCanvas(file));
  } catch {
    showError('photo', 'Sorry, that image could not be opened. Try a JPEG or PNG.');
  }
}

function retakePhoto() {
  state.photo = null;
  $('#photo-preview').hidden = true;
  $('#photo-buttons').hidden = false;
  setBlurMode(false);
}

// ------------------------------------------------------------------ blurring
function redrawPhoto() {
  const { canvas, base, blurs } = state.photo;
  const img = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
  const block = Math.max(8, Math.round(base.width / 40));
  for (const r of blurs) pixelateRegion(img, r.x, r.y, r.w, r.h, block);
  canvas.getContext('2d').putImageData(img, 0, 0);
  $('#blur-undo').disabled = blurs.length === 0;
}

function setBlurMode(on) {
  $('#blur-toggle').setAttribute('aria-pressed', String(on));
  $('#photo-preview').classList.toggle('blurring', on);
  $('#blur-hint').hidden = !on;
}

function initBlur() {
  const canvas = $('#photo-canvas');
  let start = null;
  const toImage = (ev) => {
    const r = canvas.getBoundingClientRect();
    return { x: (ev.clientX - r.left) * (canvas.width / r.width), y: (ev.clientY - r.top) * (canvas.height / r.height) };
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if ($('#blur-toggle').getAttribute('aria-pressed') !== 'true' || !state.photo) return;
    start = toImage(ev);
    canvas.setPointerCapture(ev.pointerId);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const p = toImage(ev);
    redrawPhoto();
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#ffbf47';
    ctx.lineWidth = Math.max(2, canvas.width / 300);
    ctx.strokeRect(start.x, start.y, p.x - start.x, p.y - start.y);
  });
  const finish = (ev) => {
    if (!start) return;
    const p = toImage(ev);
    let rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    // A tap (tiny drag) blurs a sensible square around the point.
    if (rect.w < 10 && rect.h < 10) {
      const s = canvas.width / 8;
      rect = { x: start.x - s / 2, y: start.y - s / 2, w: s, h: s };
    }
    state.photo.blurs.push(rect);
    start = null;
    redrawPhoto();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', () => { start = null; redrawPhoto(); });
  $('#blur-toggle').addEventListener('click', () => setBlurMode($('#blur-toggle').getAttribute('aria-pressed') !== 'true'));
  $('#blur-undo').addEventListener('click', () => { state.photo?.blurs.pop(); redrawPhoto(); });
}

// --------------------------------------------------------------- pin picker
let pickMap;
let pickMarker = null;

function setPin(latlng, { pan = true } = {}) {
  state.pin = { lat: Number(latlng.lat.toFixed(6)), lng: Number(latlng.lng.toFixed(6)) };
  if (!pickMarker) {
    pickMarker = L.marker(latlng, { draggable: true, autoPan: true, keyboard: true, title: 'Building location' }).addTo(pickMap);
    pickMarker.on('dragend', () => setPin(pickMarker.getLatLng(), { pan: false }));
  } else {
    pickMarker.setLatLng(latlng);
  }
  if (pan) pickMap.setView(latlng, Math.max(pickMap.getZoom(), 18));
  $('#pin-readout').textContent = `${state.pin.lat.toFixed(5)}, ${state.pin.lng.toFixed(5)}`;
  showError('location', '');
}

function initPickMap() {
  pickMap = L.map('pick-map', {
    maxBounds: [[IRELAND_BOUNDS.minLat - 1, IRELAND_BOUNDS.minLng - 2], [IRELAND_BOUNDS.maxLat + 1, IRELAND_BOUNDS.maxLng + 2]],
  }).setView(IRELAND_CENTRE, 6);
  tileLayer().addTo(pickMap);
  pickMap.on('click', (e) => setPin(e.latlng, { pan: false }));
}

function locate() {
  const status = $('#locate-status');
  if (!navigator.geolocation) { status.textContent = 'Location is not available. Tap the map instead.'; return; }
  status.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setPin(L.latLng(pos.coords.latitude, pos.coords.longitude));
      status.textContent = `Accurate to about ${Math.round(pos.coords.accuracy)} m. Drag the pin onto the building.`;
    },
    (err) => {
      status.textContent = err.code === 1 ? 'Location permission refused. Tap the map instead.' : 'Could not get your location. Tap the map instead.';
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
  );
}

// --------------------------------------------------------------- submission
function showError(field, message) {
  const el = $(`[data-error="${field}"]`);
  if (el) el.textContent = message || '';
  const input = $(`#report-form [name="${field}"]`);
  if (input && input.type !== 'radio') input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

function collectForm() {
  const form = $('#report-form');
  const fd = new FormData(form);
  return normaliseReport({
    client_id: newClientId(),
    street: fd.get('street'),
    house_number: fd.get('house_number'),
    town: fd.get('town'),
    county: fd.get('county'),
    lat: state.pin?.lat,
    lng: state.pin?.lng,
    empty_band: fd.get('empty_band'),
    upstairs_empty: fd.get('upstairs_empty'),
    downstairs_empty: fd.get('downstairs_empty'),
    notes: fd.get('notes'),
  });
}

async function onSubmit(e) {
  e.preventDefault();
  if (!$('#privacy-ok').checked) {
    banner('Please read the photo guidance and tick the box first.', 'warn');
    $('#privacy-ok').focus();
    return;
  }
  const btn = $('#submit-btn');
  btn.disabled = true;
  try {
    const report = collectForm();
    const photo = state.photo ? await canvasToCleanJpeg(state.photo.canvas) : null;
    const { valid, errors } = validateReport(report, { photo });
    for (const f of ['photo', 'location', 'street', 'house_number', 'town', 'county', 'empty_band', 'units', 'notes']) showError(f, errors[f]);
    if (!valid) {
      const first = $('#report-form .error:not(:empty)');
      first?.closest('fieldset')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      banner('A few things need fixing before this can be sent.', 'error');
      return;
    }
    await queue.enqueue(report, photo);
    resetForm();
    await syncNow();
  } catch (err) {
    banner(`Something went wrong: ${err.message}`, 'error', 0);
  } finally {
    btn.disabled = false;
  }
}

function resetForm() {
  $('#report-form').reset();
  $('#notes-count').textContent = '0';
  retakePhoto();
  // keep the pin and map view: the next report is often next door
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ---------------------------------------------------------------------- sync
async function updateOutboxBadge() {
  const n = await queue.count();
  $('#outbox-count').textContent = n;
  $('#outbox-btn').hidden = n === 0;
}

async function syncNow({ force = false } = {}) {
  if (!navigator.onLine) {
    banner('You are offline. Your report is saved on this phone and will send when you are back online.', 'warn');
    await updateOutboxBadge();
    return;
  }
  const result = await queue.flush((entry) => backend.submit(entry), { force });
  if (result.sent.length) {
    banner(result.sent.length === 1 ? 'Thank you. Your report has been sent.' : `Thank you. ${result.sent.length} reports sent.`);
    state.reportsLoaded = false;
  }
  if (result.failed.length) banner(`Saved on this phone; sending failed (${result.failed[0].error}). We will retry automatically.`, 'warn', 9000);
  if (result.rejected.length) banner(`A report was rejected by the server: ${result.rejected[0].error}`, 'error', 0);
  await updateOutboxBadge();
  if (!$('#view-about').hidden) renderOutbox();
}

async function renderOutbox() {
  const box = $('#outbox-list');
  const items = await queue.list();
  if (!items.length) { box.innerHTML = '<p class="hint">Nothing waiting.</p>'; return; }
  box.innerHTML = items.map((e) => `
    <div class="outbox-item">
      <span>${escapeHtml(e.report.house_number)} ${escapeHtml(e.report.street)}, ${escapeHtml(e.report.town)}
      <br><small class="hint">${e.attempts ? `${e.attempts} attempt(s)${e.attempts >= MAX_ATTEMPTS ? ', paused' : ''}: ${escapeHtml(e.last_error)}` : 'Not tried yet'}</small></span>
      <button type="button" class="link-btn" data-discard="${escapeHtml(e.client_id)}">Discard</button>
    </div>`).join('');
}

// ----------------------------------------------------------- reports: data
async function loadReports({ force = false } = {}) {
  if (state.reportsLoaded && !force) return state.reports;
  try {
    state.reports = await backend.listReports();
    state.reportsLoaded = true;
  } catch (err) {
    banner(`Could not load reports: ${err.message}`, 'error');
  }
  return state.reports;
}

function reportCardHtml(r, { popup = false } = {}) {
  const flagged = readFlagged().has(r.id);
  const img = r.photo_url
    ? `<img src="${escapeHtml(r.photo_url)}" alt="Photo of ${escapeHtml(r.house_number)} ${escapeHtml(r.street)}" loading="lazy">`
    : '<div class="noimg" aria-hidden="true"></div>';
  const body = `
    <h2>${escapeHtml(r.house_number)} ${escapeHtml(r.street)}</h2>
    <p class="meta">${escapeHtml(r.town)}, Co. ${escapeHtml(r.county)}</p>
    <p><span class="tag">${escapeHtml(bandLabel(r.empty_band))}</span><span class="tag">${escapeHtml(describeUnits(r))}</span></p>
    ${r.notes ? `<p>${escapeHtml(r.notes)}</p>` : ''}
    <p class="meta">Reported ${escapeHtml(formatDate(r.created_at))}
      ${backend.mode === 'supabase' ? `&middot; <button type="button" class="link-btn" data-flag="${escapeHtml(r.id)}" ${flagged ? 'disabled' : ''}>${flagged ? 'Flagged' : 'Flag a problem'}</button>` : ''}</p>`;
  return popup ? `<div class="popup">${img}${body}</div>` : `<li class="report-card">${img}<div>${body}</div></li>`;
}

// ------------------------------------------------------------ reports: map
let reportsMap = null;
let cluster = null;

async function showReportsMap() {
  if (!reportsMap) {
    reportsMap = L.map('reports-map').setView(IRELAND_CENTRE, 7);
    tileLayer().addTo(reportsMap);
    cluster = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50 });
    reportsMap.addLayer(cluster);
  }
  setTimeout(() => reportsMap.invalidateSize(), 0);
  const reports = await loadReports();
  cluster.clearLayers();
  const markers = reports
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
    .map((r) => L.marker([r.lat, r.lng], { title: `${r.house_number} ${r.street}`, keyboard: true })
      .bindPopup(() => reportCardHtml(r, { popup: true }), { maxWidth: 260 }));
  cluster.addLayers(markers);
  const n = reports.length;
  $('#map-summary').textContent = n
    ? `${n} building${n === 1 ? '' : 's'} reported${backend.mode === 'demo' ? ' on this device (demo mode)' : ''}. Tap a cluster to zoom in.`
    : 'No reports yet. Be the first on your street.';
  if (markers.length) reportsMap.fitBounds(cluster.getBounds(), { padding: [30, 30], maxZoom: 16 });
}

// ----------------------------------------------------------- reports: list
async function renderList() {
  const county = $('#county-filter').value;
  const items = state.reports.filter((r) => !county || r.county === county);
  $('#list-summary').textContent = `${items.length} report${items.length === 1 ? '' : 's'}${county ? ` in Co. ${county}` : ''}.`;
  $('#report-list').innerHTML = items.map((r) => reportCardHtml(r)).join('');
}

async function onFlag(id, button) {
  if (!window.confirm('Flag this report for a moderator? Use this if it shows a person, a number plate, private information, or is not an empty building.')) return;
  try {
    await backend.flag(id);
    rememberFlagged(id);
    button.disabled = true;
    button.textContent = 'Flagged';
    banner('Thanks. A moderator will take a look.');
  } catch (err) {
    banner(`Could not flag: ${err.message}`, 'error');
  }
}

// -------------------------------------------------------------------- boot
function wire() {
  $('#camera-open').addEventListener('click', openCamera);
  $('#camera-shutter').addEventListener('click', takePhoto);
  $('#camera-cancel').addEventListener('click', stopCamera);
  $('#photo-file').addEventListener('change', onFileChosen);
  $('#photo-retake').addEventListener('click', retakePhoto);
  $('#locate-btn').addEventListener('click', locate);
  $('#report-form').addEventListener('submit', onSubmit);
  $('#county-filter').addEventListener('change', renderList);
  $('#outbox-btn').addEventListener('click', () => { location.hash = '#about'; });
  $('#sync-btn').addEventListener('click', () => syncNow({ force: true }));
  document.addEventListener('click', async (e) => {
    const flagBtn = e.target.closest('[data-flag]');
    if (flagBtn) onFlag(flagBtn.dataset.flag, flagBtn);
    const discard = e.target.closest('[data-discard]');
    if (discard && window.confirm('Discard this unsent report?')) {
      await queue.remove(discard.dataset.discard);
      renderOutbox();
      updateOutboxBadge();
    }
  });
  window.addEventListener('online', () => syncNow());
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'sync-reports') syncNow(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    // Background Sync (Chromium) wakes the page's sync when connectivity returns.
    await reg.sync?.register('sync-reports').catch(() => {});
  } catch (err) {
    console.warn('Service worker registration failed', err);
  }
}

initForm();
initBlur();
initPickMap();
wire();
route();
registerServiceWorker();
updateOutboxBadge().then(() => syncNow());
