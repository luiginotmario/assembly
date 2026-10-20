import type { Guide, Manual, Part, Photo, Visual } from '../../shared/types';
import { api } from './api';
import { Drawing } from './drawing/drawing';

// A manual: the drawing filling the page, the step you're on floating over its corner, and a
// photo button for when a step is confusing. Questions go to the agent that made it; this page
// is for following along.

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const PROVIDERS = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI' };

export async function openManual(root: HTMLElement, id: string) {
  const example = id === 'example';
  root.innerHTML = layout(example);
  const $ = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  const panel = $('.title-block');
  // on a wide screen the step panel floats over the drawing's right side
  const covered = () => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: getComputedStyle(panel).position === 'absolute' && panel.offsetParent ? panel.offsetWidth + 40 : 0,
  });
  const drawing = new Drawing($('#drawing'), reduceMotion, covered);
  new ResizeObserver(() => drawing.refit()).observe(panel);

  let manual: Manual | null = null;
  let guideKey = '';
  let step = -1;
  let first = true;
  /** photo checks whose answer was drawn already, so each is shown once as it arrives */
  const shown = new Set<string>();
  /** which check the card shows; null follows the newest */
  let viewing: string | null = null;
  let dismissed = '';
  /** a saved photo to check on the page as soon as a key is connected */
  let pending: Photo | null = null;
  const card = $('[data-verdict]');

  // ---------- steps ----------

  const frame = $('.frame');
  let turning: Animation | null = null;
  /** the page you were on turns over like a booklet page, the next step already drawn beneath */
  const turnPage = (forward: boolean) => {
    turning?.finish();
    const sheet = document.createElement('div');
    sheet.className = 'turning';
    sheet.append(drawing.snapshot());
    // what's printed on the page goes with it: the title, the step number, the parts box, the labels
    for (const selector of ['.sheet-title', '.callouts']) {
      const printed = frame.querySelector(selector);
      if (printed) sheet.append(printed.cloneNode(true));
    }
    frame.append(sheet);
    const edge = forward ? 'left' : 'right';
    sheet.style.transformOrigin = `${edge} center`;
    const angle = forward ? -100 : 100;
    turning = reduceMotion
      ? sheet.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease' })
      : sheet.animate(
          [
            { transform: 'perspective(2600px) rotateY(0deg)', filter: 'brightness(1)' },
            { transform: `perspective(2600px) rotateY(${angle}deg)`, filter: 'brightness(0.86)' },
          ],
          { duration: 620, easing: 'cubic-bezier(0.5, 0, 0.2, 1)' },
        );
    const done = turning;
    void done.finished.catch(() => {}).finally(() => {
      sheet.remove();
      if (turning === done) turning = null;
    });
  };

  const go = (to: number) => {
    if (!manual) return;
    const next = Math.max(0, Math.min(manual.guide.steps.length - 1, to));
    if (next === step) return;
    turnPage(next > step);
    step = next;
    drawing.setStep(step);
    renderStep();
    if (!example) void api.step(id, step);
  };
  const show = (visual: Visual) => {
    if (visual.step !== null) go(visual.step);
    drawing.showVisual({ ...visual, step: null });
  };
  $('[data-prev]').addEventListener('click', () => go(step - 1));
  $('[data-next]').addEventListener('click', () => go(step + 1));
  addEventListener('keydown', (event) => {
    if ((event.target as HTMLElement).closest('input, textarea')) return;
    if (event.key === 'ArrowRight') go(step + 1);
    if (event.key === 'ArrowLeft') go(step - 1);
  });

  const loading = $('[data-loading]');
  const take = async (next: Manual) => {
    manual = next;
    const key = JSON.stringify(next.guide);
    if (key !== guideKey) {
      guideKey = key;
      // the real 3d parts come first, so the build never draws half-made
      if (next.guide.parts.some((p) => p.mesh)) {
        loading.hidden = false;
        const { failed } = await drawing.prepare(next.guide, (done, total) => (loading.textContent = `Loading the 3D parts… ${done} of ${total}`));
        loading.hidden = true;
        if (failed.length) console.warn('some 3d parts could not be loaded and are drawn as blocks:', failed);
        if (guideKey !== key) return;
      }
      drawing.setGuide(next.guide);
      step = next.step;
      drawing.setStep(step, !first);
    } else if (next.step !== step) {
      // another device moved on: this page turns too
      turnPage(next.step > step);
      step = next.step;
      drawing.setStep(step);
    }
    // a check that just finished draws its answer
    for (const photo of next.photos) {
      if (photo.status === 'reading' || shown.has(photo.id)) continue;
      shown.add(photo.id);
      const visual = photo.analysis?.visual;
      if (!first && visual && (visual.focus.length || visual.connections.length || visual.step !== null)) show(visual);
    }
    first = false;
    document.title = `${next.guide.title} · Assembly`;
    renderStep();
    renderCheck();
    if (pending && next.key) {
      const photo = pending;
      pending = null;
      closeSheet();
      void api.check(id, photo.id).catch((e) => alert(e.message));
    }
  };

  if (example) {
    const { example: guide } = await import('../../shared/example');
    await take({ id, createdAt: 0, updatedAt: 0, guide, step: 0, photos: [], key: null });
    return;
  }

  // ---------- checking a photo ----------

  const sheet = $('[data-connect]');
  const sheetError = $('[data-connect-error]');

  const send = async (file: File) => {
    viewing = null;
    dismissed = '';
    try {
      await api.photo(id, file, step);
    } catch (error) {
      alert((error as Error).message);
    }
  };

  const camera = $<HTMLInputElement>('[data-camera]');
  camera.addEventListener('change', () => {
    const file = camera.files?.[0];
    camera.value = '';
    // with a key the page checks it; without one it's saved for the user's agent
    if (file) void send(file);
  });

  async function openSheet(photo: Photo) {
    pending = photo;
    sheetError.textContent = '';
    $<HTMLImageElement>('[data-held]').src = photo.file;
    const saved = await api.savedKey().then((r) => r.saved).catch(() => null);
    const useSaved = $<HTMLButtonElement>('[data-saved]');
    useSaved.hidden = !saved;
    if (saved) useSaved.textContent = `Use your ${PROVIDERS[saved.provider]} key ending ${saved.last4}`;
    $('[data-openrouter]').classList.toggle('primary', !saved);
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    sheet.hidden = true;
    document.body.classList.remove('sheet-open');
  }
  const failed = (error: unknown) => (sheetError.textContent = (error as Error).message);

  $('[data-cancel]').addEventListener('click', () => {
    pending = null;
    closeSheet();
  });
  sheet.addEventListener('click', (event) => event.target === sheet && $<HTMLButtonElement>('[data-cancel]').click());
  addEventListener('keydown', (event) => event.key === 'Escape' && !sheet.hidden && $<HTMLButtonElement>('[data-cancel]').click());

  $('[data-saved]').addEventListener('click', async () => {
    try {
      const { key } = await api.useSavedKey(id);
      if (manual) take({ ...manual, key });
    } catch (error) {
      failed(error);
    }
  });
  $('[data-openrouter]').addEventListener('click', () => {
    // a small window, so this page (and the photo) stays put; the manual sees the key arrive
    const url = `/api/connect/openrouter?manual=${id}`;
    const popup = open(url, 'assembly-connect', 'popup,width=520,height=720');
    if (!popup) location.href = url;
  });
  $('[data-paste]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const input = form.elements.namedItem('key') as HTMLInputElement;
    const button = form.querySelector('button')!;
    button.disabled = true;
    sheetError.textContent = '';
    try {
      const { key } = await api.pasteKey(id, input.value);
      input.value = '';
      if (manual) take({ ...manual, key });
    } catch (error) {
      failed(error);
    } finally {
      button.disabled = false;
    }
  });

  card.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!target || !manual) return;
    const photos = manual.photos;
    const at = photos.findIndex((p) => p.id === current()?.id);
    if (target.dataset.act === 'close') dismissed = current()?.id ?? '';
    if (target.dataset.act === 'older') viewing = photos[Math.max(0, at - 1)]?.id ?? null;
    if (target.dataset.act === 'newer') viewing = at + 1 >= photos.length - 1 ? null : photos[at + 1].id;
    if (target.dataset.act === 'connect') {
      const photo = current();
      if (photo) void openSheet(photo);
    }
    if (target.dataset.act === 'show') {
      const visual = current()?.analysis?.visual;
      if (visual) show(visual);
    }
    if (target.dataset.act === 'forget' && confirm('Disconnect this key? Photos can’t be checked until one is connected again.')) {
      await api.forgetKey(id).catch((e) => alert(e.message));
    }
    renderCheck();
  });

  // ---------- the phone ----------

  const phone = $<HTMLDetailsElement>('[data-phone]');
  phone.addEventListener('toggle', async () => {
    if (!phone.open || phone.dataset.ready) return;
    phone.dataset.ready = '1';
    const info = await api.info().catch(() => ({ lan: [] as string[] }));
    const local = ['localhost', '127.0.0.1'].includes(location.hostname);
    const host = local && info.lan[0] ? `${info.lan[0]}${location.port ? `:${location.port}` : ''}` : location.host;
    const url = `${location.protocol}//${host}/m/${id}`;
    const { default: QRCode } = await import('qrcode');
    $('[data-qr]').innerHTML = await QRCode.toString(url, { type: 'svg', margin: 0, color: { dark: '#1d1d1f', light: '#0000' } });
    $('[data-phone-url]').textContent = url.replace(/^https?:\/\//, '');
    $('[data-phone-hint]').textContent = local ? 'Same wifi. It stays on the same step as this screen.' : 'It stays on the same step as this screen.';
  });
  addEventListener('click', (event) => phone.open && !phone.contains(event.target as Node) && (phone.open = false));

  // ---------- following the manual ----------

  api.follow(
    id,
    take,
    (up) => root.querySelector('.link')?.toggleAttribute('data-down', !up),
    (why) => {
      root.innerHTML = `<main class="missing"><p>${esc(why)}</p><a class="button" href="/">About Assembly</a></main>`;
    },
  );

  // ---------- rendering ----------

  function current(): Photo | null {
    const photos = manual?.photos ?? [];
    return photos.find((p) => p.id === viewing) ?? photos.at(-1) ?? null;
  }

  function renderCheck() {
    const photo = current();
    card.hidden = !photo || photo.id === dismissed;
    if (!photo || card.hidden || !manual) return;
    const photos = manual.photos;
    const at = photos.indexOf(photo);
    const a = photo.analysis;
    const state = photo.status === 'done' ? (a?.verdict ?? 'none') : photo.status;
    const title = {
      waiting: 'Saved for your agent',
      reading: 'Reading the labels…',
      ok: 'Looks right',
      wrong: 'Not quite',
      unsure: 'Hard to tell',
      none: 'Here’s what I see',
      retake: 'Can you retake it?',
      error: 'Couldn’t check that one',
    }[state];
    const body =
      photo.status === 'waiting'
        ? 'Tell your agent “check my photo”. Its answer shows up here, with the part and pins it means highlighted.'
        : photo.status === 'retake'
          ? a?.retake
          : photo.status === 'error'
            ? photo.error
            : photo.status === 'done'
              ? a?.explanation
              : '';
    const visual = a?.visual;
    const drawable = visual && (visual.focus.length || visual.connections.length || visual.step !== null);
    card.dataset.state = state;
    card.innerHTML = `
      <a class="verdict-photo" href="${esc(photo.file)}" target="_blank" rel="noreferrer"><img src="${esc(photo.file)}" alt="Your photo" /></a>
      <div class="verdict-body">
        <p class="verdict-title">${title}<small>${photo.answeredBy === 'agent' ? 'your agent · ' : ''}step ${photo.step + 1}</small></p>
        ${body ? `<p class="verdict-text">${esc(body)}</p>` : ''}
        ${photo.crops.length ? `<div class="crops">${photo.crops.map((c) => `<img src="${esc(c)}" alt="A close-up it read" />`).join('')}</div>` : ''}
        ${photo.captured.length ? `<p class="verdict-note">Your ${esc(list(photo.captured))} ${photo.captured.length > 1 ? 'are' : 'is'} now on the drawing, as photographed.</p>` : ''}
        <div class="verdict-foot">
          ${drawable && photo.status === 'done' ? '<button class="link-button" data-act="show">Show me</button>' : ''}
          ${photo.status === 'waiting' && !manual.key ? '<button class="link-button" data-act="connect">Or check it here with a key</button>' : ''}
          ${photos.length > 1 ? `<span class="pager"><button class="icon" data-act="older" aria-label="Older check" ${at <= 0 ? 'disabled' : ''}>‹</button>${at + 1} / ${photos.length}<button class="icon" data-act="newer" aria-label="Newer check" ${at >= photos.length - 1 ? 'disabled' : ''}>›</button></span>` : ''}
          ${manual.key ? `<button class="link-button quiet" data-act="forget" title="Photos are checked with this key">${PROVIDERS[manual.key.provider]} ·· ${esc(manual.key.last4)}</button>` : ''}
        </div>
      </div>
      <button class="icon close" data-act="close" aria-label="Close">×</button>`;
  }

  function renderStep() {
    const guide = manual?.guide;
    if (!guide) return;
    const current = guide.steps[step];
    $('[data-title]').textContent = guide.title;
    $('[data-summary]').textContent = guide.summary;
    $('[data-count]').textContent = `${step + 1} of ${guide.steps.length}`;
    $('[data-step-title]').textContent = current?.title ?? '';
    $('[data-instruction]').textContent = current?.instruction ?? '';
    // the page itself: a big step number and the box of what this step uses
    $('[data-big-step]').textContent = String(step + 1);
    const box = $('[data-callout]');
    box.innerHTML = callout(guide, step);
    box.hidden = !box.innerHTML;
    for (const img of box.querySelectorAll<HTMLImageElement>('img[data-thumb]')) {
      void drawing.thumbnail(img.dataset.thumb!).then((src) => src && (img.src = src));
    }
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
    $('[data-part-count]').textContent = String(guide.parts.length);
    const parts = $<HTMLDetailsElement>('[data-parts]');
    if (!parts.dataset.set) {
      parts.dataset.set = '1';
      // a short list is open; a big build's list waits to be asked for
      parts.open = guide.parts.length <= 8;
    }
    $('[data-bom]').innerHTML = guide.parts.map((p, i) => `<li><b>${i + 1}</b>${esc(p.name)}<em>${esc(p.model)} · ${origin(p)}</em></li>`).join('');
    $<HTMLButtonElement>('[data-prev]').disabled = step <= 0;
    $<HTMLButtonElement>('[data-next]').disabled = step >= guide.steps.length - 1;
  }
}

