import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, RefObject } from 'react';
import { ArrowRight, AudioLines, Captions, Crosshair, Download, Hash, LayoutPanelTop, Link2, Package, Plus, Scissors, ShieldCheck, Sparkles, UploadCloud, Zap } from 'lucide-react';
import { CAPTION_PRESETS } from '../engine/clips/types';
import type { CaptionPresetId } from '../engine/clips/types';
import { CAPTION_PRESET_DEFS } from '../engine/clips/captions';
import { captionStyle, CAPTION_NOTES } from './captionStyle';
import { handoff } from './handoff';
import { spotlight, useReveal, useTilt } from './hooks';
import { Link, navigate } from './router';
import { Backdrop, Logo } from './ui';

const delay = (seconds: number) => ({ '--d': `${seconds}s` }) as CSSProperties;

function Nav() {
  return (
    <header className="nav">
      <div className="nav-in glass">
        <Logo />
        <nav className="nav-links" aria-label="Sections">
          <a href="#how">How it works</a><a href="#features">Features</a><a href="#captions">Captions</a><a href="#layouts">Layouts</a><a href="#faq">FAQ</a>
        </nav>
        <Link to="/app" className="btn sm">Open the studio <ArrowRight /></Link>
      </div>
    </header>
  );
}

/** The link box: it hands the link (or a dropped file) to the studio, which asks for the rights basis and starts. */
function CtaBar({ id }: { id: string }) {
  const [url, setUrl] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); navigate(url.trim() ? `/app?link=${encodeURIComponent(url.trim())}` : '/app'); };
  return (
    <form className="cta-bar glass" onSubmit={submit}>
      <Link2 aria-hidden="true" />
      <input id={id} type="text" inputMode="url" autoComplete="off" spellCheck={false} aria-label="Video link" placeholder="Paste a video link" value={url} onChange={e => setUrl(e.target.value)} />
      <button className="btn" type="submit">Make my reels <ArrowRight /></button>
    </form>
  );
}

const SAMPLE = ['This', 'changes', 'everything'];
function PhoneDemo({ phone }: { phone: RefObject<HTMLDivElement | null> }) {
  const [on, setOn] = useState(0);
  useEffect(() => { const t = setInterval(() => setOn(n => (n + 1) % (SAMPLE.length + 1)), 640); return () => clearInterval(t); }, []);
  const style = captionStyle('pop', 284);
  return (
    <div className="phone" ref={phone} aria-hidden="true">
      <div className="phone-body">
        <div className="screen">
          <div className="scene"><div className="orb" /><div className="figure"><i className="head" /><i className="body" /></div><div className="reticle"><i /><i /><i /><i /></div></div>
          <div className="hook">Nobody tells you this</div>
          <div className="cap">{SAMPLE.map((word, i) => <span key={word} className={on === i + 1 ? 'on' : ''} style={style.word(on === i + 1)}>{word}</span>)}</div>
          <div className="badge"><i /> Following speaker</div>
          <div className="bar"><i /></div>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  const input = useRef<HTMLInputElement>(null);
  const { area, target } = useTilt<HTMLDivElement>();
  const pick = (file?: File) => { if (file) { handoff.file = file; navigate('/app'); } };
  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div>
          <span className="eyebrow glass flat" data-reveal><i className="dot" /> AI reel maker for creators</span>
          <h1 data-reveal style={delay(.06)}>Long videos in.<br /><span className="grad"><span style={{ whiteSpace: 'nowrap' }}>Scroll-stopping</span> reels</span> out.</h1>
          <p className="lede" data-reveal style={delay(.12)}>Paste a link or drop a file. Sprity Reels finds the moments worth posting, frames them with a camera that follows the action, and adds word-perfect captions. You get vertical videos, ready to publish.</p>
          <div data-reveal style={delay(.18)}>
            <CtaBar id="hero-link" />
            <div className="hero-sub">
              <span>or</span>
              <button type="button" onClick={() => input.current?.click()}><UploadCloud /> upload a video file</button>
              <input ref={input} type="file" accept="video/*,.mkv" hidden onChange={e => pick(e.target.files?.[0])} />
            </div>
          </div>
          <div className="sites" data-reveal style={delay(.24)}>{['YouTube', 'Vimeo', 'TikTok', 'Twitch', 'X', 'Instagram', 'Facebook', 'MP4 · MOV · MKV · WebM'].map(s => <span className="chip" key={s}>{s}</span>)}</div>
        </div>
        <div className="hero-visual" ref={area} data-reveal style={delay(.1)}>
          <PhoneDemo phone={target} />
          <div className="float-chip glass c1"><span className="ic"><Sparkles /></span><div><small>AI found</small><b>5 moments</b></div></div>
          <div className="float-chip glass c2"><span className="score"><span>94</span></span><div><small>Virality score</small><b>Strong hook</b></div></div>
          <div className="float-chip glass c3"><span className="ic"><Crosshair /></span><div><small>Camera</small><b>Follows the speaker</b></div></div>
          <div className="float-chip glass c4"><span className="ic"><Captions /></span><div><small>Captions</small><b>Pop, word by word</b></div></div>
        </div>
      </div>
    </section>
  );
}

