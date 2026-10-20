import QRCode from 'qrcode';
import type { Guide, Message, Session, Visual } from '../../shared/types';
import { api, type Info } from './api';
import { Drawing } from './drawing/drawing';
import { agentPrompt } from './prompt';

// One thing on screen at a time:
//   no guide yet  -> a single card: get the plan from your agent (or describe it)
//   a guide       -> the drawing, with one step card: what to do now, back and next
//   stuck         -> the help panel: ask, or send a photo to check (opens on demand)

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function openSession(root: HTMLElement, id: string) {
  root.innerHTML = layout();
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const app = $('.app');
  const card = $('.step-card');
  const help = $('.help');
  const topbar = $('.topbar');

  // the drawing frames itself in whatever the step card, top bar and help panel leave free
  const wide = () => matchMedia('(min-width: 901px)').matches;
  const covered = () => ({
    top: topbar.offsetHeight + 16,
    bottom: 0,
    left: wide() ? card.offsetWidth + 32 : 0,
    right: wide() && help.dataset.open === 'true' ? help.offsetWidth + 24 : 0,
  });
  const drawing = new Drawing($('#drawing'), reduceMotion, covered);
  new ResizeObserver(() => drawing.refit()).observe(card);

  let session: Session | null = null;
  let info: Info | null = null;
  let guideKey = '';
  let step = -1;
  let firstSnapshot = true;
  const seen = new Set<string>();

  // ---------- getting a guide ----------

  $('[data-copy]').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    await navigator.clipboard.writeText(agentPrompt(location.origin, id));
    button.textContent = 'Copied';
    button.classList.add('done');
    setTimeout(() => {
      button.textContent = 'Copy prompt';
      button.classList.remove('done');
    }, 2400);
  });
  $('[data-prompt]').textContent = agentPrompt(location.origin, id);
  $('[data-describe-open]').addEventListener('click', () => {
    $('.describe').hidden = false;
    $('[data-describe-open]').hidden = true;
    $<HTMLTextAreaElement>('[data-plan]').focus();
  });
  $('[data-build]').addEventListener('click', async () => {
    const plan = $<HTMLTextAreaElement>('[data-plan]');
    if (!plan.value.trim()) return plan.focus();
    await api.plan(id, plan.value).catch((e) => alert(e.message));
  });
  for (const button of root.querySelectorAll('[data-example]')) button.addEventListener('click', () => api.example(id));

  // ---------- following it ----------

  const go = (to: number) => {
    if (!session?.guide) return;
    const next = Math.max(0, Math.min(session.guide.steps.length - 1, to));
    if (next === step) return;
    step = next;
    drawing.setStep(step);
    renderStep();
    void api.step(id, step);
  };
  /** an answer, drawn: jumps go through go() so every device follows */
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
    if (event.key === 'Escape') {
      closePopovers();
      setHelp(false);
    }
  });

  // ---------- parts and phone popovers ----------

  const closePopovers = () => root.querySelectorAll('.popover').forEach((p) => p.removeAttribute('data-open'));
  for (const toggle of root.querySelectorAll<HTMLElement>('[data-toggle]')) {
    toggle.addEventListener('click', (event) => {
      event.stopPropagation();
      const pop = $(`[data-pop="${toggle.dataset.toggle}"]`);
      const open = pop.hasAttribute('data-open');
      closePopovers();
      if (!open) pop.setAttribute('data-open', '');
    });
  }
  addEventListener('click', (event) => {
    if (!(event.target as HTMLElement).closest('.popover')) closePopovers();
  });

  void api.info().then(async (value) => {
    info = value;
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const host = local && info.lan[0] ? `${info.lan[0]}${location.port ? `:${location.port}` : ''}` : location.host;
    const url = `${location.protocol}//${host}/s/${id}`;
    $('[data-qr]').innerHTML = await QRCode.toString(url, { type: 'svg', margin: 0, color: { dark: '#1d1d1f', light: '#0000' } });
    $('[data-phone-url]').textContent = url;
    $('[data-no-key]').hidden = info.hasKey;
  });

  // ---------- help: ask, or check with a photo ----------

  const setHelp = (open: boolean) => {
    if ((help.dataset.open === 'true') === open) return;
    help.dataset.open = String(open);
    drawing.refit(true);
    if (open) requestAnimationFrame(() => scrollMessages(true));
  };
  for (const button of root.querySelectorAll('[data-help-open]')) button.addEventListener('click', () => setHelp(true));
  $('[data-help-close]').addEventListener('click', () => setHelp(false));

  const question = $<HTMLInputElement>('[data-question]');
  const photoInput = $<HTMLInputElement>('[data-photo-input]');
  const pickPhoto = () => {
    setHelp(true);
    photoInput.click();
  };
  for (const button of root.querySelectorAll('[data-photo]')) button.addEventListener('click', pickPhoto);
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    photoInput.value = '';
    if (!file) return;
    const text = question.value.trim();
    question.value = '';
    await api.photo(id, file, text).catch((e) => alert(e.message));
  });
  $('form.composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = question.value.trim();
    if (!text) return;
    question.value = '';
    await api.ask(id, text).catch((e) => alert(e.message));
  });
  $('[data-messages]').addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-show]');
    const message = session?.messages.find((m) => m.id === button?.dataset.show);
    if (message?.visual) show(message.visual);
  });

  // ---------- following the session, on every device ----------

  api.follow(
    id,
    (next) => {
      session = next;
      app.dataset.mode = next.guide ? 'guide' : 'setup';
      const key = next.guide ? JSON.stringify(next.guide) : '';
      if (key !== guideKey) {
        guideKey = key;
        if (next.guide) {
          drawing.setGuide(next.guide);
          step = next.step;
          renderStep();
          drawing.setStep(step, !firstSnapshot);
        }
      } else if (next.guide && next.step !== step) {
        step = next.step;
        drawing.setStep(step);
      }

      // new messages (a photo from the phone, an answer) open the help panel and get drawn
      let fresh = false;
      for (const message of next.messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (firstSnapshot) continue;
        fresh = true;
        if (message.visual && message.role === 'guide') show(message.visual);
      }
      if (fresh) setHelp(true);

      firstSnapshot = false;
      renderSetup();
      renderStep();
      renderHelp();
    },
    (up) => app.toggleAttribute('data-offline', !up),
  );

  // ---------- rendering ----------

  function renderSetup() {
    if (!session) return;
    const status = $('[data-setup-status]');
    const busy = session.building || !!session.buildError;
    status.hidden = !busy;
    $('.waiting .idle').hidden = busy;
    status.innerHTML = session.building
      ? '<span class="spinner"></span>Drawing your guide…'
      : `<span class="error">${esc(session.buildError)}</span>`;
  }

  function renderStep() {
    const guide = session?.guide;
    if (!guide) return;
    const current = guide.steps[step];
    const total = guide.steps.length;
    $('[data-title]').textContent = guide.title;
    $('[data-count]').textContent = `Step ${step + 1} of ${total}`;
    $('[data-progress]').innerHTML = guide.steps.map((_, i) => `<i${i <= step ? ' data-done' : ''}></i>`).join('');
    $('[data-step-title]').textContent = current?.title ?? '';
    $('[data-instruction]').textContent = current?.instruction ?? '';
    $('[data-wires]').innerHTML = (current?.connections ?? [])
      .map(
        (c) =>
          `<li><i class="dot" style="--wire:${esc(c.wire || 'transparent')}"></i>${end(guide, c.from)}<span class="arrow">→</span>${end(guide, c.to)}</li>`,
      )
      .join('');
    const caution = $('[data-caution]');
    caution.hidden = !current?.caution;
    caution.querySelector('span')!.textContent = current?.caution ?? '';
    const check = $('[data-check]');
    check.hidden = !current?.check;
    check.querySelector('span')!.textContent = current?.check ?? '';
    $<HTMLButtonElement>('[data-prev]').disabled = step <= 0;
    const next = $<HTMLButtonElement>('[data-next]');
    next.disabled = step >= total - 1;
    next.textContent = step >= total - 1 ? 'Done' : 'Next';
    $('[data-bom]').innerHTML = guide.parts
      .map((p, i) => `<li><b>${i + 1}</b><span>${esc(p.name)}<small>${esc(p.model)}${p.estimated ? ' · approximate shape' : ''}</small></span></li>`)
      .join('');
  }

  function renderHelp() {
    if (!session) return;
    const keepAtBottom = scrollMessages(false);
    const busy = session.thinking || session.photos.some((p) => p.status === 'analyzing');
    $('[data-messages]').innerHTML =
      session.messages.map((m) => messageRow(m, session!)).join('') +
        (busy ? '<div class="msg guide"><p class="typing"><i></i><i></i><i></i></p></div>' : '') ||
      `<div class="help-empty">
        <p>Send a photo of your wiring and it gets checked against this step.</p>
        <p>Or ask anything, like “which pin does the black wire go on?”</p>
      </div>`;
    if (keepAtBottom) scrollMessages(true);
  }

  /** returns whether the conversation was scrolled to the bottom; scrolls there if asked */
  function scrollMessages(toBottom: boolean) {
    const list = $('[data-messages]');
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    if (toBottom) list.scrollTop = list.scrollHeight;
    return atBottom;
  }
}

