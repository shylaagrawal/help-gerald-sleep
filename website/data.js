// ============================================
// Help Gerald Sleep — data page
// Dropdown night selector (scales to any number of nights).
// The chart itself is the interface: click a dot to hear that car.
// All numbers below come from the real raw/peaks/final CSVs -- nothing
// on this page is fabricated or simulated.
// ============================================

const WHO_THRESHOLD_DB = 45;
const MAX_CHART_POINTS = 900;

let manifestData = [];
let currentIndex = 0;
let currentNight = null;
let selectedEventId = null;
let chartLayout = null;
let hoveredMarkerId = null;

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

  manifestData.sort((a, b) => b.date.localeCompare(a.date)); // most recent first
  renderNightDropdown();
  currentIndex = 0;
  await loadNight(manifestData[0].date);

  document.getElementById('prevNight').addEventListener('click', () => stepNight(1));  // older
  document.getElementById('nextNight').addEventListener('click', () => stepNight(-1)); // newer
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
  clearEventDetail();
  drawChart();
}

// ---------- Gerald status ----------

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

// ---------- stat tiles: all computed from real fetched data ----------

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

  if (raw.length) {
    const rawVals = raw.map(r => r.db);
    document.getElementById('statNightAvg').textContent = (rawVals.reduce((a, b) => a + b, 0) / rawVals.length).toFixed(1);
    document.getElementById('statNightLoudest').textContent = Math.max(...rawVals).toFixed(1);
    document.getElementById('statNightQuietest').textContent = Math.min(...rawVals).toFixed(1);
  } else {
    document.getElementById('statNightAvg').textContent = '—';
    document.getElementById('statNightLoudest').textContent = '—';
    document.getElementById('statNightQuietest').textContent = '—';
  }
}

// ---------- event detail + audio ----------

function clearEventDetail() {
  selectedEventId = null;
  document.getElementById('eventDetailEmpty').style.display = 'block';
  document.getElementById('eventDetailBody').style.display = 'none';
}

function selectEvent(eventId) {
  if (!currentNight) return;
  const event = currentNight.events.find(e => e.id === eventId);
  if (!event) return;

  selectedEventId = eventId;

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
  audio.pause();

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

  drawChart();

  document.getElementById('eventDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------- chart: the real interface ----------

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

  // gridlines every 10 dB, light lines on dark bg
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

  // time ticks
  const tickCount = 6;
  for (let i = 0; i <= tickCount; i++) {
    const t = new Date(minTime.getTime() + (i / tickCount) * (maxTime - minTime));
    const x = xScale(t);
    ctx.fillText(fmtTime(t), Math.min(Math.max(x - 18, padLeft), width - padRight - 36), height - 8);
  }

  // WHO threshold line
  const whoY = yScale(WHO_THRESHOLD_DB);
  ctx.strokeStyle = '#F0A98C';
  ctx.setLineDash([5, 5]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(padLeft, whoY);
  ctx.lineTo(width - padRight, whoY);
  ctx.stroke();
  ctx.setLineDash([]);

  // raw trace -- real per-second data, drawn prominently
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

  // event markers -- bigger, glowing, obviously clickable
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
  window._chartResizeTimer = setTimeout(drawChart, 120);
});

const chartCanvas = document.getElementById('acousticChart');
chartCanvas.addEventListener('click', handleChartClick);
chartCanvas.addEventListener('mousemove', handleChartMove);
chartCanvas.addEventListener('mouseleave', () => { hoveredMarkerId = null; drawChart(); });

init();
