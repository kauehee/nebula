'use strict';

import express from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import youtubedl from 'youtube-dl-exec';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const YTDLP = youtubedl.constants.YOUTUBE_DL_PATH;

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = fileURLToPath(new URL('.', import.meta.url));

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(ROOT, 'public')));

const jobs = new Map();
const MAX_CONCURRENT = 3;
const queue = [];
let running = 0;

const VIDEO_QUALITIES = ['2160', '1440', '1080', '720', '480', '360'];
const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'ogg', 'wav'];
const JOB_TTL_MS = 30 * 60 * 1000;

function parseUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

function isSoundCloud(u) {
  return /(^|\.)soundcloud\.com$/i.test(u.hostname);
}

function isBandcamp(u) {
  return /(^|\.)bandcamp\.com$/i.test(u.hostname);
}

function contentDisposition(name) {
  const fallback = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function buildArgs(flags) {
  const out = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === undefined || value === null || value === false) continue;
    const flag = `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
    if (value === true) out.push(flag);
    else out.push(flag, String(value));
  }
  return out;
}

function runYtDlp(flags, url, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [...buildArgs(flags), '--', url], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      if (onStdout) onStdout(d);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const last = stderr.trim().split('\n').filter(Boolean).pop();
        const err = new Error(last || `yt-dlp encerrou com código ${code}`);
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function snapshot(job) {
  return {
    status: job.status,
    progress: Math.round(job.progress),
    stage: job.stage,
    error: job.error,
    filename: job.filename,
    fileUrl: job.status === 'done' ? `/api/jobs/${job.id}/file` : null,
  };
}

function emit(job, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of job.clients) {
    try { send(payload); } catch { /* cliente desconectou */ }
  }
}

const jobState = (job) => emit(job, 'state', snapshot(job));

function friendlyError(err) {
  const tail = err && err.stderr
    ? String(err.stderr).split('\n').filter(Boolean).slice(-3).join(' ')
    : '';
  const text = `${err && err.message ? err.message : ''} ${tail}`.toLowerCase();
  if (/go\+|go plus|subscription|sign in|login|age restricted|premium/i.test(text)) {
    return 'Este conteúdo exige assinatura ou login (ex.: faixas Go+ do SoundCloud) e não pode ser baixado.';
  }
  if (/not available|unavailable|removed|private|deleted|forbidden|404/i.test(text)) {
    return 'Este conteúdo não está disponível (pode ser privado, removido ou bloqueado por região).';
  }
  if (/unsupported url/i.test(text)) return 'URL não suportada.';
  if (/impersonat|curl_cffi|client challenge/i.test(text)) {
    return 'Este site bloqueia servidores de datacenter. Abra o link original no navegador para baixar direto.';
  }
  if (/geo|copyright|country/i.test(text)) return 'Conteúdo bloqueado na sua região.';
  return tail ? `Erro no download: ${tail.slice(0, 400)}` : 'Falha ao processar o link. Tente novamente.';
}

async function processJob(job) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-'));
  job.dir = tmpDir;
  try {
    const { url, type, format, quality, filenameStyle } = job.opts;
    const isSC = isSoundCloud(new URL(url));
    const args = {
      noWarnings: true,
      noPlaylist: true,
      newline: true,
      output: path.join(tmpDir, 'media.%(ext)s'),
      ffmpegLocation: ffmpegPath,
      print: 'after_move:filepath',
      progressTemplate: 'progress:%(progress._percent_str)s',
    };

    let filenameExt;
    if (type === 'audio') {
      if (isSC) {
        // MP3 nativo do SoundCloud (128 kbps, sem reconversão)
        if (format === 'mp3' || format === 'mp3-320') {
          args.format = 'http_mp3_128/bestaudio';
          filenameExt = format === 'mp3-320' ? 'mp3' : '%(ext)s';
        } else {
          args.format = 'bestaudio';
          filenameExt = '%(ext)s';
        }
      } else if (format === 'best') {
        args.format = 'bestaudio/best';
        filenameExt = '%(ext)s';
      } else {
        args.extractAudio = true;
        args.audioFormat = format;
        if (format === 'mp3') args.audioQuality = 0;
        filenameExt = format;
      }
    } else {
      const h = quality === 'best' ? '' : `[height<=${quality}]`;
      args.format = `bestvideo${h}+bestaudio/best${h}/best`;
      args.mergeOutputFormat = 'mp4';
      filenameExt = 'mp4';
    }

    const templates = {
      basic: `%(title)s [%(id)s].${filenameExt}`,
      pretty: `%(uploader)s - %(title)s [%(id)s].${filenameExt}`,
      nerdy: `%(title)s (%(id)s) [${type === 'audio' ? '%(abr)s' : '%(resolution)s'}].${filenameExt}`,
    };
    args.output = path.join(tmpDir, templates[filenameStyle] || templates.pretty);

    job.stage = 'baixando';
    jobState(job);

    let finalPath = '';
    const { stdout } = await runYtDlp(args, url, {
      onStdout: (chunk) => {
        for (const line of chunk.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          if (t.startsWith('progress:')) {
            const p = parseFloat(t.slice('progress:'.length));
            if (Number.isFinite(p)) {
              job.progress = Math.min(99, p);
              jobState(job);
            }
          } else if (/\[(ExtractAudio|Merger|FixupM4a|FixupM3u8|Metadata)\]/i.test(t)) {
            job.stage = 'convertendo';
            jobState(job);
          } else if (!t.startsWith('[')) {
            finalPath = t;
          }
        }
      },
    });

    let outPath = String(stdout)
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('progress:') && !s.startsWith('['))
      .pop() || finalPath;
    if (!outPath || !fs.existsSync(outPath)) {
      throw new Error('O arquivo final não foi encontrado após o processamento.');
    }
    if (job.opts.type === 'audio' && isSC) {
      // Garante MP3 de verdade: 320 kbps forçado, ou o stream nativo quando já é MP3
      const wantMp3 = job.opts.format === 'mp3' || job.opts.format === 'mp3-320';
      const isMp3File = outPath.toLowerCase().endsWith('.mp3');
      if (wantMp3 && (job.opts.format === 'mp3-320' || !isMp3File)) {
        job.stage = 'convertendo';
        jobState(job);
        const tmpOut = path.join(tmpDir, 'converted.mp3');
        const ffArgs = ['-y', '-i', outPath, '-codec:a', 'libmp3lame'];
        if (job.opts.format === 'mp3-320') ffArgs.push('-b:a', '320k');
        else ffArgs.push('-q:a', '0');
        ffArgs.push(tmpOut);
        await execFileAsync(ffmpegPath, ffArgs);
        fs.unlinkSync(outPath);
        const target = isMp3File ? outPath : `${outPath.replace(/\.[^.]+$/, '')}.mp3`;
        fs.renameSync(tmpOut, target);
        outPath = target;
      }
    }
    job.file = outPath;
    job.filename = path.basename(outPath);
    job.progress = 100;
    job.stage = 'concluído';
    job.status = 'done';
    job.finishedAt = Date.now();
    jobState(job);
  } catch (err) {
    job.status = 'error';
    job.error = friendlyError(err);
    job.finishedAt = Date.now();
    jobState(job);
  }
}

function pump() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    job.status = 'working';
    job.stage = 'preparando';
    jobState(job);
    processJob(job).finally(() => {
      running -= 1;
      pump();
    });
  }
}

function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'done' || job.status === 'error') && now - (job.finishedAt || 0) > JOB_TTL_MS) {
      jobs.delete(id);
      if (job.dir) fs.rm(job.dir, { recursive: true, force: true }, () => {});
    }
  }
}

app.post('/api/info', async (req, res) => {
  const u = parseUrl(req.body && req.body.url);
  if (!u) return res.status(400).json({ error: 'Cole um link válido (http ou https).' });
  try {
    const { stdout } = await runYtDlp({
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      skipDownload: true,
    }, u.href);
    const info = JSON.parse(stdout);
    if (info.is_live) {
      return res.status(422).json({ error: 'Transmissões ao vivo não são suportadas.' });
    }
    if ((info.playlist_count || 0) > 1) {
      return res.status(422).json({ error: `Esse link é uma playlist com ${info.playlist_count} itens. Cole o link de uma faixa ou vídeo individual.` });
    }
    const sc = isSoundCloud(u);
    res.json({
      title: info.title || 'Sem título',
      uploader: info.uploader || info.channel || info.creator || null,
      duration: Number.isFinite(info.duration) ? info.duration : null,
      thumbnail: info.thumbnail || info.artwork_url || null,
      webpageUrl: info.webpage_url || u.href,
      soundcloud: sc,
      bandcamp: isBandcamp(u),
      audioFormats: sc ? ['mp3-320', 'mp3', 'best'] : AUDIO_FORMATS,
      videoQualities: sc ? [] : VIDEO_QUALITIES,
    });
  } catch (err) {
    if (isBandcamp(u)) {
      return res.status(422).json({
        error: friendlyError(err),
        bandcamp: true,
        webpageUrl: u.href,
      });
    }
    res.status(422).json({ error: friendlyError(err) });
  }
});

app.post('/api/download', (req, res) => {
  const body = req.body || {};
  const u = parseUrl(body.url);
  if (!u) return res.status(400).json({ error: 'Link inválido.' });
  const type = body.type;
  if (type !== 'audio' && type !== 'video') {
    return res.status(400).json({ error: 'Tipo inválido.' });
  }
  const isSC = isSoundCloud(u);
  if (type === 'video' && isSC) {
    return res.status(400).json({ error: 'O SoundCloud não possui vídeos.' });
  }
  if (type === 'audio') {
    const valid = isSC ? ['mp3-320', 'mp3', 'best'] : ['best', ...AUDIO_FORMATS];
    if (!valid.includes(body.format)) {
      return res.status(400).json({ error: 'Formato de áudio inválido.' });
    }
  }
  if (type === 'video' && !['best', ...VIDEO_QUALITIES].includes(body.quality)) {
    return res.status(400).json({ error: 'Qualidade de vídeo inválida.' });
  }
  sweep();
  const job = {
    id: crypto.randomUUID(),
    status: 'queued',
    progress: 0,
    stage: null,
    error: null,
    file: null,
    filename: null,
    dir: null,
    finishedAt: null,
    cleaned: false,
    clients: new Set(),
    opts: {
      url: u.href,
      type,
      format: type === 'audio' ? (body.format || 'mp3') : null,
      quality: type === 'video' ? (body.quality || 'best') : null,
      filenameStyle: ['basic', 'pretty', 'nerdy'].includes(body.filenameStyle) ? body.filenameStyle : 'pretty',
    },
  };
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  res.json({ jobId: job.id });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Tarefa não encontrada.' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  const send = (payload) => res.write(payload);
  job.clients.add(send);
  send(`event: state\ndata: ${JSON.stringify(snapshot(job))}\n\n`);
  req.on('close', () => job.clients.delete(send));
});

app.get('/api/jobs/:id/file', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !job.file) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }
  if (!fs.existsSync(job.file)) {
    jobs.delete(job.id);
    return res.status(410).json({ error: 'O arquivo expirou. Gere o download novamente.' });
  }
  const name = job.filename || path.basename(job.file);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(fs.statSync(job.file).size),
    'Content-Disposition': contentDisposition(name),
  });
  const stream = fs.createReadStream(job.file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  res.on('finish', () => cleanupJob(job));
  res.on('close', () => {
    if (!res.writableEnded) {
      stream.destroy();
      cleanupJob(job);
    }
  });
});

function cleanupJob(job) {
  if (job.cleaned) return;
  job.cleaned = true;
  setTimeout(() => {
    jobs.delete(job.id);
    if (job.dir) fs.rm(job.dir, { recursive: true, force: true }, () => {});
  }, 5000);
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Keep-alive: pinga a própria URL pública para evitar hibernação do Render.
// Definir KEEPALIVE_URL no painel do Render (ex.: https://seu-app.onrender.com).
const KEEPALIVE_URL = process.env.KEEPALIVE_URL || '';
const KEEPALIVE_INTERVAL_MS = Number(process.env.KEEPALIVE_INTERVAL_MS) || 10 * 60 * 1000;
if (KEEPALIVE_URL) {
  const ping = () => {
    fetch(`${KEEPALIVE_URL.replace(/\/$/, '')}/health`)
      .then((r) => console.log(`keep-alive: ${r.status}`))
      .catch((e) => console.error('keep-alive falhou:', e.message));
  };
  setInterval(ping, KEEPALIVE_INTERVAL_MS);
  setTimeout(ping, 30 * 1000);
  console.log(`keep-alive ativo: ${KEEPALIVE_URL} a cada ${KEEPALIVE_INTERVAL_MS / 60000} min`);
}

app.listen(PORT, () => {
  console.log(`nébula rodando em http://localhost:${PORT}`);
  // mantém o yt-dlp atualizado (falha silenciosa se offline ou sem permissão)
  const updater = spawn(YTDLP, ['-U'], { windowsHide: true });
  updater.on('error', () => {});
});
