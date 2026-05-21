export { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

export const LOGIN_PATH = "/login";
export const GOOGLE_LOGIN_PATH = "/api/oauth/google/start";

export type GoogleAuthSetupState = "ready" | "setup_required";

export const getLoginUrl = () => LOGIN_PATH;

export const getGoogleLoginUrl = () => GOOGLE_LOGIN_PATH;

export const getGoogleAuthSetupMessage = (state: GoogleAuthSetupState = "setup_required") => {
  if (state === "ready") {
    return "Google sign-in is ready for this deployment.";
  }

  return "Google sign-in needs OAuth portal, app ID, and OAuth server URL configured on the server. Email/password login remains available.";
};
