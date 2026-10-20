// What you paste into the coding agent that knows your project. It writes the build plan
// and, if it can run commands, sends it straight here; otherwise you paste it back.

export const agentPrompt = (origin: string, session: string) => `I'm using a visual assembly guide (a 3D step-by-step drawing) to put together the hardware we're working on. Please write the build plan for it.

Include:
1. What we're building, in one or two sentences.
2. Every physical part, with its exact name or model as printed on it or as sold (e.g. "HLK-LD2450", "CP2102 USB to TTL adapter"), and how many of each.
3. For each part, the pin labels exactly as printed on the board, in the order they physically sit, and which edge they're on, if you know them. Say if a part has a plug or socket instead of pins.
4. Every connection, pin to pin (e.g. "LD2450 TX -> CP2102 RXD"), with wire colours if we know them.
5. The order to put it together in, and anything that could damage a part (power, polarity, 5V vs 3.3V, pins to leave empty).

Mark what we've confirmed on the real hardware (from photos, labels, tests) versus what comes from datasheets; the real hardware wins.

Then send the plan to the guide by running:

curl -X POST ${origin}/api/sessions/${session}/plan -H 'content-type: text/plain' --data-binary @- <<'PLAN'
(the plan goes here)
PLAN

If you can't run commands, just print the plan and I'll paste it in.`;
