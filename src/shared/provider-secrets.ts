import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "./config.js";
import { saveSecret } from "./secrets.js";

/**
 * Build a safe env var name for a custom provider API key.
 * Normalizes IDs like "my-proxy" to "JERIKO_PROVIDER_MY_PROXY_API_KEY".
 */
export function getProviderApiKeyEnvVar(providerId: string): string {
  const normalized = providerId
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  const safe = normalized && !/^\d/.test(normalized) ? normalized : `P_${normalized || "CUSTOM"}`;
  return `JERIKO_PROVIDER_${safe}_API_KEY`;
}

/** Save a provider API key into the secrets file and return its env ref. */
export function persistProviderApiKey(providerId: string, apiKey: string): string {
  const envVar = getProviderApiKeyEnvVar(providerId);
  saveSecret(envVar, apiKey);
  return `{env:${envVar}}`;
}

const OPENAI_CODEX_PROFILE_PATH = "openai-codex-profile.json";
const OPENAI_CODEX_PROFILES_PATH = "openai-codex-profiles.json";
const OPENAI_CODEX_PREFERENCE_ENV = "OPENAI_CODEX_PROFILE_PREFERENCE";

export type OpenAICodexProfileId = "personal" | "business";

export const OPENAI_CODEX_PROFILE_IDS: readonly OpenAICodexProfileId[] = ["personal", "business"] as const;

export const OPENAI_CODEX_PROFILE_LABELS: Record<OpenAICodexProfileId, string> = {
  personal: "Personal",
  business: "Business",
};

const OPENAI_CODEX_ENV_BY_PROFILE: Record<
  OpenAICodexProfileId,
  { accessToken: string; refreshToken: string; expiresAt: string }
> = {
  personal: {
    accessToken: "OPENAI_CODEX_PERSONAL_API_KEY",
    refreshToken: "OPENAI_CODEX_PERSONAL_REFRESH_TOKEN",
    expiresAt: "OPENAI_CODEX_PERSONAL_EXPIRES_AT",
  },
  business: {
    accessToken: "OPENAI_CODEX_BUSINESS_API_KEY",
    refreshToken: "OPENAI_CODEX_BUSINESS_REFRESH_TOKEN",
    expiresAt: "OPENAI_CODEX_BUSINESS_EXPIRES_AT",
  },
};

const ACTIVE_OPENAI_CODEX_ENVS = {
  accessToken: "OPENAI_CODEX_API_KEY",
  refreshToken: "OPENAI_CODEX_REFRESH_TOKEN",
  expiresAt: "OPENAI_CODEX_EXPIRES_AT",
} as const;

export interface OpenAICodexProfile {
  provider: "openai-codex";
  mode: "codex-oauth";
  profileId: OpenAICodexProfileId;
  accessTokenEnv: string;
  refreshTokenEnv: string;
  expiresAtEnv: string;
  expiresAt?: number;
  account: {
    id?: string;
    userId?: string;
    accountUserId?: string;
    email?: string;
    name?: string;
    subject?: string;
  };
  updatedAt: string;
}

export interface OpenAICodexProfilesState {
  provider: "openai-codex";
  mode: "codex-oauth";
  preference: OpenAICodexProfileId[];
  activeProfile?: OpenAICodexProfileId;
  profiles: Partial<Record<OpenAICodexProfileId, OpenAICodexProfile>>;
  updatedAt: string;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const decoded = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return asRecord(JSON.parse(decoded));
  } catch {
    return undefined;
  }
}

function deriveOpenAICodexAccount(accessToken: string, raw: Record<string, unknown>): OpenAICodexProfile["account"] {
  const payload = decodeJwtPayload(accessToken);
  const auth = asRecord(payload?.["https://api.openai.com/auth"]);
  const profile = asRecord(payload?.["https://api.openai.com/profile"]);
  const rawProfile = asRecord(raw.profile);
  const rawUser = asRecord(raw.user);

  return {
    id: normalizeNonEmptyString(auth?.chatgpt_account_id)
      ?? normalizeNonEmptyString(raw.account_id)
      ?? normalizeNonEmptyString(rawProfile?.id)
      ?? normalizeNonEmptyString(rawUser?.id),
    userId: normalizeNonEmptyString(auth?.chatgpt_user_id)
      ?? normalizeNonEmptyString(auth?.user_id)
      ?? normalizeNonEmptyString(raw.user_id),
    accountUserId: normalizeNonEmptyString(auth?.chatgpt_account_user_id)
      ?? normalizeNonEmptyString(raw.account_user_id),
    email: normalizeNonEmptyString(profile?.email)
      ?? normalizeNonEmptyString(raw.email)
      ?? normalizeNonEmptyString(rawProfile?.email)
      ?? normalizeNonEmptyString(rawUser?.email),
    name: normalizeNonEmptyString(profile?.name)
      ?? normalizeNonEmptyString(raw.name)
      ?? normalizeNonEmptyString(rawProfile?.name)
      ?? normalizeNonEmptyString(rawUser?.name),
    subject: normalizeNonEmptyString(payload?.sub),
  };
}

function resolveExpiresAt(raw: Record<string, unknown>): number | undefined {
  const expiresAt = raw.expires_at;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
    return expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  }

  const auth = asRecord(raw.auth);
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : auth?.expires_in;
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return Date.now() + expiresIn * 1000;
  }

  return undefined;
}

