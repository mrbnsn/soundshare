import { io } from 'socket.io-client';
import './style.css';

// ─── State ───

const app = document.getElementById('app');
let socket = null;
let username = '';
let joined = false;
let participants = [];

window.__userColors = {};
window.__queue = [];
window.__history = [];
window.__chatMessages = [];

// ─── Utilities ───

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function coloredUsername(name) {
  const color = window.__userColors[name] || '#ccc';
  return `<span class="username-colored" style="color:${color}">${escapeHtml(name)}</span>`;
}

function capitalize(s) {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function scheduleAt(atTimestamp, fn) {
  const delay = atTimestamp - Date.now();
  if (delay <= 0) fn();
  else setTimeout(fn, delay);
}

// ─── Toast system ───

function ensureToastContainer() {
  let c = document.getElementById('toast-container');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toast-container';
    c.className = 'toast-container';
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, type = 'info', duration = 3000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  setTimeout(() => {
    toast.classList.remove('toast-visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 500);
  }, duration);
}

// ─── Storage (localStorage) ───

function loadUsername() {
  try { return localStorage.getItem('soundshare_username') || ''; } catch { return ''; }
}

function saveUsername(name) {
  try { localStorage.setItem('soundshare_username', name); } catch { /* noop */ }
}

function loadVolume() {
  try { return Number(localStorage.getItem('soundshare_volume') ?? 100); } catch { return 100; }
}

function saveVolume(v) {
  try { localStorage.setItem('soundshare_volume', String(v)); } catch { /* noop */ }
}

// ─── Room routing (hash-based) ───

function getRoomFromUrl() {
  const hash = window.location.hash.replace(/^#/, '').trim();
  return hash || null;
}

function setRoomInUrl(roomId) {
  if (roomId && roomId !== 'lobby') {
    history.replaceState(null, '', `#${roomId}`);
  } else {
    history.replaceState(null, '', window.location.pathname);
  }
}

function generateRoomCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ─── Track name parsing ───

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
    if (u.hostname === 'drive.google.com') return 'Google Drive audio';
    if (u.pathname === '/api/audio-proxy') return 'Google Drive audio';
    if (isYouTubeUrl(url)) return 'YouTube video';
    const filename = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (filename) return filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
  } catch { /* fall through */ }
  return url.length > 40 ? url.slice(0, 37) + '\u2026' : url;
}

// ─── YouTube helpers ───

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return /^(www\.)?(youtube\.com|youtu\.be)$/.test(u.hostname);
  } catch { return false; }
}

function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0];
    if (u.searchParams.has('v')) return u.searchParams.get('v');
    if (u.pathname.startsWith('/embed/')) return u.pathname.split('/')[2];
  } catch { /* noop */ }
  return null;
}

async function fetchYouTubeTitle(url) {
  try {
    const resp = await fetch(`/api/youtube-title?url=${encodeURIComponent(url)}`);
    if (resp.ok) {
      const data = await resp.json();
      return data.title || 'YouTube video';
    }
  } catch { /* noop */ }
  return 'YouTube video';
}

let ytPlayer = null;
let ytReady = false;
let ytReadyPromise = null;

function initYouTubePlayer() {
  if (ytReadyPromise) return ytReadyPromise;
  ytReadyPromise = new Promise((resolve) => {
    function createPlayer() {
      const container = document.getElementById('youtube-container');
      if (!container) { resolve(null); return; }
      if (!container.querySelector('#youtube-player')) {
        const div = document.createElement('div');
        div.id = 'youtube-player';
        container.appendChild(div);
      }
      ytPlayer = new window.YT.Player('youtube-player', {
        height: '1',
        width: '1',
        playerVars: { autoplay: 0, controls: 0 },
        events: {
          onReady: () => { ytReady = true; resolve(ytPlayer); },
          onStateChange: (event) => {
            if (event.data === window.YT.PlayerState.ENDED) {
              setPlayingState(false);
              if (socket && joined && username === window.__currentSharer && window.__currentTrack?.type === 'youtube') {
                socket.emit('track_ended');
              }
            }
          },
        },
      });
    }
    if (window.YT && window.YT.Player) {
      createPlayer();
    } else {
      if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
        const tag = document.createElement('script');
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = createPlayer;
    }
  });
  return ytReadyPromise;
}

