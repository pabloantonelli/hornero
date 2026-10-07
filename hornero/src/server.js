import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { createApp } from "./app.js";
import { announceToSupervisor, writeConnectionFile } from "./component.js";
import { loadConfig, VERSION } from "./config.js";
import { HomeAssistant } from "./homeassistant.js";
import { BaileysClient } from "./baileys-client.js";
import { AllowlistStore } from "./allowlist.js";
import { mentionedJids, passesMentionRule } from "./mentions.js";
import { RecentSenders } from "./recent-senders.js";
import { SettingsStore } from "./settings.js";
import { MessageLog } from "./message-log.js";

const main = async () => {
  const config = await loadConfig();
  const logger = pino({ level: "info" });

  // The log level can change from the panel, so apply it on every change.
  const settings = new SettingsStore({
    dataDir: config.dataDir,
    logger,
    onChange: (values) => {
      logger.level = values.logLevel;
    },
  });
  await settings.load(config.settingsSeed);
  const ha = new HomeAssistant(logger);
  const clients = {};

  const allowlist = new AllowlistStore({ dataDir: config.dataDir, logger });
  await allowlist.load(config.allowedSenders);
  const recentSenders = new RecentSenders();
  const messageLog = new MessageLog();

  const createClient = async (key) => {
    const client = new BaileysClient({
      path: path.join(config.dataDir, key),
      logger: logger.child({ client: key }),
      offline: !settings.get("markOnline"),
      refreshMs: settings.get("refreshHours") * 60 * 60 * 1000,
      settings,
    });

    client.on("restart", () => logger.debug({ client: key }, "restarting"));
    client.on("qr", (qr) => {
      logger.info(
        { client: key },
        "pairing required, see the WhatsApp panel or your notifications",
      );
      ha.notifyQr(key, qr);
    });
    client.on("ready", () => {
      logger.info({ client: key }, "client is ready");
      ha.dismissQr(key);
    });
    client.on("pair", (info) =>
      logger.info({ client: key, ...info }, "paired"),
    );
    client.on("msg", (msg) => {
      const allowed = allowlist.allows(msg);
      recentSenders.record(msg, allowed);

      if (!allowed) {
        logger.debug(
          { client: key, from: msg?.key?.remoteJid },
          "message ignored: sender is not on the allowlist",
        );
        return;
      }

      if (
        !passesMentionRule(msg, {
          ownJids: client.ownJids,
          enabled: settings.get("groupsRequireMention"),
        })
      ) {
        logger.debug(
          {
            client: key,
            from: msg?.key?.remoteJid,
            ownJids: client.ownJids,
            mentioned: mentionedJids(msg),
          },
          "group message ignored: it does not mention or quote Hornero",
        );
        return;
      }

      if (settings.get("markRead")) {
        client
          .markRead(msg.key)
          .catch((err) =>
            logger.debug(
              { client: key, err: err.message },
              "could not mark the message as read",
            ),
          );
      }

      messageLog.recordReceived({ clientId: key, msg });
      ha.fireEvent("hornero_message", { clientId: key, ...msg });
    });
    client.on("presence_update", (presence) =>
      ha.fireEvent("hornero_presence", { clientId: key, ...presence }),
    );
    client.on("ack", (ack) => {
      messageLog.markStatus(ack.messageId, ack.status);
      ha.fireEvent("hornero_message_ack", { clientId: key, ...ack });
    });
    client.on("sent", (event) =>
      messageLog.recordSent({ clientId: key, ...event }),
    );
    client.on("send_failed", (event) =>
      messageLog.recordFailure({ clientId: key, ...event }),
    );
    client.on("disconnected", (code) =>
      logger.warn({ client: key, code }, "disconnected, reconnecting"),
    );
    client.on("gave_up", () =>
      logger.error({ client: key }, "gave up reconnecting"),
    );

    client.on("logout", async () => {
      logger.info({ client: key }, "logged out, wiping session and restarting");
      await client.stop();
      try {
        await fs.rm(path.join(config.dataDir, key), {
          recursive: true,
          force: true,
        });
      } catch (err) {
        logger.error(
          { client: key, err: err.message },
          "could not remove session data",
        );
      }
      await createClient(key);
    });

    clients[key] = client;

    // A failure here must not abort the other clients.
    await client
      .start()
      .catch((err) =>
        logger.error(
          { client: key, err: err.message },
          "could not start client",
        ),
      );

    return client;
  };

  for (const key of config.clients) {
    await createClient(key);
  }

  // Publish the endpoint before serving, so the custom component can reach us
  // as soon as Home Assistant loads it.
  const baseUrl = await writeConnectionFile({
    port: config.port,
    token: config.token,
    logger,
  });

  await announceToSupervisor({ baseUrl, token: config.token, logger });

  const app = createApp({
    clients,
    token: config.token,
    logger,
    baseUrl,
    allowlist,
    recentSenders,
    settings,
    messageLog,
  });

  app.listen(config.port, () =>
    logger.info(
      { port: config.port, version: VERSION, clients: config.clients },
      "WhatsApp add-on started",
    ),
  );

  process.on("unhandledRejection", (reason) =>
    logger.error(
      { err: reason instanceof Error ? reason.message : reason },
      "unhandled rejection",
    ),
  );
  process.on("uncaughtException", (err) =>
    logger.error({ err: err.message, stack: err.stack }, "uncaught exception"),
  );

  const shutdown = async () => {
    logger.info("shutting down");
    await Promise.all(Object.values(clients).map((client) => client.stop()));
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
};

main().catch((err) => {
  console.error("Fatal error during startup:", err.message);
  process.exit(1);
});
