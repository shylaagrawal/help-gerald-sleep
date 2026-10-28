// ============================================
// Help Gerald Sleep — data page
// Dropdown night selector. The overnight chart is the interface: click
// a dot to hear that car, and watch a synced mini dB-vs-time chart with
// a moving playhead while the ~15s clip plays.
// Every number on this page comes from real CSVs -- nothing simulated.
// ============================================

const WHO_THRESHOLD_DB = 45;
const MAX_CHART_POINTS = 1200;      // points actually drawn on the overnight chart
const MIN_VALID_RAW_ROWS = 60;      // fewer than a minute of real readings = treat as no data
const EVENT_CLIP_SECONDS = 15;      // matches the fixed clip length prepare_web_assets.py exports
const MAX_CANVAS_CSS_PX = 3000;     // hard ceiling so a canvas can never balloon
const MAIN_CHART_FALLBACK_H = 340;
const MINI_CHART_FALLBACK_H = 80;

let manifestData = [];
let currentIndex = 0;
let currentNight = null;
let selectedEventId = null;
let selectedSlice = [];             // raw readings around the selected car (computed once per click)
let chartLayout = null;
let hoveredMarkerId = null;
let playheadRAF = null;
let loadToken = 0;                  // ignores stale loads if the user switches nights quickly

// ---------- small helpers ----------

function splitCSVLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const cells = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}

function parseCSV(text) {
  const lines = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = splitCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = cells[j];
    rows.push(row);
  }
  return rows;
}

async function fetchCSV(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch ${path}`);
  return parseCSV(await res.text());
}

async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch ${path}`);
  return res.json();
}

// Loops instead of Math.min(...array): spreading tens of thousands of
// values into a function call can overflow the call stack.
function arrMin(values) {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] < m) m = values[i];
  return m;
}
function arrMax(values) {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}
function arrMean(values) {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}
function clamp(n, lo, hi) { return Math.min(Math.max(n, lo), hi); }

function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Sizes a canvas from its WRAPPER (which has a fixed CSS height), never
// from the canvas's own previous size. Only reallocates when the target
// size actually changes, so redrawing every frame during playback is cheap
// and can never feed back into the layout.
function prepareCanvas(canvas, fallbackHeight) {
  const wrap = canvas.parentElement;
  const rect = wrap.getBoundingClientRect();
  const width = clamp(Math.round(rect.width) || 600, 1, MAX_CANVAS_CSS_PX);
  let height = Math.round(rect.height);
  if (!height || height < 20) height = fallbackHeight;
  height = clamp(height, 1, MAX_CANVAS_CSS_PX);

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(width * dpr);
  const ph = Math.round(height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
  }

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

// Peak-preserving downsample: keeps the lowest and highest reading in each
// bucket, so short loud spikes still show up on the chart.
function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const buckets = Math.floor(maxPoints / 2);
  const size = points.length / buckets;
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor(b * size);
    const end = Math.min(points.length, Math.floor((b + 1) * size));
    if (start >= end) continue;
    let minP = points[start];
    let maxP = points[start];
    for (let i = start + 1; i < end; i++) {
      const p = points[i];
      if (p.db < minP.db) minP = p;
      if (p.db > maxP.db) maxP = p;
    }
    if (minP === maxP) out.push(minP);
    else if (minP.time < maxP.time) out.push(minP, maxP);
    else out.push(maxP, minP);
  }
  return out;
}

// ---------- loading ----------

async function init() {
  try {
    manifestData = await fetchJSON('data/manifest.json');
  } catch (err) {
    manifestData = [];
  }

  if (!manifestData.length) {
    document.getElementById('dataContent').style.display = 'none';
    document.querySelector('.night-selector').style.display = 'none';
    document.getElementById('noDataMessage').style.display = 'block';
    return;
  }

  manifestData.sort((a, b) => b.date.localeCompare(a.date));
  renderNightDropdown();
  currentIndex = 0;
  updateArrows();

  document.getElementById('prevNight').addEventListener('click', () => stepNight(1));
  document.getElementById('nextNight').addEventListener('click', () => stepNight(-1));
  document.getElementById('nightSelect').addEventListener('change', (e) => {
    currentIndex = manifestData.findIndex(n => n.date === e.target.value);
    updateArrows();
    loadNight(e.target.value);
  });

  await loadNight(manifestData[0].date);
}

