import './style.css';

// Two pages: what Assembly is and how to add it to your agent, and a manual. The manual and
// its 3d drawing load only when you open one.

const root = document.querySelector<HTMLElement>('#root')!;
const match = location.pathname.match(/^\/m\/([A-Za-z0-9]{8,32}|example)\/?$/);

if (match) {
  void import('./manual').then(({ openManual }) => openManual(root, match[1]));
} else {
  const mcp = `${location.origin}/mcp`;
  const add = `claude mcp add --transport http assembly ${mcp}`;
  root.innerHTML = `
    <main class="landing">
      <p class="eyebrow">Assembly</p>
      <h1>Wire it up, one drawn step at a time.</h1>
      <p class="lede">Your coding agent already knows your parts and how they connect. With Assembly it draws you a 3D manual of the build: every wire, every pin, every caution, step by step. Stuck on one? Take a photo and it checks it.</p>

      <ol class="how">
        <li>
          <h2>Add Assembly to your agent</h2>
          <div class="command"><code>${add}</code><button class="button" data-copy="${add}">Copy</button></div>
          <p class="hint">Any other agent: add <code>${mcp}</code> as an MCP server.</p>
        </li>
        <li>
          <h2>Ask it for a manual</h2>
          <p>“Make me an assembly manual for this build.” It looks your parts up and sends you a link.</p>
        </li>
        <li>
          <h2>Follow it</h2>
          <p>On your computer or your phone. If a part or a wire is confusing, photograph it: the labels get read and checked against the step.</p>
        </li>
      </ol>

      <a class="button primary" href="/m/example">See an example</a>
    </main>`;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
    button.addEventListener('click', async () => {
      await navigator.clipboard.writeText(button.dataset.copy!);
      button.textContent = 'Copied';
      setTimeout(() => (button.textContent = 'Copy'), 1800);
    });
  }
}
