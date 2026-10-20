# hi, this is assembly

putting hardware together for the first time is confusing when all you get is text. "connect TX to RXD" means nothing if you've never held a jumper wire. this turns a build plan into a 3D assembly drawing you follow one step at a time, and checks your wiring from a photo.

- free and open source (MIT)
- runs on your own computer. no accounts, no sign-up.
- the ai goes through [openrouter](https://openrouter.ai), with any vision model you like

## how it works

1. **your agent writes the plan.** copy the prompt from the sidebar into the coding agent that already knows your project (it knows which parts you bought and how they connect). it writes a build plan and sends it straight to the page, or prints it for you to paste.
2. **the guide draws it.** every part becomes a 3D line drawing with its real pins and printed labels. each step draws itself in: the wires arc from pin to pin in their real colours and plug on, with the pins to look at circled in red. cautions (power, polarity, pins to leave empty) are in red too.
3. **your phone checks it.** open the same session on your phone (scan the qr code), take a photo, and the guide looks at it, zooms in on the tiny printed labels to read them, and tells you if the wiring matches the step. if the photo's too blurry it asks you to retake it.
4. **ask anything.** the answer comes back drawn: it jumps to the step, circles the pin, animates the wire.

the phone and the computer stay in sync: photos, steps and answers show up on both.

parts it knows exactly (from datasheets, checked on real boards) are drawn exactly. anything else is drawn from the datasheet if the model knows it, or estimated and marked with a dashed outline.

## try it

- install [node 22](https://nodejs.org) and [pnpm](https://pnpm.io)
- copy `.env.example` to `.env` and add your [openrouter key](https://openrouter.ai/keys)
- then:

```
pnpm install
pnpm dev
```

- open http://localhost:5180 — done. hit **see an example** to see a real build (two radar sensors wired to a mac) without a key.

on your phone, use the **open on your phone** qr code (same wifi).

to run it without dev tools: `pnpm build && pnpm start`, then open http://localhost:8787.

## how it's built

```
shared/types.ts      the guide format: parts, pins, connections, steps
shared/library.ts    parts we know exactly
server/              a small node server (hono): sessions, live sync, uploads, the guide agent
server/agent.ts      plan -> guide, photo -> zoom in -> read -> check, question -> answer + what to draw
web/src/drawing/     the 3D drawing (three.js): parts from their specs, wires, steps, callouts
web/src/app.ts       the page: agent prompt, plan, photos, questions, the step panel
```

the model can be any vision model on openrouter: set `MODEL` in `.env` (default `anthropic/claude-sonnet-5.5`).

## if you wanna make an addition + pr, or just wanna remix it for yourself, go for it

the easiest thing to add is a part: put its size, pins and features in `shared/library.ts` and it gets drawn exactly from then on.

## license

[MIT](LICENSE) — made by [@giginotmario](https://x.com/giginotmario)
