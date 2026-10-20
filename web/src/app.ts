import QRCode from 'qrcode';
import type { Guide, Message, Part, Photo, Session, Visual } from '../../shared/types';
import { accessCode, api, type Info } from './api';
import { Drawing } from './drawing/drawing';
import { agentPrompt } from './prompt';
import { askForCode } from './unlock';

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function openSession(root: HTMLElement, id: string) {
  root.innerHTML = layout();
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  const panel = $('.title-block');
  // on a wide sheet the step panel floats over the drawing's right side
  const covered = () => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: getComputedStyle(panel).position === 'absolute' && panel.offsetParent ? panel.offsetWidth + 40 : 0,
  });
  const drawing = new Drawing($('#drawing'), reduceMotion, covered);
  new ResizeObserver(() => drawing.refit()).observe(panel);

  let session: Session | null = null;
  let info: Info | null = null;
  let guideKey = '';
  let step = -1;
  const shownVisuals = new Set<string>();
  let firstSnapshot = true;

  // ---------- the agent prompt ----------

  const prompt = () => agentPrompt(location.origin, id, accessCode());
  $('[data-copy]').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(prompt());
    button.textContent = 'Copied. Paste it into your agent';
    setTimeout(() => (button.textContent = 'Copy prompt for your agent'), 2400);
  });
  $('[data-prompt]').textContent = prompt();

  // ---------- the plan ----------

  const planBox = $<HTMLTextAreaElement>('[data-plan]');
  $('[data-build]').addEventListener('click', async () => {
    if (!planBox.value.trim()) return planBox.focus();
    await api.plan(id, planBox.value).catch((e) => alert(e.message));
  });
  $('[data-example]').addEventListener('click', () => api.example(id));

  // ---------- photos and questions ----------

  const question = $<HTMLTextAreaElement>('[data-question]');
  const upload = async (file: File | undefined) => {
    if (!file) return;
    const text = question.value.trim();
    question.value = '';
    await api.photo(id, file, text).catch((e) => alert(e.message));
  };
  for (const input of root.querySelectorAll<HTMLInputElement>('input[type=file]')) {
    input.addEventListener('change', () => {
      void upload(input.files?.[0]);
      input.value = '';
    });
  }
  const send = async () => {
    const text = question.value.trim();
    if (!text) return;
    question.value = '';
    await api.ask(id, text).catch((e) => alert(e.message));
  };
  $('[data-send]').addEventListener('click', send);
  question.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  $('[data-messages]').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-show]');
    const message = session?.messages.find((m) => m.id === button?.dataset.show);
    if (message?.visual) show(message.visual);
  });

  // ---------- steps ----------

  const go = (to: number) => {
    if (!session?.guide) return;
    const next = Math.max(0, Math.min(session.guide.steps.length - 1, to));
    if (next === step) return;
    step = next;
    drawing.setStep(step);
    renderStep();
    void api.step(id, step);
  };
  /** the agent's answer, drawn: a step jump goes through go() so every device follows */
  const show = (visual: Visual) => {
    if (visual.step !== null) go(visual.step);
    drawing.showVisual({ ...visual, step: null });
  };
  $('[data-prev]').addEventListener('click', () => go(step - 1));
  $('[data-next]').addEventListener('click', () => go(step + 1));
  addEventListener('keydown', (event) => {
    if ((event.target as HTMLElement).closest('textarea, input')) return;
    if (event.key === 'ArrowRight') go(step + 1);
    if (event.key === 'ArrowLeft') go(step - 1);
  });

  // ---------- the phone ----------

  void api.info().then(async (value) => {
    info = value;
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const host = local && info.lan[0] ? `${info.lan[0]}${location.port ? `:${location.port}` : ''}` : location.host;
    const code = accessCode();
    const url = `${location.protocol}//${host}/s/${id}${code ? `?code=${encodeURIComponent(code)}` : ''}`;
    $('[data-qr]').innerHTML = await QRCode.toString(url, { type: 'svg', margin: 0, color: { dark: '#151515', light: '#0000' } });
    $('[data-phone-url]').textContent = url;
    renderNotes();
  });

  // ---------- following the session ----------

  api.follow(
    id,
    (next) => {
      session = next;
      const key = next.guide ? JSON.stringify(next.guide) : '';
      if (key !== guideKey) {
        guideKey = key;
        if (next.guide) {
          drawing.setGuide(next.guide);
          step = next.step;
          drawing.setStep(step, !firstSnapshot);
        }
      } else if (next.guide && next.step !== step) {
        step = next.step;
        drawing.setStep(step);
      }
      // answers that come with something to show get shown, once, as they arrive
      for (const message of next.messages) {
        if (shownVisuals.has(message.id)) continue;
        shownVisuals.add(message.id);
        if (!firstSnapshot && message.visual && message.role === 'guide') show(message.visual);
      }
      firstSnapshot = false;
      renderNotes();
      renderStep();
    },
    (up) => root.querySelector('.link')?.toggleAttribute('data-down', !up),
    askForCode,
  );

  // ---------- rendering ----------

  function renderNotes() {
    if (!session) return;
    const keyMissing = info && !info.hasKey;
    const searching = session.lookups.filter((l) => l.status === 'searching');
    $('[data-status]').innerHTML = searching.length
      ? `<span class="working">Looking up ${esc(searching.map((l) => l.query).join(', '))} on the web…</span>`
      : session.building
      ? '<span class="working">Drawing the guide…</span>'
      : session.buildError
        ? `<span class="error">${esc(session.buildError)}</span>`
        : session.guide
          ? `Guide ready: ${session.guide.steps.length} steps.`
          : keyMissing
            ? 'No OpenRouter key yet, so the guide agent is off. The example still works.'
            : '';
    // every web lookup, so it's clear where the specs came from
    $('[data-lookups]').innerHTML = session.lookups
      .filter((l) => l.status !== 'searching')
      .map((l) => {
        const result =
          l.status === 'found'
            ? `found · ${l.sources.length} source${l.sources.length === 1 ? '' : 's'}`
            : l.status === 'not-found'
              ? 'not found online'
              : 'lookup failed';
        return `<li data-status="${l.status}"><span>${esc(l.query)}</span><em>${result}</em></li>`;
      })
      .join('');
    $('[data-photos]').innerHTML = session.photos.map(photoTile).join('') || '<p class="hint">Photos you take show up here, read and checked.</p>';
    const messages = $('[data-messages]');
    const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    messages.innerHTML =
      session.messages.map((m) => messageRow(m, session!)).join('') +
      (session.thinking ? '<p class="msg guide working">Thinking…</p>' : '') ||
      '<p class="hint">Stuck? Ask here, or attach a photo. The answer gets drawn.</p>';
    if (atBottom) messages.scrollTop = messages.scrollHeight;
  }

  function renderStep() {
    const guide = session?.guide;
    root.querySelector('.app')!.classList.toggle('has-guide', !!guide);
    $('[data-empty]').hidden = !!guide || !!session?.building;
    $('[data-drawing-status]').hidden = !session?.building;
    if (!guide) return;
    const current = guide.steps[step];
    $('[data-title]').textContent = guide.title;
    $('[data-summary]').textContent = guide.summary;
    $('[data-count]').textContent = `${String(step + 1).padStart(2, '0')} / ${String(guide.steps.length).padStart(2, '0')}`;
    $('[data-step-title]').textContent = current?.title ?? '';
    $('[data-instruction]').textContent = current?.instruction ?? '';
    const caution = $('[data-caution]');
    caution.hidden = !current?.caution;
    caution.querySelector('span')!.textContent = current?.caution ?? '';
    const check = $('[data-check]');
    check.hidden = !current?.check;
    check.querySelector('span')!.textContent = current?.check ?? '';
    $('[data-wires]').innerHTML = (current?.connections ?? [])
      .map(
        (c) =>
          `<li><i class="swatch" style="--wire:${esc(c.wire || 'transparent')}"></i>${end(guide, c.from)}<b>→</b>${end(guide, c.to)}<em>${esc(c.wire)}</em></li>`,
      )
      .join('');
    $('[data-bom]').innerHTML = guide.parts.map((p, i) => `<li><b>${i + 1}</b>${esc(p.name)}<em>${esc(p.model)} · ${origin(p)}</em></li>`).join('');
    $<HTMLButtonElement>('[data-prev]').disabled = step <= 0;
    $<HTMLButtonElement>('[data-next]').disabled = step >= guide.steps.length - 1;
  }
}

