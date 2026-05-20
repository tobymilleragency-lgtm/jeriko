import type { MetadataRoute } from "next";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://jeriko.app";

const routes = [
  "/",
  "/docs",
  "/docs/installation",
  "/docs/quickstart",
  "/docs/authentication",
  "/docs/endpoints/agent",
  "/pricing",
  "/support",
  "/privacy-policy",
  "/terms-and-conditions",
];

export default function sitemap(): MetadataRoute.Sitemap {
  return routes.map((route) => ({
    url: `${siteUrl}${route}`,
    lastModified: new Date(),
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : 0.7,
  }));
}
