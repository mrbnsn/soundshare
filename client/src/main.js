import { io } from 'socket.io-client';
import './style.css';

const app = document.getElementById('app');
let socket = null;
let username = '';
let joined = false;
let participants = [];

window.__userColors = {};
window.__queue = [];

function getSocketOrigin() {
  if (import.meta.env.DEV) return undefined;
  return window.location.origin;
}

function renderJoin() {
  app.innerHTML = `
    <div class="join-screen">
      <h1>SoundShare</h1>
      <p class="tagline">Synchronized audio for your group</p>
      <form id="join-form" class="join-form">
        <input type="text" id="username" placeholder="Your name" maxlength="32" required autofocus />
        <button type="submit">Join Lobby</button>
      </form>
      <p id="join-error" class="error" aria-live="polite"></p>
    </div>
  `;
  document.getElementById('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('username');
    const name = (input.value || '').trim();
    if (!name) {
      document.getElementById('join-error').textContent = 'Enter a name.';
      return;
    }
    document.getElementById('join-error').textContent = '';
    username = name;
    connectAndJoin(name);
  });
}

function connectAndJoin(name) {
  socket = io(getSocketOrigin(), { path: '/socket.io', transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    socket.emit('join', { username: name, roomId: null });
  });
  socket.on('joined', (data) => {
    joined = true;
    window.__queue = data.queue || [];
    if (Array.isArray(data.participants)) {
      applyParticipants(data.participants);
    }
    renderLobby();
  });
  socket.on('participants', (data) => {
    applyParticipants(data.participants || []);
    if (joined) updateParticipantsList();
  });
  socket.on('queue', (data) => {
    window.__queue = data.queue || [];
    if (joined) updateQueueList();
  });
  socket.on('play', (data) => handleRemotePlay(data));
  socket.on('seek', (data) => handleRemoteSeek(data));
  socket.on('queue_preview', (data) => {
    if (joined && !dragState) applyRemoteDragPreview(data);
  });
  socket.on('queue_preview_end', () => {
    if (joined) clearRemoteDragPreview();
  });
  socket.on('connect_error', () => {
    document.getElementById('join-error').textContent = 'Could not connect. Is the server running?';
  });
}

function applyParticipants(list) {
  participants = list.map(p => typeof p === 'string' ? p : p.username);
  list.forEach(p => {
    if (typeof p === 'object' && p.color) {
      window.__userColors[p.username] = p.color;
    }
  });
}

// ─── Color helpers ───

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function coloredUsername(name) {
  const color = window.__userColors[name] || '#ccc';
  return `<span class="username-colored" style="color:${color}">${escapeHtml(name)}</span>`;
}

// ─── Playback ───

function scheduleAt(atTimestamp, fn) {
  const delay = atTimestamp - Date.now();
  if (delay <= 0) fn();
  else setTimeout(fn, delay);
}

function setNowPlaying(who, name) {
  const el = document.getElementById('now-playing');
  if (!el) return;
  if (!name) { el.textContent = who || ''; return; }
  el.innerHTML = `Now playing (${coloredUsername(who)}): <strong>${escapeHtml(name)}</strong>`;
}

function setPlayingState(playing) {
  window.__isPlaying = playing;
  updateSkipButtonVisibility();
}

function capitalize(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function trackName(url) {
  try {
    const u = new URL(url, window.location.origin);
    if (u.hostname === 'soundcloud.com' || u.hostname === 'www.soundcloud.com') {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) {
        const track = capitalize(decodeURIComponent(parts[1]).replace(/[-_]/g, ' '));
        const artist = capitalize(decodeURIComponent(parts[0]).replace(/[-_]/g, ' '));
        return `${track} \u2014 ${artist}`;
      }
    }
    if (u.hostname === 'drive.google.com') {
      return 'Google Drive audio';
    }
    if (u.pathname === '/api/audio-proxy') {
      return 'Google Drive audio';
    }
    const filename = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (filename) {
      return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
    }
  } catch { /* fall through */ }
  return url.length > 40 ? url.slice(0, 37) + '\u2026' : url;
}

