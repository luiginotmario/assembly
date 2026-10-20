try {
  process.loadEnvFile();
} catch {
  // no .env: fine, the guide agent just stays off until there's a key
}

// running it on your own computer: the api, your photos from disk, and the built site
const { serve } = await import('@hono/node-server');
const { serveStatic } = await import('@hono/node-server/serve-static');
const { readFile } = await import('node:fs/promises');
const { networkInterfaces } = await import('node:os');
const path = await import('node:path');
const { app } = await import('./app.js');
const { hasKey } = await import('./llm.js');
const sessions = await import('./sessions.js');

const PORT = Number(process.env.PORT ?? 8787);

app.get('/files/:id/:name', async (c) => {
  const { id, name } = c.req.param();
  if (!/^[A-Za-z0-9]{8,32}$/.test(id) || !/^[A-Za-z0-9-]+\.jpg$/.test(name)) return c.notFound();
  try {
    const data = await readFile(path.join(sessions.folder(id), name));
    return c.body(data, 200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000, immutable' });
  } catch {
    return c.notFound();
  }
});

// the built site (pnpm build); during development vite serves it instead
// any built file (scripts, the example photos, the icons), then the page for every other path
app.use('/*', serveStatic({ root: './web/dist' }));
app.get('*', serveStatic({ root: './web/dist', path: 'index.html' }));

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, () => {
  console.log(`hardware-guide is up on http://localhost:${PORT}`);
  for (const a of Object.values(networkInterfaces()).flat()) {
    if (a && a.family === 'IPv4' && !a.internal) console.log(`  on your phone (same wifi): http://${a.address}:${PORT}`);
  }
  if (!hasKey()) console.log('  no OPENROUTER_API_KEY yet: the example works, the guide agent is off');
});

export {};
