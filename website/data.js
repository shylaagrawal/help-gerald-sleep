// ============================================
// Help Gerald Sleep — data page (complete rebuild)
// Dropdown night selector. The overnight chart is the interface: click
// a dot to hear that car, and watch a synced mini dB-vs-time chart with
// a moving playhead while the (now fixed-length, ~15s) clip plays.
// Every number on this page comes from real CSVs -- nothing simulated.
// ============================================

const WHO_THRESHOLD_DB = 45;
const MAX_CHART_POINTS = 900;
const MIN_VALID_RAW_ROWS = 60; // fewer than a minute of real readings = treat as no data
const EVENT_CLIP_SECONDS = 15; // matches the fixed clip length prepare_web_assets.py now exports

let manifestData = [];
let currentIndex = 0;
let currentNight = null;
let selectedEventId = null;
let chartLayout = null;
let hoveredMarkerId = null;
let playheadRAF = null;

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
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

function fmtTime(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtDateLabel(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
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
  await loadNight(manifestData[0].date);

  document.getElementById('prevNight').addEventListener('click', () => stepNight(1));
  document.getElementById('nextNight').addEventListener('click', () => stepNight(-1));
  document.getElementById('nightSelect').addEventListener('change', (e) => {
    currentIndex = manifestData.findIndex(n => n.date === e.target.value);
    loadNight(e.target.value);
  });
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

function stepNight(direction) {
  const newIndex = currentIndex + direction;
  if (newIndex < 0 || newIndex >= manifestData.length) return;
  currentIndex = newIndex;
  const date = manifestData[currentIndex].date;
  document.getElementById('nightSelect').value = date;
  loadNight(date);
}

async function loadNight(date) {
  stopPlayheadLoop();
  selectedEventId = null;

  const [peaks, final, raw] = await Promise.all([
    fetchCSV(`data/${date}/peaks.csv`),
    fetchCSV(`data/${date}/final.csv`),
    fetchCSV(`data/${date}/raw.csv`).catch(() => []),
  ]);

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
        confidence: parseFloat(f.vehicle_confidence),
        topClass: f.top_class,
        note: f.isolation_note,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  const rawPoints = raw
    .map(r => ({ time: new Date(r.timestamp), db: parseFloat(r.calibrated_db_a) }))
    .filter(r => !isNaN(r.db))
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
  renderStatTiles(currentNight);
  clearEventDetail();
  drawChart();
}

// ---------- Gerald status ----------

function renderGeraldStatus(night, isValid) {
  const badge = document.getElementById('geraldBadge');
  const title = document.getElementById('geraldTitle');
  const desc = document.getElementById('geraldDesc');

  if (!isValid) {
    badge.textContent = 'No data';
    badge.className = 'gerald-badge warn';
    title.textContent = "Gerald's numbers are missing for this night";
    desc.textContent = 'Nothing usable was recorded -- see the note below.';
    return;
  }

  const peak = night.events.length ? Math.max(...night.events.map(e => e.isolatedDb)) : null;
  const violations = night.events.filter(e => e.exceedsWho).length;

  if (peak === null) {
    badge.textContent = 'No events';
    badge.className = 'gerald-badge ok';
    title.textContent = 'A quiet night';
    desc.textContent = "Gerald didn't detect any vehicle events crossing the peak-detection threshold this night.";
    return;
  }

  if (peak > 60) {
    badge.textContent = 'WHO limit exceeded';
    badge.className = 'gerald-badge violation';
    title.textContent = 'Gerald was startled awake';
    desc.textContent = `${violations} of ${night.events.length} detected events crossed the WHO 45 dB(A) nighttime guideline. Loudest isolated level: ${peak.toFixed(1)} dB(A).`;
  } else if (peak > WHO_THRESHOLD_DB) {
    badge.textContent = 'Elevated';
    badge.className = 'gerald-badge warn';
    title.textContent = 'Gerald was restless';
    desc.textContent = `${violations} of ${night.events.length} events crossed the WHO 45 dB(A) guideline, though nothing severe.`;
  } else {
    badge.textContent = 'Within WHO guideline';
    badge.className = 'gerald-badge ok';
    title.textContent = 'Gerald mostly slept fine';
    desc.textContent = `All ${night.events.length} detected events stayed under the WHO 45 dB(A) nighttime guideline.`;
  }
}

// ---------- stat tiles ----------

function renderStatTiles(night) {
  const events = night.events;
  const raw = night.raw;

  document.getElementById('statEvents').textContent = events.length;

  if (events.length) {
    const isolatedVals = events.map(e => e.isolatedDb);
    document.getElementById('statLoudestCar').textContent = Math.max(...isolatedVals).toFixed(1);
    document.getElementById('statQuietestCar').textContent = Math.min(...isolatedVals).toFixed(1);
    document.getElementById('statAvgCar').textContent = (isolatedVals.reduce((a, b) => a + b, 0) / isolatedVals.length).toFixed(1);
    document.getElementById('statViolations').textContent = events.filter(e => e.exceedsWho).length;
  } else {
    document.getElementById('statLoudestCar').textContent = '—';
    document.getElementById('statQuietestCar').textContent = '—';
    document.getElementById('statAvgCar').textContent = '—';
    document.getElementById('statViolations').textContent = '0';
  }

  const rawVals = raw.map(r => r.db);
  document.getElementById('statNightAvg').textContent = (rawVals.reduce((a, b) => a + b, 0) / rawVals.length).toFixed(1);
  document.getElementById('statNightLoudest').textContent = Math.max(...rawVals).toFixed(1);
  document.getElementById('statNightQuietest').textContent = Math.min(...rawVals).toFixed(1);
}

// ---------- event detail + audio + synced mini chart ----------

function clearEventDetail() {
  stopPlayheadLoop();
  selectedEventId = null;
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

  document.getElementById('eventDetailEmpty').style.display = 'none';
  document.getElementById('eventDetailBody').style.display = 'block';
  document.getElementById('detailTime').textContent = fmtTime(event.time);
  document.getElementById('detailDb').textContent = `${event.isolatedDb.toFixed(1)} dB(A)`;
  document.getElementById('detailConfidence').textContent = `${(event.confidence * 100).toFixed(1)}%`;

  const note = document.getElementById('detailNote');
  note.textContent = event.note && event.note !== 'ok'
    ? `Note: ${event.note}`
    : `Classifier's closest match: ${event.topClass || 'unknown'}.`;

  const audio = document.getElementById('eventAudio');
  audio.src = `data/${currentNight.date}/audio/${eventId}.mp3`;
  audio.currentTime = 0;
  audio.pause();

  const playBtn = document.getElementById('playBtn');
  playBtn.textContent = '▶ Play clip';
  playBtn.onclick = () => {
    if (audio.paused) {
      audio.play();
      playBtn.textContent = '⏸ Pause';
      startPlayheadLoop(event);
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

  document.getElementById('eventDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Slices the real per-second night data to roughly match the clip's
// actual ~15s window (clips are now a fixed length centered on the car,
// see prepare_web_assets.py) -- the mini chart reflects real readings.
function getEventWindowRawSlice(event) {
  const halfWindowMs = (EVENT_CLIP_SECONDS / 2 + 1) * 1000; // small buffer for edge-shifted clips
  const start = new Date(event.time.getTime() - halfWindowMs);
  const end = new Date(event.time.getTime() + halfWindowMs);
  return currentNight.raw.filter(r => r.time >= start && r.time <= end);
}

function drawEventMiniChart(event, playheadFraction) {
  const canvas = document.getElementById('eventMiniChart');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const slice = getEventWindowRawSlice(event);
  if (!slice.length) {
    ctx.fillStyle = 'rgba(251,247,237,0.4)';
    ctx.font = '11px Inter, sans-serif';
    ctx.fillText('No fine-grained trace available for this moment.', 10, height / 2);
    return;
  }

  const minTime = slice[0].time, maxTime = slice[slice.length - 1].time;
  const dbVals = slice.map(r => r.db);
  const minDb = Math.min(30, ...dbVals) - 3;
  const maxDb = Math.max(70, ...dbVals) + 3;

  const padLeft = 6, padRight = 6, padTop = 6, padBottom = 6;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (t) => padLeft + ((t - minTime) / (maxTime - minTime || 1)) * plotW;
  const yScale = (db) => padTop + (1 - (db - minDb) / (maxDb - minDb || 1)) * plotH;

  const whoY = yScale(WHO_THRESHOLD_DB);
  ctx.strokeStyle = 'rgba(240,169,140,0.5)';
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
    const x = xScale(pt.time), y = yScale(pt.db);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  if (playheadFraction !== null && playheadFraction !== undefined) {
    const x = padLeft + playheadFraction * plotW;
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
    if (audio.paused || audio.ended) return;
    const fraction = audio.duration ? (audio.currentTime / audio.duration) : 0;
    drawEventMiniChart(event, fraction);
    playheadRAF = requestAnimationFrame(tick);
  }
  playheadRAF = requestAnimationFrame(tick);
}

// ---------- main overnight chart ----------

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  return out;
}

function drawChart() {
  if (!currentNight) return;
  const canvas = document.getElementById('acousticChart');
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrap.clientWidth;
  const height = wrap.clientHeight;

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const raw = downsample(currentNight.raw, MAX_CHART_POINTS);
  const events = currentNight.events;

  if (!raw.length && !events.length) {
    ctx.fillStyle = 'rgba(251,247,237,0.4)';
    ctx.font = '13px Inter, sans-serif';
    ctx.fillText('No data for this night yet.', 16, height / 2);
    chartLayout = null;
    return;
  }

  const allTimes = raw.map(r => r.time).concat(events.map(e => e.time));
  const minTime = new Date(Math.min(...allTimes));
  const maxTime = new Date(Math.max(...allTimes));

  const allDb = raw.map(r => r.db).concat(events.map(e => e.isolatedDb));
  const minDb = Math.min(30, ...allDb) - 5;
  const maxDb = Math.max(70, ...allDb) + 5;

  const padLeft = 40, padRight = 14, padTop = 14, padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (t) => padLeft + ((t - minTime) / (maxTime - minTime || 1)) * plotW;
  const yScale = (db) => padTop + (1 - (db - minDb) / (maxDb - minDb || 1)) * plotH;

  ctx.strokeStyle = 'rgba(251,247,237,0.08)';
  ctx.fillStyle = 'rgba(251,247,237,0.45)';
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

  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = new Date(minTime.getTime() + (i / tickCount) * (maxTime - minTime));
    const x = xScale(t);
    ctx.fillText(fmtTime(t), Math.min(Math.max(x - 18, padLeft), width - padRight - 36), height - 8);
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
    ctx.strokeStyle = 'rgba(251,247,237,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    raw.forEach((pt, i) => {
      const x = xScale(pt.time), y = yScale(pt.db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  const amber = '#fd7500';
  const red = '#C1502E';
  const markerPositions = [];

  events.forEach(e => {
    const x = xScale(e.time), y = yScale(e.isolatedDb);
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
  const canvas = evt.currentTarget;
  canvas.style.cursor = closest ? 'pointer' : 'default';
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
chartCanvas.addEventListener('mouseleave', () => { hoveredMarkerId = null; drawChart(); });

init();
