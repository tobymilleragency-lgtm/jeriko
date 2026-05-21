const readEnv = (keys: string[]) => {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return { value, key };
  }
  return { value: "", key: keys[0] ?? "" };
};

const appId = readEnv(["APP_ID", "VITE_APP_ID"]);
const oAuthPortalUrl = readEnv(["OAUTH_PORTAL_URL", "VITE_OAUTH_PORTAL_URL"]);
const oAuthServerUrl = readEnv(["OAUTH_SERVER_URL"]);
const cookieSecret = process.env.JWT_SECRET ?? "";

if (process.env.NODE_ENV === "production" && !cookieSecret) {
  throw new Error("JWT_SECRET is required in production for secure session signing.");
}

export const ENV = {
  appId: appId.value,
  appIdKey: appId.key,
  cookieSecret,
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthPortalUrl: oAuthPortalUrl.value,
  oAuthPortalUrlKey: oAuthPortalUrl.key,
  oAuthServerUrl: oAuthServerUrl.value,
  oAuthServerUrlKey: oAuthServerUrl.key,
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};

export const googleOAuthSetup = {
  ready: Boolean(ENV.appId && ENV.oAuthPortalUrl && ENV.oAuthServerUrl),
  missingKeys: [
    [ENV.appIdKey, ENV.appId],
    [ENV.oAuthPortalUrlKey, ENV.oAuthPortalUrl],
    [ENV.oAuthServerUrlKey, ENV.oAuthServerUrl],
  ].filter(([, value]) => !value).map(([key]) => key),
};