/** a wire end: the pin's printed label, with the part it's on underneath */
function end(guide: Guide, at: { part: string; pin: string }) {
  const part = guide.parts.find((p) => p.id === at.part);
  const pin = part?.pins.find((p) => p.id === at.pin);
  return `<span class="end"><strong>${esc(pin?.label ?? at.pin)}</strong><small>${esc(part?.name ?? at.part)}</small></span>`;
}

function messageRow(message: Message, session: Session) {
  const photo = message.photo ? session.photos.find((p) => p.id === message.photo) : null;
  const file = (name: string) => `/files/${session.id}/${name}`;
  if (message.role === 'you') {
    const thumb = photo ? `<img class="thumb" src="${file(photo.file)}" alt="your photo" />` : '';
    const text = message.text && message.text !== 'Here’s a photo.' ? `<p>${esc(message.text)}</p>` : '';
    return `<div class="msg you">${thumb}${text}</div>`;
  }
  const verdict = photo?.analysis?.verdict;
  const badge = photo ? (photo.status === 'retake' ? 'retake' : verdict === 'ok' ? 'ok' : verdict === 'wrong' ? 'wrong' : '') : '';
  const label = { ok: 'Looks right', wrong: 'Something’s off', retake: 'Retake the photo' }[badge || 'ok'];
  const crops = photo?.crops.length
    ? `<div class="crops" title="where it zoomed in to read">${photo.crops.map((c) => `<img src="${file(c)}" alt="" />`).join('')}</div>`
    : '';
  const visible = message.visual && (message.visual.focus.length || message.visual.connections.length || message.visual.step !== null);
  return `<div class="msg guide">
    ${badge ? `<span class="verdict" data-verdict="${badge}">${label}</span>` : ''}
    <p>${esc(message.text)}</p>
    ${crops}
    ${visible ? `<button class="show" data-show="${message.id}">Show on the drawing</button>` : ''}
  </div>`;
}

