// Conversation state machine:
//   MENU -> MOM_COLLECT (free-form chat, extracted via DeepSeek per message)
//        -> MOM_ASK_SIMPLE / attendee loop / list-item loop (only for fields
//           DeepSeek couldn't find)
//        -> MOM_TODO_ASK (optional next-step loop)
//        -> MOM_CONFIRM -> generate + send .docx
//
// DeepSeek never invents content — it only extracts what the user actually
// said. Anything still missing after extraction gets asked explicitly.

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { getSession, resetSession, emptyMomData } = require("./session-store");
const { extractMomData } = require("./deepseek");

const DONE_WORDS = new Set(["selesai", "done", "cukup"]);
const FINISH_COLLECT_WORDS = new Set(["selesai", "buatkan", "generate", "done"]);
const SKIP_WORDS = new Set(["skip", "lewati", "-"]);

function isDone(text) {
  return DONE_WORDS.has(text.trim().toLowerCase());
}

const WELCOME_TEXT =
  "Halo, selamat datang di *Porta Bot*.\nBot ini bisa bantu bikin dokumen Minutes of Meeting (MOM) langsung dari chat WhatsApp.";

const MENU_TEXT =
  "Mau bikin apa?\n\n1. Buat MOM (Minutes of Meeting)\n2. Panduan format cerita ideal\n\nKetik *1* atau *2*, atau *reset* kapan saja untuk kembali ke menu.";

const GUIDE_TEXT = `*Panduan cerita ideal buat MOM*

Biar sekali extract langsung lengkap, coba sertakan info berikut waktu cerita (boleh sekaligus atau bertahap):

- *Tanggal* meeting
- *Project* / nama pekerjaan
- *Venue* meeting-nya di mana
- *Notulen* (siapa yang catat)
- *Attendee*: nama + company masing-masing
- *Agenda* / tujuan meeting (1 kalimat)
- *Poin diskusi*: tiap topik + detail pembahasan + siapa yang jadi actionee
- *Next step* (kalau ada): rencana ke depan + PIC + due date

Contoh pesan:
"Tanggal 10 September 2025, project RS Mulya Medika Samarinda, venue di Office Porta, notulen Dewi Misnasari. Hadir Alindra dari PT Porta Nusa Indonesia dan Pak Adilfy dari RS Mulya. Agendanya troubleshoot Router Maipu yang down. Ditemukan router mengalami failboot, PIC-nya Alindra dan Pak Adilfy. Next step: monitoring stabilitas router selama 1 minggu, PIC Alindra, due 23 September 2025."

Nggak harus persis kayak gitu — cerita santai juga bisa, nanti kalau ada yang kurang bot bakal tanya balik. Ketik *1* untuk mulai buat MOM.`;

async function reply(sock, jid, text) {
  await sock.sendMessage(jid, { text });
}

function mergeMomData(oldData, extracted) {
  const merged = { ...oldData };
  for (const key of ["date", "project", "attachments", "venue", "minutes_taken_by", "agenda"]) {
    if (extracted[key]) merged[key] = extracted[key];
  }
  for (const key of ["attendees", "distribution_list", "list_items", "todo_items"]) {
    if (Array.isArray(extracted[key]) && extracted[key].length > 0) {
      merged[key] = extracted[key];
    }
  }
  return merged;
}

const FIELD_PROMPTS = {
  date: "Tanggal meeting-nya kapan?",
  project: "Ini project / nama pekerjaan apa?",
  venue: "Venue / lokasi meeting-nya di mana?",
  minutes_taken_by: "Siapa yang jadi notulen (minutes taken by)?",
  agenda: "Agenda / tujuan meeting-nya apa? (satu baris)",
};

