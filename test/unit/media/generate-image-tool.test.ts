// Unit tests — generate_image agent tool.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearTools, getTool, listTools, registerTool } from "../../../src/daemon/agent/tools/registry.js";
import { generateImageTool } from "../../../src/daemon/agent/tools/generate-image.js";

describe("generate_image tool", () => {
  beforeEach(() => {
    clearTools();
    registerTool(generateImageTool);
  });

  afterEach(() => {
    clearTools();
  });

  it("is registered with correct ID", () => {
    const tool = getTool("generate_image");
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("generate_image");
  });

  it("has descriptive name and description", () => {
    const tool = getTool("generate_image")!;
    expect(tool.name).toBe("generate_image");
    expect(tool.description).toContain("image");
    expect(tool.description).toContain("DALL-E");
  });

  it("requires prompt parameter", () => {
    const tool = getTool("generate_image")!;
    const params = tool.parameters;
    expect(params.required).toContain("prompt");
  });

  it("has size parameter with valid enum values", () => {
    const tool = getTool("generate_image")!;
    const sizeParam = (tool.parameters.properties as Record<string, Record<string, unknown>>)?.size;
    expect(sizeParam).toBeDefined();
    expect(sizeParam!.enum).toContain("1024x1024");
    expect(sizeParam!.enum).toContain("1024x1792");
    expect(sizeParam!.enum).toContain("1792x1024");
  });

  it("has style parameter with vivid and natural options", () => {
    const tool = getTool("generate_image")!;
    const styleParam = (tool.parameters.properties as Record<string, Record<string, unknown>>)?.style;
    expect(styleParam).toBeDefined();
    expect(styleParam!.enum).toContain("vivid");
    expect(styleParam!.enum).toContain("natural");
  });

  it("resolves aliases correctly", () => {
    expect(getTool("create_image")).toBeDefined();
    expect(getTool("image_gen")).toBeDefined();
    expect(getTool("dall_e")).toBeDefined();
    expect(getTool("image_generation")).toBeDefined();
    expect(getTool("make_image")).toBeDefined();
  });

  it("returns error JSON when prompt is missing", async () => {
    const tool = getTool("generate_image")!;
    const result = JSON.parse(await tool.execute({}));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("prompt is required");
  });

  it("returns error JSON when prompt is empty", async () => {
    const tool = getTool("generate_image")!;
    const result = JSON.parse(await tool.execute({ prompt: "" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("prompt is required");
  });

  it("returns error JSON when no API key is set", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    const originalFalKey = process.env.FAL_KEY;
    const originalGeminiKey = process.env.GEMINI_API_KEY;
    const originalGoogleKey = process.env.GOOGLE_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.FAL_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    try {
      const tool = getTool("generate_image")!;
      const result = JSON.parse(await tool.execute({ prompt: "a sunset" }));
      expect(result.ok).toBe(false);
      expect(result.error).toContain("provider");
    } finally {
      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
      if (originalFalKey) process.env.FAL_KEY = originalFalKey;
      if (originalGeminiKey) process.env.GEMINI_API_KEY = originalGeminiKey;
      if (originalGoogleKey) process.env.GOOGLE_API_KEY = originalGoogleKey;
    }
  });

  it("saves generated images into a requested project asset path", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENAI_API_KEY;
    const originalFalKey = process.env.FAL_KEY;
    const cwd = mkdtempSync(join(tmpdir(), "jeriko-image-tool-"));
    mkdirSync(join(cwd, "client", "public", "images"), { recursive: true });
    delete process.env.OPENAI_API_KEY;
    process.env.FAL_KEY = "test-fal-key";

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("fal.run")) {
        return new Response(JSON.stringify({ images: [{ url: "https://fal.media/files/hero.png" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "https://fal.media/files/hero.png") {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    try {
      const tool = getTool("generate_image")!;
      const result = JSON.parse(await tool.execute({
        prompt: "realistic roofing hero photo",
        provider: "fal",
        cwd,
        output_path: "client/public/images/hero.png",
      }));

      const expectedPath = join(cwd, "client", "public", "images", "hero.png");
      expect(result.ok).toBe(true);
      expect(result.path).toBe(expectedPath);
      expect(result.savedPath).toBe(expectedPath);
      expect(result.generatedPath).toContain("jeriko-image-");
      expect(result.provider).toBe("fal");
      expect(existsSync(expectedPath)).toBe(true);
      expect([...readFileSync(expectedPath).subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
      else delete process.env.OPENAI_API_KEY;
      if (originalFalKey) process.env.FAL_KEY = originalFalKey;
      else delete process.env.FAL_KEY;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("appears in listTools()", () => {
    const allTools = listTools();
    const imageToolIds = allTools.map((t) => t.id);
    expect(imageToolIds).toContain("generate_image");
  });
});
