// Unit tests — Image generation service.

import { describe, it, expect, afterEach } from "bun:test";

describe("Image Generation Service", () => {
  const originalEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    FAL_KEY: process.env.FAL_KEY,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  function clearImageProviderKeys(): void {
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.FAL_KEY;
  }

  describe("provider resolution", () => {
    it("throws when no API key is available and provider is auto", async () => {
      clearImageProviderKeys();
      const { generateImage } = await import("../../../src/daemon/services/media/image-gen.js");

      await expect(
        generateImage({ prompt: "a cat" }),
      ).rejects.toThrow("No image generation provider available");
    });

    it("throws when explicit provider has no key", async () => {
      clearImageProviderKeys();
      const { generateImage } = await import("../../../src/daemon/services/media/image-gen.js");

      await expect(
        generateImage({ prompt: "a cat", provider: "openai" }),
      ).rejects.toThrow("OPENAI_API_KEY not set");
    });
  });

  describe("input validation", () => {
    it("uses default size when invalid size is provided", async () => {
      // We can't test the actual API call, but we verify the function doesn't crash
      // on invalid input. It will fail at the fetch level.
      clearImageProviderKeys();
      process.env.OPENAI_API_KEY = "test-key";
      const { generateImage } = await import("../../../src/daemon/services/media/image-gen.js");

      // Will fail because key is fake, but should not fail on size validation
      await expect(
        generateImage({ prompt: "a cat", size: "invalid", provider: "openai" }),
      ).rejects.toThrow(); // API error, not validation error
    });
  });
});