function nextMissingField(data) {
  if (!data.date) return "date";
  if (!data.project) return "project";
  if (!data.venue) return "venue";
  if (!data.minutes_taken_by) return "minutes_taken_by";
  if (!data.attendees || data.attendees.length === 0) return "attendees";
  if (!data.agenda) return "agenda";
  if (!data.list_items || data.list_items.length === 0) return "list_items";
  return null;
}

// Per-item completeness check, run after every top-level required field is
// present — catches entries DeepSeek extracted but left partially filled
// (e.g. an attendee with no company, a list item with no actionee).
function buildFixQueue(data) {
  const queue = [];
  data.attendees.forEach((a, index) => {
    if (!a.name) queue.push({ type: "attendee_name", index });
    if (!a.company) queue.push({ type: "attendee_company", index });
  });
  data.list_items.forEach((item, index) => {
    if (!item.title) queue.push({ type: "item_title", index });
    if (!item.bullets || item.bullets.length === 0) queue.push({ type: "item_bullets", index });
    if (!item.actionee) queue.push({ type: "item_actionee", index });
  });
  data.todo_items.forEach((item, index) => {
    if (!item.due_date) queue.push({ type: "todo_due", index });
  });
  return queue;
}

function fixTaskPrompt(data, task) {
  switch (task.type) {
    case "attendee_name":
      return `Ada attendee yang namanya belum jelas (company: ${data.attendees[task.index].company || "-"}). Namanya siapa?`;
    case "attendee_company":
      return `Company untuk attendee *${data.attendees[task.index].name}* apa?`;
    case "item_title":
      return "Ada List item yang judulnya belum jelas. Judulnya apa?";
    case "item_bullets":
      return `Item *${data.list_items[task.index].title}* belum ada detail pembahasannya. Ceritain detailnya?`;
    case "item_actionee":
      return `Item *${data.list_items[task.index].title}* belum ada actionee-nya. Siapa yang bertanggung jawab?`;
    case "todo_due":
      return `Next Step *${data.todo_items[task.index].title}* belum ada due date-nya. Due date-nya kapan?`;
    default:
      return "Ada info yang belum jelas, tolong lengkapi.";
  }
}

function applyFixAnswer(data, task, trimmed) {
  switch (task.type) {
    case "attendee_name":
      data.attendees[task.index].name = trimmed;
      break;
    case "attendee_company":
      data.attendees[task.index].company = trimmed;
      break;
    case "item_title":
      data.list_items[task.index].title = trimmed;
      break;
    case "item_bullets":
      data.list_items[task.index].bullets = trimmed.split("\n").map((s) => s.trim()).filter(Boolean);
      break;
    case "item_actionee":
      data.list_items[task.index].actionee = trimmed;
      break;
    case "todo_due":
      data.todo_items[task.index].due_date = SKIP_WORDS.has(trimmed.toLowerCase()) ? "-" : trimmed;
      break;
  }
}

