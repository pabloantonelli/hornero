import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BAILEYS_VERSION, VERSION } from "./config.js";
import { authenticate, errorHandler } from "./routes/middleware.js";
import { createApiRouter } from "./routes/api.js";

const publicDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "public",
);

/** Builds the Express app. Kept separate from the server so tests can mount it. */
export const createApp = ({
  clients,
  token,
  logger,
  baseUrl,
  allowlist,
  recentSenders,
  settings,
  messageLog,
}) => {
  const app = express();

  // Only the ingress panel is served from a browser, and it is same-origin.
  app.use(cors({ origin: false }));
  // Large enough for a file sent as base64 at the biggest allowed size.
  app.use(express.json({ limit: "140mb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/health", (req, res) => {
    res.json({
      status: "OK",
      version: VERSION,
      baileys: BAILEYS_VERSION,
      clients: Object.fromEntries(
        Object.entries(clients).map(([id, client]) => [id, client.status]),
      ),
    });
  });

  app.use(
    "/api/v1",
    authenticate(token),
    createApiRouter(clients, {
      token,
      baseUrl,
      allowlist,
      recentSenders,
      settings,
      messageLog,
    }),
  );

  // Always revalidate: the panel is served through ingress, where a cached
  // copy would keep running an old version after an add-on update.
  app.use(
    express.static(publicDir, {
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }),
  );

  app.use(errorHandler(logger));

  return app;
};