function startYouTubeSeekUpdates() {
  if (window.__ytSeekInterval) clearInterval(window.__ytSeekInterval);
  window.__ytSeekInterval = setInterval(() => {
    if (!ytPlayer || !ytReady) return;
    try {
      const d = ytPlayer.getDuration();
      const p = ytPlayer.getCurrentTime();
      const bar = window.__seekBar;
      const timeEl = window.__seekTimeEl;
      if (!bar || !timeEl || !d) return;
      window.__durationMs = d * 1000;
      bar.value = d > 0 ? (p / d) * 100 : 0;
      timeEl.textContent = `${formatTime(p)} / ${formatTime(d)}`;
    } catch { /* player not ready */ }
  }, 300);
}

// ─── SoundCloud helpers ───

function isSoundCloudUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'soundcloud.com' || u.hostname === 'www.soundcloud.com';
  } catch { return false; }
}

// ─── Google Drive helpers ───

function isGoogleDriveUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'drive.google.com' && /\/file\/d\/([^/]+)/.test(u.pathname);
  } catch { return false; }
}

function getGoogleDriveProxyUrl(shareUrl) {
  const match = shareUrl.match(/\/file\/d\/([^/]+)/);
  return match ? `/api/audio-proxy?id=${encodeURIComponent(match[1])}` : shareUrl;
}

// ─── Socket connection ───

function getSocketOrigin() {
  if (import.meta.env.DEV) return undefined;
  return window.location.origin;
}

function connectAndJoin(name, roomId) {
  socket = io(getSocketOrigin(), { path: '/socket.io', transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    socket.emit('join', { username: name, roomId: roomId || null });
  });

  socket.on('joined', (data) => {
    joined = true;
    window.__queue = data.queue || [];
    window.__history = data.history || [];
    window.__chatMessages = data.chat || [];
    if (Array.isArray(data.participants)) applyParticipants(data.participants);
    setRoomInUrl(data.room);
    renderLobby(data.room);
  });

  socket.on('participants', (data) => {
    applyParticipants(data.participants || []);
    if (joined) updateParticipantsList();
  });

  socket.on('queue', (data) => {
    window.__queue = data.queue || [];
    if (joined) updateQueueList();
  });

  socket.on('queue_empty', () => {
    window.__currentSharer = null;
    window.__currentTrack = null;
    setPlayingState(false);
    clearNowPlaying();
  });

  socket.on('history', (data) => {
    window.__history = data.history || [];
    if (joined) updateHistoryList();
  });

  socket.on('play', (data) => handleRemotePlay(data));
  socket.on('seek', (data) => handleRemoteSeek(data));
  socket.on('pause', () => handleRemotePause());

  socket.on('queue_preview', (data) => {
    if (joined && !dragState) applyRemoteDragPreview(data);
  });
  socket.on('queue_preview_end', () => {
    if (joined) clearRemoteDragPreview();
  });

  socket.on('chat', (entry) => {
    window.__chatMessages.push(entry);
    if (joined) appendChatMessage(entry);
  });

  socket.on('connect_error', () => {
    const el = document.getElementById('join-error');
    if (el) el.textContent = 'Could not connect. Is the server running?';
  });
}

function applyParticipants(list) {
  participants = list.map(p => typeof p === 'string' ? p : p.username);
  list.forEach(p => {
    if (typeof p === 'object' && p.color) window.__userColors[p.username] = p.color;
  });
}

// ─── Playback engine ───

function clearNowPlaying() {
  window.__durationMs = 0;
  if (joined) {
    updateQueueList();
    updateParticipantsList();
  }
}

function setPlayingState(playing) {
  window.__isPlaying = playing;
  updatePlayerControls();
}

function stopPlayback() {
  const audio = document.getElementById('html-audio');
  if (audio) { audio.pause(); audio.removeAttribute('src'); }
  if (window.__scWidget) window.__scWidget.pause();
  if (ytPlayer && ytReady) try { ytPlayer.stopVideo(); } catch { /* noop */ }
  if (window.__scSeekInterval) { clearInterval(window.__scSeekInterval); window.__scSeekInterval = null; }
  if (window.__ytSeekInterval) { clearInterval(window.__ytSeekInterval); window.__ytSeekInterval = null; }
}

function pausePlayback() {
  const audio = document.getElementById('html-audio');
  if (audio && !audio.paused) audio.pause();
  if (window.__scWidget) window.__scWidget.pause();
  if (ytPlayer && ytReady) try { ytPlayer.pauseVideo(); } catch { /* noop */ }
}

