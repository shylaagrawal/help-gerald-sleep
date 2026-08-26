// ============================================
// Help Gerald Sleep — data page
// Loads website/data/manifest.json + per-night CSVs and draws the
// interactive overnight chart with click-to-hear event audio.
// ============================================

const WHO_THRESHOLD_DB = 45;
const MAX_CHART_POINTS = 700; // downsample raw trace for canvas legibility

let currentNight = null;   // { date, raw, events }
let selectedEventId = null;
let chartLayout = null;    // cached pixel<->data mapping for click hit-testing

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
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---------- loading ----------

async function init() {
  let manifest;
  try {
    manifest = await fetchJSON('data/manifest.json');
  } catch (err) {
    manifest = [];
  }

  if (!manifest.length) {
    document.getElementById('dataContent').style.display = 'none';
    document.getElementById('noDataMessage').style.display = 'block';
    return;
  }

  manifest.sort((a, b) => b.date.localeCompare(a.date));
  renderNightPicker(manifest);
  await loadNight(manifest[0].date);
}

function renderNightPicker(manifest) {
  const picker = document.getElementById('nightPicker');
  picker.innerHTML = '';
  manifest.forEach((night, i) => {
    const btn = document.createElement('button');
    btn.className = 'night-pill' + (i === 0 ? ' active' : '');
    btn.textContent = fmtDateLabel(night.date);
    btn.dataset.date = night.date;
    btn.addEventListener('click', () => {
      document.querySelectorAll('.night-pill').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      loadNight(night.date);
    });
    picker.appendChild(btn);
  });
}

async function loadNight(date) {
  selectedEventId = null;
  const [peaks, final, raw] = await Promise.all([
    fetchCSV(`data/${date}/peaks.csv`),
    fetchCSV(`data/${date}/final.csv`),
    fetchCSV(`data/${date}/raw.csv`).catch(() => []),
  ]);

  // Join peaks (clip info) with final (isolated dB, WHO flag) by event_id
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
        clipDuration: parseFloat(p.clip_duration_seconds),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  const rawPoints = raw
    .map(r => ({ time: new Date(r.timestamp), db: parseFloat(r.calibrated_db_a) }))
    .filter(r => !isNaN(r.db))
    .sort((a, b) => a.time - b.time);

  currentNight = { date, raw: rawPoints, events };

  renderGeraldStatus(currentNight);
  renderStatTiles(currentNight);
  renderEventChips(currentNight);
  clearEventDetail();
  drawChart();
}

// ---------- Gerald status + tiles ----------

function renderGeraldStatus(night) {
  const badge = document.getElementById('geraldBadge');
  const title = document.getElementById('geraldTitle');
  const desc = document.getElementById('geraldDesc');

  const peak = night.events.length ? Math.max(...night.events.map(e => e.isolatedDb)) : null;
  const violations = night.events.filter(e => e.exceedsWho).length;

  if (peak === null) {
    badge.textContent = 'No events';
    badge.className = 'gerald-badge ok';
    title.textContent = 'A quiet night';
    desc.textContent = "Gerald didn't detect any vehicle events crossing the peak-detection threshold this night.";
    return;
  }

  if (peak > WHO_THRESHOLD_DB) {
    badge.textContent = 'WHO limit exceeded';
    badge.className = 'gerald-badge violation';
    title.textContent = 'Gerald was startled awake';
    desc.textContent = `${violations} of ${night.events.length} detected events crossed the WHO 45 dB(A) nighttime guideline. Loudest isolated level: ${peak.toFixed(1)} dB(A).`;
  } else {
    badge.textContent = 'Within WHO guideline';
    badge.className = 'gerald-badge ok';
    title.textContent = 'Gerald mostly slept fine';
    desc.textContent = `All ${night.events.length} detected events stayed under the WHO 45 dB(A) nighttime guideline.`;
  }
}

function renderStatTiles(night) {
  const events = night.events;
  document.getElementById('statEvents').textContent = events.length;
  if (!events.length) {
    document.getElementById('statPeak').textContent = '—';
    document.getElementById('statViolations').textContent = '0';
    document.getElementById('statAvg').textContent = '—';
    return;
  }
  const isolatedVals = events.map(e => e.isolatedDb);
  const peak = Math.max(...isolatedVals);
  const avg = isolatedVals.reduce((a, b) => a + b, 0) / isolatedVals.length;
  const violations = events.filter(e => e.exceedsWho).length;

  document.getElementById('statPeak').textContent = `${peak.toFixed(1)}`;
  document.getElementById('statViolations').textContent = violations;
  document.getElementById('statAvg').textContent = `${avg.toFixed(1)}`;
}

function renderEventChips(night) {
  const wrap = document.getElementById('eventChips');
  wrap.innerHTML = '';
  night.events.forEach(e => {
    const chip = document.createElement('button');
    chip.className = 'event-chip';
    chip.dataset.eventId = e.id;
    chip.textContent = `${fmtTime(e.time)} · ${e.isolatedDb.toFixed(0)} dB`;
    chip.addEventListener('click', () => selectEvent(e.id));
    wrap.appendChild(chip);
  });
}