/** where a part's shape and pins came from */
function origin(part: Part) {
  const link = part.sources?.[0];
  const from = part.texture
    ? 'from your photo'
    : part.source === 'library' || part.source.startsWith('library')
      ? 'verified on a real board'
      : link
        ? `<a href="${esc(link.url)}" target="_blank" rel="noreferrer">from ${esc(new URL(link.url).hostname.replace(/^www\./, ''))}</a>`
        : 'not found online, approximate';
  return part.estimated && !part.texture ? `${from} · approximate` : from;
}

/** a wire end: the pin's printed label, with the part it's on underneath */
function end(guide: Guide, at: { part: string; pin: string }) {
  const part = guide.parts.find((p) => p.id === at.part);
  const pin = part?.pins.find((p) => p.id === at.pin);
  return `<span class="end"><strong>${esc(pin?.label ?? at.pin)}</strong><small>${esc(part?.name ?? at.part)}</small></span>`;
}

function photoTile(photo: Photo) {
  const state = { analyzing: 'Reading…', done: photo.analysis?.verdict === 'wrong' ? 'Check wiring' : 'Read', retake: 'Retake', error: 'Failed' }[photo.status];
  return `<a class="tile" data-state="${photo.status}${photo.analysis?.verdict === 'wrong' ? ' wrong' : ''}" href="${photo.file}" target="_blank">
    <img src="${photo.file}" alt="" loading="lazy" />
    <span>${state}</span>
  </a>`;
}

