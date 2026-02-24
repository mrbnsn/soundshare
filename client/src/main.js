import { io } from 'socket.io-client';
import './style.css';

const app = document.getElementById('app');
let socket = null;
let username = '';
let joined = false;
let participants = [];

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
  socket.on('joined', () => {
    joined = true;
    renderLobby();
  });
  socket.on('participants', (data) => {
    participants = data.participants || [];
    if (joined) updateParticipantsList();
  });
  socket.on('play', (data) => handleRemotePlay(data));
  socket.on('pause', (data) => handleRemotePause(data));
  socket.on('seek', (data) => handleRemoteSeek(data));
  socket.on('connect_error', () => {
    document.getElementById('join-error').textContent = 'Could not connect. Is the server running?';
  });
}

function scheduleAt(atTimestamp, fn) {
  const delay = atTimestamp - Date.now();
  if (delay <= 0) fn();
  else setTimeout(fn, delay);
}

function setNowPlaying(text) {
  const el = document.getElementById('now-playing');
  if (el) el.textContent = text || '';
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? u.pathname.slice(0, 37) + '…' : u.pathname;
    return u.origin + path;
  } catch {
    return url.length > 50 ? url.slice(0, 47) + '…' : url;
  }
}

function handleRemotePlay(data) {
  const { type, url, positionMs = 0, atTimestamp, username: who } = data || {};
  if (!url) return;
  setNowPlaying(`Now playing (started by ${escapeHtml(who || 'someone')}): ${shortUrl(url)}`);
  if (type === 'file') {
    const audio = document.getElementById('html-audio');
    if (!audio) return;
    const doPlay = () => {
      audio.src = url;
      audio.currentTime = (positionMs || 0) / 1000;
      audio.play().catch((err) => setNowPlaying(`Playback error: ${err.message}`));
    };
    scheduleAt(atTimestamp || Date.now(), doPlay);
    audio.addEventListener('durationchange', () => {
      window.__durationMs = audio.duration * 1000;
      const row = document.getElementById('seek-row');
      if (row) row.hidden = false;
    }, { once: true });
    audio.addEventListener('timeupdate', () => updateSeekBar(audio));
    audio.addEventListener('ended', () => updateSeekBar(audio));
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
      widget.play();
    });
  } });
}

function handleRemotePause(data) {
  const audio = document.getElementById('html-audio');
  if (audio) audio.pause();
  if (window.__scWidget) {
    window.__scWidget.pause();
  }
}

function handleRemoteSeek(data) {
  const { positionMs } = data || {};
  const audio = document.getElementById('html-audio');
  if (audio && !isNaN(positionMs)) {
    audio.currentTime = positionMs / 1000;
  }
  if (window.__scWidget && !isNaN(positionMs)) {
    window.__scWidget.seekTo(positionMs);
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

function updateParticipantsList() {
  const el = document.getElementById('participants-list');
  if (!el) return;
  el.innerHTML = participants.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
}

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
      <h2>Play audio</h2>
      <p>Paste a SoundCloud link or a direct URL to an audio file (mp3, wav, etc.).</p>
      <div class="url-row">
        <input type="url" id="audio-url" placeholder="https://soundcloud.com/... or https://example.com/track.mp3" />
        <button type="button" id="btn-play">Play</button>
        <button type="button" id="btn-pause">Pause</button>
      </div>
      <p id="now-playing" class="now-playing" aria-live="polite"></p>
      <div class="seek-row" id="seek-row" hidden>
        <input type="range" id="seek-bar" min="0" max="100" value="0" />
        <span id="seek-time">0:00 / 0:00</span>
      </div>
    </section>
    <audio id="html-audio" preload="auto"></audio>
    <div id="soundcloud-container" class="soundcloud-container" hidden></div>
  `;
  updateParticipantsList();
  bindPlayerHandlers();
  initSoundCloudWidget();
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function bindPlayerHandlers() {
  const urlInput = document.getElementById('audio-url');
  document.getElementById('btn-play').addEventListener('click', () => handlePlay(urlInput.value.trim()));
  document.getElementById('btn-pause').addEventListener('click', () => handlePause());
  const seekBar = document.getElementById('seek-bar');
  const seekRow = document.getElementById('seek-row');
  if (seekBar) {
    seekBar.addEventListener('input', () => {
      const positionMs = (seekBar.value / 100) * (window.__durationMs || 0);
      if (socket && joined) socket.emit('seek', { positionMs });
    });
  }
  window.__seekBar = seekBar;
  window.__seekRow = seekRow;
  window.__seekTimeEl = document.getElementById('seek-time');
}

function handlePlay(url) {
  if (!url) return;
  if (!socket || !joined) return;
  const type = isSoundCloudUrl(url) ? 'soundcloud' : 'file';
  socket.emit('play', { type, url, positionMs: 0 });
}

function handlePause() {
  if (!socket || !joined) return;
  socket.emit('pause');
}

function isSoundCloudUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'soundcloud.com' || u.hostname === 'www.soundcloud.com';
  } catch {
    return false;
  }
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

socket?.emit('participants'); // no-op if not connected
renderJoin();
