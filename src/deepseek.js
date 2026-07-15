// DeepSeek extraction: turns free-form meeting chat text into the MOM data
// schema. Only fills what's explicitly stated — never invents content
// (matches the porta-mom-generator skill's own rule).

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const SYSTEM_PROMPT = `Kamu membantu mengekstrak detail Minutes of Meeting (MOM) dari cerita natural seorang user berbahasa Indonesia/Inggris campur.

Kembalikan HANYA JSON dengan schema persis berikut, tanpa teks lain:
{
  "date": string,
  "project": string,
  "attachments": string,
  "venue": string,
  "minutes_taken_by": string,
  "attendees": [{ "name": string, "company": string }],
  "distribution_list": [string],
  "agenda": string,
  "list_items": [{ "title": string, "bullets": [string], "actionee": string, "due_date": string }],
  "todo_items": [{ "title": string, "bullets": [string], "actionee": string, "due_date": string }]
}

Aturan PENTING:
- JANGAN mengarang isi apapun. Kalau suatu informasi tidak disebutkan di teks user, kembalikan string kosong "" (atau array kosong []) untuk field itu — jangan ditebak.
- Kamu akan diberi "existing_data" (hasil ekstraksi sebelumnya) dan "new_message" (pesan baru dari user). Gabungkan: pertahankan field existing_data yang sudah terisi kecuali new_message jelas-jelas menambah/mengoreksinya.
- "list_items" adalah topik diskusi/temuan/keputusan meeting (bukan to-do). "todo_items" adalah next step / rencana ke depan, hanya isi kalau user eksplisit menyebut rencana ke depan / to-do / next step.
- due_date boleh dikosongkan "" jika tidak disebutkan, itu tidak masalah.
- title tiap list_item singkat (mis. "Identifikasi Permasalahan"), bullets berisi detail poin-poin.`;

async function extractMomData(existingData, newMessage) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY belum diset di environment.");
  }

  const userPrompt = JSON.stringify({ existing_data: existingData, new_message: newMessage });

  const res = await fetch(DEEPSEEK_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`DeepSeek API error ${res.status}: ${body}`);
  }

  const json = await res.json();
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek API tidak mengembalikan konten.");

  return JSON.parse(content);
}

module.exports = { extractMomData };
