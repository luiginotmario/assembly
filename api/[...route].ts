import { handle } from 'hono/vercel';
import { app } from '../server/app.js';

// on Vercel every /api request lands here and goes to the same app as locally
export const GET = handle(app);
export const POST = handle(app);