function renderNightDropdown() {
  const select = document.getElementById('nightSelect');
  select.innerHTML = '';
  manifestData.forEach(night => {
    const opt = document.createElement('option');
    opt.value = night.date;
    opt.textContent = fmtDateLabel(night.date);
    select.appendChild(opt);
  });
}

function updateArrows() {
  // Dropdown is newest-first: "previous night" moves down the list (older).
  document.getElementById('prevNight').disabled = currentIndex >= manifestData.length - 1;
  document.getElementById('nextNight').disabled = currentIndex <= 0;
}

function stepNight(direction) {
  const newIndex = currentIndex + direction;
  if (newIndex < 0 || newIndex >= manifestData.length) return;
  currentIndex = newIndex;
  const date = manifestData[currentIndex].date;
  document.getElementById('nightSelect').value = date;
  updateArrows();
  loadNight(date);
}

function showNightAsInvalid() {
  currentNight = null;
  document.getElementById('invalidNightNotice').style.display = 'block';
  document.getElementById('validNightContent').style.display = 'none';
  renderGeraldStatus(null, false);
}

async function loadNight(date) {
  const token = ++loadToken;
  stopPlayheadLoop();
  stopAudio();
  selectedEventId = null;
  selectedSlice = [];
  hoveredMarkerId = null;

  let peaks, final, raw;
  try {
    [peaks, final, raw] = await Promise.all([
      fetchCSV(`data/${date}/peaks.csv`),
      fetchCSV(`data/${date}/final.csv`),
      fetchCSV(`data/${date}/raw.csv`).catch(() => []),
    ]);
  } catch (err) {
    if (token === loadToken) showNightAsInvalid();
    return;
  }
  if (token !== loadToken) return; // user already switched to another night

  const finalById = {};
  final.forEach(row => { finalById[row.event_id] = row; });

  const events = peaks
    .map(p => {
      const f = finalById[p.event_id];
      if (!f) return null;
      return {
        id: p.event_id,
        time: new Date(f.centroid_timestamp),
        isolatedDb: parseFloat(f.isolated_db_a),
        exceedsWho: f.exceeds_who_45db_threshold === 'True',
        note: f.isolation_note,
      };
    })
    .filter(e => e && !isNaN(e.isolatedDb) && !isNaN(e.time.getTime()))
    .sort((a, b) => a.time - b.time);

  const rawPoints = raw
    .map(r => ({ time: new Date(r.timestamp), db: parseFloat(r.calibrated_db_a) }))
    .filter(r => !isNaN(r.db) && !isNaN(r.time.getTime()))
    .sort((a, b) => a.time - b.time);

  currentNight = { date, raw: rawPoints, events };

  const isValid = rawPoints.length >= MIN_VALID_RAW_ROWS;
  document.getElementById('invalidNightNotice').style.display = isValid ? 'none' : 'block';
  document.getElementById('validNightContent').style.display = isValid ? 'block' : 'none';

  if (!isValid) {
    renderGeraldStatus(currentNight, false);
    return;
  }

  renderGeraldStatus(currentNight, true);
  renderStatCards(currentNight);
  clearEventDetail();
  drawChart();
}

// ---------- Gerald status banner (headline left, car count right) ----------

