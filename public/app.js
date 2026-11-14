const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const clearBtn = document.getElementById('clear');
const pasteBtn = document.getElementById('paste');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');
const thumbEl = document.getElementById('thumb');
const thumbFallback = document.getElementById('thumb-fallback');
const titleEl = document.getElementById('title');
const metaLine = document.getElementById('meta-line');
const bcLink = document.getElementById('bc-link');
const bcNote = document.getElementById('bc-note');
const tabsEl = document.getElementById('tabs');
const fieldFormat = document.getElementById('field-format');
const fieldQuality = document.getElementById('field-quality');
const formatSel = document.getElementById('format');
const qualitySel = document.getElementById('quality');
const styleSel = document.getElementById('filenameStyle');
const scNote = document.getElementById('sc-note');
const downloadBtn = document.getElementById('download');
const progressEl = document.getElementById('progress');
const barFill = document.getElementById('bar-fill');
const stageEl = document.getElementById('stage');
const percentEl = document.getElementById('percent');
const doneEl = document.getElementById('done');
const againBtn = document.getElementById('again');

const FORMAT_LABELS = {
  mp3: 'MP3 · alta qualidade',
  m4a: 'M4A',
  opus: 'OPUS',
  ogg: 'OGG',
  wav: 'WAV',
  best: 'melhor disponível',
};
const SC_FORMAT_LABELS = {
  'mp3-320': 'MP3 · 320 kbps (convertido)',
  mp3: 'MP3 (melhor da fonte)',
  best: 'melhor disponível (original)',
};
const QUALITY_LABELS = {
  best: 'melhor',
  2160: '2160p (4K)',
  1440: '1440p (2K)',
  1080: '1080p',
  720: '720p',
  480: '480p',
  360: '360p',
};
const STAGE_LABELS = {
  queued: 'na fila',
  working: 'preparando',
  baixando: 'baixando',
  convertendo: 'convertendo',
  'concluído': 'concluído',
};

let info = null;
let currentUrl = null;
let currentType = 'audio';
let eventSource = null;

const hide = (el) => { el.hidden = true; };
const show = (el) => { el.hidden = false; };

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function setStatus(visible, text) {
  statusEl.hidden = !visible;
  if (text) statusText.textContent = text;
}

function showError(msg) {
  errorEl.textContent = msg;
  show(errorEl);
}

function clearError() { hide(errorEl); }

function closeEventSource() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function updateScNote() {
  scNote.hidden = !(
    info && info.soundcloud &&
    currentType === 'audio' &&
    formatSel.value === 'mp3-320'
  );
}

function applyType() {
  for (const b of tabsEl.querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.type === currentType);
  }
  fieldFormat.hidden = currentType !== 'audio';
  fieldQuality.hidden = currentType !== 'video';
  updateScNote();
}

async function fetchInfo() {
  const url = urlInput.value.trim();
  if (!url) return;
  currentUrl = url;
  closeEventSource();
  hide(resultEl);
  hide(doneEl);
  hide(progressEl);
  clearError();
  setStatus(true, 'buscando informações…');
  try {
    const r = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (data.bandcamp) {
        renderBandcampFallback(data);
        return;
      }
      throw new Error(data.error || 'Erro ao buscar informações.');
    }
    renderResult(data);
  } catch (err) {
    setStatus(false);
    showError(err.message);
  }
}

function renderBandcampFallback(data) {
  info = null;
  setStatus(false);
  clearError();

  hide(thumbEl);
  show(thumbFallback);
  titleEl.textContent = 'Bandcamp';
  metaLine.textContent = data.error || '';

  bcLink.textContent = 'abrir página original no Bandcamp ↗';
  bcLink.href = data.webpageUrl || currentUrl;
  bcLink.target = '_blank';
  bcLink.rel = 'noopener';
  show(bcLink);
  bcNote.hidden = false;

  hide(tabsEl);
  hide(downloadBtn);
  hide(progressEl);
  hide(doneEl);
  show(resultEl);
}