function resumePlayback() {
  const type = window.__currentTrack?.type;
  if (type === 'file') {
    const audio = document.getElementById('html-audio');
    if (audio) audio.play().catch(() => {});
  } else if (type === 'soundcloud') {
    if (window.__scWidget) window.__scWidget.play();
  } else if (type === 'youtube') {
    if (ytPlayer && ytReady) try { ytPlayer.playVideo(); } catch { /* noop */ }
  }
}

function getCurrentPositionMs() {
  const type = window.__currentTrack?.type;
  if (type === 'file') {
    const audio = document.getElementById('html-audio');
    if (audio && isFinite(audio.currentTime)) return Math.round(audio.currentTime * 1000);
  } else if (type === 'soundcloud') {
    // SC widget is async, so we use the last known seek bar value
    return Math.round((window.__seekBar?.value || 0) / 100 * (window.__durationMs || 0));
  } else if (type === 'youtube') {
    if (ytPlayer && ytReady) try { return Math.round(ytPlayer.getCurrentTime() * 1000); } catch { /* noop */ }
  }
  return 0;
}

function handleRemotePause() {
  pausePlayback();
  setPlayingState(false);
  updatePlayerControls();
}

function resetSeekBar() {
  const seekBar = window.__seekBar || document.getElementById('seek-bar');
  const seekTime = window.__seekTimeEl || document.getElementById('seek-time');
  if (seekBar) seekBar.value = 0;
  if (seekTime) seekTime.textContent = '0:00 / 0:00';
  window.__durationMs = 0;
}

function handleRemotePlay(data) {
  const { type, url, positionMs = 0, atTimestamp, username: who, queue: queueFromServer, name } = data || {};
  if (!url) return;

  if (Array.isArray(queueFromServer)) {
    window.__queue = queueFromServer;
    if (joined) updateQueueList();
  }

  window.__currentSharer = who || null;
  stopPlayback();
  resetSeekBar();
  window.__currentTrack = { type, url };

  if (joined) {
    updateQueueList();
    updateParticipantsList();
  }

  if (type === 'file') {
    const audio = document.getElementById('html-audio');
    if (!audio) return;
    scheduleAt(atTimestamp || Date.now(), () => {
      audio.src = url;
      audio.currentTime = (positionMs || 0) / 1000;
      audio.play().catch(() => {});
      setPlayingState(true);
    });
  } else if (type === 'soundcloud') {
    window.__pendingSoundCloud = { url, positionMs, atTimestamp, who };
    if (window.SC && window.__scWidget) {
      applySoundCloudPlay(window.__scWidget, { url, positionMs, atTimestamp });
    }
  } else if (type === 'youtube') {
    const videoId = getYouTubeVideoId(url);
    if (!videoId) return;
    initYouTubePlayer().then((player) => {
      if (!player) return;
      scheduleAt(atTimestamp || Date.now(), () => {
        player.loadVideoById({ videoId, startSeconds: (positionMs || 0) / 1000 });
        setPlayingState(true);
        startYouTubeSeekUpdates();
        const vol = Number(document.getElementById('volume-slider')?.value ?? 100);
        player.setVolume(vol);
      });
    });
  }
}

function applySoundCloudPlay(widget, { url, positionMs, atTimestamp }) {
  if (!widget) return;
  widget.load(url, { callback: () => {
    scheduleAt(atTimestamp || Date.now(), () => {
      widget.seekTo(positionMs || 0);
      const vol = Number(document.getElementById('volume-slider')?.value ?? 100);
      widget.setVolume(Math.round(vol));
      widget.play();
      setPlayingState(true);
      startSoundCloudSeekUpdates(widget);
    });
  } });
}