function renderGeraldStatus(night, isValid) {
  const badge = document.getElementById('geraldBadge');
  const title = document.getElementById('geraldTitle');
  const desc = document.getElementById('geraldDesc');
  const countBox = document.getElementById('geraldCount');

  if (!isValid) {
    badge.textContent = 'No data';
    badge.className = 'gerald-badge warn';
    title.textContent = "Gerald's numbers are missing for this night";
    desc.textContent = 'Nothing usable was recorded -- see the note below.';
    desc.style.display = 'block';
    countBox.style.display = 'none';
    return;
  }

  document.getElementById('statEvents').textContent = night.events.length;
  countBox.style.display = '';

  if (!night.events.length) {
    badge.textContent = 'No events';
    badge.className = 'gerald-badge ok';
    title.textContent = 'A quiet night';
    desc.textContent = "Gerald didn't detect any vehicle events crossing the peak-detection threshold this night.";
    desc.style.display = 'block';
    return;
  }

  desc.style.display = 'none';
  const peak = arrMax(night.events.map(e => e.isolatedDb));

  if (peak > 60) {
    badge.textContent = 'WHO limit exceeded';
    badge.className = 'gerald-badge violation';
    title.textContent = 'Gerald was startled awake';
  } else if (peak > WHO_THRESHOLD_DB) {
    badge.textContent = 'Elevated';
    badge.className = 'gerald-badge warn';
    title.textContent = 'Gerald was restless';
  } else {
    badge.textContent = 'Within WHO guideline';
    badge.className = 'gerald-badge ok';
    title.textContent = 'Gerald mostly slept fine';
  }
}

// ---------- stat cards: average car + the three whole-night numbers ----------

function renderStatCards(night) {
  const events = night.events;
  document.getElementById('statAvgCar').textContent = events.length
    ? arrMean(events.map(e => e.isolatedDb)).toFixed(1)
    : '—';

  const rawVals = night.raw.map(r => r.db);
  document.getElementById('statNightAvg').textContent = arrMean(rawVals).toFixed(1);
  document.getElementById('statNightLoudest').textContent = arrMax(rawVals).toFixed(1);
  document.getElementById('statNightQuietest').textContent = arrMin(rawVals).toFixed(1);
}

// ---------- event detail + audio + synced mini chart ----------

function stopAudio() {
  const audio = document.getElementById('eventAudio');
  audio.pause();
}

function clearEventDetail() {
  stopPlayheadLoop();
  stopAudio();
  selectedEventId = null;
  selectedSlice = [];
  document.getElementById('eventDetailEmpty').style.display = 'block';
  document.getElementById('eventDetailBody').style.display = 'none';
}

function stopPlayheadLoop() {
  if (playheadRAF) {
    cancelAnimationFrame(playheadRAF);
    playheadRAF = null;
  }
}

