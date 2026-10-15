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
  if (item.dataset.page === 'Scheduled Uploads') loadUploadJobs();
  if (item.dataset.page === 'Analytics') document.querySelector('#analytics-form')?.requestSubmit();
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
    const edit = document.createElement('button'); edit.className = 'btn'; edit.textContent = 'Edit details'; edit.style.marginTop = '8px';
    edit.addEventListener('click', async () => {
      const nextTitle = prompt('Edit video title:', video.title || '');
      if (nextTitle === null) return;
      const nextDescription = prompt('Edit video description:', video.description || '');
      if (nextDescription === null) return;
      const tagsText = prompt('Tags as comma-separated words:', (video.tags || []).join(', '));
      if (tagsText === null) return;
      if (!nextTitle.trim() || nextTitle.length > 100) { showNotice('Title is required and must be 100 characters or fewer.', 'error'); return; }
      if (!confirm('Save these metadata changes to YouTube video "' + video.title + '"?')) return;
      try {
        await api('/api/videos/' + encodeURIComponent(video.id), {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:nextTitle.trim(),description:nextDescription,tags:tagsText.split(',').map(t=>t.trim()).filter(Boolean)})});
        showNotice('YouTube confirmed the metadata update.', 'success'); loadVideos(videoSearch?.value || '');
      } catch (error) { showNotice(error.message, 'error'); }
    });
    const visibility = document.createElement('button'); visibility.className = 'btn'; visibility.textContent = 'Visibility'; visibility.style.marginTop = '8px';
    visibility.addEventListener('click', async () => {
      const next = prompt('Choose visibility: private, unlisted, or public. Current: ' + video.privacyStatus, video.privacyStatus || 'private');
      if (next === null) return;
      if (!['private','unlisted','public'].includes(next)) { showNotice('Use private, unlisted, or public.', 'error'); return; }
      if (!confirm('Change visibility of "' + video.title + '" to ' + next + '?')) return;
      try { await api('/api/videos/' + encodeURIComponent(video.id) + '/visibility', {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({privacyStatus:next})}); showNotice('YouTube confirmed the visibility change.', 'success'); loadVideos(videoSearch?.value || ''); }
      catch (error) { showNotice(error.message, 'error'); }
    });
    const thumbnail = document.createElement('button'); thumbnail.className = 'btn'; thumbnail.textContent = 'Thumbnail'; thumbnail.style.marginTop = '8px';
    thumbnail.addEventListener('click', () => {
      const picker = document.createElement('input'); picker.type = 'file'; picker.accept = 'image/jpeg,image/png';
      picker.addEventListener('change', async () => {
        const image = picker.files[0]; if (!image) return;
        if (image.size > 2 * 1024 * 1024) { showNotice('Thumbnail must be 2 MB or smaller.', 'error'); return; }
        if (!confirm('Replace the thumbnail for "' + video.title + '"?')) return;
        const form = new FormData(); form.append('file', image);
        try { await api('/api/videos/' + encodeURIComponent(video.id) + '/thumbnail', {method:'POST',body:form}); showNotice('YouTube confirmed the thumbnail update.', 'success'); loadVideos(videoSearch?.value || ''); }
        catch (error) { showNotice(error.message, 'error'); }
      });
      picker.click();
    });
    const controls = document.createElement('div'); controls.className = 'video-controls'; controls.append(edit, visibility, thumbnail);
    info.append(controls);
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
      const hide = document.createElement('button'); hide.className='btn'; hide.textContent='Reject comment';
      hide.addEventListener('click', async () => {
        if (!confirm('Reject this comment on YouTube? This moderation action affects the real channel.')) return;
        if (!confirm('Confirm again: reject comment by ' + (comment.author || 'this user') + '?')) return;
        try { await api('/api/comments/' + encodeURIComponent(comment.id) + '/moderate', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({moderationStatus:'rejected',confirm:true})}); showNotice('YouTube confirmed the moderation action.', 'success'); hide.disabled=true; }
        catch (error) { showNotice(error.message, 'error'); }
      });
      card.append(author, text, reply, button, hide); target.append(card);
    });
  } catch (error) { target.textContent = error.message; showNotice(error.message, 'error'); }
});


