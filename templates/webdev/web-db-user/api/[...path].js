// Vercel serverless entrypoint. Keep this API-only: do not import Vite or static serving here.
// The bundled app exposes /api/health, /api/oauth/callback, and /api/trpc/*.
export { default } from "../dist/api-app.js";