function startSoundCloudSeekUpdates(widget) {
  if (window.__scSeekInterval) clearInterval(window.__scSeekInterval);
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
  if (ytPlayer && ytReady && !isNaN(positionMs)) {
    try { ytPlayer.seekTo(positionMs / 1000, true); } catch { /* noop */ }
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

function applyVolume(valuePercent) {
  const v = Math.max(0, Math.min(100, valuePercent)) / 100;
  const audio = document.getElementById('html-audio');
  if (audio) audio.volume = v;
  if (window.__scWidget) window.__scWidget.setVolume(Math.round(valuePercent));
  if (ytPlayer && ytReady) try { ytPlayer.setVolume(valuePercent); } catch { /* noop */ }
  saveVolume(valuePercent);
}

function localSeek(positionMs) {
  const audio = document.getElementById('html-audio');
  if (audio && !isNaN(positionMs)) audio.currentTime = positionMs / 1000;
  if (window.__scWidget && !isNaN(positionMs)) window.__scWidget.seekTo(positionMs);
  if (ytPlayer && ytReady && !isNaN(positionMs)) try { ytPlayer.seekTo(positionMs / 1000, true); } catch { /* noop */ }
}

// ─── Handle play (user action) ───

async function handlePlay(url) {
  if (!url) return;
  if (!socket || !joined) return;

  let type;
  let name;
  let playUrl = url;

  if (isSoundCloudUrl(url)) {
    type = 'soundcloud';
    name = trackName(url);
  } else if (isYouTubeUrl(url)) {
    type = 'youtube';
    name = await fetchYouTubeTitle(url);
  } else if (isGoogleDriveUrl(url)) {
    playUrl = getGoogleDriveProxyUrl(url);
    type = 'file';
    name = 'Google Drive audio';
  } else {
    type = 'file';
    name = trackName(url);
  }

  socket.emit('play', { type, url: playUrl, positionMs: 0, name });

  // #1 Clear input after queuing
  const input = document.getElementById('audio-url');
  if (input) input.value = '';

  // #2 Toast feedback
  const queueLen = (window.__queue || []).length;
  if (queueLen > 0) {
    showToast(`Added to queue (#${queueLen + 1})`, 'success');
  } else {
    showToast('Now playing!', 'success');
  }
}

// ─── UI: Join screen ───

function renderJoin() {
  const savedName = loadUsername();
  const roomFromUrl = getRoomFromUrl();
  const roomDisplay = roomFromUrl || '';

  app.innerHTML = `
    <div class="join-screen">
      <h1>SoundShare</h1>
      <p class="tagline">Synchronized audio for your group</p>
      <form id="join-form" class="join-form">
        <input type="text" id="username" placeholder="Your name" maxlength="32" required autofocus value="${escapeHtml(savedName)}" />
        <input type="text" id="room-input" placeholder="Room code (leave blank for lobby)" maxlength="32" value="${escapeHtml(roomDisplay)}" />
        <button type="submit">Join</button>
      </form>
      <p id="join-error" class="error" aria-live="polite"></p>
    </div>
  `;

  document.getElementById('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const nameInput = document.getElementById('username');
    const roomInput = document.getElementById('room-input');
    const name = (nameInput.value || '').trim();
    if (!name) {
      document.getElementById('join-error').textContent = 'Enter a name.';
      return;
    }
    username = name;
    saveUsername(name);
    const roomId = (roomInput.value || '').trim() || null;
    connectAndJoin(name, roomId);
  });
}

// ─── UI: Lobby layout ───

function renderLobby(room) {
  const roomLabel = room && room !== 'lobby' ? room : 'lobby';
  const shareUrl = room && room !== 'lobby'
    ? `${window.location.origin}${window.location.pathname}#${room}`
    : '';
  const vol = loadVolume();

  app.innerHTML = `
    <header class="lobby-header">
      <div class="lobby-title-row">
        <h1>SoundShare</h1>
        <span class="room-badge" title="Room code">${escapeHtml(roomLabel)}</span>
      </div>
      <div class="lobby-meta">
        <span class="you">You: <strong>${coloredUsername(username)}</strong></span>
        ${shareUrl ? `<button type="button" class="btn-copy-link" id="btn-copy-link" title="Copy room link">Copy link</button>` : ''}
      </div>
    </header>

    <div class="lobby-grid">
      <section class="participants">
        <h2>Participants</h2>
        <ul id="participants-list"></ul>
      </section>

      <section class="player-section">
        <h2>Queue audio</h2>
        <p class="player-hint">Paste a SoundCloud, YouTube, Google Drive, or direct audio URL.</p>
        <div class="url-row">
          <input type="url" id="audio-url" placeholder="Paste URL and press Enter or click Queue" />
          <button type="button" id="btn-queue">Queue</button>
        </div>
        <div class="queue-section" id="queue-section"></div>
        <div class="history-section" id="history-section"></div>
      </section>

      <section class="chat-section" id="chat-section">
        <h2>Chat</h2>
        <div class="reaction-bar" id="reaction-bar">
          <button type="button" class="reaction-btn" data-emoji="\uD83D\uDC4D">\uD83D\uDC4D</button>
          <button type="button" class="reaction-btn" data-emoji="\uD83D\uDD25">\uD83D\uDD25</button>
          <button type="button" class="reaction-btn" data-emoji="\uD83D\uDC80">\uD83D\uDC80</button>
          <button type="button" class="reaction-btn" data-emoji="\u2764\uFE0F">\u2764\uFE0F</button>
          <button type="button" class="reaction-btn" data-emoji="\uD83C\uDFB6">\uD83C\uDFB6</button>
          <button type="button" class="reaction-btn" data-emoji="\uD83D\uDE02">\uD83D\uDE02</button>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-row">
          <input type="text" id="chat-input" placeholder="Type a message\u2026" maxlength="500" />
          <button type="button" id="btn-chat-send">Send</button>
        </div>
      </section>
    </div>

    <audio id="html-audio" preload="auto"></audio>
    <div id="soundcloud-container" class="soundcloud-container" hidden></div>
    <div id="youtube-container" class="youtube-container" hidden></div>
  `;

  updateParticipantsList();
  updateQueueList();
  updateHistoryList();
  renderChatHistory();
  bindPlayerHandlers();
  bindChatHandlers();
  initSoundCloudWidget();
  applyVolume(vol);

  if (shareUrl) {
    document.getElementById('btn-copy-link')?.addEventListener('click', () => {
      navigator.clipboard.writeText(shareUrl).then(() => showToast('Link copied!', 'success'));
    });
  }
}

// ─── UI: Participants ───

function updateParticipantsList() {
  const el = document.getElementById('participants-list');
  if (!el) return;
  const sharer = window.__currentSharer || null;
  el.innerHTML = participants.map((p) => {
    const isSharer = p === sharer;
    return `<li>${coloredUsername(p)}${isSharer ? ' <span class="sharer-badge" aria-label="Now playing">\u25B6</span>' : ''}</li>`;
  }).join('');
}

// ─── UI: Player controls ───

function updatePlayerControls() {
  const btnPause = document.getElementById('btn-pause');
  const btnSkip = document.getElementById('btn-skip');
  const isSharer = username === (window.__currentSharer || null);
  const playing = window.__isPlaying;

  if (btnPause) {
    btnPause.disabled = !isSharer;
    btnPause.textContent = playing ? '\u275A\u275A' : '\u25B6';
    btnPause.title = isSharer
      ? (playing ? 'Pause for everyone' : 'Resume for everyone')
      : 'Only the sharer can pause';
  }
  if (btnSkip) {
    btnSkip.disabled = !(isSharer && (playing || window.__currentTrack));
    btnSkip.title = isSharer ? 'Skip to next track' : 'Only the sharer can skip';
  }
}

// ─── UI: Queue with player card ───

function updateQueueList() {
  const container = document.getElementById('queue-section');
  if (!container) return;
  if (dragState) return;
  const queue = window.__queue || [];
  const vol = loadVolume();

  let html = '';

  // Player card — always rendered
  if (queue.length > 0) {
    const np = queue[0];
    const seekVal = window.__seekBar?.value || 0;
    const seekTime = window.__seekTimeEl?.textContent || '0:00 / 0:00';
    html += `<div class="now-playing-card" id="now-playing-card">
      <div class="npc-top">
        <button type="button" id="btn-pause" class="npc-btn npc-btn-pause" title="Pause">\u275A\u275A</button>
        <div class="npc-info">
          <span class="npc-track">${escapeHtml(np.name || trackName(np.url))}</span>
          <span class="npc-meta">queued by ${coloredUsername(np.username)}</span>
        </div>
        <button type="button" id="btn-skip" class="npc-btn npc-btn-skip" title="Skip">\u23ED</button>
      </div>
      <div class="npc-seek">
        <input type="range" id="seek-bar" min="0" max="100" value="${seekVal}" />
        <span id="seek-time" class="npc-time">${seekTime}</span>
      </div>
      <div class="npc-volume">
        <span class="npc-vol-icon">\uD83D\uDD0A</span>
        <input type="range" id="volume-slider" min="0" max="100" value="${vol}" />
      </div>
    </div>`;
  } else {
    html += `<div class="now-playing-card now-playing-card-empty">
      <span class="npc-empty-text">No track playing</span>
    </div>`;
  }

  // Up next list
  const upNext = queue.slice(1);
  if (upNext.length > 0) {
    html += '<h3 class="queue-up-next-heading">Up next</h3><ul id="queue-list" class="queue-list">';
    upNext.forEach((item, i) => {
      const idx = i + 1;
      const isOwn = item.username === username;
      html += `<li class="queue-item queue-item-draggable" data-index="${idx}">
        <span class="drag-handle" title="Drag to reorder">\u2630</span>
        <span class="queue-pos">${idx + 1}</span>
        <span class="queue-info">
          <span class="queue-track-name">${escapeHtml(item.name || trackName(item.url))}</span>
          <span class="queue-meta">${coloredUsername(item.username)}</span>
        </span>
        ${isOwn ? `<button type="button" class="btn-queue-remove" data-index="${idx}" title="Remove from queue">\u2715</button>` : ''}
      </li>`;
    });
    html += '</ul>';
  }

  container.innerHTML = html;

  // Re-bind references for seek/volume
  window.__seekBar = document.getElementById('seek-bar');
  window.__seekTimeEl = document.getElementById('seek-time');

  // Bind card controls
  bindCardControls();
  bindQueueDragHandlers();
  bindQueueRemoveHandlers();
  updatePlayerControls();
  if (upNext.length > 0) scrollQueueIntoView();
}

function bindCardControls() {
  const btnPause = document.getElementById('btn-pause');
  const btnSkip = document.getElementById('btn-skip');
  const seekBar = document.getElementById('seek-bar');
  const volumeSlider = document.getElementById('volume-slider');

  if (btnPause) {
    btnPause.addEventListener('click', () => {
      if (!socket || !joined || username !== window.__currentSharer) return;
      if (window.__isPlaying) {
        socket.emit('pause');
      } else {
        const positionMs = getCurrentPositionMs();
        resumePlayback();
        setPlayingState(true);
        updatePlayerControls();
        socket.emit('play', {
          type: window.__currentTrack?.type,
          url: window.__currentTrack?.url,
          positionMs,
        });
      }
    });
  }

  if (btnSkip) {
    btnSkip.addEventListener('click', () => {
      if (!socket || !joined || username !== window.__currentSharer) return;
      stopPlayback();
      setPlayingState(false);
      socket.emit('track_ended');
    });
  }

  if (seekBar) {
    seekBar.addEventListener('input', () => {
      const positionMs = (seekBar.value / 100) * (window.__durationMs || 0);
      localSeek(positionMs);
      if (socket && joined && username === window.__currentSharer) socket.emit('seek', { positionMs });
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => applyVolume(Number(volumeSlider.value)));
  }
}

function bindQueueRemoveHandlers() {
  document.querySelectorAll('.btn-queue-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const index = parseInt(btn.dataset.index, 10);
      if (socket && joined && index >= 1) {
        socket.emit('queue_remove', { index });
        showToast('Removed from queue', 'info');
      }
    });
  });
}