function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/videos/upload');
    xhr.withCredentials = true;
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100))); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        const detail = typeof data.detail === 'string' ? data.detail : data.detail?.message || data.detail?.code || 'Upload request failed.';
        reject(new Error(detail));
      }
    };
    xhr.onerror = () => reject(new Error('Network interruption during upload. Check YouTube Studio before retrying to avoid duplicates.'));
    xhr.onabort = () => reject(new Error('Upload was cancelled. Check YouTube Studio before retrying.'));
    xhr.send(formData);
  });
}

const uploadForm = document.querySelector('#upload-form');
if (uploadForm) uploadForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = uploadForm.querySelector('button[type="submit"]');
  const file = uploadForm.querySelector('input[type="file"]').files[0];
  if (!file) { showNotice('Choose a video file first.', 'error'); return; }
  const publishInput = document.querySelector('#publish-at-local');
  const publishAt = publishInput && publishInput.value ? new Date(publishInput.value) : null;
  if (publishAt && (!Number.isFinite(publishAt.getTime()) || publishAt.getTime() <= Date.now())) {
    showNotice('Choose a future scheduled time.', 'error'); return;
  }
  const confirmText = publishAt
    ? 'Upload privately and ask YouTube to publish at ' + publishAt.toLocaleString() + '? The video stays private until the scheduled time if YouTube accepts the schedule.'
    : 'Upload this video privately to the connected YouTube channel? You can change visibility later.';
  if (!confirm(confirmText)) return;
  const body = new FormData(uploadForm);
  body.set('privacy_status', 'private');
  body.set('publish_at', publishAt ? publishAt.toISOString() : '');
  button.disabled = true; button.textContent = 'Uploading…';
  showNotice('Upload started. Keep this page open while the server sends the file to YouTube.');
  try {
    const result = await uploadWithProgress(body, percent => showNotice('Uploading video to YouTube… ' + percent + '%'));
    showNotice('YouTube confirmed upload. Video ID: ' + result.videoId + '. ' + (result.scheduledPublishAt ? 'Scheduled for ' + new Date(result.scheduledPublishAt).toLocaleString() + '.' : 'It is private.'), 'success');
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

async function loadUploadJobs() {
  const target = document.querySelector('#upload-job-list');
  if (!target) return;
  target.textContent = 'Loading upload history…';
  try {
    const data = await api('/api/upload-jobs');
    target.replaceChildren();
    if (!data.items.length) { target.textContent = 'No upload jobs yet.'; return; }
    data.items.forEach(job => {
      const row = document.createElement('div'); row.className = 'task';
      const dot = document.createElement('span'); dot.className = 'task-dot';
      const text = document.createElement('div');
      const scheduled = job.payload?.scheduledPublishAt ? ' · Scheduled ' + new Date(job.payload.scheduledPublishAt).toLocaleString() : '';
      text.textContent = (job.payload?.title || 'Video upload') + ' · ' + job.status + scheduled + (job.video_id ? ' · Video ID ' + job.video_id : '') + (job.error ? ' · ' + job.error : '');
      row.append(dot, text); target.append(row);
    });
  } catch (error) { target.textContent = error.message; }
}
const analyticsForm = document.querySelector('#analytics-form');
if (analyticsForm) {
  const toDateInput = date => [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
  const today = new Date(); const start = new Date(); start.setDate(today.getDate()-28);
  document.querySelector('#analytics-start').value = toDateInput(start);
  document.querySelector('#analytics-end').value = toDateInput(today);
  analyticsForm.addEventListener('submit', async event => {
    event.preventDefault();
    const target = document.querySelector('#analytics-results'); target.textContent = 'Loading official YouTube Analytics…';
    const from = document.querySelector('#analytics-start').value, to = document.querySelector('#analytics-end').value;
    try {
      const data = await api('/api/analytics?start_date=' + encodeURIComponent(from) + '&end_date=' + encodeURIComponent(to));
      target.replaceChildren();
      if (!data.rows?.length) { target.textContent = 'No analytics rows returned for this range.'; return; }
      const table = document.createElement('table'); table.className = 'data-table';
      const head = document.createElement('tr'); (data.headers || []).forEach(value => { const th=document.createElement('th'); th.textContent=value; head.append(th); }); table.append(head);
      data.rows.forEach(row => { const tr=document.createElement('tr'); row.forEach(value => { const td=document.createElement('td'); td.textContent=String(value); tr.append(td); }); table.append(tr); });
      target.append(table);
    } catch (error) { target.textContent = error.message; showNotice(error.message, 'error'); }
  });
}
const seoForm = document.querySelector('#seo-form');
if (seoForm) seoForm.addEventListener('submit', event => {
  event.preventDefault();
  const topic = document.querySelector('#seo-topic').value.trim();
  const audience = document.querySelector('#seo-audience').value.trim();
  const target = document.querySelector('#seo-results'); target.replaceChildren();
  const words = topic.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
  const unique = values => [...new Set(values.map(v => v.trim()).filter(Boolean))];
  const titleIdeas = unique([
    topic + ' Explained Simply | Complete Guide',
    'How to ' + topic + ' Step by Step',
    topic + ': 7 Important Things You Should Know',
    'Stop Making These ' + topic + ' Mistakes',
    topic + ' Tutorial with Examples'
  ]).map((v, i) => (i + 1) + '. ' + v.slice(0, 100));
  const hashtags = unique(['#' + words.slice(0, 3).join(''), '#YouTubeTips', '#LearnWithMe', ...(audience.toLowerCase().includes('math') ? ['#Maths','#Education'] : []), ...(audience.toLowerCase().includes('urdu') ? ['#Urdu','#Pakistan'] : [])]).slice(0, 8).join(' ');
  const tags = unique([...words, ...words.map(w => w + ' tutorial'), topic.toLowerCase(), 'how to ' + topic.toLowerCase(), 'explained', 'step by step', 'beginner guide', 'tutorial', 'education']).slice(0, 25).join(', ');
  const description = topic + '\n\nIn this video, you will learn about ' + topic + ' with clear explanations and practical examples.\n\n📌 What you will learn:\n• The core idea and important concepts\n• A simple step-by-step explanation\n• Common mistakes and how to avoid them\n• Examples and key takeaways\n\n' + (audience ? '🎯 For: ' + audience + '\n\n' : '') + hashtags + '\n\nIf this video helps you, like it, share it, and subscribe for more useful videos. Please check all facts and replace any generic points with the exact content of your video before publishing.';
  const hook = '“Before you try ' + topic + ', make sure you understand this one important point…”';
  const outline = '0:00 — Strong hook: show the result or problem\n0:15 — Promise: explain exactly what viewers will learn\n0:30 — Step 1: explain the basics\n1:30 — Step 2: demonstrate with a real example\n2:30 — Common mistake and correction\n3:15 — Quick recap / result\n3:40 — Ask one specific question and invite viewers to watch the next related video';
  const thumbnail = 'Use one clear subject, high contrast, 2–4 readable words, and a visual that honestly represents: ' + topic + '. Avoid clutter and misleading claims.';
  const pinned = 'Which part of ' + topic + ' should I explain next? Tell me in the comments.';
  const cards = [
    ['Title options (choose one)', titleIdeas.join('\n')],
    ['SEO description + hashtags', description],
    ['Tags / keywords', tags],
    ['Opening hook', hook],
    ['Video structure / chapters', outline],
    ['Thumbnail concept', thumbnail],
    ['Pinned comment', pinned]
  ];
  cards.forEach(([label, value]) => {
    const card=document.createElement('div'); card.className='card';
    const h=document.createElement('strong'); h.textContent=label;
    const area=document.createElement('textarea'); area.className='text-input'; area.rows=label.includes('description')?9:label.includes('structure')?7:4; area.value=value;
    const copy=document.createElement('button'); copy.className='btn'; copy.textContent='Copy';
    copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(area.value);showNotice(label+' copied.','success');}catch{area.select();showNotice('Select the text and copy it manually.');}});
    card.append(h,area,copy); target.append(card);
  });
  showNotice('Complete SEO pack drafted locally. These are templates, not live search-volume data or guaranteed rankings; verify accuracy before publishing.');
});
const researchForm = document.querySelector('#research-form');
if (researchForm) researchForm.addEventListener('submit', async event => {
  event.preventDefault();
  const q=document.querySelector('#research-query').value.trim();
  const target=document.querySelector('#research-results'); target.textContent='Comparing recent uploads and high-view videos on YouTube…';
  try {
    const data=await api('/api/research?q='+encodeURIComponent(q)+'&max_results=12');
    target.replaceChildren();
    const summary=document.createElement('div'); summary.className='card';
    const summaryTitle=document.createElement('strong'); summaryTitle.textContent='Trend research summary';
    const summaryText=document.createElement('p'); summaryText.className='muted';
    summaryText.textContent=(data.method||'Compared public YouTube results.')+' '+(data.note||'');
    summary.append(summaryTitle,summaryText); target.append(summary);
    if (!data.items.length) { const empty=document.createElement('p'); empty.textContent='No results found. Try a broader keyword.'; target.append(empty); return; }
    const top=data.items[0];
    const idea=document.createElement('div'); idea.className='card';
    const ideaTitle=document.createElement('strong'); ideaTitle.textContent='Suggested original video angle';
    const ideaText=document.createElement('p'); ideaText.textContent='Study the audience interest behind “'+(top.title||q)+'”, but make a fresh explanation, comparison, challenge, or practical tutorial instead of copying the video.';
    const hook=document.createElement('p'); hook.textContent='Hook idea: “Most people miss this important part of '+q+' — here is a simple way to understand it.”';
    const useIdea=document.createElement('button'); useIdea.className='btn primary'; useIdea.textContent='Use topic in SEO Studio';
    useIdea.addEventListener('click',()=>{document.querySelector('#seo-topic').value=q;document.querySelector('#seo-audience').value='Viewers interested in '+q;document.querySelector('[data-page="SEO Studio"]').click();document.querySelector('#seo-form').requestSubmit();});
    idea.append(ideaTitle,ideaText,hook,useIdea); target.append(idea);
    data.items.forEach((item,index)=>{
      const card=document.createElement('div'); card.className='card';
      if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt='';img.loading='lazy';img.style.cssText='width:100%;max-width:360px;border-radius:10px;object-fit:cover';card.append(img);}
      const h=document.createElement('strong'); h.textContent=(index+1)+'. '+(item.title||'Untitled video');
      const meta=document.createElement('p'); meta.className='muted';
      meta.textContent=(item.channelTitle||'Channel')+' · '+Number(item.viewCount||0).toLocaleString()+' views · '+Number(item.viewsPerDay||0).toLocaleString()+' estimated views/day · '+Number(item.engagementRate||0).toFixed(2)+'% visible engagement · relative score '+item.trendScore+' · '+(item.publishedAt?new Date(item.publishedAt).toLocaleDateString():'date unavailable');
      const link=document.createElement('a'); link.href='https://www.youtube.com/watch?v='+encodeURIComponent(item.id); link.target='_blank'; link.rel='noopener noreferrer'; link.textContent='Open video ↗'; link.style.color='#bba5ff';
      card.append(h,meta,link); target.append(card);
    });
    showNotice('Trend research complete. Scores compare these search results only; they do not predict virality.','success');
  } catch(error) { target.textContent=error.message; showNotice(error.message,'error'); }
});

