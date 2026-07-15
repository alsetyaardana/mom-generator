// Voice note transcription via Groq's Whisper API. Free tier is plenty for
// this bot's volume — see console.groq.com/keys for the API key.

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

async function transcribeAudio(buffer, filename = "voice.ogg") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY belum diset di environment.");
  }

  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", GROQ_MODEL);

  const res = await fetch(GROQ_TRANSCRIBE_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq transcription error ${res.status}: ${body}`);
  }

  const json = await res.json();
  if (!json.text) throw new Error("Groq API tidak mengembalikan teks transkrip.");
  return json.text;
}

module.exports = { transcribeAudio };