/** what this step uses, like the box in the corner of a LEGO page: each new part pictured with how
 * many, then the screws and the like, then how many times to do it */
function callout(guide: Guide, index: number) {
  const steps = guide.steps;
  const before = new Set(
    steps.slice(0, index).flatMap((s) => [...s.show, ...(s.place ?? []).map((p) => p.part), ...s.connections.flatMap((c) => [c.from.part, c.to.part])]),
  );
  const step = steps[index];
  const fresh = [...new Set([...(step.place ?? []).map((p) => p.part), ...step.show, ...step.connections.flatMap((c) => [c.from.part, c.to.part])])].filter(
    (id) => !before.has(id),
  );
  // identical parts (two adapters) are one picture with a count
  const groups = new Map<string, { id: string; name: string; n: number }>();
  for (const id of fresh) {
    const part = guide.parts.find((p) => p.id === id);
    if (!part) continue;
    const key = `${part.model}|${part.mesh?.url ?? ''}`;
    const group = groups.get(key);
    if (group) group.n += 1;
    else groups.set(key, { id, name: part.name, n: 1 });
  }
  const items = [
    ...[...groups.values()].map(
      (g) => `<li title="${esc(g.name)}"><img data-thumb="${esc(g.id)}" alt="${esc(g.name)}" /><b>${g.n}x</b></li>`,
    ),
    ...(step.fasteners ?? []).map(
      (f) => `<li class="fastener" title="${esc(`${f.size} ${f.kind}${f.note ? ` (${f.note})` : ''}`)}">${screwIcon(f.kind)}<b>${f.count}x</b><small>${esc(f.size)}</small></li>`,
    ),
  ];
  const times = step.times ?? 1;
  return (items.length ? `<ul class="parts-box">${items.join('')}</ul>` : '') + (times > 1 ? `<span class="repeat">${times}x</span>` : '');
}