const plannerForm = document.querySelector('#planner-form');
let latestPlan = [];
const plannerTopics = [
  ['Beginner foundation', 'explain the basic idea in simple steps'],
  ['Common mistakes', 'show three mistakes and how to correct them'],
  ['Worked example', 'solve one realistic example from start to finish'],
  ['Myth vs fact', 'separate a common misconception from the facts'],
  ['Quick revision', 'summarize the most important points'],
  ['Challenge', 'give viewers a short question to try before revealing the answer'],
  ['Comparison', 'compare two methods and explain when each is useful'],
  ['FAQ', 'answer the questions beginners ask most often'],
  ['Step-by-step tutorial', 'demonstrate a repeatable process'],
  ['Practice set', 'give three practice prompts with a clear solution'],
  ['Real-life use', 'connect the topic to a practical everyday example'],
  ['Recap', 'recap key takeaways and preview the next lesson']
];
const plannerHooks = [
  'Most beginners miss this part of {topic}—let’s make it simple.',
  'Can you solve this {topic} challenge before the answer appears?',
  'In under a minute, understand one useful idea about {topic}.',
  'Stop and check this common misunderstanding about {topic}.',
  'Here is a step-by-step way to approach {topic}.'
];
function safeText(value) { return String(value || '').trim(); }
function buildPlannerPlan(niche, audience, days, format) {
  const result = [];
  for (let i=0;i<days;i++) {
    const [angle, brief] = plannerTopics[i % plannerTopics.length];
    const type = format === 'shorts' ? 'Short' : format === 'long' ? 'Long video' : (i % 3 === 0 ? 'Long video' : 'Short');
    const topic = niche + ': ' + angle;
    const title = type === 'Short'
      ? niche + ' in 60 Seconds: ' + angle
      : niche + ' ' + angle + ' | Step-by-Step Guide';
    const hook = plannerHooks[i % plannerHooks.length].replaceAll('{topic}', niche.toLowerCase());
    const cta = i % 2 ? 'Ask viewers to comment with their question or attempt.' : 'Invite viewers to save the lesson and watch the next related video.';
    result.push({day:i+1,format:type,topic,title,hook,brief:brief[0].toUpperCase()+brief.slice(1)+'.',audience:audience || 'Your target viewers',cta});
  }
  return result;
}
function renderPlannerPlan(plan) {
  const target=document.querySelector('#planner-results'); target.replaceChildren();
  plan.forEach(item=>{
    const card=document.createElement('div'); card.className='card';
    const heading=document.createElement('strong'); heading.textContent='Day '+item.day+' · '+item.format;
    const title=document.createElement('p'); title.textContent='Title: '+item.title;
    const hook=document.createElement('p'); hook.textContent='Hook: '+item.hook;
    const brief=document.createElement('p'); brief.textContent='Core idea: '+item.brief;
    const cta=document.createElement('p'); cta.textContent='CTA: '+item.cta;
    card.append(heading,title,hook,brief,cta); target.append(card);
  });
}
if (plannerForm) {
  try {
    const saved=JSON.parse(localStorage.getItem('ytcc_content_plan') || '[]');
    if(Array.isArray(saved) && saved.length){latestPlan=saved;renderPlannerPlan(saved);document.querySelector('#planner-copy').disabled=false;document.querySelector('#planner-csv').disabled=false;}
  } catch {}
  plannerForm.addEventListener('submit',event=>{
    event.preventDefault();
    const niche=safeText(document.querySelector('#planner-niche').value);
    const audience=safeText(document.querySelector('#planner-audience').value);
    const days=Number(document.querySelector('#planner-frequency').value);
    const format=document.querySelector('#planner-format').value;
    if(!niche){showNotice('Enter your channel niche or topic first.','error');return;}
    latestPlan=buildPlannerPlan(niche,audience,days,format);
    renderPlannerPlan(latestPlan);
    try{localStorage.setItem('ytcc_content_plan',JSON.stringify(latestPlan));}catch{}
    document.querySelector('#planner-copy').disabled=false;document.querySelector('#planner-csv').disabled=false;
    showNotice(days+'-day content plan created and saved on this device. These are planning drafts, not live trend guarantees.','success');
  });
  document.querySelector('#planner-copy').addEventListener('click',async()=>{
    const text=latestPlan.map(p=>['Day '+p.day+' — '+p.format,p.title,'Hook: '+p.hook,'Core idea: '+p.brief,'CTA: '+p.cta].join('\n')).join('\n\n');
    try{await navigator.clipboard.writeText(text);showNotice('Content plan copied.','success');}catch{showNotice('Clipboard unavailable; select and copy the plan text.','error');}
  });
  document.querySelector('#planner-csv').addEventListener('click',()=>{
    const esc=v=>'"'+String(v).replaceAll('"','""')+'"';
    const csv=[['Day','Format','Topic','Title','Hook','Core idea','Audience','CTA'],...latestPlan.map(p=>[p.day,p.format,p.topic,p.title,p.hook,p.brief,p.audience,p.cta])].map(row=>row.map(esc).join(',')).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a');a.href=url;a.download='youtube-content-plan.csv';a.click();URL.revokeObjectURL(url);
    showNotice('CSV export prepared.','success');
  });
}
const scriptForm=document.querySelector('#script-form');
if(scriptForm) scriptForm.addEventListener('submit',event=>{
  event.preventDefault();
  const topic=safeText(document.querySelector('#script-topic').value);
  const tone=safeText(document.querySelector('#script-tone').value)||'clear, friendly language';
  const type=document.querySelector('#script-type').value;
  const content=type==='short'
    ? 'SHORT VIDEO SCRIPT DRAFT — '+topic+'\n\n[0–3 sec | HOOK]\n'+topic+' can be easier than it looks. Here is the key idea.\n\n[3–12 sec | CONTEXT]\nToday we will explain '+topic+' in '+tone+'.\n\n[12–40 sec | MAIN VALUE]\nStep 1: Explain the basic concept in one simple sentence.\nStep 2: Demonstrate one accurate example on screen.\nStep 3: Point out one common mistake and show the correction.\n\n[40–55 sec | RECAP]\nRemember: explain the main rule, show the example, and check the result.\n\n[55–60 sec | CTA]\nWhat part should be explained next? Leave a specific question in the comments.\n\nEDITOR NOTE: Replace generic steps with verified facts/examples before recording.'
    : 'LONG VIDEO SCRIPT OUTLINE — '+topic+'\n\n[0:00–0:20 | OPENING HOOK]\nShow the problem/result first. Promise a specific, realistic learning outcome for '+topic+'.\n\n[0:20–0:50 | INTRODUCTION]\nWelcome viewers. Explain who this lesson is for and why '+topic+' matters. Tone: '+tone+'.\n\n[0:50–1:40 | FOUNDATION]\nDefine the key terms in simple language. Use a visual or on-screen example.\n\n[1:40–3:30 | STEP-BY-STEP DEMONSTRATION]\nTeach the method in numbered steps. Show each step clearly and explain why it works. Insert a verified worked example.\n\n[3:30–4:30 | COMMON MISTAKE]\nShow a likely mistake, explain why it happens, and correct it.\n\n[4:30–5:20 | PRACTICE + RECAP]\nAsk one practice question, give viewers a moment to think, then reveal the verified answer. Summarize three takeaways.\n\n[5:20–5:40 | CLOSE]\nAsk one specific comment question and point to the next related lesson.\n\nEDITOR NOTE: This is a structure draft, not a fact-checked finished script. Add real examples, sources, and your own explanation.';
  const target=document.querySelector('#script-results');target.replaceChildren();
  const card=document.createElement('div');card.className='card';
  const area=document.createElement('textarea');area.className='text-input';area.rows=type==='short'?14:20;area.value=content;
  const copy=document.createElement('button');copy.className='btn';copy.textContent='Copy script';
  copy.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(area.value);showNotice('Script draft copied.','success');}catch{area.select();showNotice('Select and copy the script manually.');}});
  card.append(area,copy);target.append(card);
  showNotice('Script draft created. Add verified examples and your own details before publishing.','success');
});