function handleRemotePlay(data) {
  const { type, url, positionMs = 0, atTimestamp, username: who, queue: queueFromServer, name } = data || {};
  if (!url) return;
  if (Array.isArray(queueFromServer)) {
    window.__queue = queueFromServer;
    if (joined) updateQueueList();
  }
  window.__currentSharer = who || null;
  if (window.__scSeekInterval) {
    clearInterval(window.__scSeekInterval);
    window.__scSeekInterval = null;
  }
  setNowPlaying(who || 'someone', name || trackName(url));
  window.__currentTrack = { type, url };
  if (joined) {
    updateParticipantsList();
    updateSkipButtonVisibility();
  }
  let playUrl = url;
  if (type === 'file') {
    const audio = document.getElementById('html-audio');
    if (!audio) return;
    const doPlay = () => {
      audio.src = playUrl;
      audio.currentTime = (positionMs || 0) / 1000;
      audio.play().catch((err) => setNowPlaying(`Playback error: ${err.message}`));
      setPlayingState(true);
    };
    scheduleAt(atTimestamp || Date.now(), doPlay);
  }
  if (type === 'soundcloud') {
    window.__pendingSoundCloud = { url, positionMs, atTimestamp, who };
    if (window.SC && window.__scWidget) {
      applySoundCloudPlay(window.__scWidget, { url, positionMs, atTimestamp });
    }
  }
}

function applySoundCloudPlay(widget, { url, positionMs, atTimestamp }) {
  if (!widget) return;
  widget.load(url, { callback: () => {
    scheduleAt(atTimestamp || Date.now(), () => {
      widget.seekTo(positionMs || 0);
      const vol = Number(document.getElementById('volume-slider')?.value ?? 100);
      if (window.__scWidget) window.__scWidget.setVolume(Math.round(vol));
      widget.play();
      setPlayingState(true);
      startSoundCloudSeekUpdates(widget);
    });
  } });
}

function startSoundCloudSeekUpdates(widget) {
  if (window.__scSeekInterval) clearInterval(window.__scSeekInterval);
  const seekRow = document.getElementById('seek-row');
  if (seekRow) seekRow.hidden = false;
  window.__scSeekInterval = setInterval(() => {
    if (!widget) return;
    widget.getDuration((d) => {
      widget.getPosition((p) => {
        const bar = window.__seekBar;
        const timeEl = window.__seekTimeEl;
        if (!bar || !timeEl || !d) return;
        window.__durationMs = d;
        bar.value = d > 0 ? (p / d) * 100 : 0;
        timeEl.textContent = `${formatTime(p / 1000)} / ${formatTime(d / 1000)}`;
      });
    });
  }, 300);
}

function handleRemoteSeek(data) {
  const { positionMs } = data || {};
  const audio = document.getElementById('html-audio');
  if (audio && !isNaN(positionMs)) {
    audio.currentTime = positionMs / 1000;
    audio.play().catch(() => {});
  }
  if (window.__scWidget && !isNaN(positionMs)) {
    window.__scWidget.seekTo(positionMs);
    window.__scWidget.play();
  }
}

