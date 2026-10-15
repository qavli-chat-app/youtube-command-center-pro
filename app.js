const navItems = document.querySelectorAll('[data-page]');
const title = document.querySelector('#page-title');
const notice = document.querySelector('#notice');
const connectButton = document.querySelector('#connect-button');
const refreshButton = document.querySelector('#refresh-button');
const numberCards = document.querySelectorAll('#panel-overview .grid .card');

function showNotice(message, type = 'info') {
  notice.textContent = message;
  notice.style.borderColor = type === 'error' ? '#743a4b' : type === 'success' ? '#315c4d' : '#3a315d';
  notice.style.background = type === 'error' ? '#25131b' : type === 'success' ? '#12221d' : '#18142a';
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : data.detail?.message || data.detail?.code || 'Request failed.';
    throw new Error(detail);
  }
  return data;
}
function setPage(page) {
  navItems.forEach(node => {
    const active = node.dataset.page === page;
    node.classList.toggle('active', active);
    node.setAttribute('aria-current', active ? 'page' : 'false');
  });
  title.textContent = page;
  document.querySelectorAll('.panel-page').forEach(node => {
    node.hidden = node.id !== 'panel-' + page.toLowerCase().replaceAll(' ', '-');
  });
  const heading = document.querySelector('#headline');
  heading.textContent = page === 'Overview' ? 'Your YouTube command center' : page;
}
navItems.forEach(item => item.addEventListener('click', () => {
  setPage(item.dataset.page);
  if (item.dataset.page === 'My Videos') loadVideos();
  if (item.dataset.page === 'Security & API') loadConnectionStatus();
  if (item.dataset.page === 'Notifications') loadNotifications();
  if (item.dataset.page === 'Channel Settings') loadChannelSettings();
  if (item.dataset.page === 'Security & API') renderSecurityStatus();
}));

async function loadConnectionStatus() {
  try {
    const status = await api('/api/auth/status');
    const pill = document.querySelector('.status');
    if (status.connected) {
      pill.textContent = status.tokenExpired ? '● Reconnect required' : '● Connected';
      pill.style.color = status.tokenExpired ? '#f3ce8d' : '#9ce7c3';
      connectButton.textContent = status.tokenExpired ? 'Reconnect YouTube' : 'Disconnect';
      connectButton.dataset.connected = status.tokenExpired ? 'expired' : 'yes';
      await loadChannel();
    } else {
      pill.textContent = '● Setup required';
      connectButton.textContent = 'Connect YouTube';
      connectButton.dataset.connected = 'no';
    }
  } catch (error) {
    showNotice(error.message + ' Check backend configuration.', 'error');
  }
}
connectButton.addEventListener('click', async () => {
  if (connectButton.dataset.connected === 'yes') {
    if (!confirm('Disconnect this YouTube channel from this dashboard?')) return;
    try {
      await api('/api/auth/disconnect', { method: 'POST' });
      showNotice('Channel disconnected. Stored credentials for this session were removed.', 'success');
      window.location.reload();
    } catch (error) { showNotice(error.message, 'error'); }
    return;
  }
  window.location.href = '/api/auth/start';
});
refreshButton.addEventListener('click', async () => {
  refreshButton.disabled = true;
  try {
    await loadConnectionStatus();
    await loadVideos();
    showNotice('Dashboard refresh completed.', 'success');
  } catch (error) { showNotice(error.message, 'error'); }
  finally { refreshButton.disabled = false; }
});

async function loadChannel() {
  try {
    const channel = await api('/api/channel');
    const values = [
      channel.subscriberCount ?? (channel.hiddenSubscriberCount ? 'Hidden' : '—'),
      channel.viewCount ?? '—',
      channel.videoCount ?? '—',
      '—'
    ];
    numberCards.forEach((card, index) => {
      const value = card.querySelector('.stat-value');
      if (value) value.textContent = Number.isFinite(Number(values[index])) && values[index] !== '—' ? Number(values[index]).toLocaleString() : values[index];
    });
    const intro = document.querySelector('#panel-overview .section-title');
    intro.querySelector('span').textContent = channel.title + ' · ' + channel.id;
    const avatar = document.querySelector('.avatar');
    avatar.textContent = (channel.title || 'YT').slice(0, 2).toUpperCase();
    if (channel.thumbnail) {
      avatar.textContent = '';
      avatar.style.backgroundImage = 'url("' + channel.thumbnail.replaceAll('"', '') + '")';
      avatar.style.backgroundSize = 'cover';
    }
    showNotice('Connected channel: ' + channel.title + '. Channel details were retrieved from YouTube.', 'success');
  } catch (error) {
    if (!/Connect your YouTube channel first/.test(error.message)) showNotice(error.message, 'error');
  }
}
function renderVideoRows(container, videos) {
  container.replaceChildren();
  if (!videos.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No videos found for this query.';
    container.append(empty);
    return;
  }
  videos.forEach(video => {
    const row = document.createElement('div'); row.className = 'video-row';
    const thumb = document.createElement('div'); thumb.className = 'thumb';
    if (video.thumbnail) { const img = document.createElement('img'); img.src = video.thumbnail; img.alt = ''; img.loading = 'lazy'; img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:8px'; thumb.append(img); } else thumb.textContent = '▶';
    const info = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = video.title || 'Untitled video';
    const meta = document.createElement('small'); meta.textContent = (video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : 'Date unavailable') + ' · ' + (video.viewCount ? Number(video.viewCount).toLocaleString() + ' views' : 'Views unavailable');
    info.append(name, meta);
    const badge = document.createElement('span'); badge.className = 'pill'; badge.textContent = video.privacyStatus || video.uploadStatus || 'Unknown';
    row.append(thumb, info, badge); container.append(row);
  });
}
async function loadVideos(query = '') {
  const panel = document.querySelector('#panel-my-videos');
  if (!panel || panel.hidden) return;
  const target = panel.querySelector('.video-list');
  if (!target) return;
  target.textContent = 'Loading videos…';
  try {
    const data = await api('/api/videos?max_results=25&query=' + encodeURIComponent(query));
    renderVideoRows(target, data.items || []);
    showNotice('Loaded ' + (data.items || []).length + ' videos from the connected YouTube channel.', 'success');
  } catch (error) {
    target.textContent = error.message;
    showNotice(error.message, 'error');
  }
}
const videoSearch = document.querySelector('#video-search');
if (videoSearch) {
  let searchTimer;
  videoSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadVideos(videoSearch.value), 350);
  });
}
const videosRefresh = document.querySelector('#videos-refresh');
if (videosRefresh) videosRefresh.addEventListener('click', () => loadVideos(videoSearch?.value || ''));

