import { mediaInfo, quotedInfo } from "./inbound.js";
import { mentionedJids, passesMentionRule } from "./mentions.js";

/**
 * Turns what a WhatsApp client reports into Home Assistant events. Every
 * event about what someone did — a message, a reaction, a vote — goes
 * through the allowlist first, and a group change only for allowed groups.
 */
export const forwardEvents = ({
  client,
  clientId,
  ha,
  allowlist,
  recentSenders,
  settings,
  messageLog,
  logger,
}) => {
  client.on("msg", (msg) => {
    const allowed = allowlist.allows(msg);
    recentSenders.record(msg, allowed);

    if (!allowed) {
      logger.debug(
        { client: clientId, from: msg?.key?.remoteJid },
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
          client: clientId,
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
            { client: clientId, err: err.message },
            "could not mark the message as read",
          ),
        );
    }

    // Only allowed messages are kept, so a blocked sender's media is
    // never downloadable.
    client.remember(msg);

    const media = mediaInfo(msg);
    const quoted = quotedInfo(msg, client.ownJids);

    messageLog.recordReceived({ clientId, msg });
    ha.fireEvent("hornero_message", {
      clientId,
      ...msg,
      ...(media ? { media } : {}),
      ...(quoted ? { quoted } : {}),
    });
  });
  client.on("reaction", ({ key: reactionKey, ...reaction }) => {
    if (!allowlist.allows({ key: reactionKey })) {
      logger.debug(
        { client: clientId, from: reactionKey?.remoteJid },
        "reaction ignored: sender is not on the allowlist",
      );
      return;
    }
    ha.fireEvent("hornero_reaction", { clientId, ...reaction });
  });
  client.on("poll_vote", ({ key: voteKey, ...vote }) => {
    if (!allowlist.allows({ key: voteKey })) {
      logger.debug(
        { client: clientId, from: voteKey?.remoteJid },
        "poll vote ignored: sender is not on the allowlist",
      );
      return;
    }
    ha.fireEvent("hornero_poll_vote", { clientId, ...vote });
  });
  client.on("group_update", (update) => {
    if (!allowlist.allowsChat(update.chat)) {
      logger.debug(
        { client: clientId, group: update.chat },
        "group change ignored: the group is not on the allowlist",
      );
      return;
    }
    ha.fireEvent("hornero_group_update", { clientId, ...update });
  });
  client.on("presence_update", (presence) =>
    ha.fireEvent("hornero_presence", { clientId, ...presence }),
  );
  client.on("ack", (ack) => {
    messageLog.markStatus(ack.messageId, ack.status);
    ha.fireEvent("hornero_message_ack", { clientId, ...ack });
  });
  client.on("sent", (event) => messageLog.recordSent({ clientId, ...event }));
  client.on("send_failed", (event) =>
    messageLog.recordFailure({ clientId, ...event }),
  );
};