function updateSeekBar(audio) {
  const bar = window.__seekBar;
  const timeEl = window.__seekTimeEl;
  if (!bar || !timeEl || !audio) return;
  const d = audio.duration;
  const t = audio.currentTime;
  if (!isFinite(d) || d === 0) return;
  bar.value = (t / d) * 100;
  window.__durationMs = d * 1000;
  timeEl.textContent = `${formatTime(t)} / ${formatTime(d)}`;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── UI rendering ───

function updateParticipantsList() {
  const el = document.getElementById('participants-list');
  if (!el) return;
  const sharer = window.__currentSharer || null;
  el.innerHTML = participants.map((p) => {
    const isSharer = p === sharer;
    return `<li>${coloredUsername(p)}${isSharer ? ' <span class="sharer-badge" aria-label="Now playing">\u25B6</span>' : ''}</li>`;
  }).join('');
}

function updateQueueList() {
  const container = document.getElementById('queue-section');
  if (!container) return;
  if (dragState) return; // don't re-render during local drag
  const queue = window.__queue || [];
  if (queue.length === 0) {
    container.innerHTML = '<h3>Queue</h3><p class="queue-empty">No tracks queued.</p>';
    return;
  }
  const nowPlaying = queue[0];
  const upNext = queue.slice(1);
  let html = '<h3>Queue</h3><ul id="queue-list" class="queue-list">';
  html += `<li class="queue-item queue-item-now" data-index="0"><span class="queue-label">Now playing</span> ${coloredUsername(nowPlaying.username)}: <strong>${escapeHtml(nowPlaying.name || trackName(nowPlaying.url))}</strong></li>`;
  upNext.forEach((item, i) => {
    const idx = i + 1;
    const label = i === 0 ? '<span class="queue-label">Next</span> ' : '';
    const cls = i === 0 ? 'queue-item queue-item-next queue-item-draggable' : 'queue-item queue-item-draggable';
    html += `<li class="${cls}" data-index="${idx}"><span class="drag-handle" title="Drag to reorder">\u2630</span>${label}${coloredUsername(item.username)}: ${escapeHtml(item.name || trackName(item.url))}</li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
  bindQueueDragHandlers();
}

// ─── Drag-and-drop queue reordering ───

let dragState = null;

function bindQueueDragHandlers() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  list.querySelectorAll('.queue-item-draggable').forEach(item => {
    item.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (!e.target.closest('.drag-handle')) return;
      e.preventDefault();
      startDrag(item, e);
    });
  });
}

function startDrag(item, startEvent) {
  const list = document.getElementById('queue-list');
  if (!list) return;
  const fromIndex = parseInt(item.dataset.index, 10);
  if (fromIndex < 1) return;

  const allItems = [...list.querySelectorAll('.queue-item-draggable')];
  const rects = new Map();
  allItems.forEach(el => {
    rects.set(parseInt(el.dataset.index, 10), el.getBoundingClientRect());
  });
  const itemRect = item.getBoundingClientRect();
  const itemH = itemRect.height;

  const ghost = item.cloneNode(true);
  ghost.classList.add('queue-item-ghost');
  ghost.style.width = itemRect.width + 'px';
  ghost.style.position = 'fixed';
  ghost.style.left = itemRect.left + 'px';
  ghost.style.top = itemRect.top + 'px';
  ghost.style.zIndex = '1000';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);

  item.classList.add('queue-item-dragging');
  allItems.forEach(el => el.style.transition = 'transform 150ms ease');

  dragState = {
    fromIndex,
    currentHover: fromIndex,
    ghost,
    item,
    allItems,
    rects,
    itemH,
    offsetY: startEvent.clientY - itemRect.top,
  };

  let lastEmit = 0;
  const THROTTLE = 60;

  const onMove = (e) => {
    if (!dragState) return;
    dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';

    let hoverIndex = dragState.fromIndex;
    for (const el of dragState.allItems) {
      const idx = parseInt(el.dataset.index, 10);
      if (idx === dragState.fromIndex) continue;
      const r = dragState.rects.get(idx);
      if (!r) continue;
      const midY = r.top + r.height / 2;
      if (e.clientY < midY && idx < hoverIndex) hoverIndex = idx;
      if (e.clientY > midY && idx > hoverIndex) hoverIndex = idx;
    }

    // More robust: find closest gap
    const indices = dragState.allItems
      .map(el => parseInt(el.dataset.index, 10))
      .filter(i => i !== dragState.fromIndex)
      .sort((a, b) => a - b);
    let bestIdx = dragState.fromIndex;
    let bestDist = Infinity;
    for (const idx of indices) {
      const r = dragState.rects.get(idx);
      if (!r) continue;
      const midY = r.top + r.height / 2;
      const dist = Math.abs(e.clientY - midY);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
        if (e.clientY > midY) bestIdx = idx;
      }
    }
    // Determine insertion point
    const targetR = dragState.rects.get(bestIdx);
    if (targetR) {
      const midY = targetR.top + targetR.height / 2;
      if (e.clientY < midY && bestIdx < dragState.fromIndex) hoverIndex = bestIdx;
      else if (e.clientY >= midY && bestIdx > dragState.fromIndex) hoverIndex = bestIdx;
      else if (e.clientY < midY && bestIdx > dragState.fromIndex) hoverIndex = bestIdx;
      else if (e.clientY >= midY && bestIdx < dragState.fromIndex) hoverIndex = bestIdx;
      else hoverIndex = bestIdx;
    }
    hoverIndex = Math.max(1, hoverIndex);

    if (hoverIndex !== dragState.currentHover) {
      dragState.currentHover = hoverIndex;
      applyDragTransforms(dragState.fromIndex, hoverIndex);
      const now = Date.now();
      if (now - lastEmit > THROTTLE && socket && joined) {
        lastEmit = now;
        socket.emit('queue_drag', { fromIndex: dragState.fromIndex, hoverIndex });
      }
    }
  };

  const onUp = () => {
    if (!dragState) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);

    const { fromIndex: f, currentHover: t, ghost: g, item: it, allItems: all } = dragState;
    g.remove();
    it.classList.remove('queue-item-dragging');
    all.forEach(el => { el.style.transform = ''; el.style.transition = ''; });
    dragState = null;

    if (socket && joined) socket.emit('queue_drag_end');
    if (f !== t && socket && joined) {
      socket.emit('queue_reorder', { fromIndex: f, toIndex: t });
    }
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

function applyDragTransforms(fromIndex, hoverIndex) {
  if (!dragState) return;
  const { allItems, itemH } = dragState;
  allItems.forEach(el => {
    const idx = parseInt(el.dataset.index, 10);
    if (idx === fromIndex) return;
    let shift = 0;
    if (fromIndex < hoverIndex) {
      if (idx > fromIndex && idx <= hoverIndex) shift = -itemH;
    } else {
      if (idx >= hoverIndex && idx < fromIndex) shift = itemH;
    }
    el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
}

function applyRemoteDragPreview(data) {
  const { fromIndex, hoverIndex } = data;
  const list = document.getElementById('queue-list');
  if (!list) return;
  const items = list.querySelectorAll('.queue-item-draggable');
  if (items.length === 0) return;
  const itemH = items[0].getBoundingClientRect().height;
  items.forEach(el => {
    const idx = parseInt(el.dataset.index, 10);
    el.style.transition = 'transform 150ms ease';
    if (idx === fromIndex) {
      el.classList.add('queue-item-remote-dragging');
      let targetShift = 0;
      if (hoverIndex > fromIndex) targetShift = (hoverIndex - fromIndex) * itemH;
      else if (hoverIndex < fromIndex) targetShift = (hoverIndex - fromIndex) * itemH;
      el.style.transform = targetShift ? `translateY(${targetShift}px)` : '';
    } else {
      let shift = 0;
      if (fromIndex < hoverIndex) {
        if (idx > fromIndex && idx <= hoverIndex) shift = -itemH;
      } else {
        if (idx >= hoverIndex && idx < fromIndex) shift = itemH;
      }
      el.style.transform = shift ? `translateY(${shift}px)` : '';
    }
  });
}

function clearRemoteDragPreview() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  list.querySelectorAll('.queue-item-draggable').forEach(el => {
    el.classList.remove('queue-item-remote-dragging');
    el.style.transform = '';
    el.style.transition = '';
  });
}

// ─── Lobby layout ───

function renderLobby() {
  app.innerHTML = `
    <header class="lobby-header">
      <h1>SoundShare</h1>
      <p class="you">You: <strong>${escapeHtml(username)}</strong></p>
    </header>
    <section class="participants">
      <h2>In the lobby</h2>
      <ul id="participants-list"></ul>
    </section>
    <section class="player-section">
      <h2>Queue audio</h2>
      <p>Paste a SoundCloud link, a shared Google Drive file link, or a direct URL to an audio file (mp3, wav, etc.).</p>
      <div class="url-row">
        <input type="url" id="audio-url" placeholder="SoundCloud, Google Drive, or direct audio URL (mp3, wav\u2026)" />
        <button type="button" id="btn-queue">Queue</button>
        <button type="button" id="btn-skip" class="btn-skip" title="Skip current track" hidden>Skip</button>
      </div>
      <p id="now-playing" class="now-playing" aria-live="polite"></p>
      <div class="queue-section" id="queue-section">
        <h3>Queue</h3>
        <p class="queue-empty">No tracks queued.</p>
      </div>
      <div class="seek-row" id="seek-row" hidden>
        <input type="range" id="seek-bar" min="0" max="100" value="0" />
        <span id="seek-time">0:00 / 0:00</span>
      </div>
      <div class="volume-row">
        <label for="volume-slider">Volume</label>
        <input type="range" id="volume-slider" min="0" max="100" value="100" />
      </div>
    </section>
    <audio id="html-audio" preload="auto"></audio>
    <div id="soundcloud-container" class="soundcloud-container" hidden></div>
  `;
  updateParticipantsList();
  updateQueueList();
  updateSkipButtonVisibility();
  bindPlayerHandlers();
  initSoundCloudWidget();
  applyVolume(100);
}

function updateSkipButtonVisibility() {
  const btn = document.getElementById('btn-skip');
  if (!btn) return;
  const isSharer = username === (window.__currentSharer || null);
  const isPlaying = window.__isPlaying;
  btn.hidden = !(isSharer && isPlaying);
}

function applyVolume(valuePercent) {
  const v = Math.max(0, Math.min(100, valuePercent)) / 100;
  const audio = document.getElementById('html-audio');
  if (audio) audio.volume = v;
  if (window.__scWidget) window.__scWidget.setVolume(Math.round(valuePercent));
}

function bindPlayerHandlers() {
  const btnQueue = document.getElementById('btn-queue');
  const urlInput = document.getElementById('audio-url');
  if (btnQueue && urlInput) {
    btnQueue.addEventListener('click', () => handlePlay(urlInput.value.trim()));
  }
  const btnSkip = document.getElementById('btn-skip');
  if (btnSkip) {
    btnSkip.addEventListener('click', () => {
      if (!socket || !joined || username !== window.__currentSharer) return;
      stopPlayback();
      setPlayingState(false);
      if (window.__scSeekInterval) {
        clearInterval(window.__scSeekInterval);
        window.__scSeekInterval = null;
      }
      socket.emit('track_ended');
    });
  }
  const seekBar = document.getElementById('seek-bar');
  const seekRow = document.getElementById('seek-row');
  const audio = document.getElementById('html-audio');
  if (audio) {
    audio.addEventListener('durationchange', () => {
      window.__durationMs = audio.duration * 1000;
      if (seekRow) seekRow.hidden = false;
      updateSeekBar(audio);
    });
    audio.addEventListener('timeupdate', () => updateSeekBar(audio));
    audio.addEventListener('ended', () => {
      updateSeekBar(audio);
      setPlayingState(false);
      if (socket && joined && username === window.__currentSharer && window.__currentTrack?.type === 'file') {
        socket.emit('track_ended');
      }
    });
  }
  if (seekBar) {
    seekBar.addEventListener('input', () => {
      const positionMs = (seekBar.value / 100) * (window.__durationMs || 0);
      localSeek(positionMs);
      if (socket && joined && username === window.__currentSharer) socket.emit('seek', { positionMs });
    });
  }
  window.__seekBar = seekBar || window.__seekBar;
  window.__seekRow = seekRow || window.__seekRow;
  window.__seekTimeEl = document.getElementById('seek-time') || window.__seekTimeEl;

  const volumeSlider = document.getElementById('volume-slider');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => applyVolume(Number(volumeSlider.value)));
  }
}

function localSeek(positionMs) {
  const audio = document.getElementById('html-audio');
  if (audio && !isNaN(positionMs)) audio.currentTime = positionMs / 1000;
  if (window.__scWidget && !isNaN(positionMs)) window.__scWidget.seekTo(positionMs);
}

function stopPlayback() {
  const audio = document.getElementById('html-audio');
  if (audio) audio.pause();
  if (window.__scWidget) window.__scWidget.pause();
}

function handlePlay(url) {
  if (!url) return;
  if (!socket || !joined) return;
  const name = trackName(url);
  let type;
  if (isSoundCloudUrl(url)) {
    type = 'soundcloud';
  } else if (isGoogleDriveUrl(url)) {
    url = getGoogleDriveProxyUrl(url);
    type = 'file';
  } else {
    type = 'file';
  }
  socket.emit('play', { type, url, positionMs: 0, name });
}

function isSoundCloudUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'soundcloud.com' || u.hostname === 'www.soundcloud.com';
  } catch {
    return false;
  }
}

function isGoogleDriveUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'drive.google.com' && /\/file\/d\/([^/]+)/.test(u.pathname);
  } catch {
    return false;
  }
}

function getGoogleDriveFileId(shareUrl) {
  const match = shareUrl.match(/\/file\/d\/([^/]+)/);
  return match ? match[1] : null;
}

function getGoogleDriveProxyUrl(shareUrl) {
  const id = getGoogleDriveFileId(shareUrl);
  if (!id) return shareUrl;
  return `/api/audio-proxy?id=${encodeURIComponent(id)}`;
}

function initSoundCloudWidget() {
  const container = document.getElementById('soundcloud-container');
  if (!container || container.querySelector('iframe')) return;
  const iframe = document.createElement('iframe');
  iframe.id = 'soundcloud-widget';
  iframe.setAttribute('width', '100%');
  iframe.setAttribute('height', '166');
  iframe.setAttribute('frameborder', 'no');
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('allow', 'autoplay');
  iframe.title = 'SoundCloud player';
  iframe.src = 'https://w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fsoundcloud%2Ftracks%2F293&auto_play=false&single_active=false';
  container.appendChild(iframe);

  function attachWidget() {
    if (!window.SC) return false;
    try {
      window.__scWidget = SC.Widget(iframe);
      window.__scWidget.bind(window.SC.Widget.Events.FINISH, () => {
        setPlayingState(false);
        if (window.__scSeekInterval) {
          clearInterval(window.__scSeekInterval);
          window.__scSeekInterval = null;
        }
        if (socket && joined && username === window.__currentSharer && window.__currentTrack?.type === 'soundcloud') {
          socket.emit('track_ended');
        }
      });
      if (window.__pendingSoundCloud) {
        const p = window.__pendingSoundCloud;
        applySoundCloudPlay(window.__scWidget, p);
        window.__pendingSoundCloud = null;
      }
      return true;
    } catch (e) {
      return false;
    }
  }
  if (!attachWidget()) {
    const t = setInterval(() => {
      if (attachWidget()) clearInterval(t);
    }, 100);
  }
}

renderJoin();
