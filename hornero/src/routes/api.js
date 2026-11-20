import axios from "axios";
import { Router } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { asyncRoute, resolveClient, validate } from "./middleware.js";
import { RESTART_REQUIRED } from "../settings.js";
import { DEFAULT_GROUP_MODE, GROUP_MODES, isGroupJid } from "../allowlist.js";
import {
  captureRecording,
  captureSnapshot,
  toMessageContent,
} from "../media.js";
import {
  buildContent,
  extensionFor,
  loadSource,
  saveFile,
} from "../outgoing-media.js";

const messageSchema = z.object({
  to: z.union([z.string().min(1), z.number()]),
  body: z.record(z.string(), z.unknown()),
  options: z.record(z.string(), z.unknown()).optional(),
  // false skips the typing indicator and its pause, for urgent alerts.
  typing: z.boolean().optional(),
});

const presenceSchema = z.object({
  type: z.enum([
    "unavailable",
    "available",
    "composing",
    "recording",
    "paused",
  ]),
  to: z.union([z.string().min(1), z.number()]).optional(),
  infinity: z.boolean().optional(),
});

const subscribeSchema = z.object({
  userId: z.union([z.string().min(1), z.number()]),
});

const statusSchema = z.object({
  status: z.string(),
});

const pairingSchema = z.object({
  phone: z.union([z.string().min(1), z.number()]),
});

const recipient = z.union([z.string().min(1), z.number()]);

const KINDS = ["image", "video", "audio", "document", "sticker"];

const mediaSchema = z
  .object({
    to: recipient,
    // Exactly one source: a camera or image entity, a file, a URL or base64.
    entityId: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    url: z.string().url().optional(),
    data: z.string().min(1).optional(),
    kind: z.enum(KINDS).optional(),
    mimetype: z.string().min(1).optional(),
    fileName: z.string().min(1).optional(),
    caption: z.string().optional(),
    // true sends audio as a voice note, converted to Ogg/Opus when needed.
    ptt: z.boolean().optional(),
    // With a duration a clip is recorded; without one a still frame is sent.
    duration: z.number().int().min(1).max(120).optional(),
    lookback: z.number().int().min(0).max(60).optional(),
    typing: z.boolean().optional(),
  })
  .refine(
    (v) =>
      [v.entityId, v.path, v.url, v.data].filter((x) => x !== undefined)
        .length === 1,
    { message: "Give exactly one of entityId, path, url or data." },
  );

const messageKeySchema = z
  .object({
    id: z.string().min(1),
    remoteJid: z.string().min(1),
    fromMe: z.boolean().optional(),
    participant: z.string().optional(),
  })
  .passthrough();

/** A message is named by its id (plus the chat, if it is not recent) or its key. */
const targetSchema = {
  chat: recipient.optional(),
  messageId: z.string().min(1).optional(),
  key: messageKeySchema.optional(),
};
const hasTarget = (v) => Boolean(v.messageId || v.key);
const targetMessage = { message: "Give messageId, or a whole key." };

const reactSchema = z
  .object({ ...targetSchema, emoji: z.string().optional() })
  .refine(hasTarget, targetMessage);

const editSchema = z
  .object({ ...targetSchema, text: z.string().min(1) })
  .refine(hasTarget, targetMessage);

const deleteSchema = z.object(targetSchema).refine(hasTarget, targetMessage);

const pollSchema = z
  .object({
    to: recipient,
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(2).max(12),
    // How many options each person may pick; 0 means any number.
    selectableCount: z.number().int().min(0).optional(),
    typing: z.boolean().optional(),
  })
  .refine((v) => new Set(v.options).size === v.options.length, {
    message: "Poll options must be different from each other.",
  })
  .refine(
    (v) =>
      v.selectableCount === undefined || v.selectableCount <= v.options.length,
    { message: "selectableCount cannot exceed the number of options." },
  );

const locationSchema = z.object({
  to: recipient,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().optional(),
  address: z.string().optional(),
  typing: z.boolean().optional(),
});

const downloadSchema = z
  .object({
    mediaId: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    chat: recipient.optional(),
    // Write the file here instead of returning it as base64.
    saveTo: z.string().min(1).optional(),
  })
  .refine((v) => v.mediaId || v.messageId, {
    message: "Give mediaId, or messageId.",
  });

