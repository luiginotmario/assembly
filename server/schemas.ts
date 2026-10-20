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

// a step to jump to, or null to stay
export const visual = obj({ focus: list(str), connections: list(connection), step: { anyOf: [int, { type: 'null' }] } });

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

const point = obj({ x: num, y: num });

/** where each board of the manual is in a photo */
export const boards = obj({
  boards: list(obj({ part: str, whole: bool, corners: list(point) })),
});

/** a corner placed exactly, in each zoomed crop */
export const corners = obj({ corners: list(obj({ found: bool, at: point })) });

/** pins measured off the straightened board */
export const pinsOnBoard = obj({ pins: list(obj({ id: str, label: str, u: num, v: num, side })) });
