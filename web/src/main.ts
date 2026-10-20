import './style.css';
import { Locked, accessCode, api } from './api';
import { openSession } from './app';
import { askForCode } from './unlock';

const root = document.querySelector<HTMLElement>('#root')!;
const match = location.pathname.match(/^\/s\/([A-Za-z0-9]{8,32})\/?$/);

if (match) {
  openSession(root, match[1]);
} else {
  root.innerHTML = `
    <main class="landing">
      <p class="eyebrow">Assembly</p>
      <h1>Put hardware together, one drawn step at a time.</h1>
      <p class="lede">Your coding agent writes the plan. This turns it into a 3D assembly drawing you follow step by step, and checks your wiring from a photo.</p>
      <div class="actions">
        <button class="button primary" data-start>Start a guide</button>
        <button class="button" data-example>See an example</button>
      </div>
    </main>`;
  const go = async (example: boolean) => {
    try {
      const { id } = await api.create();
      if (example) await api.example(id);
      location.href = `/s/${id}`;
    } catch (error) {
      if (error instanceof Locked) askForCode();
      else alert((error as Error).message);
    }
  };
  void api.info().then((info) => {
    if (info.locked && !accessCode()) askForCode();
  });
  root.querySelector('[data-start]')!.addEventListener('click', () => go(false));
  root.querySelector('[data-example]')!.addEventListener('click', () => go(true));
}
