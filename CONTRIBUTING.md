# contributing

thanks for wanting to help. assembly stays useful by staying simple, so here's the deal:

**yes please**
- parts measured on real boards, in `shared/library.ts`
- more design files it can read (step, more urdf quirks, gltf scenes)
- making the drawing look more like the real thing
- bug fixes

**probably not**
- accounts, dashboards, settings — the agent is the interface, the manual is a link

## getting set up

```
pnpm install
pnpm dev          # the page on http://localhost:5180, the mcp server on http://localhost:5180/mcp
pnpm check        # types
```

- the manual format is `shared/types.ts`, and `shared/manual.ts` checks what an agent sends. errors should say exactly what to fix.
- the tools agents use are in `server/mcp.ts`; their descriptions are the instructions agents follow, so write them carefully.
- the 3d drawing is `web/src/drawing/`. no ui framework on the page: plain typescript and vite.
- keep it light. if a change adds a heavy dependency or something that runs in the background, say why in the pr.

open a pr with what you changed and how you tested it (a manual made by a real agent is the best test). small prs get merged fastest.