async function route(sock, jid, rawText) {
  const text = rawText || "";
  const trimmed = text.trim();

  if (trimmed.toLowerCase() === "reset") {
    resetSession(jid);
    await reply(sock, jid, "Sesi direset. " + MENU_TEXT);
    return;
  }

  const session = getSession(jid);

  if (session.state === "MENU" && !session.greeted) {
    session.greeted = true;
    return reply(sock, jid, WELCOME_TEXT + "\n\n" + MENU_TEXT);
  }

  switch (session.state) {
    case "MENU":
      return handleMenu(sock, jid, session, trimmed);

    case "MOM_COLLECT":
      return handleCollect(sock, jid, session, trimmed);

    case "MOM_ASK_SIMPLE":
      session.data[session.currentField] = trimmed;
      session.currentField = null;
      return proceedAfterFieldResolved(sock, jid, session);

    case "MOM_ATTENDEE_NAME":
      if (isDone(trimmed)) {
        if (session.data.attendees.length === 0) {
          return reply(sock, jid, "Minimal 1 attendee ya. Nama attendee?");
        }
        return proceedAfterFieldResolved(sock, jid, session);
      }
      session.tempItem = { name: trimmed };
      session.state = "MOM_ATTENDEE_COMPANY";
      return reply(sock, jid, `Company untuk *${trimmed}*?`);

    case "MOM_ATTENDEE_COMPANY":
      session.data.attendees.push({ name: session.tempItem.name, company: trimmed });
      session.tempItem = {};
      session.state = "MOM_ATTENDEE_NAME";
      return reply(sock, jid, "Attendee berikutnya? (ketik *selesai* kalau sudah semua)");

    case "MOM_ITEM_TITLE":
      if (isDone(trimmed)) {
        if (session.data.list_items.length === 0) {
          return reply(sock, jid, "Minimal 1 item ya. Judul item?");
        }
        return proceedAfterFieldResolved(sock, jid, session);
      }
      session.tempItem = { title: trimmed, bullets: [] };
      session.state = "MOM_ITEM_BULLETS";
      return reply(
        sock,
        jid,
        "Bullet poin untuk item ini? Kirim satu per pesan, ketik *selesai* kalau sudah."
      );

    case "MOM_ITEM_BULLETS":
      if (isDone(trimmed)) {
        if (session.tempItem.bullets.length === 0) {
          return reply(sock, jid, "Minimal 1 bullet ya. Bullet poinnya apa?");
        }
        session.state = "MOM_ITEM_ACTIONEE";
        return reply(sock, jid, "Actionee (siapa yang bertanggung jawab)?");
      }
      session.tempItem.bullets.push(trimmed);
      return reply(sock, jid, "Bullet ditambahkan. Lanjut lagi atau ketik *selesai*.");

    case "MOM_ITEM_ACTIONEE":
      session.tempItem.actionee = trimmed;
      session.tempItem.due_date = "-";
      session.data.list_items.push(session.tempItem);
      session.tempItem = {};
      session.state = "MOM_ITEM_TITLE";
      return reply(
        sock,
        jid,
        "Item ditambahkan. Judul item berikutnya? (ketik *selesai* kalau sudah semua)"
      );

    case "MOM_TODO_ASK":
      if (["ya", "yes", "y"].includes(trimmed.toLowerCase())) {
        session.state = "MOM_TODO_TITLE";
        return reply(sock, jid, "Judul Next Step pertama? (default: 'Next Step')");
      }
      session.state = "MOM_CONFIRM";
      return sendConfirmation(sock, jid, session);

    case "MOM_TODO_TITLE":
      if (isDone(trimmed)) {
        session.state = "MOM_CONFIRM";
        return sendConfirmation(sock, jid, session);
      }
      session.tempItem = { title: trimmed || "Next Step", bullets: [] };
      session.state = "MOM_TODO_BULLETS";
      return reply(
        sock,
        jid,
        "Bullet poin untuk Next Step ini? Kirim satu per pesan, ketik *selesai* kalau sudah."
      );

    case "MOM_TODO_BULLETS":
      if (isDone(trimmed)) {
        if (session.tempItem.bullets.length === 0) {
          return reply(sock, jid, "Minimal 1 bullet ya. Bullet poinnya apa?");
        }
        session.state = "MOM_TODO_ACTIONEE";
        return reply(sock, jid, "Actionee?");
      }
      session.tempItem.bullets.push(trimmed);
      return reply(sock, jid, "Bullet ditambahkan. Lanjut lagi atau ketik *selesai*.");

    case "MOM_TODO_ACTIONEE":
      session.tempItem.actionee = trimmed;
      session.state = "MOM_TODO_DUE";
      return reply(sock, jid, "Due date? (ketik *-* kalau tidak ada)");

    case "MOM_TODO_DUE":
      session.tempItem.due_date = SKIP_WORDS.has(trimmed.toLowerCase()) ? "-" : trimmed;
      session.data.todo_items.push(session.tempItem);
      session.tempItem = {};
      session.state = "MOM_TODO_TITLE";
      return reply(
        sock,
        jid,
        "Next Step ditambahkan. Judul berikutnya? (ketik *selesai* kalau sudah semua)"
      );

    case "MOM_FIX":
      return handleFix(sock, jid, session, trimmed);

    case "MOM_CONFIRM":
      return handleConfirm(sock, jid, session, trimmed);

    default:
      session.state = "MENU";
      return reply(sock, jid, MENU_TEXT);
  }
}

