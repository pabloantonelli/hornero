import { describe, expect, it } from "vitest";
import { identityOf, mediaInfo, quotedInfo } from "../src/inbound.js";

const key = { id: "MSG1", remoteJid: "5491111111111@s.whatsapp.net" };

describe("mediaInfo", () => {
  it("resume una nota de voz sin incluir el archivo", () => {
    const info = mediaInfo({
      key,
      message: {
        audioMessage: {
          mimetype: "audio/ogg; codecs=opus",
          fileLength: { toNumber: () => 12345 },
          seconds: 7,
          ptt: true,
          mediaKey: Buffer.from("secret"),
          url: "https://mmg.whatsapp.net/x",
        },
      },
    });

    expect(info).toEqual({
      type: "audio",
      mimetype: "audio/ogg; codecs=opus",
      size: 12345,
      seconds: 7,
      ptt: true,
      caption: null,
      file_name: null,
      media_id: "MSG1",
    });
  });

  it("toma el epígrafe de una foto y no le pone duración", () => {
    const info = mediaInfo({
      key,
      message: {
        imageMessage: {
          mimetype: "image/jpeg",
          fileLength: "2048",
          caption: "¿qué planta es?",
        },
      },
    });
    expect(info).toMatchObject({
      type: "image",
      size: 2048,
      seconds: null,
      ptt: false,
      caption: "¿qué planta es?",
    });
  });

  it("encuentra la media dentro de un mensaje de ver una vez o efímero", () => {
    const info = mediaInfo({
      key,
      message: {
        ephemeralMessage: {
          message: {
            viewOnceMessageV2: {
              message: { videoMessage: { mimetype: "video/mp4", seconds: 12 } },
            },
          },
        },
      },
    });
    expect(info).toMatchObject({ type: "video", seconds: 12 });
  });

  it("incluye el nombre de un documento enviado con epígrafe", () => {
    const info = mediaInfo({
      key,
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              mimetype: "application/pdf",
              fileName: "factura.pdf",
              caption: "leeme esta factura",
            },
          },
        },
      },
    });
    expect(info).toMatchObject({
      type: "document",
      file_name: "factura.pdf",
      caption: "leeme esta factura",
    });
  });

  it("reconoce los stickers", () => {
    expect(
      mediaInfo({
        key,
        message: { stickerMessage: { mimetype: "image/webp" } },
      }).type,
    ).toBe("sticker");
  });

  it("devuelve null para un mensaje de texto", () => {
    expect(mediaInfo({ key, message: { conversation: "hola" } })).toBeNull();
  });
});

describe("quotedInfo", () => {
  const own = ["5490000000000:3@s.whatsapp.net", "99999@lid"];

  it("marca from_me cuando responden a un mensaje propio, aunque sea por LID", () => {
    const quoted = quotedInfo(
      {
        key,
        message: {
          extendedTextMessage: {
            text: "sí",
            contextInfo: {
              stanzaId: "ORIG",
              participant: "99999@lid",
              quotedMessage: { conversation: "¿Apago la luz?" },
            },
          },
        },
      },
      own,
    );

    expect(quoted).toEqual({
      message_id: "ORIG",
      author: "99999@lid",
      author_phone: null,
      author_lid: "99999@lid",
      from_me: true,
      text: "¿Apago la luz?",
    });
  });

  it("no marca from_me cuando responden a otra persona", () => {
    const quoted = quotedInfo(
      {
        key,
        message: {
          imageMessage: {
            contextInfo: {
              stanzaId: "ORIG",
              participant: "5491222222222@s.whatsapp.net",
              participantAlt: "222@lid",
            },
          },
        },
      },
      own,
    );
    expect(quoted).toMatchObject({
      author: "5491222222222@s.whatsapp.net",
      author_phone: "5491222222222",
      author_lid: "222@lid",
      from_me: false,
      text: null,
    });
  });

  it("devuelve null si no es una respuesta", () => {
    expect(
      quotedInfo(
        {
          key,
          message: {
            extendedTextMessage: {
              text: "x",
              contextInfo: { mentionedJid: [] },
            },
          },
        },
        own,
      ),
    ).toBeNull();
  });
});

describe("identityOf", () => {
  it("separa el teléfono y el LID, sin el sufijo de dispositivo", () => {
    expect(identityOf("123@lid", "5491111111111:12@s.whatsapp.net")).toEqual({
      jid: "5491111111111@s.whatsapp.net",
      phone: "5491111111111",
      lid: "123@lid",
    });
  });
});