function layout() {
  return `
  <div class="app" data-mode="setup">

    <section class="setup">
      <a href="/" class="wordmark">Hardware Guide</a>
      <div class="setup-card">
        <h1>What are you building?</h1>
        <p class="lede">Your coding agent already knows your parts and how they connect. Let it write the guide.</p>
        <p class="notice" data-no-key hidden>To draw new guides, add an OpenRouter key to the <code>.env</code> file. The example works without one.</p>
        <ol class="setup-steps">
          <li>
            <span class="num">1</span>
            <div><b>Copy the prompt</b><small>It asks your agent for an exact build plan.</small></div>
            <button class="button primary" data-copy>Copy prompt</button>
          </li>
          <li>
            <span class="num">2</span>
            <div><b>Paste it into your coding agent</b><small>The one that helped plan this project.</small></div>
          </li>
          <li class="waiting">
            <span class="num">3</span>
            <div><b>Your guide appears here</b><small data-setup-status hidden></small><small class="idle">Waiting for your agent to send the plan…</small></div>
          </li>
        </ol>
        <details class="prompt"><summary>Read the prompt</summary><pre data-prompt></pre></details>
        <div class="alternatives">
          <button class="link-button" data-describe-open>No agent? Describe it yourself</button>
          <button class="link-button" data-example>See an example</button>
        </div>
        <div class="describe" hidden>
          <textarea data-plan rows="4" placeholder="What you're building and the exact parts, e.g. “an HLK-LD2450 radar wired to a CP2102 USB adapter”"></textarea>
          <button class="button primary" data-build>Make the guide</button>
        </div>
      </div>
    </section>

    <main class="stage">
      <div class="canvas"><div class="viewport" id="drawing"></div></div>

      <header class="topbar">
        <a href="/" class="wordmark" title="start a new guide">Hardware Guide</a>
        <h1 data-title></h1>
        <nav class="pills">
          <div class="anchor">
            <button class="pill" data-toggle="parts">Parts</button>
            <div class="popover" data-pop="parts"><h3>Parts</h3><ol class="bom" data-bom></ol></div>
          </div>
          <div class="anchor">
            <button class="pill" data-toggle="phone">Phone</button>
            <div class="popover" data-pop="phone">
              <h3>Open on your phone</h3>
              <p>To take photos of your wiring. Same Wi-Fi.</p>
              <div class="qr" data-qr></div>
              <p class="url" data-phone-url></p>
            </div>
          </div>
          <button class="pill accent" data-help-open>Help</button>
        </nav>
      </header>

      <section class="step-card">
        <div class="step-head">
          <span data-count></span>
          <div class="progress" data-progress></div>
        </div>
        <h2 data-step-title></h2>
        <p class="instruction" data-instruction></p>
        <ul class="wires" data-wires></ul>
        <p class="caution" data-caution hidden><b>Careful</b><span></span></p>
        <div class="check" data-check hidden>
          <p><b>Before you go on</b><span></span></p>
          <button class="button small" data-photo>Check with a photo</button>
        </div>
        <div class="step-nav">
          <button class="button" data-prev>Back</button>
          <button class="button primary" data-next>Next</button>
        </div>
      </section>

      <aside class="help" data-open="false">
        <header>
          <h2>Help</h2>
          <button class="close" data-help-close aria-label="close">×</button>
        </header>
        <div class="messages" data-messages></div>
        <form class="composer">
          <button type="button" class="camera" data-photo aria-label="send a photo"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4.5h6l1.5 2H20a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18V8A1.5 1.5 0 0 1 4 6.5h3.5L9 4.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="12.5" r="3.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg></button>
          <input data-question placeholder="Ask anything" autocomplete="off" />
          <button class="send" aria-label="send">↑</button>
          <input type="file" accept="image/*" data-photo-input hidden />
        </form>
      </aside>
    </main>
  </div>`;
}
