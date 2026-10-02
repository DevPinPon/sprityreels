import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ArrowRight, Clock, FileVideo, Film, Link2, Trash2, UploadCloud, X } from 'lucide-react';
import type { ClipRights, ClipSource } from '../../engine/clips/types';
import { handoff } from '../handoff';
import { clipsAPI, message, uploadClipSource } from './api';
import type { Overview } from './api';
import { Banner, Bar, Spinner, bytes, clock, keepFor, upTo } from './ui';

const RIGHTS: { id: ClipRights; title: string; hint: string }[] = [
  { id: 'own', title: 'It’s mine', hint: 'My own content' },
  { id: 'permission', title: 'I have permission', hint: 'From the creator, or an official clipping program' },
  { id: 'license', title: 'It’s licensed', hint: 'Licensed or Creative Commons, with credit' },
  { id: 'commentary', title: 'Commentary or news', hint: 'I judge fair use myself' },
];
const LINK = /^https?:\/\/\S+\.\S+/i;

type Props = { overview: Overview | null; initialLink: string; onStarted: (sourceId: string) => void; onOpen: (sourceId: string) => void; onChanged: () => void };

export default function AddVideo({ overview, initialLink, onStarted, onOpen, onChanged }: Props) {
  const linkOk = overview ? overview.tools.linkImport : true;
  const [mode, setMode] = useState<'link' | 'file'>(handoff.file || !linkOk ? 'file' : 'link');
  const [link, setLink] = useState(initialLink);
  const [file, setFile] = useState<File | null>(handoff.file);
  const [rights, setRights] = useState<ClipRights | ''>('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { handoff.file = null; }, []);
  useEffect(() => { if (overview && !overview.tools.linkImport) setMode('file'); }, [overview]);

  const limit = overview?.limits.uploadBytes ?? 0;
  const tooBig = !!file && limit > 0 && file.size > limit;
  const ready = !!rights && !busy && !tooBig && (mode === 'link' ? LINK.test(link.trim()) : !!file);
  const choose = (picked?: File | null) => { if (picked) { setFile(picked); setError(''); } };
  const drop = (event: DragEvent) => { event.preventDefault(); setOver(false); choose(event.dataTransfer.files[0]); };

  const start = async () => {
    if (!ready) return;
    setBusy(true); setError('');
    try {
      const started = mode === 'link' ? await clipsAPI<{ source: ClipSource }>('/sources', { url: link.trim(), rights, watch: true }) : await uploadClipSource(file!, rights, '', setProgress);
      onStarted(started.source.id);
    } catch (e) { setError(message(e)); setBusy(false); setProgress(null); }
  };
  const remove = async (source: ClipSource) => {
    if (!window.confirm(`Delete “${source.title}” and its reels? This cannot be undone.`)) return;
    try { await clipsAPI(`/sources/${source.id}/delete`, { confirm: true }); onChanged(); } catch (e) { setError(message(e)); }
  };
  const shortsOf = (id: string) => overview?.shorts.filter(s => s.sourceId === id && s.render?.status === 'done').length ?? 0;

  return (
    <div className="add">
      <section className="panel glass" aria-labelledby="add-title">
        <header className="panel-head"><h1 id="add-title">What are we making reels from?</h1><p>Add a long video and Sprity Reels finds the moments worth posting.</p></header>

        {overview && !overview.tools.ffmpeg && <Banner kind="warn">This server cannot render video yet (FFmpeg is missing), so reels cannot be created until it is installed.</Banner>}
        {overview && !overview.tools.transcription && <Banner kind="warn">Speech recognition is not set up on this server yet, so videos cannot be analysed. (Operator: install whisper.cpp, see the README.)</Banner>}

        {!linkOk && <Banner kind="info">Pasting links is not available on this server yet, so upload the video file instead{initialLink ? ' (your link was not used)' : ''}.</Banner>}

        <div className="tabs" role="tablist" aria-label="How to add the video">
          <button type="button" role="tab" aria-selected={mode === 'link'} disabled={!linkOk || busy} onClick={() => setMode('link')}><Link2 /> Paste a link</button>
          <button type="button" role="tab" aria-selected={mode === 'file'} disabled={busy} onClick={() => setMode('file')}><UploadCloud /> Upload a file</button>
        </div>

        {mode === 'link' ? (
          <div className="source-input">
            <label className="sr-only" htmlFor="link">Video link</label>
            <div className="link-field glass flat"><Link2 aria-hidden="true" /><input id="link" className="bare" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://www.youtube.com/watch?v=…" value={link} disabled={busy} onChange={e => setLink(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void start(); }} />{link && !busy && <button type="button" className="icon-btn" aria-label="Clear the link" onClick={() => setLink('')}><X /></button>}</div>
            <p className="help">Public videos from YouTube, Vimeo, TikTok, Twitch, X, Instagram and Facebook can be pasted. Sprity Reels never signs in to a site, so private, members-only or age-restricted videos need to be uploaded.</p>
          </div>
        ) : (
          <div className="source-input">
            <div className={`drop${over ? ' over' : ''}${file ? ' has' : ''}`} role="button" tabIndex={0} aria-label="Choose a video file" onClick={() => !busy && input.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }} onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
              <input ref={input} type="file" hidden accept="video/*,.mkv,.mov,.m4v,.avi,.webm" onChange={e => { choose(e.target.files?.[0]); e.target.value = ''; }} />
              {file ? (
                <div className="file-card"><span className="icon-tile"><FileVideo /></span><div><b>{file.name}</b><small>{bytes(file.size)}</small></div>{!busy && <button type="button" className="icon-btn" aria-label="Remove the file" onClick={e => { e.stopPropagation(); setFile(null); }}><X /></button>}</div>
              ) : (
                <><span className="icon-tile big"><UploadCloud /></span><b>Drop your video here</b><span className="muted">or <u>browse your files</u></span><small>MP4, MOV, MKV, WebM{limit ? ` · up to ${bytes(limit)}` : ''}</small></>
              )}
            </div>
            {tooBig && <Banner kind="error">This file is {bytes(file!.size)}. The limit is {bytes(limit)}. Trim it first, or paste a link instead.</Banner>}
          </div>
        )}

        <fieldset className="rights" disabled={busy}>
          <legend>Do you have the right to use this video?</legend>
          <div className="rights-grid" role="radiogroup" aria-label="Your basis for using this video">
            {RIGHTS.map(r => (
              <label key={r.id} className={`right${rights === r.id ? ' on' : ''}`}>
                <input type="radio" name="rights" value={r.id} checked={rights === r.id} onChange={() => setRights(r.id)} />
                <b>{r.title}</b><small>{r.hint}</small>
              </label>
            ))}
          </div>
          <p className="help">For other people’s videos we add a credit line and keep the original link in the post text. Publishing decisions stay with you.</p>
        </fieldset>

        {error && <Banner kind="error">{error}</Banner>}
        {busy && progress !== null && <div className="upload-progress"><Bar value={progress} label="Upload progress" /><span>{progress < 1 ? `Uploading… ${Math.round(progress * 100)}%` : 'Upload finished. Getting started…'}</span></div>}
        <button type="button" className="btn big" disabled={!ready} onClick={() => void start()}>{busy ? <><Spinner /> Starting…</> : <>Find my best moments <ArrowRight /></>}</button>
        {!rights && <p className="help center">Choose how you’re allowed to use the video to continue.</p>}
        {overview && overview.limits.minutesPerDay > 0 && <p className="help center">{overview.limits.minutesLeft === 0 ? `You have used today’s ${overview.limits.minutesPerDay} minutes of video. They come back at midnight UTC.` : `You can add ${upTo(overview.limits.minutesLeft ?? overview.limits.minutesPerDay)} more of video today.`}</p>}
        <p className="help center">Videos up to {upTo(overview?.limits.maxVideoMinutes ?? 360)} long. Frames taken from your video for analysis are deleted as soon as your reels are ready.{overview && overview.limits.retentionHours > 0 ? ` Your videos and reels are kept for ${keepFor(overview.limits.retentionHours)} after your last visit, so download what you need.` : ''}</p>
      </section>

      {overview && overview.sources.length > 0 && (
        <section className="recent" aria-labelledby="recent-title">
          <h2 id="recent-title">Your videos</h2>
          <div className="recent-grid">
            {overview.sources.map(s => (
              <article className="recent-card glass flat" key={s.id}>
                <button type="button" className="recent-open" onClick={() => onOpen(s.id)} aria-label={`Open ${s.title}`}>
                  <span className="icon-tile"><Film /></span>
                  <span className="recent-text"><b>{s.title}</b>
                    <small><Clock /> {s.duration ? clock(s.duration) : '…'} · {s.status === 'working' ? 'Analysing' : s.status === 'failed' ? 'Needs attention' : shortsOf(s.id) ? `${shortsOf(s.id)} reel${shortsOf(s.id) === 1 ? '' : 's'}` : 'Ready'}</small></span>
                </button>
                <button type="button" className="icon-btn" aria-label={`Delete ${s.title}`} onClick={() => void remove(s)}><Trash2 /></button>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