/** What every send returns: enough to edit, delete or react to it later. */
const sentBody = (result) => {
  const timestamp = result?.messageTimestamp;
  const ts =
    timestamp === undefined || timestamp === null ? null : Number(timestamp);
  return {
    messageId: result?.key?.id ?? null,
    to: result?.key?.remoteJid ?? null,
    timestamp: ts,
    message_id: result?.key?.id ?? null,
    chat: result?.key?.remoteJid ?? null,
    key: result?.key ?? null,
  };
};

const readSchema = z.object({
  // Either the whole key from a hornero_message event, or its parts.
  keys: z
    .array(
      z.object({
        id: z.string().min(1),
        remoteJid: z.string().min(1),
        participant: z.string().optional(),
        fromMe: z.boolean().optional(),
      }),
    )
    .optional(),
  messageId: z.string().min(1).optional(),
  to: z.union([z.string().min(1), z.number()]).optional(),
});

const settingsSchema = z
  .object({
    markRead: z.boolean(),
    groupsRequireMention: z.boolean(),
    typingIndicator: z.boolean(),
    typingMaxSeconds: z.number().int().min(0).max(10),
    markOnline: z.boolean(),
    refreshHours: z.number().int().min(0).max(48),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]),
    mediaCacheHours: z.number().int().min(0).max(168),
    mediaMaxMb: z.number().int().min(1).max(100),
  })
  .partial();

const allowlistSchema = z.object({
  entries: z.array(z.union([z.string(), z.number()])),
  groupModes: z.record(z.string(), z.enum(GROUP_MODES)).optional(),
});

const describe = (id, client) => ({
  clientId: id,
  ...client.status,
  hasQr: Boolean(client.qr),
});

