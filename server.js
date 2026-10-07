const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

const PORT = process.env.PORT || 3000;
const CLAN_KEY = "ClanXu";
const ADMIN_PASS = "CLANXU2026";

const RANKS = [
  "Rookie",
  "Veteran",
  "Elite",
  "Pro",
  "Master",
  "Grandmaster",
  "Legendary",
  "ClanXU Elite"
];

// In-memory state
const state = {
  users: {},          // name -> user
  pendingUsers: {},   // name -> pending
  tryouts: [],
  chatHistory: [],
  announcements: [],
  admins: new Set()
};

function publicUser(u) {
  if (!u) return null;
  return {
    name: u.name,
    role: u.role,
    rank: u.rank || "Rookie",
    uid: u.uid || "",
    hud: u.hud || "",
    sensi: u.sensi || "",
    avatar: u.avatar || "",
    collection: u.collection || "",
    invitedBy: u.invitedBy || "",
    isAdmin: !!u.isAdmin
  };
}

function roster() {
  return Object.values(state.users)
    .map(publicUser)
    .sort((a, b) => RANKS.indexOf(b.rank) - RANKS.indexOf(a.rank) || a.name.localeCompare(b.name));
}

function mailbox() {
  return {
    joins: Object.values(state.pendingUsers).filter(p => p.type === "join"),
    admins: Object.values(state.pendingUsers).filter(p => p.type === "admin"),
    tryouts: state.tryouts.filter(t => t.status === "pending")
  };
}

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