function renderResult(data) {
  info = data;
  setStatus(false);
  clearError();

  if (data.thumbnail) {
    thumbEl.src = data.thumbnail;
    show(thumbEl);
    hide(thumbFallback);
  } else {
    hide(thumbEl);
    show(thumbFallback);
  }
  thumbEl.onerror = () => { hide(thumbEl); show(thumbFallback); };

  titleEl.textContent = data.title;
  const parts = [data.uploader, fmtDuration(data.duration)].filter(Boolean);
  metaLine.textContent = parts.join(' · ');

  if (data.soundcloud) {
    const q = encodeURIComponent([data.uploader, data.title].filter(Boolean).join(' '));
    bcLink.textContent = 'buscar 320/WAV no Bandcamp ↗';
    bcLink.href = `https://bandcamp.com/search?q=${q}`;
    show(bcLink);
  } else if (data.bandcamp) {
    bcLink.textContent = 'abrir página original no Bandcamp ↗';
    bcLink.href = data.webpageUrl || currentUrl;
    show(bcLink);
  } else {
    hide(bcLink);
  }
  bcNote.hidden = !data.bandcamp;

  tabsEl.hidden = data.soundcloud;
  currentType = data.soundcloud ? 'audio' : 'video';

  formatSel.innerHTML = '';
  for (const f of data.audioFormats) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = (data.soundcloud ? SC_FORMAT_LABELS : FORMAT_LABELS)[f] || f;
    formatSel.appendChild(opt);
  }
  formatSel.value = data.soundcloud ? 'mp3-320' : 'mp3';

  qualitySel.innerHTML = '';
  for (const q of data.videoQualities) {
    const opt = document.createElement('option');
    opt.value = q;
    opt.textContent = QUALITY_LABELS[q] || q;
    qualitySel.appendChild(opt);
  }
  qualitySel.value = 'best';

  applyType();
  hide(progressEl);
  hide(doneEl);
  show(downloadBtn);
  show(resultEl);
}

function updateProgress(s) {
  const pct = Math.round(s.progress || 0);
  barFill.style.width = `${pct}%`;
  stageEl.textContent = STAGE_LABELS[s.stage] || s.stage || 'processando';
  if (s.status === 'queued') percentEl.textContent = '…';
  else if (s.status === 'done') percentEl.textContent = '100%';
  else percentEl.textContent = `${pct}%`;
}

function triggerDownload(fileUrl) {
  const a = document.createElement('a');
  a.href = fileUrl;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function onJobState(e) {
  const s = JSON.parse(e.data);
  updateProgress(s);
  if (s.status === 'done') {
    closeEventSource();
    show(doneEl);
    triggerDownload(s.fileUrl);
  } else if (s.status === 'error') {
    closeEventSource();
    hide(progressEl);
    showError(s.error || 'Falha no download.');
    show(downloadBtn);
  }
}

async function startDownload() {
  if (!info || !currentUrl) return;
  closeEventSource();
  hide(downloadBtn);
  hide(doneEl);
  hide(progressEl);
  clearError();
  const payload = {
    url: currentUrl,
    type: currentType,
    filenameStyle: styleSel.value,
    format: currentType === 'audio' ? formatSel.value : undefined,
    quality: currentType === 'video' ? qualitySel.value : undefined,
  };
  try {
    const r = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Erro ao iniciar o download.');
    show(progressEl);
    updateProgress({ status: 'queued', progress: 0, stage: 'queued' });
    eventSource = new EventSource(`/api/jobs/${data.jobId}/events`);
    eventSource.addEventListener('state', onJobState);
    eventSource.onerror = () => {
      closeEventSource();
      hide(progressEl);
      showError('Conexão com o servidor perdida. Tente novamente.');
      show(downloadBtn);
    };
  } catch (err) {
    showError(err.message);
    show(downloadBtn);
  }
}

function resetView() {
  closeEventSource();
  info = null;
  currentUrl = null;
  hide(resultEl);
  hide(errorEl);
  hide(doneEl);
  hide(progressEl);
  setStatus(false);
}

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    fetchInfo();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  fetchInfo();
});

urlInput.addEventListener('input', () => {
  clearBtn.hidden = !urlInput.value.trim();
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearBtn.hidden = true;
  resetView();
  urlInput.focus();
});

pasteBtn.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      urlInput.value = text.trim();
      clearBtn.hidden = false;
      form.requestSubmit();
      return;
    }
  } catch { /* área de transferência indisponível */ }
  urlInput.focus();
});

for (const b of tabsEl.querySelectorAll('button')) {
  b.addEventListener('click', () => {
    currentType = b.dataset.type;
    applyType();
  });
}

formatSel.addEventListener('change', updateScNote);
downloadBtn.addEventListener('click', startDownload);
againBtn.addEventListener('click', startDownload);