// ---------- event detail + audio ----------

function clearEventDetail() {
  selectedEventId = null;
  document.getElementById('eventDetailEmpty').style.display = 'block';
  document.getElementById('eventDetailBody').style.display = 'none';
  document.querySelectorAll('.event-chip').forEach(c => c.classList.remove('active'));
}

function selectEvent(eventId) {
  if (!currentNight) return;
  const event = currentNight.events.find(e => e.id === eventId);
  if (!event) return;

  selectedEventId = eventId;

  document.querySelectorAll('.event-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.eventId === eventId);
  });

  document.getElementById('eventDetailEmpty').style.display = 'none';
  document.getElementById('eventDetailBody').style.display = 'block';
  document.getElementById('detailTime').textContent = fmtTime(event.time);
  document.getElementById('detailDb').textContent = `${event.isolatedDb.toFixed(1)} dB(A)`;
  document.getElementById('detailConfidence').textContent = `${(event.confidence * 100).toFixed(1)}%`;

  const note = document.getElementById('detailNote');
  note.textContent = event.note && event.note !== 'ok'
    ? `Note: ${event.note}`
    : `Classifier's closest match: ${event.topClass || 'unknown'}. Clip is ${event.clipDuration ? event.clipDuration.toFixed(0) : '?'}s long.`;

  const audio = document.getElementById('eventAudio');
  audio.src = `data/${currentNight.date}/audio/${eventId}.mp3`;
  audio.currentTime = 0;

  const playBtn = document.getElementById('playBtn');
  playBtn.textContent = '▶ Play clip';
  playBtn.onclick = () => {
    if (audio.paused) {
      audio.play();
      playBtn.textContent = '⏸ Pause';
    } else {
      audio.pause();
      playBtn.textContent = '▶ Play clip';
    }
  };
  audio.onended = () => { playBtn.textContent = '▶ Play clip'; };

  drawChart(); // redraw so the selected marker highlights
}

// ---------- chart ----------

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
    ctx.fillStyle = 'rgba(61,68,84,0.5)';
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

  const padLeft = 38, padRight = 12, padTop = 12, padBottom = 26;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (t) => padLeft + ((t - minTime) / (maxTime - minTime || 1)) * plotW;
  const yScale = (db) => padTop + (1 - (db - minDb) / (maxDb - minDb || 1)) * plotH;

  // gridlines every 10 dB
  ctx.strokeStyle = 'rgba(61,68,84,0.12)';
  ctx.fillStyle = 'rgba(61,68,84,0.55)';
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

  // time ticks
  const tickCount = 5;
  for (let i = 0; i <= tickCount; i++) {
    const t = new Date(minTime.getTime() + (i / tickCount) * (maxTime - minTime));
    const x = xScale(t);
    ctx.fillText(fmtTime(t), Math.min(Math.max(x - 18, padLeft), width - padRight - 36), height - 8);
  }

  // WHO threshold line
  const whoY = yScale(WHO_THRESHOLD_DB);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--signal-red').trim() || '#C1502E';
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft, whoY);
  ctx.lineTo(width - padRight, whoY);
  ctx.stroke();
  ctx.setLineDash([]);

  // raw trace
  if (raw.length > 1) {
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--asphalt-600').trim() || '#3D4454';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    raw.forEach((pt, i) => {
      const x = xScale(pt.time), y = yScale(pt.db);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // event markers
  const amber = getComputedStyle(document.documentElement).getPropertyValue('--amber-500').trim() || '#fd7500';
  const red = getComputedStyle(document.documentElement).getPropertyValue('--signal-red').trim() || '#C1502E';
  const markerPositions = [];

  events.forEach(e => {
    const x = xScale(e.time), y = yScale(e.isolatedDb);
    const isSelected = e.id === selectedEventId;
    const radius = isSelected ? 7 : 5;

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = e.exceedsWho ? red : amber;
    ctx.fill();

    if (isSelected) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
      ctx.strokeStyle = e.exceedsWho ? red : amber;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    markerPositions.push({ id: e.id, x, y });
  });

  chartLayout = { markerPositions };
}

function handleChartClick(evt) {
  if (!chartLayout) return;
  const canvas = evt.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const clickX = evt.clientX - rect.left;
  const clickY = evt.clientY - rect.top;

  let closest = null, closestDist = Infinity;
  chartLayout.markerPositions.forEach(m => {
    const dist = Math.hypot(m.x - clickX, m.y - clickY);
    if (dist < closestDist) { closestDist = dist; closest = m; }
  });

  if (closest && closestDist <= 16) {
    selectEvent(closest.id);
  }
}

// ---------- wiring ----------

window.addEventListener('resize', () => {
  clearTimeout(window._chartResizeTimer);
  window._chartResizeTimer = setTimeout(drawChart, 120);
});

document.getElementById('acousticChart').addEventListener('click', handleChartClick);

init();