function normalizePreference(
  preference?: readonly OpenAICodexProfileId[],
  preferredFirst?: OpenAICodexProfileId,
): OpenAICodexProfileId[] {
  const ordered: OpenAICodexProfileId[] = [];
  const seen = new Set<OpenAICodexProfileId>();

  for (const id of [preferredFirst, ...(preference ?? []), ...OPENAI_CODEX_PROFILE_IDS]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }

  return ordered;
}

function getConfigPath(fileName: string): string {
  return join(getConfigDir(), fileName);
}

function loadOpenAICodexProfilesState(): OpenAICodexProfilesState {
  const filePath = getConfigPath(OPENAI_CODEX_PROFILES_PATH);
  if (!existsSync(filePath)) {
    return {
      provider: "openai-codex",
      mode: "codex-oauth",
      preference: [...OPENAI_CODEX_PROFILE_IDS],
      profiles: {},
      updatedAt: new Date().toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<OpenAICodexProfilesState>;
    return {
      provider: "openai-codex",
      mode: "codex-oauth",
      preference: normalizePreference(parsed.preference),
      activeProfile: parsed.activeProfile,
      profiles: parsed.profiles ?? {},
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return {
      provider: "openai-codex",
      mode: "codex-oauth",
      preference: [...OPENAI_CODEX_PROFILE_IDS],
      profiles: {},
      updatedAt: new Date().toISOString(),
    };
  }
}

function writeOpenAICodexProfilesState(state: OpenAICodexProfilesState): void {
  const configDir = getConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(getConfigPath(OPENAI_CODEX_PROFILES_PATH), `${JSON.stringify(state, null, 2)}\n`);

  const activeProfile = state.activeProfile ? state.profiles[state.activeProfile] : undefined;
  if (activeProfile) {
    writeFileSync(getConfigPath(OPENAI_CODEX_PROFILE_PATH), `${JSON.stringify(activeProfile, null, 2)}\n`);
  }
}

export function getOpenAICodexProfileEnv(profileId: OpenAICodexProfileId): {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
} {
  return OPENAI_CODEX_ENV_BY_PROFILE[profileId];
}

export function setOpenAICodexProfilePreference(
  preference: readonly OpenAICodexProfileId[],
): OpenAICodexProfilesState {
  const state = loadOpenAICodexProfilesState();
  state.preference = normalizePreference(preference);

  let activeProfile: OpenAICodexProfileId | undefined;
  for (const profileId of state.preference) {
    const envs = getOpenAICodexProfileEnv(profileId);
    const accessToken = state.profiles[profileId]?.accessTokenEnv
      ? process.env[state.profiles[profileId]!.accessTokenEnv]
      : process.env[envs.accessToken];
    if (accessToken) {
      activeProfile = profileId;
      saveSecret(ACTIVE_OPENAI_CODEX_ENVS.accessToken, accessToken);

      const refreshToken = process.env[envs.refreshToken];
      if (refreshToken) saveSecret(ACTIVE_OPENAI_CODEX_ENVS.refreshToken, refreshToken);

      const expiresAt = process.env[envs.expiresAt];
      if (expiresAt) saveSecret(ACTIVE_OPENAI_CODEX_ENVS.expiresAt, expiresAt);
      break;
    }
  }

  state.activeProfile = activeProfile;
  state.updatedAt = new Date().toISOString();
  saveSecret(OPENAI_CODEX_PREFERENCE_ENV, state.preference.join(","));
  writeOpenAICodexProfilesState(state);
  return state;
}

/**
 * Persist native OpenAI Codex OAuth credentials on the dedicated Codex lane.
 *
 * - the OAuth access token is written to a named profile lane and mirrored into OPENAI_CODEX_API_KEY.
 * - refresh token and expiry come from the auth exchange and are stored both per-profile and active.
 * - account/profile metadata is stored in a small JSON sidecar for future refresh/profile work.
 */
export function persistOpenAICodexOAuth(
  raw: Record<string, unknown>,
  profileId: OpenAICodexProfileId = "personal",
  preference?: readonly OpenAICodexProfileId[],
): OpenAICodexProfilesState {
  const tokenExchange = asRecord(raw.tokenExchange);
  const accessToken = normalizeNonEmptyString(raw.access_token)
    ?? normalizeNonEmptyString(tokenExchange?.key)
    ?? normalizeNonEmptyString(tokenExchange?.access_token);
  if (!accessToken) {
    throw new Error("OpenAI Codex OAuth response missing access token");
  }

  const auth = asRecord(raw.auth);
  const refreshToken = normalizeNonEmptyString(raw.refresh_token)
    ?? normalizeNonEmptyString(auth?.refresh_token);
  const expiresAt = resolveExpiresAt(raw);
  const account = deriveOpenAICodexAccount(accessToken, raw);
  const envs = getOpenAICodexProfileEnv(profileId);

  saveSecret(envs.accessToken, accessToken);
  if (refreshToken) saveSecret(envs.refreshToken, refreshToken);
  if (expiresAt) saveSecret(envs.expiresAt, String(expiresAt));

  const profile: OpenAICodexProfile = {
    provider: "openai-codex",
    mode: "codex-oauth",
    profileId,
    accessTokenEnv: envs.accessToken,
    refreshTokenEnv: envs.refreshToken,
    expiresAtEnv: envs.expiresAt,
    expiresAt,
    account,
    updatedAt: new Date().toISOString(),
  };

  const state = loadOpenAICodexProfilesState();
  state.profiles[profileId] = profile;
  state.preference = normalizePreference(preference ?? state.preference, profileId);
  state.updatedAt = new Date().toISOString();
  writeOpenAICodexProfilesState(state);

  return setOpenAICodexProfilePreference(state.preference);
}
