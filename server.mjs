import express from "express";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8881;
const DEFAULT_CONTAINER = process.env.MC_CONTAINER || "minecraft-java";
const CONFIG_PATH = process.env.MC_SERVERS_FILE || path.join(__dirname, "servers.json");
const DEFAULT_DOCKER_TIMEOUT_MS = Number.parseInt(process.env.DOCKER_TIMEOUT_MS || "20000", 10);
const QUICK_DOCKER_TIMEOUT_MS = Number.parseInt(process.env.DOCKER_QUICK_TIMEOUT_MS || "6000", 10);
const SSH_CONNECT_TIMEOUT_SECONDS = Number.parseInt(process.env.SSH_CONNECT_TIMEOUT_SECONDS || "10", 10);
const SSH_STRICT_HOST_KEY_CHECKING = process.env.SSH_STRICT_HOST_KEY_CHECKING || "accept-new";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "techtavern";
const AUTH_COOKIE = "mcsm_auth";
const AUTH_TOKEN = randomBytes(32).toString("hex");

const normalizeTimeout = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

const slug = (value, fallback = "server") => {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || fallback;
};

const defaultServers = () => [
  {
    id: slug(`local-${DEFAULT_CONTAINER}`, "local"),
    label: `Local ${DEFAULT_CONTAINER}`,
    type: "local",
    container: DEFAULT_CONTAINER,
  },
];

const normalizeServer = (server = {}, index = 0) => {
  const type = server.type === "ssh" ? "ssh" : "local";
  const container = String(server.container || server.name || DEFAULT_CONTAINER).trim();
  const label = String(server.label || server.id || container || `Server ${index + 1}`).trim();
  const id = slug(server.id || label || `${type}-${index + 1}`, `${type}-${index + 1}`);

  const normalized = {
    id,
    label,
    type,
    container,
  };

  if (type === "ssh") {
    normalized.host = String(server.host || "").trim();
    normalized.user = String(server.user || "").trim();
    normalized.port = Number.parseInt(server.port || "22", 10) || 22;
    normalized.identityFile = String(server.identityFile || "").trim();
    normalized.dockerPath = String(server.dockerPath || "docker").trim() || "docker";
  } else {
    normalized.dockerPath = String(server.dockerPath || "docker").trim() || "docker";
  }

  return normalized;
};

const publicServer = (server) => ({
  id: server.id,
  label: server.label,
  type: server.type,
  container: server.container,
  host: server.host || "",
  user: server.user || "",
  port: server.port || null,
  identityFile: server.identityFile || "",
  dockerPath: server.dockerPath || "docker",
  hostLabel: hostLabel(server),
});

const validateServer = (server) => {
  if (!server.label) throw new Error("server label required");
  if (!server.container) throw new Error("container name required");

  if (server.type === "ssh") {
    if (!server.host) throw new Error("SSH host required");
    if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65535) {
      throw new Error("SSH port must be between 1 and 65535");
    }
  }
};

let SERVERS = defaultServers();
let ACTIVE_SERVER_ID = process.env.MC_SERVER_ID || SERVERS[0].id;

const loadServers = async () => {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const servers = Array.isArray(parsed.servers) ? parsed.servers.map(normalizeServer) : [];
    SERVERS = servers.length ? servers : defaultServers();
    ACTIVE_SERVER_ID = parsed.activeServerId || process.env.MC_SERVER_ID || SERVERS[0].id;
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read ${CONFIG_PATH}: ${error.message}`);
    }
    SERVERS = defaultServers();
    ACTIVE_SERVER_ID = process.env.MC_SERVER_ID || SERVERS[0].id;
  }

  if (!SERVERS.some((server) => server.id === ACTIVE_SERVER_ID)) {
    ACTIVE_SERVER_ID = SERVERS[0].id;
  }
};

const saveServers = async () => {
  const payload = {
    activeServerId: ACTIVE_SERVER_ID,
    servers: SERVERS,
  };
  await fs.writeFile(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`);
};

