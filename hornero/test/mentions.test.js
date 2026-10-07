import { describe, expect, it } from "vitest";
import { addressesMe, passesMentionRule } from "../src/mentions.js";

const OWN = ["5491122334455:7@s.whatsapp.net", "173478124720340@lid"];

const group = (message) => ({ key: { remoteJid: "120363@g.us" }, message });

describe("addressesMe", () => {
  it("matches a mention even with a device suffix on our own id", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: { mentionedJid: ["5491122334455@s.whatsapp.net"] },
          },
        }),
        OWN,
      ),
    ).toBe(true);
  });

  it("matches a mention by LID", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: { mentionedJid: ["173478124720340@lid"] },
          },
        }),
        OWN,
      ),
    ).toBe(true);
  });

  it("matches a reply to something we sent", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: {
              stanzaId: "3EB0ABC",
              participant: "5491122334455@s.whatsapp.net",
              quotedMessage: { conversation: "alarm armed" },
            },
          },
        }),
        OWN,
      ),
    ).toBe(true);
  });

  it("finds the context on a caption, not only on text", () => {
    expect(
      addressesMe(
        group({
          imageMessage: {
            caption: "look",
            contextInfo: { mentionedJid: ["173478124720340@lid"] },
          },
        }),
        OWN,
      ),
    ).toBe(true);
  });

  it("ignores chatter that names someone else", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: { mentionedJid: ["5491199999999@s.whatsapp.net"] },
          },
        }),
        OWN,
      ),
    ).toBe(false);
  });

  it("ignores a reply to someone else's message that mentioned us", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            text: "jaja",
            contextInfo: {
              stanzaId: "3EB0ABC",
              participant: "5491199999999@s.whatsapp.net",
              quotedMessage: {
                extendedTextMessage: {
                  text: "@5491122334455 prendé la luz",
                  contextInfo: {
                    mentionedJid: ["5491122334455@s.whatsapp.net"],
                  },
                },
              },
            },
          },
        }),
        OWN,
      ),
    ).toBe(false);
  });

  it("matches a number typed by hand, but not a longer one", () => {
    const typed = (text) =>
      addressesMe(group({ extendedTextMessage: { text } }), OWN);

    expect(typed("@5491122334455 prendé la luz")).toBe(true);
    expect(typed("hola @173478124720340")).toBe(true);
    expect(typed("@54911223344559 prendé la luz")).toBe(false);
  });

  it("matches a number typed in a caption", () => {
    expect(
      addressesMe(
        group({ imageMessage: { caption: "mirá @5491122334455" } }),
        OWN,
      ),
    ).toBe(true);
  });

  it("needs a real reply, not just our id as participant", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: { participant: "5491122334455@s.whatsapp.net" },
          },
        }),
        OWN,
      ),
    ).toBe(false);
  });

  it("matches a LID mention when our LID carries a device suffix", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: { mentionedJid: ["173478124720340@lid"] },
          },
        }),
        ["5491122334455@s.whatsapp.net", "173478124720340:12@lid"],
      ),
    ).toBe(true);
  });

  it("is false when the account identity is not known yet", () => {
    expect(
      addressesMe(
        group({
          extendedTextMessage: {
            contextInfo: { mentionedJid: ["5491122334455@s.whatsapp.net"] },
          },
        }),
        [],
      ),
    ).toBe(false);
  });
});

describe("passesMentionRule", () => {
  const msg = group({ conversation: "hola a todos" });

  it("lets everything through while disabled", () => {
    expect(passesMentionRule(msg, { ownJids: OWN, enabled: false })).toBe(true);
  });

  it("drops unaddressed group chatter while enabled", () => {
    expect(passesMentionRule(msg, { ownJids: OWN, enabled: true })).toBe(false);
  });

  it("never filters a direct chat", () => {
    const direct = {
      key: { remoteJid: "5491199999999@s.whatsapp.net" },
      message: { conversation: "hola" },
    };
    expect(passesMentionRule(direct, { ownJids: OWN, enabled: true })).toBe(
      true,
    );
  });
});
