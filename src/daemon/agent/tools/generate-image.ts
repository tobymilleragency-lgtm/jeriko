// Tool — Image generation from text prompts.
//
// Provider-agnostic: delegates to the media/image-gen service which
// supports Google Imagen, FAL.ai FLUX, and DALL-E 3 with auto-detection of available keys.
//
// Generated images are saved to tmpdir. The channel router auto-detects
// image file paths in tool results and sends them via sendPhoto().

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { registerTool } from "./registry.js";
import type { ToolDefinition } from "./registry.js";
import type { ImageGenConfig } from "../../../shared/config.js";
import { loadConfig } from "../../../shared/config.js";

async function execute(args: Record<string, unknown>): Promise<string> {
  const prompt = args.prompt as string | undefined;
  if (!prompt?.trim()) {
    return JSON.stringify({ ok: false, error: "prompt is required" });
  }

  try {
    const { generateImage } = await import("../../services/media/image-gen.js");

    const config = loadConfig();
    const imageGenConfig: ImageGenConfig | undefined = config.media?.imageGen;

    const result = await generateImage(
      {
        prompt: prompt.trim(),
        size: (args.size as string) ?? undefined,
        style: (args.style as string) ?? undefined,
        provider: (args.provider as string) ?? undefined,
        model: (args.model as string) ?? undefined,
      },
      imageGenConfig,
    );

    const savedPath = resolveRequestedOutputPath(args.output_path, args.cwd);
    if (savedPath) {
      mkdirSync(dirname(savedPath), { recursive: true });
      copyFileSync(result.path, savedPath);
    }
    const finalPath = savedPath ?? result.path;

    return JSON.stringify({
      ok: true,
      path: finalPath,
      savedPath: savedPath ?? undefined,
      generatedPath: savedPath ? result.path : undefined,
      url: result.url,
      revisedPrompt: result.revisedPrompt,
      provider: result.provider,
      model: result.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ ok: false, error: msg });
  }
}

function resolveRequestedOutputPath(outputPath: unknown, cwd: unknown): string | undefined {
  if (typeof outputPath !== "string" || !outputPath.trim()) return undefined;
  const base = typeof cwd === "string" && cwd.trim() ? resolve(cwd) : process.cwd();
  const target = resolve(base, outputPath.trim());
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  if (target !== base && !target.startsWith(normalizedBase)) {
    throw new Error(`output_path must stay inside cwd (${base})`);
  }
  return target;
}

export const generateImageTool: ToolDefinition = {
  id: "generate_image",
  name: "generate_image",
  description:
    "Generate an image or realistic website photo from a text prompt using Google Imagen, FAL.ai FLUX, DALL-E 3, or another configured provider. " +
    "Use this for website hero photos, service images, Open Graph cards, icons, mockups, and marketing assets. " +
    "For generated sites, pass output_path such as client/public/images/hero.png so the real file is saved inside the app and can be referenced by components. " +
    "Returns the local file path to the generated image. " +
    "The image will be automatically sent if the conversation is in a channel (Telegram/WhatsApp).",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Detailed description of the image to generate. Be specific about content, style, composition, and mood.",
      },
      size: {
        type: "string",
        description: 'Image dimensions/aspect ratio: "1792x1024" or "16:9" (landscape), "1024x1792" or "9:16" (portrait), "1024x1024" or "1:1" (square). Default: provider-specific.',
        enum: ["1024x1024", "1024x1792", "1792x1024", "16:9", "9:16", "1:1"],
      },
      style: {
        type: "string",
        description: 'Image style: "vivid" (hyper-real, dramatic) or "natural" (more subdued, realistic). Default: "vivid".',
        enum: ["vivid", "natural"],
      },
      provider: {
        type: "string",
        description: 'Image generation provider: "google" (Google Imagen), "fal" (FAL.ai FLUX), "openai" (DALL-E 3), or "auto" (first available). Default: "auto".',
        enum: ["auto", "google", "fal", "openai"],
      },
      model: {
        type: "string",
        description: 'Provider model override. Google default is "imagen-4.0-ultra-generate-001"; FAL default is "fal-ai/flux/schnell".',
      },
      output_path: {
        type: "string",
        description: "Optional app-local destination path to copy the generated image into, for example client/public/images/hero.png. Relative paths resolve against cwd.",
      },
      cwd: {
        type: "string",
        description: "Project directory used to resolve output_path. Jeriko injects this automatically for project work.",
      },
    },
    required: ["prompt"],
  },
  execute,
  aliases: ["create_image", "image_gen", "dall_e", "image_generation", "make_image", "website_photo", "generate_photo", "hero_image"],
};

registerTool(generateImageTool);
