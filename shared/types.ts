// The shapes the server, the guide agent and the 3D drawing all share.
// Everything physical is in millimetres. Looking down at a part lying on the table,
// "top" is its far edge, "bottom" the edge nearest you, "left" and "right" as you'd expect.

export type Side = 'top' | 'bottom' | 'left' | 'right';

export type Pin = {
  id: string;
  /** exactly as printed on the board */
  label: string;
  side: Side;
  /** position along its side: top/bottom count left to right, left/right count far to near */
  index: number;
  /** header = metal pin, socket = a small plug housing, pad = flat solder pad */
  style: 'header' | 'socket' | 'pad';
  /** exactly where it sits, measured off a photo of the real board: u across (0 left, 1 right),
   * v front to back (0 far edge, 1 near edge). Without it, pins spread evenly along their side */
  at?: { u: number; v: number };
};

export type Source = { url: string; title: string };

export type Feature = {
  kind: 'usb-a' | 'usb-c' | 'socket' | 'chip' | 'antenna';
  side: Side;
  /** 0..1 along that side */
  at: number;
  label: string;
};

export type Part = {
  id: string;
  name: string;
  model: string;
  kind: 'board' | 'adapter' | 'sensor' | 'cable' | 'computer' | 'other';
  /** w across, h front to back, t thickness */
  size: { w: number; h: number; t: number };
  /** the board's real colour, used as a faint tint */
  color: string;
  /** distance between neighbouring pins */
  pitch: number;
  pins: Pin[];
  features: Feature[];
  /** true when the geometry is a best guess rather than from a datasheet */
  estimated: boolean;
  /** where the geometry came from: "library", a datasheet url, or "estimate" */
  source: string;
  note: string;
  /** a straightened photo of the real board's top, laid onto the 3d part */
  texture?: string;
  /** the pages the specs came from */
  sources?: Source[];
};

export type End = { part: string; pin: string };

export type Connection = {
  from: End;
  to: End;
  /** the real wire colour if known, e.g. "black"; empty if not */
  wire: string;
  note: string;
};

export type Step = {
  title: string;
  /** one or two plain sentences */
  instruction: string;
  /** part ids that appear from this step on */
  show: string[];
  connections: Connection[];
  /** part ids, or "part.pin", to draw the eye to */
  focus: string[];
  /** anything that can damage a part, or empty */
  caution: string;
  /** what to verify before moving on, or empty */
  check: string;
};

export type Guide = {
  title: string;
  summary: string;
  parts: Part[];
  steps: Step[];
};

/** what the agent wants shown on the drawing alongside an answer */
export type Visual = {
  focus: string[];
  connections: Connection[];
  /** jump to this step, or null to stay */
  step: number | null;
};

export type PhotoAnalysis = {
  quality: 'good' | 'retake';
  /** what to do differently, if quality is retake */
  retake: string;
  /** a plain description of what's in the photo */
  seen: string;
  /** text read off the parts, after zooming in */
  labels: { where: string; text: string }[];
  /** guide part ids recognised in the photo */
  parts: string[];
  /** does the wiring match the current step */
  verdict: 'ok' | 'wrong' | 'unsure' | 'none';
  explanation: string;
  visual: Visual;
};

export type Photo = {
  id: string;
  file: string;
  createdAt: number;
  /** the step they were on when they took it */
  step: number;
  /** waiting: no key on the manual, so it's saved for the user's agent to look at and answer */
  status: 'waiting' | 'reading' | 'done' | 'retake' | 'error';
  /** who answered it: the page's model (with the manual's key) or the user's agent */
  answeredBy: 'page' | 'agent' | null;
  /** zoomed-in crops the labels were read from */
  crops: string[];
  analysis: PhotoAnalysis | null;
  /** boards from this photo that are now laid onto their 3d parts */
  captured: string[];
  error: string;
};

export type Provider = 'openrouter' | 'anthropic' | 'openai';

/** what anyone may see about the key a manual checks photos with; the key itself never leaves the server */
export type KeyInfo = { provider: Provider; last4: string; connectedAt: number };

/** a manual: the guide an agent wrote, the step every device is on, and the photos checked against it */
export type Manual = {
  id: string;
  createdAt: number;
  updatedAt: number;
  guide: Guide;
  step: number;
  photos: Photo[];
  key: KeyInfo | null;
};
