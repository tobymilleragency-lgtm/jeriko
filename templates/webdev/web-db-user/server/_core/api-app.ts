import "dotenv/config";
import express from "express";
import mysql from "mysql2/promise";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";

export function createApiApp() {
  const app = express();

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  app.get("/api/health", async (_req, res) => {
    const databaseConfigured = Boolean(process.env.DATABASE_URL);
    let databaseReady = false;
    if (databaseConfigured) {
      try {
        const connection = await mysql.createConnection(process.env.DATABASE_URL!);
        await connection.query("SELECT 1");
        await connection.end();
        databaseReady = true;
      } catch (error) {
        console.warn("[Health] Database readiness check failed:", error);
      }
    }
    res.json({ ok: true, databaseConfigured, databaseReady });
  });

  registerOAuthRoutes(app);

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  return app;
}