await loadServers();

const parseCookies = (header = "") =>
  Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );

const isAuthenticated = (req) => parseCookies(req.headers.cookie || "")[AUTH_COOKIE] === AUTH_TOKEN;

const authCookieOptions = (req) => {
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
  return [
    `${AUTH_COOKIE}=${encodeURIComponent(AUTH_TOKEN)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Max-Age=2592000",
  ]
    .filter(Boolean)
    .join("; ");
};

app.get("/login", (req, res) => {
  if (isAuthenticated(req)) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/session", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.post("/api/login", (req, res) => {
  const password = String(req.body?.password || "");
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid password" });
  }

  res.setHeader("Set-Cookie", authCookieOptions(req));
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Authentication required" });
  return res.redirect("/login");
});

const hostLabel = (server) => {
  if (!server) return "unknown";
  if (server.type === "ssh") {
    const user = server.user ? `${server.user}@` : "";
    return `${user}${server.host}:${server.port || 22}`;
  }
  return "local Docker";
};

const findServer = (id) => SERVERS.find((server) => server.id === id);

const localTransientServer = (container) =>
  normalizeServer({
    id: `local-${container}`,
    label: `Local ${container}`,
    type: "local",
    container,
  });

const resolveServer = (source = {}) => {
  const serverId = String(source.serverId || "").trim();
  const name = String(source.name || "").trim();

  if (serverId) {
    const server = findServer(serverId);
    if (!server) throw new Error(`server target not found: ${serverId}`);
    return name && name !== server.container ? { ...server, container: name } : server;
  }

  if (name) {
    const matching = SERVERS.find((server) => server.id === name || server.label === name || server.container === name);
    return matching || localTransientServer(name);
  }

  return findServer(ACTIVE_SERVER_ID) || SERVERS[0];
};

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const dockerCommandArgs = (server, args) => [server.dockerPath || "docker", ...args];

const sshDestination = (server) => (server.user ? `${server.user}@${server.host}` : server.host);

const sshArgs = (server, args) => {
  const remoteCommand = dockerCommandArgs(server, args).map(shellQuote).join(" ");
  const options = [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${normalizeTimeout(SSH_CONNECT_TIMEOUT_SECONDS, 10)}`,
    "-o",
    `StrictHostKeyChecking=${SSH_STRICT_HOST_KEY_CHECKING}`,
    "-p",
    String(server.port || 22),
  ];

  if (server.identityFile) {
    options.push("-i", server.identityFile);
  }

  return [...options, sshDestination(server), remoteCommand];
};

const runDocker = async (server, timeoutMs, ...args) => {
  const timeout = normalizeTimeout(timeoutMs, DEFAULT_DOCKER_TIMEOUT_MS);
  const command = server.type === "ssh" ? "ssh" : server.dockerPath || "docker";
  const commandArgs = server.type === "ssh" ? sshArgs(server, args) : args;

  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      windowsHide: true,
    });
    return stdout.toString();
  } catch (error) {
    const timeoutMessage =
      error?.killed || error?.code === "ETIMEDOUT"
        ? `${server.type === "ssh" ? "ssh docker" : "docker"} ${args[0] || "command"} timed out after ${timeout}ms`
        : "";
    const parts = [timeoutMessage, error?.message, error?.stdout?.toString?.(), error?.stderr?.toString?.()].filter(Boolean);
    throw new Error(parts.join("\n").trim());
  }
};

const run = async (server, ...args) => runDocker(server, DEFAULT_DOCKER_TIMEOUT_MS, ...args);
const runQuick = async (server, ...args) => runDocker(server, QUICK_DOCKER_TIMEOUT_MS, ...args);

const inspect = async (server) => {
  const parsed = JSON.parse(await run(server, "inspect", server.container));
  if (!parsed.length) throw new Error("container not found");
  return parsed[0];
};