const STEPS = [
  { icon: Link2, title: 'Drop in your video', text: 'Paste a link from YouTube, Vimeo, TikTok, Twitch, X or Instagram, or upload an MP4, MOV, MKV or WebM. Videos up to six hours are fine.' },
  { icon: Sparkles, title: 'Let the AI find the moments', text: 'It listens to every word, watches the picture and ranks the best moments with a virality score. Each pick is repaired so it makes sense on its own.' },
  { icon: Download, title: 'Download your reels', text: 'Choose the moments you like and a caption style. You get vertical MP4s with captions, hook titles, covers and post text.' },
];
function HowItWorks() {
  return (
    <section className="section" id="how">
      <div className="wrap">
        <div className="section-head" data-reveal><span className="kicker">How it works</span><h2>From one long video to a week of posts</h2><p>Three steps, no editing skills, nothing to install.</p></div>
        <div className="steps">
          {STEPS.map((s, i) => (
            <article className="step glass" key={s.title} data-reveal style={delay(i * .1)}>
              <span className="num" aria-hidden="true">0{i + 1}</span>
              <div className="icon-tile"><s.icon /></div>
              <h3>{s.title}</h3><p>{s.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const FEATURES = [
  { icon: Scissors, title: 'Clips that stand alone', text: 'Every pick is repaired by whole sentences. An answer pulls in its question and a setup gets its payoff, so no clip starts mid-thought.' },
  { icon: AudioLines, title: 'Hears and sees the action', text: 'Highlights come from loud moments and bursts of on-screen motion, so a silent trick shot or a dunk in a muted stream still makes the cut.' },
  { icon: Crosshair, title: 'A camera that follows', text: 'It follows whoever is talking, a group, a ball, a car or a pet. It holds still when it should and glides when it must.' },
  { icon: LayoutPanelTop, title: 'Layouts that fit the scene', text: 'Follow the speaker, split the screen for two to four people, put a face cam over gameplay or a speaker under a shared screen. Auto chooses per shot.' },
  { icon: Captions, title: 'Word-perfect captions', text: 'Eight animated styles, timed to each word and kept clear of faces and the buttons the platforms draw on top.' },
  { icon: Hash, title: 'Hooks, titles and hashtags', text: 'A hook title for the first seconds, plus a post title, description and hashtags for every reel, with credit for other creators.' },
  { icon: ShieldCheck, title: 'Brand-safe sound', text: 'Bleep or mute swear words, cut dead air and filler words, and level every reel to the loudness the platforms expect.' },
  { icon: Zap, title: 'Fast on long videos', text: 'For links it reads captions first, so the first picks can appear within seconds, and it only downloads the parts of the video your reels use.' },
  { icon: Package, title: 'Everything in one download', text: 'MP4, subtitles, cover and post text for each reel, plus one ZIP with a posting sheet for the whole video.' },
];
function Features() {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <div className="section-head" data-reveal><span className="kicker">Features</span><h2>The details that make a reel worth watching</h2><p>Picking the moment is half the job. The other half is how it looks and sounds.</p></div>
        <div className="features">
          {FEATURES.map((f, i) => (
            <article className="feature glass" key={f.title} data-reveal style={delay((i % 3) * .08)} {...spotlight}>
              <div className="icon-tile"><f.icon /></div>
              <h3>{f.title}</h3><p>{f.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const CAPTION_WORDS = ['Make', 'every', 'word', 'count'];
function CaptionShowcase() {
  const [preset, setPreset] = useState<CaptionPresetId>('pop');
  const [on, setOn] = useState(0);
  useEffect(() => { const t = setInterval(() => setOn(n => (n + 1) % (CAPTION_WORDS.length + 1)), 560); return () => clearInterval(t); }, []);
  const stage = captionStyle(preset, 300);
  return (
    <section className="section" id="captions">
      <div className="wrap">
        <div className="section-head" data-reveal><span className="kicker">Captions</span><h2>Eight styles, built to hold attention</h2><p>The same fonts and outlines you see here are what the renderer burns into your video.</p></div>
        <div className="caps">
          <div className="cap-list" data-reveal>
            {CAPTION_PRESETS.map(id => {
              const sample = captionStyle(id, 250).word(true);
              return (
                <button type="button" className="cap-tab" key={id} aria-pressed={preset === id} onClick={() => setPreset(id)}>
                  <span className="cap-sample" style={sample}>{CAPTION_PRESET_DEFS[id].label}</span>
                  <small>{CAPTION_NOTES[id]}</small>
                </button>
              );
            })}
          </div>
          <div className="cap-stage glass" data-reveal style={delay(.1)} aria-label={`${CAPTION_PRESET_DEFS[preset].label} caption style preview`}>
            <div className="scene"><div className="orb" /><div className="figure"><i className="head" /><i className="body" /></div></div>
            <span className="chip violet tag">{CAPTION_PRESET_DEFS[preset].label}</span>
            <div className="caption-line"><span style={stage.line}>{CAPTION_WORDS.map((w, i) => <span key={w} style={stage.word(on === i + 1)}>{w}</span>)}</span></div>
          </div>
        </div>
      </div>
    </section>
  );
}

const LAYOUTS = [
  { id: 'follow', title: 'Follow', text: 'One crop on whoever talks' },
  { id: 'split', title: 'Split screen', text: 'Two to four people' },
  { id: 'gameplay', title: 'Gameplay', text: 'Face cam over the game' },
  { id: 'screen', title: 'Screen share', text: 'The screen over its speaker' },
  { id: 'blur', title: 'Full frame', text: 'Whole picture over blur' },
] as const;
function LayoutFrame({ id }: { id: typeof LAYOUTS[number]['id'] }) {
  const face = <i className="face" />;
  return (
    <div className={`frame ${id}`} aria-hidden="true">
      {id === 'follow' && <div className="pane">{face}<i className="ret" /></div>}
      {id === 'split' && <><div className="pane">{face}</div><div className="pane b">{face}</div></>}
      {id === 'gameplay' && <><div className="pane">{face}</div><div className="pane game" /></>}
      {id === 'screen' && <><div className="pane screenshot" /><div className="pane b">{face}</div></>}
      {id === 'blur' && <div className="pane dim" />}
    </div>
  );
}
function Layouts() {
  return (
    <section className="section" id="layouts">
      <div className="wrap">
        <div className="section-head" data-reveal><span className="kicker">Layouts</span><h2>The shot decides the layout</h2><p>Auto looks at every shot and chooses. You can also pin one layout, or tell the camera what to follow: speakers, people, a ball, vehicles, animals or whatever moves.</p></div>
        <div className="layouts">
          {LAYOUTS.map((l, i) => (
            <article className="layout-card glass" key={l.id} data-reveal style={delay(i * .07)}>
              <LayoutFrame id={l.id} /><h3>{l.title}</h3><p>{l.text}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

const FAQ = [
  { q: 'What can I upload or paste?', a: 'Links from YouTube, Vimeo, TikTok, Twitch, X, Instagram, Facebook and similar sites, or MP4, MOV, M4V, WebM, MKV and AVI files. Private, members-only and age-restricted videos must be downloaded by you and uploaded.' },
  { q: 'How long are the reels?', a: 'You choose: short (15 to 30 seconds), standard (30 to 60) or long (60 to 90). Every reel ends on a complete thought, never in the middle of a sentence.' },
  { q: 'Which formats do I get?', a: 'Vertical 9:16 for TikTok, Instagram Reels and YouTube Shorts, plus 4:5, 1:1 and 16:9. Every reel comes as an MP4 with burned-in captions, a separate subtitle file and a cover image.' },
  { q: 'Do I need the rights to the video?', a: 'Yes. When you add a video you tell us your basis for using it: your own content, creator permission, a licence, or commentary and news. For other people’s content we add a credit line and put the original link in the post text. Publishing decisions stay with you.' },
  { q: 'Does it work for gaming, sports and videos with no talking?', a: 'Yes. It looks for action in the sound and the picture, and follows the ball, the vehicle or the person in shot. It measures how much happens on screen, not what it means, so a replay can look like action and a quiet key moment can be missed.' },
  { q: 'What happens to the frames from my video?', a: 'To find scenes and to follow the speaker, the server looks at still frames of your video. Most are only ever held in memory; the few that must be files live in a temporary folder. All of them are deleted before your reels are marked ready, and also if a step fails or you cancel. Your video and your reels stay in your private workspace until you delete them.' },
  { q: 'Can I change what I get?', a: 'Before rendering you choose which moments to make, the caption style, the format, what the camera follows, the hook title and whether to bleep swear words. You can render the same moment again with other settings as often as you like.' },
];
function Faq() {
  return (
    <section className="section" id="faq">
      <div className="wrap">
        <div className="section-head" data-reveal><span className="kicker">FAQ</span><h2>Good questions</h2></div>
        <div className="faq">
          {FAQ.map((item, i) => (
            <details className="glass flat" key={item.q} data-reveal style={delay(i * .04)}>
              <summary>{item.q}<Plus aria-hidden="true" /></summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="section" id="start">
      <div className="wrap">
        <div className="final glass" data-reveal>
          <h2>Your next reel is <span className="grad">one link</span> away</h2>
          <p>Paste a video, pick your favourite moments and download. It takes a few minutes, not an afternoon.</p>
          <div style={{ marginTop: 34 }}><CtaBar id="final-link" /></div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="foot">
      <div className="wrap">
        <Logo />
        <nav aria-label="Footer"><a href="#how">How it works</a><a href="#features">Features</a><a href="#captions">Captions</a><a href="#faq">FAQ</a><Link to="/app">Studio</Link></nav>
        <span>© {new Date().getFullYear()} Sprity Reels</span>
      </div>
    </footer>
  );
}

export default function Landing() {
  useReveal();
  useEffect(() => { document.title = 'Sprity Reels · Long videos in, scroll-stopping reels out'; }, []);
  return (
    <>
      <Backdrop /><Nav />
      <main><Hero /><HowItWorks /><Features /><CaptionShowcase /><Layouts /><Faq /><FinalCta /></main>
      <Footer />
    </>
  );
}