function scrollQueueIntoView() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  const lastItem = list.lastElementChild;
  if (lastItem) lastItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── UI: Queue drag & drop ───

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
  allItems.forEach(el => rects.set(parseInt(el.dataset.index, 10), el.getBoundingClientRect()));
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

  dragState = { fromIndex, currentHover: fromIndex, ghost, item, allItems, rects, itemH, offsetY: startEvent.clientY - itemRect.top };

  let lastEmit = 0;
  const THROTTLE = 60;

  const onMove = (e) => {
    if (!dragState) return;
    dragState.ghost.style.top = (e.clientY - dragState.offsetY) + 'px';

    const indices = dragState.allItems.map(el => parseInt(el.dataset.index, 10)).sort((a, b) => a - b);
    let hoverIndex = dragState.fromIndex;
    let bestDist = Infinity;
    for (const idx of indices) {
      const r = dragState.rects.get(idx);
      if (!r) continue;
      const midY = r.top + r.height / 2;
      const dist = Math.abs(e.clientY - midY);
      if (dist < bestDist) { bestDist = dist; hoverIndex = idx; }
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
    if (f !== t && socket && joined) socket.emit('queue_reorder', { fromIndex: f, toIndex: t });
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
    if (fromIndex < hoverIndex && idx > fromIndex && idx <= hoverIndex) shift = -itemH;
    else if (fromIndex > hoverIndex && idx >= hoverIndex && idx < fromIndex) shift = itemH;
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
      const targetShift = (hoverIndex - fromIndex) * itemH;
      el.style.transform = targetShift ? `translateY(${targetShift}px)` : '';
    } else {
      let shift = 0;
      if (fromIndex < hoverIndex && idx > fromIndex && idx <= hoverIndex) shift = -itemH;
      else if (fromIndex > hoverIndex && idx >= hoverIndex && idx < fromIndex) shift = itemH;
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

// ─── UI: History (#12) ───

function updateHistoryList() {
  const container = document.getElementById('history-section');
  if (!container) return;
  const history = window.__history || [];
  if (history.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = `<details class="history-details">
    <summary>Previously played (${history.length})</summary>
    <ul class="history-list">`;

  [...history].reverse().forEach((item) => {
    html += `<li class="history-item">
      <span class="history-track">${escapeHtml(item.name || trackName(item.url))}</span>
      <span class="history-meta">${coloredUsername(item.username)}</span>
      <button type="button" class="btn-requeue" data-url="${escapeHtml(item.url)}" data-type="${escapeHtml(item.type)}" data-name="${escapeHtml(item.name || '')}" title="Re-queue this track">\u21BB</button>
    </li>`;
  });

  html += '</ul></details>';
  container.innerHTML = html;

  container.querySelectorAll('.btn-requeue').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!socket || !joined) return;
      const { url, type, name } = btn.dataset;
      socket.emit('play', { type, url, positionMs: 0, name: name || null });
      showToast('Re-queued!', 'success');
    });
  });
}

