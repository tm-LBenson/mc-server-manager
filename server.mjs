// =========================
import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const run = async (...args) => {
  const { stdout } = await promisify(execFile)("docker", args);
  return stdout.toString();
};

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8881; // default UI port
let TARGET = process.env.MC_CONTAINER || "bedrock-server"; // current target container name or ID

const inspect = async (name = TARGET) => {
  const j = JSON.parse(await run("inspect", name));
  if (!j.length) throw new Error("container not found");
  return j[0];
};

const fileDifficulty = async (name = TARGET) => {
  try {
    const out = await run(
      "exec",
      name,
      "sh",
      "-lc",
      "grep -E '^difficulty=' /data/server.properties | head -n1 | cut -d= -f2",
    );
    return out.trim() || null;
  } catch {
    return null;
  }
};

const envListToObject = (list = []) =>
  Object.fromEntries(
    list.map((e) => {
      const i = e.indexOf("=");
      return i === -1 ? [e, ""] : [e.slice(0, i), e.slice(i + 1)];
    }),
  );

// -------- API --------
app.get("/api/info", async (req, res) => {
  try {
    const target = req.query.name || TARGET;
    const i = await inspect(target);
    const env = envListToObject(i.Config?.Env || []);
    res.json({
      target,
      name: i.Name?.replace(/^\//, ""),
      running: !!i.State?.Running,
      state: i.State?.Status || "unknown",
      envDifficulty: env.DIFFICULTY ?? null,
      fileDifficulty: await fileDifficulty(target),
      ports: i.HostConfig?.PortBindings || {},
      mounts: (i.Mounts || []).map((m) => ({
        type: m.Type,
        source: m.Name || m.Source,
        dest: m.Destination,
        rw: m.RW,
      })),
      restartPolicy: i.HostConfig?.RestartPolicy || {},
      image: i.Config?.Image,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/restart", async (req, res) => {
  const name = req.body?.name || TARGET;
  try {
    await run("restart", name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/start", async (req, res) => {
  const name = req.body?.name || TARGET;
  try {
    await run("start", name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/stop", async (req, res) => {
  const name = req.body?.name || TARGET;
  try {
    await run("stop", name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// change difficulty by recreating the container with updated DIFFICULTY, preserving ports and volumes
app.post("/api/difficulty", async (req, res) => {
  try {
    const target = req.body?.name || TARGET;
    const level = String(req.body?.level || "").toLowerCase();
    if (!["peaceful", "easy", "normal", "hard"].includes(level))
      return res
        .status(400)
        .json({ error: "level must be peaceful|easy|normal|hard" });

    const i = await inspect(target);

    const env = (i.Config?.Env || []).filter(
      (e) => !e.startsWith("DIFFICULTY="),
    );
    env.push(`DIFFICULTY=${level}`);
    if (!env.some((e) => e.startsWith("EULA="))) env.push("EULA=TRUE");

    const portFlags = [];
    const pb = i.HostConfig?.PortBindings || {};
    for (const key of Object.keys(pb)) {
      const binds = pb[key];
      if (!binds || !binds.length) continue;
      const host = binds[0].HostPort; // first mapping
      portFlags.push("-p", `${host}:${key}`); // key includes /udp if needed
    }

    const volFlags = [];
    for (const m of i.Mounts || []) {
      const src = m.Type === "volume" ? m.Name || m.Source : m.Source;
      const mode = m.RW ? "" : ":ro";
      volFlags.push("-v", `${src}:${m.Destination}${mode}`);
    }

    const envFlags = env.flatMap((e) => ["-e", e]);
    const restartName = i.HostConfig?.RestartPolicy?.Name || "unless-stopped";
    const image = i.Config?.Image || "itzg/minecraft-bedrock-server:latest";
    const name = i.Name?.replace(/^\//, "") || target;

    try {
      await run("stop", name);
    } catch {}
    try {
      await run("rm", "-f", name);
    } catch {}

    await run(
      "run",
      "-d",
      "--name",
      name,
      ...portFlags,
      ...volFlags,
      ...envFlags,
      "--restart",
      restartName,
      image,
    );

    TARGET = name; // keep current target
    res.json({ ok: true, newDifficulty: level, target: TARGET });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// target management
app.get("/api/target", (_req, res) => res.json({ target: TARGET }));
app.post("/api/target", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name required" });
    await inspect(name); // throws if not found
    TARGET = name;
    res.json({ ok: true, target: TARGET });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// list containers
app.get("/api/containers", async (_req, res) => {
  try {
    const out = await run(
      "ps",
      "-a",
      "--format",
      "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}",
    );
    const rows = out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [id, name, image, ...rest] = l.split(/\t/);
        return { id, name, image, status: rest.join(" ") };
      });
    res.json({ containers: rows });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// rename container
app.post("/api/rename", async (req, res) => {
  try {
    const name = req.body?.name || TARGET;
    const newName = String(req.body?.newName || "").trim();
    if (!newName) return res.status(400).json({ error: "newName required" });
    await run("rename", name, newName);
    if (TARGET === name) TARGET = newName;
    res.json({ ok: true, target: TARGET });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// logs
app.get("/api/logs", async (req, res) => {
  const name = req.query.name || TARGET;
  const lines = Math.max(
    1,
    Math.min(5000, parseInt(req.query.lines || "200", 10) || 200),
  );
  try {
    const out = await run("logs", "--tail", String(lines), name);
    res.type("text/plain").send(out);
  } catch (e) {
    res
      .status(500)
      .type("text/plain")
      .send(String(e.message || e));
  }
});

// serve static UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html")),
);

app.listen(PORT, () =>
  console.log(`UI: http://localhost:${PORT}  (target: ${TARGET})`),
);