async function loadChannelSettings() {
  const target = document.querySelector('#channel-settings-data');
  if (!target) return;
  target.textContent = 'Loading channel settings…';
  try {
    const data = await api('/api/channel/settings');
    target.replaceChildren();
    [['Channel', data.title], ['Channel ID', data.id], ['Country', data.country], ['Language', data.defaultLanguage], ['Custom URL', data.customUrl]].forEach(([label, value]) => {
      if (!value) return;
      const row = document.createElement('div'); row.className = 'task';
      const text = document.createElement('div'); text.textContent = label + ': ' + value;
      row.append(text); target.append(row);
    });
  } catch (error) { target.textContent = error.message; }
}
function renderSecurityStatus() {
  const target = document.querySelector('#security-status');
  if (!target) return;
  target.replaceChildren();
  [['OAuth status', connectButton.dataset.connected === 'yes' ? 'Connected' : 'Not connected'], ['API mode', 'Official YouTube Data API v3'], ['Token storage', 'Encrypted server-side'], ['Production deployment', 'Not yet independently verified']].forEach(([label, value]) => {
    const row = document.createElement('div'); row.className = 'task';
    const text = document.createElement('div'); text.textContent = label + ': ' + value;
    row.append(text); target.append(row);
  });
}
const commentsForm = document.querySelector('#comments-form');
if (commentsForm) commentsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const target = document.querySelector('#comments-results');
  target.textContent = 'Loading comments…';
  try {
    const data = await api('/api/comments?video_id=' + encodeURIComponent(document.querySelector('#comments-video-id').value.trim()));
    target.replaceChildren();
    if (!data.items.length) { target.textContent = 'No comments returned, or comments are disabled for this video.'; return; }
    data.items.forEach(comment => {
      const card = document.createElement('div'); card.className = 'card';
      const author = document.createElement('strong'); author.textContent = comment.author || 'YouTube user';
      const text = document.createElement('p'); text.textContent = comment.text || '';
      const reply = document.createElement('textarea'); reply.className = 'text-input'; reply.rows = 2; reply.placeholder = 'Write a reply…';
      const button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Reply';
      button.addEventListener('click', async () => {
        if (!confirm('Send this reply to YouTube?')) return;
        try { await api('/api/comments/' + encodeURIComponent(comment.id) + '/reply', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text:reply.value})}); showNotice('YouTube confirmed the comment reply.', 'success'); button.disabled=true; }
        catch (error) { showNotice(error.message, 'error'); }
      });
      card.append(author, text, reply, button); target.append(card);
    });
  } catch (error) { target.textContent = error.message; showNotice(error.message, 'error'); }
});

const uploadForm = document.querySelector('#upload-form');
if (uploadForm) uploadForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = uploadForm.querySelector('button[type="submit"]');
  const file = uploadForm.querySelector('input[type="file"]').files[0];
  if (!file) { showNotice('Choose a video file first.', 'error'); return; }
  if (!confirm('Upload this video privately to the connected YouTube channel? You can change visibility later.')) return;
  const body = new FormData(uploadForm);
  body.set('privacy_status', 'private');
  button.disabled = true; button.textContent = 'Uploading…';
  showNotice('Upload started. Keep this page open while the server sends the file to YouTube.');
  try {
    const result = await api('/api/videos/upload', { method: 'POST', body });
    showNotice('YouTube confirmed upload. Video ID: ' + result.videoId + '. It is private.', 'success');
    uploadForm.reset();
  } catch (error) {
    showNotice(error.message + ' Check YouTube Studio before retrying to avoid duplicates.', 'error');
  } finally { button.disabled = false; button.textContent = 'Upload privately'; }
});
async function loadNotifications() {
  const panel = document.querySelector('#panel-notifications');
  if (!panel) return;
  const target = panel.querySelector('.notification-list');
  if (!target) return;
  try {
    const data = await api('/api/notifications');
    target.replaceChildren();
    if (!data.items.length) { target.textContent = 'No upload notifications yet.'; return; }
    data.items.forEach(item => {
      const row = document.createElement('div'); row.className = 'task';
      const dot = document.createElement('span'); dot.className = 'task-dot';
      const text = document.createElement('div'); text.textContent = item.title + ': ' + item.message;
      row.append(dot, text); target.append(row);
    });
  } catch (error) { target.textContent = error.message; }
}
if (new URLSearchParams(location.search).has('oauth')) {
  const result = new URLSearchParams(location.search).get('oauth');
  showNotice(result === 'connected' ? 'Google authorization callback completed. Checking channel status…' : 'Google authorization was cancelled.', result === 'connected' ? 'success' : 'info');
  history.replaceState({}, '', location.pathname);
}
loadConnectionStatus();
