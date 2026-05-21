import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_APP_SUPABASE_URL ?? "";
const supabaseAnonKey = import.meta.env.VITE_APP_SUPABASE_ANON_KEY ?? "";

export const supabaseAuthConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = supabaseAuthConfigured
  ? createClient(supabaseUrl, supabaseAnonKey)
  : null;

export function getSupabaseAuthCallbackUrl(path = "/auth/callback") {
  if (typeof window === "undefined") return path;
  return new URL(path, window.location.origin).toString();
}

export async function signInWithGoogle(redirectTo = getSupabaseAuthCallbackUrl()) {
  if (!supabase) {
    throw new Error("Supabase Auth is not configured. Set VITE_APP_SUPABASE_URL and VITE_APP_SUPABASE_ANON_KEY, then authorize https://<project-ref>.supabase.co/auth/v1/callback in Google Cloud.");
  }

  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });
}