const envListToObject = (list = []) =>
  Object.fromEntries(
    list.map((entry) => {
      const index = entry.indexOf("=");
      return index === -1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );

const detectEdition = (image = "") => {
  const lowered = String(image).toLowerCase();
  if (lowered.includes("minecraft-bedrock-server")) return "bedrock";
  if (lowered.includes("minecraft-server")) return "java";
  return "unknown";
};

const whitelistFilePath = (edition) => (edition === "bedrock" ? "/data/allowlist.json" : "/data/whitelist.json");

const quoteCommandArg = (value) => `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const getContainerMeta = async (server) => {
  const i = await inspect(server);
  const image = i.Config?.Image || "";
  const edition = detectEdition(image);
  return { i, image, edition };
};

const ensureRunning = (containerInspect) => {
  if (!containerInspect?.State?.Running) {
    throw new Error("container is not running");
  }
};

const normalizePlayerName = (value) => {
  const player = String(value || "").trim();
  if (!player) throw new Error("player username required");
  if (/[\r\n]/.test(player)) throw new Error("player username cannot contain line breaks");
  return player;
};

const sendServerCommand = async (server, containerInspect, args) => {
  const edition = detectEdition(containerInspect.Config?.Image || "");

  if (edition === "java") {
    const stdout = await run(server, "exec", server.container, "rcon-cli", ...args);
    return { edition, stdout };
  }

  if (edition === "bedrock") {
    await run(server, "exec", server.container, "send-command", ...args);
    return {
      edition,
      stdout: "",
      note: "Bedrock command output is written to the container logs.",
    };
  }

  throw new Error(`unsupported container image for server commands: ${containerInspect.Config?.Image || "unknown"}`);
};

const fileDifficulty = async (server) => {
  try {
    const out = await runQuick(
      server,
      "exec",
      server.container,
      "sh",
      "-lc",
      "grep -E '^difficulty=' /data/server.properties | head -n1 | cut -d= -f2",
    );
    return out.trim() || null;
  } catch {
    return null;
  }
};

const readWhitelistFile = async (server) => {
  const { i, edition } = await getContainerMeta(server);
  if (edition === "unknown") {
    throw new Error(`could not determine server edition for ${i.Config?.Image || "unknown image"}`);
  }

  const file = whitelistFilePath(edition);
  let raw = "[]";
  try {
    raw = await runQuick(server, "exec", server.container, "sh", "-lc", `test -f ${file} && cat ${file} || printf '[]'`);
  } catch {
    raw = "[]";
  }

  let entries = [];
  try {
    entries = JSON.parse(raw || "[]");
  } catch {
    entries = [];
  }

  return {
    edition,
    file,
    entries,
    raw: raw || "[]",
  };
};

const updateServerContainer = async (serverId, container) => {
  const server = findServer(serverId);
  if (!server || !container || server.container === container) return server;
  server.container = container;
  await saveServers();
  return server;
};

// -------- API --------
app.get("/api/servers", (_req, res) => {
  res.json({
    activeServerId: ACTIVE_SERVER_ID,
    servers: SERVERS.map(publicServer),
  });
});

app.post("/api/servers", async (req, res) => {
  try {
    const server = normalizeServer(req.body || {}, SERVERS.length);
    validateServer(server);
    await inspect(server);

    const existingIndex = SERVERS.findIndex((item) => item.id === server.id);
    if (existingIndex === -1) {
      SERVERS.push(server);
    } else {
      SERVERS[existingIndex] = server;
    }

    ACTIVE_SERVER_ID = server.id;
    await saveServers();
    res.json({ ok: true, activeServerId: ACTIVE_SERVER_ID, server: publicServer(server), servers: SERVERS.map(publicServer) });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.delete("/api/servers/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ error: "server id required" });
    if (SERVERS.length <= 1) return res.status(400).json({ error: "cannot delete the only server target" });

    const nextServers = SERVERS.filter((server) => server.id !== id);
    if (nextServers.length === SERVERS.length) return res.status(404).json({ error: "server target not found" });

    SERVERS = nextServers;
    if (ACTIVE_SERVER_ID === id) ACTIVE_SERVER_ID = SERVERS[0].id;
    await saveServers();
    res.json({ ok: true, activeServerId: ACTIVE_SERVER_ID, servers: SERVERS.map(publicServer) });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/info", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const i = await inspect(server);
    const env = envListToObject(i.Config?.Env || []);
    const edition = detectEdition(i.Config?.Image || "");
    res.json({
      serverId: server.id,
      serverLabel: server.label,
      hostLabel: hostLabel(server),
      target: server.container,
      name: i.Name?.replace(/^\//, ""),
      running: !!i.State?.Running,
      state: i.State?.Status || "unknown",
      edition,
      envDifficulty: env.DIFFICULTY ?? null,
      fileDifficulty: await fileDifficulty(server),
      ports: i.HostConfig?.PortBindings || {},
      mounts: (i.Mounts || []).map((m) => ({
        type: m.Type,
        source: m.Name || m.Source,
        dest: m.Destination,
        rw: m.RW,
      })),
      restartPolicy: i.HostConfig?.RestartPolicy || {},
      image: i.Config?.Image,
      whitelistFile: edition === "unknown" ? null : whitelistFilePath(edition),
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/restart", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    await run(server, "restart", server.container);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/start", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    await run(server, "start", server.container);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/stop", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    await run(server, "stop", server.container);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// Change difficulty by recreating the container with updated DIFFICULTY, preserving ports and volumes.
app.post("/api/difficulty", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const level = String(req.body?.level || "").toLowerCase();
    if (!["peaceful", "easy", "normal", "hard"].includes(level)) {
      return res.status(400).json({ error: "level must be peaceful|easy|normal|hard" });
    }

    const i = await inspect(server);

    const env = (i.Config?.Env || []).filter((entry) => !entry.startsWith("DIFFICULTY="));
    env.push(`DIFFICULTY=${level}`);
    if (!env.some((entry) => entry.startsWith("EULA="))) env.push("EULA=TRUE");

    const portFlags = [];
    const pb = i.HostConfig?.PortBindings || {};
    for (const [key, binds] of Object.entries(pb)) {
      if (!Array.isArray(binds)) continue;
      for (const bind of binds) {
        if (!bind?.HostPort) continue;
        const hostIp = bind.HostIp && bind.HostIp !== "0.0.0.0" ? `${bind.HostIp}:` : "";
        portFlags.push("-p", `${hostIp}${bind.HostPort}:${key}`);
      }
    }

    const volFlags = [];
    for (const mount of i.Mounts || []) {
      const src = mount.Type === "volume" ? mount.Name || mount.Source : mount.Source;
      const mode = mount.RW ? "" : ":ro";
      volFlags.push("-v", `${src}:${mount.Destination}${mode}`);
    }

    const envFlags = env.flatMap((entry) => ["-e", entry]);
    const restartName = i.HostConfig?.RestartPolicy?.Name || "unless-stopped";
    const image = i.Config?.Image || "itzg/minecraft-server:latest";
    const name = i.Name?.replace(/^\//, "") || server.container;

    try {
      await run(server, "stop", name);
    } catch {}
    try {
      await run(server, "rm", "-f", name);
    } catch {}

    await run(server, "run", "-d", "--name", name, ...portFlags, ...volFlags, ...envFlags, "--restart", restartName, image);

    await updateServerContainer(server.id, name);
    res.json({ ok: true, newDifficulty: level, target: name, serverId: server.id });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/whitelist", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    res.json(await readWhitelistFile(server));
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/whitelist/enable", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const enabled = req.body?.enabled !== false;
    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    const command = edition === "bedrock" ? ["allowlist", enabled ? "on" : "off"] : ["whitelist", enabled ? "on" : "off"];

    const result = await sendServerCommand(server, i, command);
    const whitelist = await readWhitelistFile(server).catch(() => null);

    res.json({
      ok: true,
      edition,
      enabled,
      stdout: result.stdout || null,
      note: result.note || null,
      whitelist,
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/whitelist/add", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const player = normalizePlayerName(req.body?.player);
    const autoEnable = req.body?.autoEnable !== false;

    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    if (autoEnable) {
      await sendServerCommand(server, i, edition === "bedrock" ? ["allowlist", "on"] : ["whitelist", "on"]);
    }

    const playerArg = edition === "bedrock" && /\s/.test(player) ? quoteCommandArg(player) : player;
    const result = await sendServerCommand(server, i, edition === "bedrock" ? ["allowlist", "add", playerArg] : ["whitelist", "add", playerArg]);
    const whitelist = await readWhitelistFile(server).catch(() => null);

    res.json({
      ok: true,
      edition,
      player,
      stdout: result.stdout || null,
      note: result.note || null,
      whitelist,
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/whitelist/remove", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const player = normalizePlayerName(req.body?.player);

    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    const playerArg = edition === "bedrock" && /\s/.test(player) ? quoteCommandArg(player) : player;
    const result = await sendServerCommand(
      server,
      i,
      edition === "bedrock" ? ["allowlist", "remove", playerArg] : ["whitelist", "remove", playerArg],
    );
    const whitelist = await readWhitelistFile(server).catch(() => null);

    res.json({
      ok: true,
      edition,
      player,
      stdout: result.stdout || null,
      note: result.note || null,
      whitelist,
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// target management
app.get("/api/target", (_req, res) => {
  const server = findServer(ACTIVE_SERVER_ID) || SERVERS[0];
  res.json({ serverId: server.id, target: server.container, server: publicServer(server) });
});

app.post("/api/target", async (req, res) => {
  try {
    const requestedId = String(req.body?.serverId || "").trim();
    const name = String(req.body?.name || "").trim();
    let server;

    if (requestedId) {
      server = findServer(requestedId);
      if (!server) throw new Error(`server target not found: ${requestedId}`);
      if (name && name !== server.container) {
        server.container = name;
      }
    } else if (name) {
      server = SERVERS.find((item) => item.id === name || item.label === name || item.container === name);
      if (!server) {
        server = localTransientServer(name);
        SERVERS.push(server);
      }
    } else {
      return res.status(400).json({ error: "serverId or name required" });
    }

    await inspect(server);
    ACTIVE_SERVER_ID = server.id;
    await saveServers();
    res.json({ ok: true, serverId: ACTIVE_SERVER_ID, target: server.container, server: publicServer(server) });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// list containers on the selected host
app.get("/api/containers", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const out = await run(server, "ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}");
    const rows = out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [id, name, image, ...rest] = line.split(/\t/);
        return { id, name, image, status: rest.join(" ") };
      });
    res.json({ serverId: server.id, hostLabel: hostLabel(server), containers: rows });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// rename container
app.post("/api/rename", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const newName = String(req.body?.newName || "").trim();
    if (!newName) return res.status(400).json({ error: "newName required" });
    await run(server, "rename", server.container, newName);
    await updateServerContainer(server.id, newName);
    res.json({ ok: true, serverId: server.id, target: newName });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// logs
app.get("/api/logs", async (req, res) => {
  const lines = Math.max(1, Math.min(5000, Number.parseInt(req.query.lines || "200", 10) || 200));
  try {
    const server = resolveServer(req.query);
    const out = await run(server, "logs", "--tail", String(lines), server.container);
    res.type("text/plain").send(out);
  } catch (error) {
    res.status(500).type("text/plain").send(String(error.message || error));
  }
});

// serve static UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  const server = findServer(ACTIVE_SERVER_ID) || SERVERS[0];
  console.log(`UI: http://localhost:${PORT}  (target: ${server.label} / ${server.container})`);
});