async function handleMenu(sock, jid, session, trimmed) {
  if (trimmed === "1") {
    session.data = emptyMomData();
    session.state = "MOM_COLLECT";
    return reply(
      sock,
      jid,
      "Oke, cerita aja tentang meeting-nya bebas — bisa langsung lengkap sekaligus, atau bertahap beberapa pesan. Kalau sudah selesai cerita, ketik *selesai*."
    );
  }
  if (trimmed === "2") {
    return reply(sock, jid, GUIDE_TEXT);
  }
  return reply(sock, jid, MENU_TEXT);
}

async function handleCollect(sock, jid, session, trimmed) {
  if (FINISH_COLLECT_WORDS.has(trimmed.toLowerCase())) {
    return proceedAfterFieldResolved(sock, jid, session);
  }

  try {
    const extracted = await extractMomData(session.data, trimmed);
    session.data = mergeMomData(session.data, extracted);
  } catch (err) {
    console.error("DeepSeek extraction error:", err);
    return reply(
      sock,
      jid,
      "Gagal proses lewat AI barusan, coba kirim ulang ceritanya ya. (Kalau terus gagal, cek DEEPSEEK_API_KEY di server.)"
    );
  }

  return reply(sock, jid, "Dicatat. Lanjut cerita lagi, atau ketik *selesai* kalau sudah lengkap.");
}

async function proceedAfterFieldResolved(sock, jid, session) {
  const missing = nextMissingField(session.data);

  if (missing === "attendees") {
    session.state = "MOM_ATTENDEE_NAME";
    return reply(sock, jid, "Siapa aja yang hadir? Nama attendee pertama? (ketik *selesai* kalau sudah semua)");
  }
  if (missing === "list_items") {
    session.state = "MOM_ITEM_TITLE";
    return reply(
      sock,
      jid,
      "Belum ada List/Action item yang ke-capture. Judul item pertama? (contoh: 'Identifikasi Permasalahan')"
    );
  }
  if (missing) {
    session.currentField = missing;
    session.state = "MOM_ASK_SIMPLE";
    return reply(sock, jid, FIELD_PROMPTS[missing]);
  }

  const fixQueue = buildFixQueue(session.data);
  if (fixQueue.length > 0) {
    session.fixQueue = fixQueue;
    session.state = "MOM_FIX";
    return reply(sock, jid, fixTaskPrompt(session.data, fixQueue[0]));
  }

  return finalizeAndConfirm(sock, jid, session);
}

async function handleFix(sock, jid, session, trimmed) {
  const task = session.fixQueue[0];
  applyFixAnswer(session.data, task, trimmed);
  session.fixQueue.shift();

  if (session.fixQueue.length > 0) {
    return reply(sock, jid, fixTaskPrompt(session.data, session.fixQueue[0]));
  }

  return finalizeAndConfirm(sock, jid, session);
}

async function finalizeAndConfirm(sock, jid, session) {
  if (session.data.distribution_list.length === 0) {
    session.data.distribution_list = [
      ...new Set(session.data.attendees.map((a) => a.company).filter(Boolean)),
    ];
  }

  if (session.data.todo_items.length > 0 || session.todoAsked) {
    session.state = "MOM_CONFIRM";
    return sendConfirmation(sock, jid, session);
  }

  session.todoAsked = true;
  session.state = "MOM_TODO_ASK";
  return reply(sock, jid, "Ada Next Step / to-do tambahan yang belum ke-capture? (ya/tidak)");
}

