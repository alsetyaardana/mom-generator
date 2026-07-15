const path = require("path");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const { route, MENU_TEXT } = require("./router");

const AUTH_DIR = path.join(__dirname, "..", "data", "auth_state");
const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan QR ini dengan WhatsApp (Linked Devices > Link a Device):");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(
        `Koneksi ditutup (status ${statusCode}). ${shouldReconnect ? "Mencoba reconnect..." : "Logged out, perlu scan QR ulang."}`
      );
      if (shouldReconnect) {
        start().catch((err) => console.error("Gagal reconnect:", err));
      }
    } else if (connection === "open") {
      console.log("Terhubung ke WhatsApp.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith("@g.us") || jid === "status@broadcast") continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        "";
      if (!text) continue;

      try {
        await route(sock, jid, text);
      } catch (err) {
        console.error("Router error:", err);
        await sock.sendMessage(jid, {
          text: "Terjadi error. Ketik *reset* untuk mulai ulang.\n\n" + MENU_TEXT,
        });
      }
    }
  });

  return sock;
}

start().catch((err) => {
  console.error("Gagal start bot:", err);
  process.exit(1);
});
