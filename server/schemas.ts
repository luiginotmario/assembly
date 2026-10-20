// JSON schemas the model must answer in. Strict mode: every field required, nothing extra.

const str = { type: 'string' };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const list = (items: object) => ({ type: 'array', items });
const oneOf = (...values: string[]) => ({ type: 'string', enum: values });
const obj = (properties: Record<string, object>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const side = oneOf('top', 'bottom', 'left', 'right');
const end = obj({ part: str, pin: str });

export const connection = obj({ from: end, to: end, wire: str, note: str });

export const part = obj({
  id: str,
  name: str,
  model: str,
  kind: oneOf('board', 'adapter', 'sensor', 'cable', 'computer', 'other'),
  size: obj({ w: num, h: num, t: num }),
  color: str,
  pitch: num,
  pins: list(obj({ id: str, label: str, side, index: int, style: oneOf('header', 'socket', 'pad') })),
  features: list(obj({ kind: oneOf('usb-a', 'usb-c', 'socket', 'chip', 'antenna'), side, at: num, label: str })),
  estimated: bool,
  source: str,
  note: str,
});

export const step = obj({
  title: str,
  instruction: str,
  show: list(str),
  connections: list(connection),
  focus: list(str),
  caution: str,
  check: str,
});

export const guide = obj({ title: str, summary: str, parts: list(part), steps: list(step) });

export const visual = obj({ focus: list(str), connections: list(connection), step: { type: ['integer', 'null'] } });

const box = obj({ x0: num, y0: num, x1: num, y1: num });

export const firstLook = obj({
  quality: oneOf('good', 'retake'),
  retake: str,
  seen: str,
  zoom: list(obj({ box, why: str })),
});

export const closeLook = obj({
  quality: oneOf('good', 'retake'),
  retake: str,
  seen: str,
  labels: list(obj({ where: str, text: str })),
  parts: list(str),
  verdict: oneOf('ok', 'wrong', 'unsure', 'none'),
  explanation: str,
  visual,
});

export const answer = obj({ reply: str, visual });

const point = obj({ x: num, y: num });
const source = obj({ url: str, title: str });

/** a part's real specs, from what a web search found */
export const research = obj({
  found: bool,
  name: str,
  model: str,
  kind: oneOf('board', 'adapter', 'sensor', 'cable', 'computer', 'other'),
  size: obj({ w: num, h: num, t: num }),
  color: str,
  pitch: num,
  pins: list(obj({ id: str, label: str, side, index: int, style: oneOf('header', 'socket', 'pad') })),
  features: list(obj({ kind: oneOf('usb-a', 'usb-c', 'socket', 'chip', 'antenna'), side, at: num, label: str })),
  sources: list(source),
  missing: list(str),
  note: str,
});

/** the physical parts a plan mentions */
export const partsInPlan = obj({ parts: list(obj({ name: str, model: str, count: int })) });

/** where each board is in a photo, and boards it can't match to a known part */
export const boards = obj({
  boards: list(obj({ part: str, whole: bool, corners: list(point) })),
  unknown: list(obj({ markings: str, description: str })),
});

/** a corner placed exactly, in each zoomed crop */
export const corners = obj({ corners: list(obj({ found: bool, at: point })) });

/** pins measured off the straightened board */
export const pinsOnBoard = obj({ pins: list(obj({ id: str, label: str, u: num, v: num, side })) });