function summarize(data) {
  const lines = [];
  lines.push("*Ringkasan MOM*");
  lines.push(`Date: ${data.date}`);
  lines.push(`Project: ${data.project}`);
  lines.push(`Attachments: ${data.attachments || "-"}`);
  lines.push(`Venue: ${data.venue}`);
  lines.push(`Minutes taken by: ${data.minutes_taken_by}`);
  lines.push("");
  lines.push("Attendees:");
  for (const a of data.attendees) lines.push(`- ${a.name} (${a.company})`);
  lines.push("");
  lines.push(`Distribution List: ${data.distribution_list.join(", ")}`);
  lines.push("");
  lines.push(`Agenda: ${data.agenda}`);
  lines.push("");
  lines.push("List/Actions:");
  data.list_items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.title}`);
    (item.bullets || []).forEach((b) => lines.push(`   - ${b}`));
    lines.push(`   Actionee: ${item.actionee} | Due: ${item.due_date || "-"}`);
  });
  if (data.todo_items.length) {
    lines.push("");
    lines.push("Next Step:");
    data.todo_items.forEach((item, i) => {
      lines.push(`${data.list_items.length + i + 1}. ${item.title}`);
      (item.bullets || []).forEach((b) => lines.push(`   - ${b}`));
      lines.push(`   Actionee: ${item.actionee} | Due: ${item.due_date || "-"}`);
    });
  }
  return lines.join("\n");
}

async function sendConfirmation(sock, jid, session) {
  const summary = summarize(session.data);
  await reply(
    sock,
    jid,
    `${summary}\n\n---\nKirim *ya* untuk generate file, tulis koreksinya langsung (contoh: "venue-nya ganti jadi Zoom") untuk edit, atau *reset* untuk mulai ulang dari awal.`
  );
}

async function handleConfirm(sock, jid, session, trimmed) {
  if (trimmed.toLowerCase() !== "ya") {
    try {
      const extracted = await extractMomData(session.data, trimmed);
      session.data = mergeMomData(session.data, extracted);
    } catch (err) {
      console.error("DeepSeek correction error:", err);
      return reply(
        sock,
        jid,
        "Gagal proses koreksinya lewat AI, coba kirim ulang ya. Atau ketik *ya* untuk generate langsung, *reset* untuk mulai ulang."
      );
    }
    return proceedAfterFieldResolved(sock, jid, session);
  }

  await reply(sock, jid, "Generating MOM...");

  const jobId = `${jid.replace(/[^a-zA-Z0-9]/g, "_")}-${Date.now()}`;
  const outDir = path.join(__dirname, "..", "outputs", jobId);
  fs.mkdirSync(outDir, { recursive: true });

  const dataPath = path.join(outDir, "data.json");
  const docxPath = path.join(outDir, "MOM.docx");

  const payload = {
    ...session.data,
    form_number: "FRM-SLS-03",
    revision: "00",
    form_date: "13- 06- 2023",
  };
  fs.writeFileSync(dataPath, JSON.stringify(payload, null, 2));

  const generatorPath = path.join(__dirname, "mom", "generate_mom.js");

  await new Promise((resolve) => {
    execFile("node", [generatorPath, dataPath, docxPath], (error, stdout, stderr) => {
      if (error) {
        console.error("generate_mom.js failed:", error, stderr);
      }
      resolve();
    });
  });

  if (!fs.existsSync(docxPath)) {
    await reply(sock, jid, "Gagal generate file. Coba lagi atau ketik *reset*.");
    return;
  }

  await sock.sendMessage(jid, {
    document: fs.readFileSync(docxPath),
    fileName: `MOM - ${session.data.project || "Meeting"}.docx`,
    mimetype:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });

  resetSession(jid);
  await reply(sock, jid, "File terkirim. " + MENU_TEXT);
}

module.exports = { route, MENU_TEXT };