// ─── UI: Chat (#11) ───

function renderChatHistory() {
  const container = document.getElementById('chat-messages');
  if (!container) return;
  container.innerHTML = '';
  (window.__chatMessages || []).forEach(entry => appendChatMessage(entry, false));
  container.scrollTop = container.scrollHeight;
}

function appendChatMessage(entry, scroll = true) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  div.className = entry.type === 'reaction' ? 'chat-msg chat-reaction' : 'chat-msg';

  if (entry.type === 'reaction') {
    div.innerHTML = `${coloredUsername(entry.username)} ${escapeHtml(entry.message)}`;
  } else {
    div.innerHTML = `<span class="chat-author">${coloredUsername(entry.username)}</span> ${escapeHtml(entry.message)}`;
  }
  container.appendChild(div);
  if (scroll) container.scrollTop = container.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chat-input');
  if (!input || !socket || !joined) return;
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat_message', { message: msg, type: 'message' });
  input.value = '';
}

function bindChatHandlers() {
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('btn-chat-send');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    });
  }
  if (btn) btn.addEventListener('click', sendChat);

  document.querySelectorAll('.reaction-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (!socket || !joined) return;
      socket.emit('chat_message', { message: b.dataset.emoji, type: 'reaction' });
    });
  });
}

// ─── UI: Player controls (queue button + audio element events) ───

function bindPlayerHandlers() {
  const btnQueue = document.getElementById('btn-queue');
  const urlInput = document.getElementById('audio-url');

  if (btnQueue && urlInput) {
    btnQueue.addEventListener('click', () => handlePlay(urlInput.value.trim()));
  }

  if (urlInput) {
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handlePlay(urlInput.value.trim()); }
    });
  }

  const audio = document.getElementById('html-audio');
  if (audio) {
    audio.addEventListener('durationchange', () => {
      window.__durationMs = audio.duration * 1000;
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
}

// ─── SoundCloud widget ───

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
        if (window.__scSeekInterval) { clearInterval(window.__scSeekInterval); window.__scSeekInterval = null; }
        if (socket && joined && username === window.__currentSharer && window.__currentTrack?.type === 'soundcloud') {
          socket.emit('track_ended');
        }
      });
      if (window.__pendingSoundCloud) {
        applySoundCloudPlay(window.__scWidget, window.__pendingSoundCloud);
        window.__pendingSoundCloud = null;
      }
      return true;
    } catch { return false; }
  }
  if (!attachWidget()) {
    const t = setInterval(() => { if (attachWidget()) clearInterval(t); }, 100);
  }
}

// ─── Init ───

renderJoin();
