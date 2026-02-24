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

function setPlayingState(playing) {
  window.__isPlaying = playing;
  const btn = document.getElementById('btn-play-pause');
  if (btn) btn.textContent = playing ? 'Pause' : 'Play';
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
  window.__currentSharer = who || null;
  if (window.__scSeekInterval) {
    clearInterval(window.__scSeekInterval);
    window.__scSeekInterval = null;
  }
  setNowPlaying(`Now playing (started by ${escapeHtml(who || 'someone')}): ${shortUrl(url)}`);
  window.__currentTrack = { type, url };
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

function handleRemotePause() {
  setPlayingState(false);
  if (window.__scSeekInterval) {
    clearInterval(window.__scSeekInterval);
    window.__scSeekInterval = null;
  }
  const audio = document.getElementById('html-audio');
  if (audio) audio.pause();
  if (window.__scWidget) window.__scWidget.pause();
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
      <p>Paste a SoundCloud link, a shared Google Drive file link, or a direct URL to an audio file (mp3, wav, etc.).</p>
      <div class="url-row">
        <input type="url" id="audio-url" placeholder="SoundCloud, Google Drive, or direct audio URL (mp3, wav…)" />
        <button type="button" id="btn-play-pause">Play</button>
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
  document.getElementById('btn-play-pause').addEventListener('click', () => {
    if (window.__isPlaying) {
      handlePause();
    } else {
      handlePlayOrResume(urlInput.value.trim());
    }
  });
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
    });
  }
  if (seekBar) {
    seekBar.addEventListener('input', () => {
      const positionMs = (seekBar.value / 100) * (window.__durationMs || 0);
      localSeek(positionMs);
      if (socket && joined && username === window.__currentSharer) {
        socket.emit('seek', { positionMs });
      }
    });
  }
  window.__seekBar = seekBar;
  window.__seekRow = seekRow;
  window.__seekTimeEl = document.getElementById('seek-time');
}

function localSeek(positionMs) {
  const audio = document.getElementById('html-audio');
  if (audio && !isNaN(positionMs)) audio.currentTime = positionMs / 1000;
  if (window.__scWidget && !isNaN(positionMs)) window.__scWidget.seekTo(positionMs);
}

function handlePlayOrResume(url) {
  if (!socket || !joined) return;
  const track = window.__currentTrack;
  const isResume = !url && track && track.url;
  if (isResume && track) {
    if (username === window.__currentSharer) {
      getCurrentPositionMs((positionMs) => {
        if (positionMs != null) socket.emit('play', { type: track.type, url: track.url, positionMs });
      });
    } else {
      localResume();
      setPlayingState(true);
    }
    return;
  }
  if (!url) return;
  handlePlay(url);
}

function localResume() {
  const audio = document.getElementById('html-audio');
  if (audio && audio.src) audio.play().catch(() => {});
  if (window.__scWidget) window.__scWidget.play();
}

function getCurrentPositionMs(cb) {
  const audio = document.getElementById('html-audio');
  if (audio && audio.src && isFinite(audio.duration)) {
    cb(audio.currentTime * 1000);
    return;
  }
  if (window.__scWidget) {
    window.__scWidget.getPosition((p) => cb(p));
    return;
  }
  cb(0);
}

function handlePlay(url) {
  if (!url) return;
  if (!socket || !joined) return;
  let type;
  if (isSoundCloudUrl(url)) {
    type = 'soundcloud';
  } else if (isGoogleDriveUrl(url)) {
    url = getGoogleDriveProxyUrl(url);
    type = 'file';
  } else {
    type = 'file';
  }
  socket.emit('play', { type, url, positionMs: 0 });
}

function handlePause() {
  if (!socket || !joined) return;
  localPause();
  setPlayingState(false);
  if (username === window.__currentSharer) {
    socket.emit('pause');
  }
}

function localPause() {
  const audio = document.getElementById('html-audio');
  if (audio) audio.pause();
  if (window.__scWidget) window.__scWidget.pause();
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

function getGoogleDriveDirectUrl(shareUrl) {
  const id = getGoogleDriveFileId(shareUrl);
  if (!id) return shareUrl;
  return `https://drive.google.com/uc?export=download&id=${id}`;
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
