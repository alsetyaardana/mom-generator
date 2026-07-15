// In-memory per-JID conversation state. Cleared on process restart —
// this is intentional for this version (see plan: no SQLite yet). The WA
// auth session itself persists separately via the Docker volume mount on
// data/auth_state, so restarting this store does not require re-scanning
// the QR code.

const sessions = new Map();

function emptyMomData() {
  return {
    date: "",
    project: "",
    attachments: "",
    venue: "",
    minutes_taken_by: "",
    attendees: [],
    distribution_list: [],
    agenda: "",
    list_items: [],
    todo_items: [],
  };
}

function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, {
      state: "MENU",
      data: emptyMomData(),
      tempItem: {},
    });
  }
  return sessions.get(jid);
}

function resetSession(jid) {
  sessions.set(jid, {
    state: "MENU",
    data: emptyMomData(),
    tempItem: {},
  });
  return sessions.get(jid);
}

module.exports = { getSession, resetSession, emptyMomData };