const videoGalleryInput=document.querySelector('#video-gallery-file');
if(videoGalleryInput) videoGalleryInput.addEventListener('change',()=>{
  const file=videoGalleryInput.files[0];
  const preview=document.querySelector('#video-gallery-preview');
  const meta=document.querySelector('#video-gallery-meta');
  if(!file) return;
  if(!file.type.startsWith('video/')) { preview.hidden=true; meta.textContent='Please choose a video file from Gallery or Files.'; return; }
  const oldUrl=preview.dataset.objectUrl;
  if(oldUrl) URL.revokeObjectURL(oldUrl);
  const url=URL.createObjectURL(file);
  preview.dataset.objectUrl=url; preview.src=url; preview.hidden=false;
  meta.textContent=file.name+' · '+(file.size/1024/1024).toFixed(1)+' MB · Ready to upload privately';
});

const thumbPreviewForm=document.querySelector('#thumbnail-preview-form');
if(thumbPreviewForm) {
  thumbPreviewForm.addEventListener('change',()=>{
    const file=document.querySelector('#thumbnail-preview-file').files[0];
    const image=document.querySelector('#thumbnail-preview'); const meta=document.querySelector('#thumbnail-preview-meta');
    if(!file) return;
    if(!['image/jpeg','image/png'].includes(file.type)||file.size>2*1024*1024){image.hidden=true;meta.textContent='Choose a JPEG or PNG image no larger than 2 MB.';return;}
    const oldUrl=image.dataset.objectUrl;
    if(oldUrl) URL.revokeObjectURL(oldUrl);
    const url=URL.createObjectURL(file); image.dataset.objectUrl=url; image.src=url; image.hidden=false;
    const probe=new Image(); probe.onload=()=>{meta.textContent=probe.naturalWidth+' × '+probe.naturalHeight+' px · '+(file.size/1024).toFixed(0)+' KB'+(probe.naturalWidth===1280&&probe.naturalHeight===720?' · Recommended dimensions':' · Consider using 1280 × 720');}; probe.src=url;
  });
  thumbPreviewForm.addEventListener('submit',async event=>{
    event.preventDefault();
    const file=document.querySelector('#thumbnail-preview-file').files[0];
    const videoId=document.querySelector('#thumbnail-video-id').value.trim();
    const meta=document.querySelector('#thumbnail-preview-meta');
    if(!file){showNotice('Choose a thumbnail photo from Gallery first.','error');return;}
    if(!videoId){showNotice('Enter a video ID. Open My Videos and copy the video ID for the video you want to update.','error');return;}
    if(!['image/jpeg','image/png'].includes(file.type)||file.size>2*1024*1024){showNotice('Choose a JPEG or PNG image no larger than 2 MB.','error');return;}
    const probe=await new Promise(resolve=>{
      const img=new Image(); img.onload=()=>resolve({width:img.naturalWidth,height:img.naturalHeight}); img.onerror=()=>resolve(null);
      img.src=URL.createObjectURL(file);
    });
    if(!probe){showNotice('The selected photo could not be read. Choose another image.','error');return;}
    if(probe.width<640||probe.height<360){showNotice('Thumbnail must be at least 640 × 360 pixels. 1280 × 720 is recommended.','error');return;}
    if(!confirm('Apply this selected thumbnail to YouTube video '+videoId+'?')) return;
    const button=thumbPreviewForm.querySelector('button[type="submit"]');
    button.disabled=true; button.textContent='Applying thumbnail…';
    try{
      const body=new FormData(); body.append('file',file);
      await api('/api/videos/'+encodeURIComponent(videoId)+'/thumbnail',{method:'POST',body});
      showNotice('YouTube confirmed the thumbnail update.','success');
      meta.textContent=probe.width+' × '+probe.height+' px · Applied successfully';
    }catch(error){showNotice(error.message,'error');}
    finally{button.disabled=false;button.textContent='Apply thumbnail to YouTube video';}
  });
}

if (new URLSearchParams(location.search).has('oauth')) {
  const result = new URLSearchParams(location.search).get('oauth');
  showNotice(result === 'connected' ? 'Google authorization callback completed. Checking channel status…' : 'Google authorization was cancelled.', result === 'connected' ? 'success' : 'info');
  history.replaceState({}, '', location.pathname);
}
loadConnectionStatus();