/** a small drawing of the fastener, the way manuals show them life-size in the corner */
function screwIcon(kind: string) {
  if (kind === 'nut') return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10l5 8-5 8H7l-5-8z" /><circle cx="12" cy="12" r="3.6" /></svg>`;
  if (kind === 'washer') return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.6" /></svg>`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9.5h5v5H3z" /><path d="M8 11h13M8 13h13M10 11l1 2M13 11l1 2M16 11l1 2M19 11l1 2" /></svg>`;
}

const list = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ''));

/** where a part's shape and pins came from */
function origin(part: Part) {
  const link = part.sources?.[0];
  const from = part.texture
    ? 'from your photo'
    : part.mesh
      ? `<a href="${esc(part.mesh.url)}" target="_blank" rel="noreferrer">its real 3D model</a>`
    : part.source === 'library'
      ? 'measured on a real board'
      : link
        ? `<a href="${esc(link.url)}" target="_blank" rel="noreferrer">from ${esc(host(link.url))}</a>`
        : 'approximate';
  return part.estimated && !part.texture && from !== 'approximate' ? `${from} · approximate` : from;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** a wire end: the pin's printed label, with the part it's on underneath */
function end(guide: Guide, at: { part: string; pin: string }) {
  const part = guide.parts.find((p) => p.id === at.part);
  const pin = part?.pins.find((p) => p.id === at.pin);
  return `<span class="end"><strong>${esc(pin?.label ?? at.pin)}</strong><small>${esc(part?.name ?? at.part)}</small></span>`;
}

const cameraIcon = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9.4 4h5.2l1.6 2.2H19a2.5 2.5 0 0 1 2.5 2.5v8.8A2.5 2.5 0 0 1 19 20H5a2.5 2.5 0 0 1-2.5-2.5V8.7A2.5 2.5 0 0 1 5 6.2h2.8L9.4 4Zm2.6 4.3a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Zm0 1.8a2.6 2.6 0 1 1 0 5.2 2.6 2.6 0 0 1 0-5.2Z"/></svg>`;

function layout(example: boolean) {
  return `
  <div class="manual">
    <main class="frame">
      <div class="viewport" id="drawing"></div>
      <p class="loading" data-loading hidden></p>
      <header class="sheet-title">
        <a href="/" class="wordmark">Assembly${example ? ' · example' : ''}</a>
        <h1 data-title></h1>
        <p data-summary></p>
        <div class="page-step">
          <span class="step-number" data-big-step></span>
          <div class="callout" data-callout hidden></div>
        </div>
      </header>
      ${
        example
          ? ''
          : `<div class="actions">
        <details class="phone" data-phone>
          <summary class="button">Open on your phone</summary>
          <div class="phone-card">
            <div class="qr" data-qr></div>
            <p class="phone-url" data-phone-url></p>
            <p class="hint" data-phone-hint></p>
          </div>
        </details>
        <label class="button primary camera">${cameraIcon}<span>Check with a photo</span><input data-camera type="file" accept="image/*" capture="environment" hidden /></label>
      </div>
      <span class="link" title="connected"></span>`
      }
    </main>

    <section class="verdict" data-verdict hidden aria-live="polite"></section>

    <section class="title-block">
      <div class="tb-head">
        <span class="tb-label">Step <span data-count></span></span>
        <div class="tb-nav">
          <button class="nav" data-prev aria-label="Previous step">←</button>
          <button class="nav" data-next aria-label="Next step">→</button>
        </div>
      </div>
      <h2 data-step-title></h2>
      <p class="instruction" data-instruction></p>
      <ul class="wires" data-wires></ul>
      <p class="caution" data-caution hidden><b>Caution</b><span></span></p>
      <p class="check" data-check hidden><b>Check</b><span></span></p>
      <details class="parts" data-parts>
        <summary class="tb-label">Parts <span data-part-count></span></summary>
        <ol class="bom" data-bom></ol>
      </details>
    </section>

    <div class="backdrop" data-connect hidden>
      <div class="connect" role="dialog" aria-modal="true" aria-labelledby="connect-title">
        <img class="connect-photo" data-held alt="The photo you took" />
        <h2 id="connect-title">Check photos right on this page</h2>
        <p>With a key, this page reads your photos by itself: it zooms into the labels, says which part it is, and highlights exactly which pins and wires the step means. Your key stays encrypted on the server and is only used for this manual’s photos.</p>
        <button class="button primary wide" data-saved hidden></button>
        <button class="button primary wide" data-openrouter>Continue with OpenRouter</button>
        <form class="paste" data-paste>
          <input name="key" type="password" autocomplete="off" spellcheck="false" placeholder="Or paste a key: sk-or-…, sk-ant-…, sk-…" aria-label="API key" required />
          <button class="button">Save</button>
        </form>
        <p class="error" data-connect-error role="alert"></p>
        <button class="link-button" data-cancel>Not now</button>
      </div>
    </div>
  </div>`;
}