function messageRow(message: Message, session: Session) {
  const photo = message.photo ? session.photos.find((p) => p.id === message.photo) : null;
  const crops = message.role === 'guide' && photo?.crops.length
    ? `<div class="crops">${photo.crops.map((c) => `<img src="${c}" alt="zoomed in" />`).join('')}</div>`
    : '';
  const thumb = message.role === 'you' && photo ? `<img class="thumb" src="${photo.file}" alt="" />` : '';
  const show = message.visual && (message.visual.focus.length || message.visual.connections.length || message.visual.step !== null)
    ? `<button class="show" data-show="${message.id}">Show me</button>`
    : '';
  return `<div class="msg ${message.role}">${thumb}<p>${esc(message.text)}</p>${crops}${show}</div>`;
}

function layout() {
  return `
  <div class="app">
    <aside class="notes">
      <header class="notes-head">
        <a href="/" class="wordmark">Assembly</a>
        <details class="phone">
          <summary>Open on your phone</summary>
          <div class="qr" data-qr></div>
          <p class="hint" data-phone-url></p>
          <p class="hint">Same wifi. Photos you take there show up here.</p>
        </details>
      </header>

      <section class="note">
        <h2><b>01</b> Your agent</h2>
        <p>Paste this into the coding agent that knows your project. It writes the plan and sends it here.</p>
        <button class="button primary" data-copy>Copy prompt for your agent</button>
        <details class="prompt"><summary>See the prompt</summary><pre data-prompt></pre></details>
      </section>

      <section class="note">
        <h2><b>02</b> Or describe it</h2>
        <textarea data-plan rows="4" placeholder="What you're building and the exact parts, e.g. “HLK-LD2450 radar to a CP2102 USB adapter”"></textarea>
        <div class="row">
          <button class="button" data-build>Make the guide</button>
          <button class="link-button" data-example>See an example</button>
        </div>
        <p class="status" data-status></p>
        <ul class="lookups" data-lookups></ul>
      </section>

      <section class="note">
        <h2><b>03</b> Photos</h2>
        <div class="row">
          <label class="button primary"><input type="file" accept="image/*" capture="environment" hidden />Take a photo</label>
          <label class="button"><input type="file" accept="image/*" hidden />Upload</label>
        </div>
        <div class="tiles" data-photos></div>
      </section>

      <section class="note ask">
        <h2><b>04</b> Ask</h2>
        <div class="messages" data-messages></div>
        <div class="composer">
          <textarea data-question rows="2" placeholder="Which pin does the black wire go on?"></textarea>
          <div class="row">
            <label class="button" title="attach a photo to this question"><input type="file" accept="image/*" hidden />+ Photo</label>
            <button class="button primary" data-send>Ask</button>
          </div>
        </div>
      </section>
    </aside>

    <main class="sheet">
      <div class="frame">
        <div class="viewport" id="drawing"></div>
        <header class="sheet-title">
          <h1 data-title></h1>
          <p data-summary></p>
        </header>
        <div class="empty" data-empty>
          <p>Nothing drawn yet.</p>
          <p>Send a plan from your agent, describe what you're building, or open the example.</p>
        </div>
        <p class="drawing-status working" data-drawing-status hidden>Drawing the guide…</p>
        <span class="link" title="connection to the session"></span>
      </div>

      <section class="title-block">
        <div class="tb-head">
          <span class="tb-label">Step</span>
          <span class="tb-count" data-count>—</span>
          <div class="tb-nav">
            <button class="nav" data-prev aria-label="previous step">←</button>
            <button class="nav" data-next aria-label="next step">→</button>
          </div>
        </div>
        <h2 data-step-title></h2>
        <p class="instruction" data-instruction></p>
        <ul class="wires" data-wires></ul>
        <p class="caution" data-caution hidden><b>Caution</b><span></span></p>
        <p class="check" data-check hidden><b>Check</b><span></span></p>
        <div class="tb-label">Parts</div>
        <ol class="bom" data-bom></ol>
      </section>
    </main>
  </div>`;
}
