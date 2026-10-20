import './style.css';

// Two pages: what Assembly is and how to add it to your agent, and a manual. The manual and
// its 3d drawing load only when you open one.

const root = document.querySelector<HTMLElement>('#root')!;
const match = location.pathname.match(/^\/m\/([A-Za-z0-9]{8,32}|example)\/?$/);

if (match) {
  void import('./manual').then(({ openManual }) => openManual(root, match[1]));
} else {
  const mcp = `${location.origin}/mcp`;
  root.innerHTML = `
    <main class="landing">
      <p class="eyebrow">Assembly</p>
      <h1>A simple manual for anything you build.</h1>
      <p class="lede">Toy bricks come with a booklet: one picture per step, the pieces it needs, nothing else to read. Hardware never does. Assembly lets your coding agent make you one, with every part, screw and wire drawn in 3D the way it looks on your desk.</p>

      <ol class="how">
        <li>
          <h2>Add Assembly to your agent</h2>
          <div class="command"><code>${mcp}</code><button class="button" data-copy="${mcp}">Copy</button></div>
          <p class="hint">Add it as an MCP server in whichever coding agent you use, or just paste it to your agent and ask it to add it.</p>
        </li>
        <li>
          <h2>Ask it for a manual</h2>
          <p>“Make me an assembly manual for this build.” It looks your parts up and sends you a link.</p>
        </li>
        <li>
          <h2>Follow it</h2>
          <p>On your computer or your phone. If a part or a wire is confusing, photograph it and your agent (or the page itself, with a key) shows you which piece it is and where it goes.</p>
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