function selectEvent(eventId) {
  if (!currentNight) return;
  const event = currentNight.events.find(e => e.id === eventId);
  if (!event) return;

  stopPlayheadLoop();
  selectedEventId = eventId;
  selectedSlice = getEventWindowRawSlice(event);

  document.getElementById('eventDetailEmpty').style.display = 'none';
  document.getElementById('eventDetailBody').style.display = 'block';
  document.getElementById('detailTime').textContent = fmtTime(event.time);
  document.getElementById('detailDb').textContent = `${event.isolatedDb.toFixed(1)} dB(A)`;

  // Lowest / highest of the real per-second readings in this clip's window.
  const sliceDb = selectedSlice.map(r => r.db);
  document.getElementById('detailLow').textContent = sliceDb.length ? `${arrMin(sliceDb).toFixed(1)} dB(A)` : '—';
  document.getElementById('detailHigh').textContent = sliceDb.length ? `${arrMax(sliceDb).toFixed(1)} dB(A)` : '—';

  const note = document.getElementById('detailNote');
  if (event.note && event.note !== 'ok') {
    note.textContent = `Note: ${event.note}`;
    note.style.display = 'block';
  } else {
    note.textContent = '';
    note.style.display = 'none';
  }

  const audio = document.getElementById('eventAudio');
  audio.pause();
  audio.src = `data/${currentNight.date}/audio/${eventId}.mp3`;
  audio.currentTime = 0;

  const playBtn = document.getElementById('playBtn');
  playBtn.textContent = '▶ Play clip';
  playBtn.onclick = () => {
    if (audio.paused) {
      const attempt = audio.play();
      playBtn.textContent = '⏸ Pause';
      startPlayheadLoop(event);
      if (attempt && attempt.catch) {
        attempt.catch(() => {
          playBtn.textContent = '▶ Play clip';
          stopPlayheadLoop();
          note.textContent = "Couldn't load this clip's audio.";
          note.style.display = 'block';
        });
      }
    } else {
      audio.pause();
      playBtn.textContent = '▶ Play clip';
      stopPlayheadLoop();
    }
  };
  audio.onended = () => {
    playBtn.textContent = '▶ Play clip';
    stopPlayheadLoop();
    drawEventMiniChart(event, null);
  };

  drawChart();
  drawEventMiniChart(event, null);

  document.getElementById('eventDetail').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Real per-second readings around the car, to match the clip's ~15s window.
function getEventWindowRawSlice(event) {
  const halfWindowMs = (EVENT_CLIP_SECONDS / 2 + 1) * 1000; // small buffer for edge-shifted clips
  const start = event.time.getTime() - halfWindowMs;
  const end = event.time.getTime() + halfWindowMs;
  return currentNight.raw.filter(r => {
    const t = r.time.getTime();
    return t >= start && t <= end;
  });
}

function drawEventMiniChart(event, playheadFraction) {
  const canvas = document.getElementById('eventMiniChart');
  const { ctx, width, height } = prepareCanvas(canvas, MINI_CHART_FALLBACK_H);

  const slice = selectedSlice;
  if (!slice.length) {
    ctx.fillStyle = 'rgba(251,247,237,0.55)';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('No fine-grained trace available for this moment.', 12, height / 2 + 4);
    return;
  }

  const minTime = slice[0].time.getTime();
  const maxTime = slice[slice.length - 1].time.getTime();
  const dbVals = slice.map(r => r.db);
  const minDb = Math.min(30, arrMin(dbVals)) - 3;
  const maxDb = Math.max(70, arrMax(dbVals)) + 3;

  const padLeft = 6, padRight = 6, padTop = 6, padBottom = 6;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (t) => padLeft + ((t - minTime) / (maxTime - minTime || 1)) * plotW;
  const yScale = (db) => padTop + (1 - (db - minDb) / (maxDb - minDb || 1)) * plotH;

  const whoY = yScale(WHO_THRESHOLD_DB);
  ctx.strokeStyle = 'rgba(240,169,140,0.55)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padLeft, whoY);
  ctx.lineTo(width - padRight, whoY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#fd7500';
  ctx.lineWidth = 2;
  ctx.beginPath();
  slice.forEach((pt, i) => {
    const x = xScale(pt.time.getTime()), y = yScale(pt.db);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (playheadFraction !== null && playheadFraction !== undefined) {
    const x = padLeft + clamp(playheadFraction, 0, 1) * plotW;
    ctx.strokeStyle = 'rgba(251,247,237,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function startPlayheadLoop(event) {
  const audio = document.getElementById('eventAudio');
  function tick() {
    if (audio.paused || audio.ended) { playheadRAF = null; return; }
    const fraction = audio.duration ? (audio.currentTime / audio.duration) : 0;
    drawEventMiniChart(event, fraction);
    playheadRAF = requestAnimationFrame(tick);
  }
  playheadRAF = requestAnimationFrame(tick);
}

// ---------- main overnight chart ----------

function drawChart() {
  if (!currentNight) return;
  const canvas = document.getElementById('acousticChart');
  const { ctx, width, height } = prepareCanvas(canvas, MAIN_CHART_FALLBACK_H);

  const raw = downsample(currentNight.raw, MAX_CHART_POINTS);
  const events = currentNight.events;

  if (!raw.length && !events.length) {
    ctx.fillStyle = 'rgba(251,247,237,0.55)';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('No data for this night yet.', 16, height / 2);
    chartLayout = null;
    return;
  }

  const allTimes = raw.map(r => r.time.getTime()).concat(events.map(e => e.time.getTime()));
  const minTime = arrMin(allTimes);
  const maxTime = arrMax(allTimes);

  const allDb = raw.map(r => r.db).concat(events.map(e => e.isolatedDb));
  const minDb = Math.min(30, arrMin(allDb)) - 5;
  const maxDb = Math.max(70, arrMax(allDb)) + 5;

  const padLeft = 40, padRight = 14, padTop = 14, padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (t) => padLeft + ((t - minTime) / (maxTime - minTime || 1)) * plotW;
  const yScale = (db) => padTop + (1 - (db - minDb) / (maxDb - minDb || 1)) * plotH;

  ctx.strokeStyle = 'rgba(251,247,237,0.1)';
  ctx.fillStyle = 'rgba(251,247,237,0.65)';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.lineWidth = 1;
  for (let db = Math.ceil(minDb / 10) * 10; db <= maxDb; db += 10) {
    const y = yScale(db);
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillText(`${db}`, 4, y + 3);
  }

  const tickCount = width < 520 ? 3 : 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = new Date(minTime + (i / tickCount) * (maxTime - minTime));
    const x = xScale(t.getTime());
    ctx.fillText(fmtTime(t), clamp(x - 18, padLeft, width - padRight - 40), height - 8);
  }

  const whoY = yScale(WHO_THRESHOLD_DB);
  ctx.strokeStyle = '#F0A98C';
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft, whoY);
  ctx.lineTo(width - padRight, whoY);
  ctx.stroke();
  ctx.setLineDash([]);

  if (raw.length > 1) {
    ctx.strokeStyle = 'rgba(251,247,237,0.6)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    raw.forEach((pt, i) => {
      const x = xScale(pt.time.getTime()), y = yScale(pt.db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  const amber = '#fd7500';
  const red = '#C1502E';
  const markerPositions = [];

  events.forEach(e => {
    const x = xScale(e.time.getTime()), y = yScale(e.isolatedDb);
    const isSelected = e.id === selectedEventId;
    const isHovered = e.id === hoveredMarkerId;
    const color = e.exceedsWho ? red : amber;
    const radius = isSelected ? 9 : (isHovered ? 8 : 6);

    if (isSelected || isHovered) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = color + '33';
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(251,247,237,0.9)';
    ctx.stroke();

    markerPositions.push({ id: e.id, x, y });
  });

  chartLayout = { markerPositions };
}

function findClosestMarker(evt) {
  if (!chartLayout) return null;
  const canvas = evt.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  const x = clientX - rect.left;
  const y = clientY - rect.top;

  let closest = null, closestDist = Infinity;
  chartLayout.markerPositions.forEach(m => {
    const dist = Math.hypot(m.x - x, m.y - y);
    if (dist < closestDist) { closestDist = dist; closest = m; }
  });
  return closest && closestDist <= 18 ? closest : null;
}

function handleChartClick(evt) {
  const closest = findClosestMarker(evt);
  if (closest) selectEvent(closest.id);
}

function handleChartMove(evt) {
  const closest = findClosestMarker(evt);
  evt.currentTarget.style.cursor = closest ? 'pointer' : 'default';
  const newHoverId = closest ? closest.id : null;
  if (newHoverId !== hoveredMarkerId) {
    hoveredMarkerId = newHoverId;
    drawChart();
  }
}

// ---------- wiring ----------

window.addEventListener('resize', () => {
  clearTimeout(window._chartResizeTimer);
  window._chartResizeTimer = setTimeout(() => {
    drawChart();
    if (selectedEventId && currentNight) {
      const event = currentNight.events.find(e => e.id === selectedEventId);
      if (event) drawEventMiniChart(event, null);
    }
  }, 120);
});

const chartCanvas = document.getElementById('acousticChart');
chartCanvas.addEventListener('click', handleChartClick);
chartCanvas.addEventListener('mousemove', handleChartMove);
chartCanvas.addEventListener('mouseleave', () => {
  if (hoveredMarkerId !== null) { hoveredMarkerId = null; drawChart(); }
});

init();
