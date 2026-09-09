// ============================================
// Help Gerald Sleep — data page (redesigned)
// The event list IS the interface. Every car has its own visible
// play button. The chart is decorative context only, not clickable.
// ============================================

const WHO_THRESHOLD_DB = 45;
const MAX_CHART_POINTS = 400;

let currentNight = null;
let currentlyPlayingId = null;
const audioPlayers = {}; // eventId -> <audio> element

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
  stopAllAudio();

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
  renderEventList(currentNight);
  drawMiniChart();
}

// ---------- Gerald status (the "at a glance" summary) ----------

function renderGeraldStatus(night) {
  const badge = document.getElementById('geraldBadge');
  const title = document.getElementById('geraldTitle');
  const desc = document.getElementById('geraldDesc');
  const card = document.getElementById('geraldStatus');

  const peak = night.events.length ? Math.max(...night.events.map(e => e.isolatedDb)) : null;
  const violations = night.events.filter(e => e.exceedsWho).length;

  card.classList.remove('mood-calm', 'mood-restless', 'mood-violation');

  document.getElementById('statEvents').textContent = night.events.length;
  document.getElementById('statPeak').textContent = peak !== null ? peak.toFixed(1) : '—';

  if (peak === null) {
    badge.textContent = 'No events';
    card.classList.add('mood-calm');
    title.textContent = 'A quiet night';
    desc.textContent = "Gerald didn't detect any vehicle events crossing the peak-detection threshold this night.";
  } else if (peak > 60) {
    card.classList.add('mood-violation');
    badge.textContent = 'WHO limit exceeded';
    title.textContent = 'Gerald was startled awake';
    desc.textContent = `${violations} of ${night.events.length} events crossed the WHO 45 dB(A) guideline.`;
  } else if (peak > 45) {
    card.classList.add('mood-restless');
    badge.textContent = 'Elevated';
    title.textContent = 'Gerald was restless';
    desc.textContent = `Some events crossed the WHO 45 dB(A) guideline, though nothing severe.`;
  } else {
    card.classList.add('mood-calm');
    badge.textContent = 'Within WHO guideline';
    title.textContent = 'Gerald mostly slept fine';
    desc.textContent = `All ${night.events.length} detected events stayed under the WHO 45 dB(A) guideline.`;
  }
}

// ---------- the event list: the actual interface ----------

function stopAllAudio() {
  Object.values(audioPlayers).forEach(a => { a.pause(); a.currentTime = 0; });
  currentlyPlayingId = null;
  document.querySelectorAll('.event-play-btn').forEach(btn => {
    btn.textContent = '▶ Play';
    btn.classList.remove('playing');
  });
}

function renderEventList(night) {
  const list = document.getElementById('eventList');
  const emptyMsg = document.getElementById('eventListEmpty');
  const countLabel = document.getElementById('eventListCount');
  list.innerHTML = '';

  if (!night.events.length) {
    emptyMsg.style.display = 'block';
    countLabel.textContent = '0 cars detected';
    return;
  }
  emptyMsg.style.display = 'none';
  countLabel.textContent = `${night.events.length} car${night.events.length === 1 ? '' : 's'} detected, loudest first`;

  const sorted = [...night.events].sort((a, b) => b.isolatedDb - a.isolatedDb);

  sorted.forEach(event => {
    const card = document.createElement('div');
    card.className = 'event-card' + (event.exceedsWho ? ' event-card-violation' : '');

    const audio = document.createElement('audio');
    audio.preload = 'none';
    audio.src = `data/${night.date}/audio/${event.id}.mp3`;
    audioPlayers[event.id] = audio;

    card.innerHTML = `
      <button class="event-play-btn" aria-label="Play this car's audio">▶ Play</button>
      <div class="event-card-info">
        <div class="event-card-top">
          <span class="event-card-time">${fmtTime(event.time)}</span>
          <span class="event-card-db ${event.exceedsWho ? 'over' : ''}">${event.isolatedDb.toFixed(1)} dB(A)</span>
          ${event.exceedsWho ? '<span class="event-card-flag">Over WHO limit</span>' : ''}
        </div>
        <button class="event-card-more" type="button">Details ▾</button>
        <div class="event-card-detail">
          <p><strong>Classifier confidence:</strong> ${(event.confidence * 100).toFixed(1)}%</p>
          <p><strong>Closest sound match:</strong> ${event.topClass || 'unknown'}</p>
          <p><strong>Clip length:</strong> ${event.clipDuration ? event.clipDuration.toFixed(0) : '?'} seconds</p>
        </div>
      </div>
    `;

    const playBtn = card.querySelector('.event-play-btn');
    playBtn.addEventListener('click', () => togglePlay(event.id, playBtn));

    const moreBtn = card.querySelector('.event-card-more');
    const detailPanel = card.querySelector('.event-card-detail');
    moreBtn.addEventListener('click', () => {
      const open = detailPanel.classList.toggle('open');
      moreBtn.textContent = open ? 'Details ▴' : 'Details ▾';
    });

    audio.addEventListener('ended', () => {
      playBtn.textContent = '▶ Play';
      playBtn.classList.remove('playing');
      currentlyPlayingId = null;
    });

    list.appendChild(card);
  });
}

function togglePlay(eventId, btn) {
  const audio = audioPlayers[eventId];
  if (!audio) return;

  if (currentlyPlayingId && currentlyPlayingId !== eventId) {
    stopAllAudio();
  }

  if (audio.paused) {
    audio.play();
    btn.textContent = '⏸ Pause';
    btn.classList.add('playing');
    currentlyPlayingId = eventId;
  } else {
    audio.pause();
    btn.textContent = '▶ Play';
    btn.classList.remove('playing');
    currentlyPlayingId = null;
  }
}

// ---------- mini chart: decorative context, NOT interactive ----------

function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  return out;
}

function drawMiniChart() {
  if (!currentNight) return;
  const canvas = document.getElementById('miniChart');
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
  if (!raw.length) {
    ctx.fillStyle = 'rgba(61,68,84,0.5)';
    ctx.font = '12px Inter, sans-serif';
    ctx.fillText('No overnight trace for this night yet.', 12, height / 2);
    return;
  }

  const minTime = raw[0].time, maxTime = raw[raw.length - 1].time;
  const dbVals = raw.map(r => r.db);
  const minDb = Math.min(30, ...dbVals) - 3;
  const maxDb = Math.max(70, ...dbVals) + 3;

  const padLeft = 8, padRight = 8, padTop = 8, padBottom = 8;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xScale = (t) => padLeft + ((t - minTime) / (maxTime - minTime || 1)) * plotW;
  const yScale = (db) => padTop + (1 - (db - minDb) / (maxDb - minDb || 1)) * plotH;

  // WHO line, very subtle -- context only
  const whoY = yScale(WHO_THRESHOLD_DB);
  ctx.strokeStyle = 'rgba(193,80,46,0.35)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padLeft, whoY);
  ctx.lineTo(width - padRight, whoY);
  ctx.stroke();
  ctx.setLineDash([]);

  // trace
  ctx.strokeStyle = 'rgba(61,68,84,0.55)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  raw.forEach((pt, i) => {
    const x = xScale(pt.time), y = yScale(pt.db);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// ---------- wiring ----------

window.addEventListener('resize', () => {
  clearTimeout(window._chartResizeTimer);
  window._chartResizeTimer = setTimeout(drawMiniChart, 120);
});

init();
