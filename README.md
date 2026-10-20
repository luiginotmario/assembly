# hi, this is assembly

putting hardware together for the first time is confusing when all you get is text. "connect TX to RXD" means nothing if you've never held a jumper wire, and "attach the wrist to the forearm" means nothing until you see which way round. assembly lets your coding agent make you a 3D assembly manual of whatever you're building, one step at a time, like the booklet in the box: wiring, boards, 3D-printed parts, motors, robots, enclosures. and it checks your work from a photo when you're stuck.

- free and open source (MIT)
- no accounts, no sign-up. a manual is a link.
- no keys needed: your agent does the thinking (it already knows your parts). a key is optional, for photo checks right on the page
- light: no framework on the page. the landing page is a few KB, and the 3D drawing only loads when you open a manual.

## how it works

1. **add it to your agent.** assembly is an MCP server. in claude code:

   ```
   claude mcp add --transport http assembly https://assembly-guide.dev/mcp
   ```

   any other agent: add `https://assembly-guide.dev/mcp` as an MCP server (streamable http).

2. **ask for a manual.** "make me an assembly manual for this build." the agent uses the project's own design files where they exist (a robot's URDF, the STL/OBJ/GLB/3MF of each printed part or board), looks everything else up (board size, pinout as printed), writes the steps and gets back a link. parts we've measured on real boards (LD2450, LD2410C, CP2102) are drawn from those measurements.
3. **follow it.** the drawing is your build: real shapes, real colours, every part where it really goes. each step slides its parts in from the way your hand brings them, lists its screws by size and count, turns the view when the work is on the other side, says "do this 4 times" when it repeats, and draws its wires in pin to pin in their real colours, with the pins to look at circled in red. open it on your phone with the qr code; both stay on the same step.
4. **stuck? take a photo.** "is this the part you mean?" two ways, your choice:
   - **no key:** the photo is saved. tell your agent "check my photo": it looks at it, answers you, and the page shows its answer with the part and pins it means highlighted.
   - **with a key** (sign in with openrouter, or paste an openrouter, anthropic or openai key): the page answers by itself, right away. it zooms into the tiny printed labels, says which part it is and highlights exactly which pins and wires the step means. boards that show up whole get straightened and laid onto their 3D part, so the drawing looks like your hardware. the key is stored encrypted with that manual and only used for its photos.

questions go to your agent, which can also fix the manual (`update_manual`).

### tools

| tool | what it does |
| --- | --- |
| `read_cad` | reads a design file (a URDF, or one 3D file) and lists its pieces with their 3D files and positions |
| `create_manual` | checks the manual (every wire must land on a real pin), stores it, returns the link and an edit token |
| `update_manual` | replaces the guide; open pages update by themselves, photos of your boards stay |
| `get_manual` | the guide, the step you're on, and every photo (and which wait for an answer) |
| `get_photo` | a photo you took on the page, as an image |
| `answer_photo` | its answer, shown on the page with the part, pins and wires highlighted |

no MCP? the same over plain http: `POST /api/manuals` with the manual as JSON, `PUT /api/manuals/:id` with `authorization: Bearer <edit token>`, `GET /api/manuals/:id/checks`.

## what's stored

nothing about you. no accounts, no analytics, and no cookies except the key one below (plus a 15-minute one while you sign in with openrouter).

- **a manual** (what your agent sent) and the step you're on, for 90 days after it last changed. anyone with its link can open it, so treat the link like the manual itself. its id is random and long enough not to be guessed.
- **photos you take on a manual**, with the close-ups that were read, in the same place for as long as the manual.
- **a key, only if you connect one.** it's sealed (aes-256-gcm) with that one manual and used only for its photo checks; it's never sent back to a browser. your browser keeps a sealed copy in a cookie it can't read, so your next manual can reuse it with one tap. disconnecting deletes both.
- **design files** your agent points at (urdf, stl, …) are read when it asks, never stored; the page loads 3D models straight from where they're published.

## how it's built

```
shared/types.ts       the manual format: parts (3D models or boards with pins), poses, steps, fasteners, wires
shared/manual.ts      checking what an agent sends, with errors that say what to fix
shared/library.ts     parts measured on real boards
server/mcp.ts         the MCP server and its tools
server/cad.ts         design files -> parts with real 3D models in their places
server/photos.ts      photo -> zoom in -> read labels -> check against the step -> lay boards onto the drawing
server/keys.ts        sealing keys, openrouter sign-in
web/src/manual.ts     the page: the drawing, the step, the photo check
web/src/drawing/      the 3D drawing (three.js): real models or generated boards, slide-ins, views, wires, callouts
```

the page is plain typescript and three.js, built with vite; the server is a small hono app (node locally, a vercel function hosted).

## if you wanna make an addition + pr, or just wanna remix it for yourself, go for it

- clone the repo
- install [node 22](https://nodejs.org) and [pnpm](https://pnpm.io)
- `pnpm install && pnpm dev`, then open http://localhost:5180 — done, you're up and running.
- add your local copy to your agent with `claude mcp add --transport http assembly http://localhost:5180/mcp`
- optional: put `OPENROUTER_API_KEY` in `.env` and every local manual checks photos with it, no connecting

the easiest thing to add is a part: put its size, pins and features in `shared/library.ts` and it gets drawn exactly from then on.

to host it on vercel: link an upstash redis database (manuals) and a blob store (photos) to the project, and set `KEY_SECRET` to any long random string (keys are sealed with it).

make changes on a pr and i'll ship them :)

## license

[MIT](LICENSE) — made by [@giginotmario](https://x.com/giginotmario)
