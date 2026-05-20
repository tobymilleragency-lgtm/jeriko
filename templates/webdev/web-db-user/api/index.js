// Vercel serverless entrypoint. The bundled app exposes /api/health, /api/oauth/callback, and /api/trpc/*.
export { default } from "./[...path].js";