io.on("connection", (socket) => {
  socket.data.name = null;
  socket.data.role = null;
  socket.data.isAdmin = false;

  socket.emit("ranks", RANKS);

  socket.on("check-key", (key, cb) => {
    cb && cb({ ok: key === CLAN_KEY });
  });

  socket.on("request-join", (payload, cb) => {
    const name = (payload.name || "").trim();
    const role = payload.role === "tryouter" ? "tryouter" : "member";
    const invitedBy = (payload.invitedBy || "").trim();
    if (!name || name.length < 2) return cb && cb({ ok: false, error: "Invalid name" });
    if (state.users[name] || state.pendingUsers[name]) return cb && cb({ ok: false, error: "Name taken" });
    state.pendingUsers[name] = {
      name,
      role,
      type: "join",
      invitedBy,
      createdAt: Date.now()
    };
    io.emit("mailbox", mailbox());
    cb && cb({ ok: true, waiting: true });
  });

  socket.on("admin-login", (password, cb) => {
    if (password !== ADMIN_PASS) return cb && cb({ ok: false, error: "Wrong password" });
    socket.data.isAdmin = true;
    if (socket.data.name) {
      state.admins.add(socket.data.name);
      if (state.users[socket.data.name]) state.users[socket.data.name].isAdmin = true;
    }
    cb && cb({ ok: true });
    socket.emit("mailbox", mailbox());
  });

  socket.on("approve-user", (name, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    const p = state.pendingUsers[name];
    if (!p) return cb && cb({ ok: false });
    state.users[name] = {
      name,
      role: p.role === "tryouter" ? "tryouter" : "member",
      rank: "Rookie",
      uid: "",
      hud: "",
      sensi: "",
      avatar: "",
      collection: "",
      invitedBy: p.invitedBy || "",
      isAdmin: false
    };
    delete state.pendingUsers[name];
    io.emit("roster", roster());
    io.emit("mailbox", mailbox());
    io.emit("user-approved", { name });
    cb && cb({ ok: true });
  });

  socket.on("deny-user", (name, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    delete state.pendingUsers[name];
    io.emit("mailbox", mailbox());
    io.emit("user-denied", { name });
    cb && cb({ ok: true });
  });

  socket.on("enter", (payload, cb) => {
    const name = (payload.name || "").trim();
    if (!name || !state.users[name]) return cb && cb({ ok: false, error: "Not approved yet" });
    socket.data.name = name;
    socket.data.role = state.users[name].role;
    socket.data.isAdmin = !!state.users[name].isAdmin || state.admins.has(name);
    socket.join("clan");
    cb && cb({
      ok: true,
      user: publicUser(state.users[name]),
      isAdmin: socket.data.isAdmin
    });
    socket.emit("chat-history", state.chatHistory.slice(-100));
    socket.emit("roster", roster());
    socket.emit("announcements", state.announcements.slice(-20));
    if (socket.data.isAdmin) socket.emit("mailbox", mailbox());
  });

  socket.on("save-profile", (data, cb) => {
    const name = socket.data.name;
    if (!name || !state.users[name]) return cb && cb({ ok: false });
    const u = state.users[name];
    if (data.uid !== undefined) u.uid = String(data.uid).slice(0, 32);
    if (data.rank && RANKS.includes(data.rank)) u.rank = data.rank;
    if (data.hud !== undefined) u.hud = String(data.hud).slice(0, 80);
    if (data.sensi !== undefined) u.sensi = String(data.sensi).slice(0, 80);
    if (data.avatar !== undefined) u.avatar = String(data.avatar).slice(0, 500000);
    if (data.collection !== undefined) u.collection = String(data.collection).slice(0, 500000);
    io.emit("roster", roster());
    cb && cb({ ok: true, user: publicUser(u) });
  });

  socket.on("chat-message", (msg, cb) => {
    const name = socket.data.name;
    if (!name || !state.users[name]) return;
    if (state.users[name].role === "tryouter" && msg.type === "voice") {
      // allow voice for tryouter too
    }
    const item = {
      id: uuidv4(),
      name,
      role: state.users[name].role,
      text: msg.type === "text" ? String(msg.text || "").slice(0, 500) : "",
      type: msg.type === "voice" ? "voice" : "text",
      voice: msg.type === "voice" ? String(msg.voice || "").slice(0, 400000) : "",
      time: Date.now()
    };
    state.chatHistory.push(item);
    if (state.chatHistory.length > 300) state.chatHistory = state.chatHistory.slice(-300);
    io.to("clan").emit("chat-message", item);
    cb && cb({ ok: true });
  });

  socket.on("delete-message", (id, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    state.chatHistory = state.chatHistory.filter(m => m.id !== id);
    io.to("clan").emit("delete-message", id);
    cb && cb({ ok: true });
  });

  socket.on("announce", (text, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    const a = { id: uuidv4(), text: String(text).slice(0, 300), by: socket.data.name, time: Date.now() };
    state.announcements.unshift(a);
    state.announcements = state.announcements.slice(0, 30);
    io.emit("announce", a);
    cb && cb({ ok: true });
  });

  socket.on("submit-tryout", (data, cb) => {
    const name = socket.data.name || data.ign;
    const t = {
      id: uuidv4(),
      ign: String(data.ign || name || "").slice(0, 24),
      uid: String(data.uid || "").slice(0, 32),
      rank: data.rank || "Rookie",
      placement: String(data.placement || "").slice(0, 40),
      hud: String(data.hud || "").slice(0, 80),
      sensi: String(data.sensi || "").slice(0, 80),
      reason: String(data.reason || "").slice(0, 300),
      status: "pending",
      time: Date.now()
    };
    state.tryouts.unshift(t);
    io.emit("mailbox", mailbox());
    cb && cb({ ok: true });
  });

  socket.on("approve-tryout", (id, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    const t = state.tryouts.find(x => x.id === id);
    if (!t) return cb && cb({ ok: false });
    t.status = "approved";
    if (!state.users[t.ign]) {
      state.users[t.ign] = {
        name: t.ign,
        role: "member",
        rank: t.rank || "Rookie",
        uid: t.uid,
        hud: t.hud,
        sensi: t.sensi,
        avatar: "",
        collection: "",
        invitedBy: "",
        isAdmin: false
      };
    } else {
      state.users[t.ign].role = "member";
    }
    io.emit("roster", roster());
    io.emit("mailbox", mailbox());
    cb && cb({ ok: true });
  });

  socket.on("deny-tryout", (id, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    const t = state.tryouts.find(x => x.id === id);
    if (t) t.status = "denied";
    io.emit("mailbox", mailbox());
    cb && cb({ ok: true });
  });

  socket.on("rename-user", ({ oldName, newName }, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    newName = (newName || "").trim();
    if (!state.users[oldName] || !newName || state.users[newName]) return cb && cb({ ok: false });
    state.users[newName] = { ...state.users[oldName], name: newName };
    delete state.users[oldName];
    io.emit("roster", roster());
    cb && cb({ ok: true });
  });

  socket.on("kick-user", (name, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    delete state.users[name];
    state.admins.delete(name);
    io.emit("roster", roster());
    io.emit("kicked", { name });
    cb && cb({ ok: true });
  });

  socket.on("promote-tryouter", (name, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    if (state.users[name]) {
      state.users[name].role = "member";
      io.emit("roster", roster());
    }
    cb && cb({ ok: true });
  });

  socket.on("get-mailbox", (cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false });
    cb && cb({ ok: true, mailbox: mailbox() });
  });

  socket.on("get-initial", (cb) => {
    cb && cb({
      ok: true,
      ranks: RANKS,
      roster: roster(),
      announcements: state.announcements.slice(-20)
    });
  });

  socket.on("disconnect", () => {});
});

server.listen(PORT, () => {
  console.log("ClanXU running on port", PORT);
});
