const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD;
if (!ADMIN) { console.error("Defina a variável ADMIN_PASSWORD."); process.exit(1); }
const TOKEN = crypto.createHmac("sha256", ADMIN).update("amigo-admin").digest("hex");
const sha = s => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const SIZES = ["PP", "P", "M", "G", "GG", "XG"];

/* ---------- armazenamento: Postgres (Render) ou arquivo local ---------- */
/* Usa a chave "amigo-secreto" na tabela kv, então pode dividir o mesmo banco de outros sites. */
const KEY = "amigo-secreto";
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: false }
  });
}
const FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
let state = { people: [], assign: null, info: "" };

async function load() {
  try {
    if (pool) {
      await pool.query("create table if not exists kv(key text primary key, value jsonb not null)");
      const r = await pool.query("select value from kv where key=$1", [KEY]);
      if (r.rows[0]) state = r.rows[0].value;
    } else if (fs.existsSync(FILE)) {
      state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    }
  } catch (e) { console.error("Erro ao carregar dados:", e.message); }
  state.people = state.people || []; state.assign = state.assign || null; state.info = state.info || "";
}
let chain = Promise.resolve();
function persist() {
  const snap = JSON.stringify(state);
  chain = chain.then(async () => {
    try {
      if (pool) await pool.query(
        "insert into kv(key,value) values($1,$2) on conflict(key) do update set value=excluded.value", [KEY, snap]);
      else fs.writeFileSync(FILE, snap);
    } catch (e) { console.error("Erro ao salvar:", e.message); }
  });
}

/* ---------- tempo real (SSE) ---------- */
const clients = new Set();
let rev = 0;
const publicState = () => ({
  rev,
  drawn: !!state.assign,
  info: state.info,
  people: state.people.map(p => ({ id: p.id, name: p.name, likes: p.likes, size: p.size }))
});
function broadcast() {
  const msg = "data: " + JSON.stringify(publicState()) + "\n\n";
  for (const res of clients) res.write(msg);
}
function mutate(fn) { fn(); rev++; persist(); broadcast(); }

/* ---------- utilidades ---------- */
const hashPin = (pin, salt) => crypto.createHash("sha256").update(salt + ":" + pin).digest("hex");
const pinOk = (p, pin) => typeof pin === "string" && /^\d{4}$/.test(pin) && safeEq(hashPin(pin, p.salt), p.pinHash);
const hits = new Map();
function limited(req, max) {
  const now = Date.now(), k = req.ip + req.path.split("/").slice(0, 3).join("/");
  const arr = (hits.get(k) || []).filter(t => now - t < 60000);
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}
function clean(b) {
  return {
    name: String(b.name || "").trim().slice(0, 30),
    likes: String(b.likes || "").trim().slice(0, 300),
    size: SIZES.includes(b.size) ? b.size : ""
  };
}

/* ---------- app ---------- */
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

const isAdmin = req => safeEq(req.get("x-admin-token") || "", TOKEN);
const needAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(401).json({ error: "não autorizado" });

app.get("/api/state", (req, res) => res.json(publicState()));

app.get("/api/events", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("data: " + JSON.stringify(publicState()) + "\n\n");
  clients.add(res);
  const ka = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => { clearInterval(ka); clients.delete(res); });
});

app.post("/api/login", (req, res) => {
  if (limited(req, 10)) return res.status(429).json({ error: "muitas tentativas, espere um pouco" });
  if (safeEq(req.body.password || "", ADMIN)) return res.json({ token: TOKEN });
  res.status(401).json({ error: "senha errada" });
});

app.post("/api/people", (req, res) => {
  if (limited(req, 10)) return res.status(429).json({ error: "calma, muitas tentativas seguidas" });
  if (state.assign) return res.status(400).json({ error: "o sorteio já foi feito, cadastros fechados" });
  if (state.people.length >= 40) return res.status(400).json({ error: "limite de 40 pessoas" });
  const { name, likes, size } = clean(req.body);
  const pin = String(req.body.pin || "");
  if (!name) return res.status(400).json({ error: "coloca seu nome" });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: "o PIN precisa ter 4 números" });
  if (state.people.some(p => p.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: "já existe alguém com esse nome" });
  const salt = crypto.randomBytes(8).toString("hex");
  mutate(() => state.people.push({ id: crypto.randomUUID(), name, likes, size, salt, pinHash: hashPin(pin, salt) }));
  res.json({ ok: true });
});

app.post("/api/people/:id/update", (req, res) => {
  const p = state.people.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "não encontrado" });
  if (!isAdmin(req)) {
    if (limited(req, 10)) return res.status(429).json({ error: "muitas tentativas, espere um pouco" });
    if (!pinOk(p, String(req.body.pin || ""))) return res.status(401).json({ error: "PIN errado" });
  }
  const { name, likes, size } = clean(req.body);
  if (!name) return res.status(400).json({ error: "coloca um nome" });
  if (state.people.some(x => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: "já existe alguém com esse nome" });
  mutate(() => { p.name = name; p.likes = likes; p.size = size; });
  res.json({ ok: true });
});

app.delete("/api/people/:id", needAdmin, (req, res) => {
  if (!state.people.some(p => p.id === req.params.id)) return res.status(404).json({ error: "não encontrado" });
  mutate(() => {
    state.people = state.people.filter(p => p.id !== req.params.id);
    state.assign = null; // mudou a lista: o sorteio precisa ser refeito
  });
  res.json({ ok: true });
});

app.post("/api/info", needAdmin, (req, res) => {
  mutate(() => { state.info = String(req.body.info || "").trim().slice(0, 500); });
  res.json({ ok: true });
});

app.post("/api/draw", needAdmin, (req, res) => {
  const n = state.people.length;
  if (n < 3) return res.status(400).json({ error: "precisa de pelo menos 3 pessoas" });
  if (state.assign) return res.status(400).json({ error: "o sorteio já foi feito" });
  const ids = state.people.map(p => p.id);
  for (let i = ids.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  const assign = {};
  ids.forEach((id, i) => { assign[id] = ids[(i + 1) % ids.length]; }); // ciclo único: ninguém tira a si mesmo nem troca em dupla
  mutate(() => { state.assign = assign; });
  res.json({ ok: true });
});

app.post("/api/draw/reset", needAdmin, (req, res) => {
  mutate(() => { state.assign = null; });
  res.json({ ok: true });
});

app.post("/api/reveal", (req, res) => {
  if (limited(req, 10)) return res.status(429).json({ error: "muitas tentativas, espere um pouco" });
  if (!state.assign) return res.status(400).json({ error: "o sorteio ainda não foi feito" });
  const p = state.people.find(x => x.id === String(req.body.id || ""));
  if (!p || !pinOk(p, String(req.body.pin || ""))) return res.status(401).json({ error: "PIN errado" });
  const t = state.people.find(x => x.id === state.assign[p.id]);
  if (!t) return res.status(400).json({ error: "o sorteio precisa ser refeito" });
  res.set("Cache-Control", "no-store");
  res.json({ name: t.name, likes: t.likes, size: t.size });
});

load().then(() => app.listen(PORT, () => console.log("Amigo Secreto dos Vingadores na porta " + PORT)));
