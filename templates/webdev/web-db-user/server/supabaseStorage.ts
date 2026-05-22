import { createClient } from "@supabase/supabase-js";
import { ENV } from "./_core/env";

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_APP_SUPABASE_URL || "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const bucket = process.env["{{app_env_prefix}}_SUPABASE_STORAGE_BUCKET"] || "inventory-photos";

export const supabaseStorageConfigured = Boolean(supabaseUrl && serviceRoleKey);

export function getSupabaseStorageBucket() {
  return bucket;
}

export function getSupabaseAdminClient() {
  if (!supabaseStorageConfigured) {
    throw new Error(
      "Supabase Storage is not configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and {{app_env_prefix}}_SUPABASE_STORAGE_BUCKET before accepting photo uploads."
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function buildInventoryPhotoPath(ownerOpenId: string, fileName: string) {
  const safeOwner = ownerOpenId.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${safeOwner}/${Date.now()}-${safeName}`;
}

export async function uploadInventoryPhoto(args: {
  ownerOpenId: string;
  fileName: string;
  data: Blob | ArrayBuffer | Uint8Array;
  contentType?: string;
}) {
  const client = getSupabaseAdminClient();
  const path = buildInventoryPhotoPath(args.ownerOpenId, args.fileName);
  const { error } = await client.storage.from(bucket).upload(path, args.data, {
    contentType: args.contentType || "application/octet-stream",
    upsert: false,
  });

  if (error) {
    throw new Error(`Supabase Storage upload failed: ${error.message}`);
  }

  const { data } = client.storage.from(bucket).getPublicUrl(path);
  return { bucket, path, publicUrl: data.publicUrl };
}
