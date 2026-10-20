import { setAccessCode } from './api';

/** a small card asking for the site's access code; the page starts over once it's in */
export function askForCode() {
  if (document.querySelector('.unlock')) return;
  const card = document.createElement('div');
  card.className = 'unlock';
  card.innerHTML = `
    <form class="unlock-card">
      <h2>Access code</h2>
      <p>This guide runs on a private AI key. Enter the code to use it.</p>
      <input name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Code" required />
      <button class="button primary">Continue</button>
    </form>`;
  document.body.append(card);
  const form = card.querySelector('form')!;
  form.querySelector('input')!.focus();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    setAccessCode(new FormData(form).get('code') as string);
    location.reload();
  });
}