export const createApiRouter = (
  clients,
  { token, baseUrl, allowlist, recentSenders, settings, messageLog } = {},
) => {
  const router = Router();
  const withClient = resolveClient(clients);

  router.get("/clients", (req, res) => {
    res.json({
      clients: Object.entries(clients).map(([id, client]) =>
        describe(id, client),
      ),
    });
  });

  router.get("/clients/:clientId", withClient, (req, res) => {
    res.json(describe(req.clientId, req.client));
  });

  router.get(
    "/clients/:clientId/qr",
    withClient,
    asyncRoute(async (req, res) => {
      const qr = req.client.qr;
      if (!qr) {
        return res.status(404).json({
          error: req.client.status.connected
            ? "Client is already paired."
            : "No QR code available yet.",
        });
      }

      if (req.query.format === "png") {
        res.type("png");
        return QRCode.toFileStream(res, qr, { margin: 1, width: 512 });
      }
      return res.json({
        qr,
        dataUrl: await QRCode.toDataURL(qr, { margin: 1, width: 512 }),
      });
    }),
  );

  router.post(
    "/clients/:clientId/pairing-code",
    withClient,
    validate(pairingSchema),
    asyncRoute(async (req, res) => {
      const code = await req.client.requestPairingCode(req.validated.phone);
      res.json({ code });
    }),
  );

  router.post(
    "/clients/:clientId/messages",
    withClient,
    validate(messageSchema),
    asyncRoute(async (req, res) => {
      const { to, body, options, typing } = req.validated;
      const result = await req.client.sendMessage(to, body, options, {
        typing,
      });
      res.json(sentBody(result));
    }),
  );

  router.post(
    "/clients/:clientId/media",
    withClient,
    validate(mediaSchema),
    asyncRoute(async (req, res) => {
      const { to, entityId, caption, duration, lookback, typing } =
        req.validated;

      if (entityId) {
        const captured = duration
          ? await captureRecording(entityId, { duration, lookback })
          : await captureSnapshot(entityId);

        const result = await req.client.sendMessage(
          to,
          toMessageContent(captured, caption),
          undefined,
          { typing },
        );

        return res.json({
          ...sentBody(result),
          mimetype: captured.mimetype,
          bytes: captured.buffer.length,
        });
      }

      const { path, url, data, kind, mimetype, fileName, ptt } = req.validated;
      const file = await loadSource(
        { path, url, data, mimetype, fileName },
        { maxBytes: req.client.maxMediaBytes },
      );
      const content = await buildContent(file, { kind, caption, ptt });
      const result = await req.client.sendMessage(to, content, undefined, {
        typing,
      });

      return res.json({
        ...sentBody(result),
        mimetype: content.mimetype ?? file.mimetype,
        bytes: file.buffer.length,
      });
    }),
  );

  /** Downloads the file of a recent incoming message, by its media id. */
  router.post(
    "/clients/:clientId/media/download",
    withClient,
    validate(downloadSchema),
    asyncRoute(async (req, res) => {
      const { mediaId, messageId, saveTo } = req.validated;
      const id = mediaId ?? messageId;
      const { buffer, mimetype, info } = await req.client.downloadMedia(id);

      const base = { content_type: mimetype, size: buffer.length, media: info };
      if (saveTo) {
        const name =
          info.file_name?.replace(/[/\\]/g, "_") ||
          `${id}.${extensionFor(mimetype)}`;
        const written = await saveFile(saveTo, buffer, { defaultName: name });
        return res.json({ ...base, path: written });
      }
      return res.json({ ...base, data_base64: buffer.toString("base64") });
    }),
  );

  router.post(
    "/clients/:clientId/react",
    withClient,
    validate(reactSchema),
    asyncRoute(async (req, res) => {
      res.json(sentBody(await req.client.react(req.validated)));
    }),
  );

  router.post(
    "/clients/:clientId/edit",
    withClient,
    validate(editSchema),
    asyncRoute(async (req, res) => {
      res.json(sentBody(await req.client.editMessage(req.validated)));
    }),
  );

  router.post(
    "/clients/:clientId/delete",
    withClient,
    validate(deleteSchema),
    asyncRoute(async (req, res) => {
      res.json(sentBody(await req.client.deleteMessage(req.validated)));
    }),
  );

  router.post(
    "/clients/:clientId/poll",
    withClient,
    validate(pollSchema),
    asyncRoute(async (req, res) => {
      const { to, typing, ...poll } = req.validated;
      res.json(sentBody(await req.client.sendPoll(to, poll, { typing })));
    }),
  );

  router.post(
    "/clients/:clientId/location",
    withClient,
    validate(locationSchema),
    asyncRoute(async (req, res) => {
      const { to, typing, ...place } = req.validated;
      res.json(sentBody(await req.client.sendLocation(to, place, { typing })));
    }),
  );

  router.get(
    "/clients/:clientId/groups",
    withClient,
    asyncRoute(async (req, res) => {
      res.json({ groups: await req.client.listGroups() });
    }),
  );

  router.get(
    "/clients/:clientId/groups/:jid",
    withClient,
    asyncRoute(async (req, res) => {
      res.json(await req.client.getGroup(req.params.jid));
    }),
  );

  /** Phone number ↔ LID, with the name the person goes by. */
  router.get(
    "/clients/:clientId/contacts/:contact",
    withClient,
    asyncRoute(async (req, res) => {
      res.json(await req.client.resolveContact(req.params.contact));
    }),
  );

  router.get(
    "/clients/:clientId/chats",
    withClient,
    asyncRoute(async (req, res) => {
      res.json({
        groups: await req.client.fetchGroups(),
        contacts: req.client.contacts,
      });
    }),
  );

  /**
   * Proxies the chat avatar. Fetching it in the browser would hit WhatsApp's
   * CDN directly, which the ingress content policy blocks.
   */
  router.get(
    "/clients/:clientId/avatar/:jid",
    withClient,
    asyncRoute(async (req, res) => {
      const url = await req.client.fetchAvatarUrl(req.params.jid);
      if (!url) return res.status(404).json({ error: "No profile picture" });

      const { data, headers } = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 15000,
      });

      res.set("Content-Type", headers["content-type"] || "image/jpeg");
      res.set("Cache-Control", "private, max-age=3600");
      return res.send(Buffer.from(data));
    }),
  );

  /**
   * Resolves a readable name for an allowlist entry from whatever has been
   * synced already: group subjects, contacts, or the name WhatsApp reported
   * on a recent message.
   */
  const describeEntry = (id) => {
    for (const client of Object.values(clients)) {
      const name = client.resolveName?.(id);
      if (name) return name;
    }

    const recent = recentSenders?.entries.find(
      (sender) => sender.id === id || sender.ids?.includes(id),
    );
    return recent?.name ?? null;
  };

  const withNames = (entries, groupModes = {}) =>
    entries.map((id) => ({
      id,
      name: describeEntry(id),
      ...(isGroupJid(id) ? { mode: groupModes[id] ?? DEFAULT_GROUP_MODE } : {}),
    }));

  const allowlistBody = () => {
    const entries = allowlist?.entries ?? [];
    const groupModes = allowlist?.groupModes ?? {};
    return {
      entries,
      // The same list with names, for clients that can show them.
      details: withNames(entries, groupModes),
      groupModes,
      open: allowlist?.open ?? true,
    };
  };

  /** Which senders may trigger Home Assistant events. Empty allows everyone. */
  router.get("/allowlist", (req, res) => {
    res.json(allowlistBody());
  });

  router.put(
    "/allowlist",
    validate(allowlistSchema),
    asyncRoute(async (req, res) => {
      const { entries, groupModes } = req.validated;
      await (groupModes
        ? allowlist.replace(entries, groupModes)
        : allowlist.replace(entries));
      res.json(allowlistBody());
    }),
  );

  /** Who wrote recently, so the panel can offer Allow without guesswork. */
  router.get("/recent-senders", (req, res) => {
    res.json({ senders: recentSenders?.entries ?? [] });
  });

  /** Settings the panel can change without touching the add-on options. */
  router.get("/settings", (req, res) => {
    res.json({
      settings: settings?.values ?? {},
      restartRequired: RESTART_REQUIRED,
    });
  });

  router.put(
    "/settings",
    validate(settingsSchema),
    asyncRoute(async (req, res) => {
      res.json({
        settings: await settings.update(req.validated),
        restartRequired: RESTART_REQUIRED,
      });
    }),
  );

  /** Recent traffic, so the panel can show what actually went out. */
  router.get("/messages", (req, res) => {
    res.json({ messages: messageLog?.entries ?? [] });
  });

  /**
   * Base URL and token, so the panel can build ready-to-paste snippets for
   * Node-RED and curl. Only served over ingress, which Home Assistant has
   * already authenticated.
   */
  router.get("/connection", (req, res) => {
    if (req.get("X-Ingress-Path") === undefined) {
      return res.status(403).json({ error: "Only available through ingress" });
    }
    return res.json({ baseUrl, token });
  });

  router.post(
    "/clients/:clientId/read",
    withClient,
    validate(readSchema),
    asyncRoute(async (req, res) => {
      const { keys, messageId, to } = req.validated;

      const list =
        keys ??
        (messageId && to
          ? [{ id: messageId, remoteJid: req.client.toJid(to) }]
          : []);

      if (list.length === 0) {
        return res.status(400).json({
          error: "Provide keys, or both messageId and to.",
        });
      }

      return res.json({ marked: await req.client.markRead(list) });
    }),
  );

  router.get(
    "/clients/:clientId/check/:phone",
    withClient,
    asyncRoute(async (req, res) => {
      res.json(await req.client.checkNumber(req.params.phone));
    }),
  );

  router.post(
    "/clients/:clientId/status",
    withClient,
    validate(statusSchema),
    asyncRoute(async (req, res) => {
      await req.client.updateProfileStatus(req.validated.status);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/clients/:clientId/presence",
    withClient,
    validate(presenceSchema),
    asyncRoute(async (req, res) => {
      const { type, to, infinity } = req.validated;
      if (infinity) req.client.setSendPresenceUpdateInterval(type, to);
      else await req.client.sendPresenceUpdate(type, to);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/clients/:clientId/presence/subscribe",
    withClient,
    validate(subscribeSchema),
    asyncRoute(async (req, res) => {
      await req.client.presenceSubscribe(req.validated.userId);
      res.json({ ok: true });
    }),
  );

  router.post(
    "/clients/:clientId/restart",
    withClient,
    asyncRoute(async (req, res) => {
      await req.client.restart();
      res.json({ ok: true });
    }),
  );

  router.post(
    "/clients/:clientId/logout",
    withClient,
    asyncRoute(async (req, res) => {
      req.client.emit("logout");
      res.json({ ok: true });
    }),
  );

  return router;
};
