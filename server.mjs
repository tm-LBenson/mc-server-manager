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
const CHEST_SCAN_TIMEOUT_MS = Number.parseInt(process.env.CHEST_SCAN_TIMEOUT_MS || "120000", 10);
const DEATH_DROP_POLL_MS = Number.parseInt(process.env.DEATH_DROP_POLL_MS || "2000", 10);
const SSH_CONNECT_TIMEOUT_SECONDS = Number.parseInt(process.env.SSH_CONNECT_TIMEOUT_SECONDS || "10", 10);
const SSH_STRICT_HOST_KEY_CHECKING = process.env.SSH_STRICT_HOST_KEY_CHECKING || "accept-new";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "techtavern";
const AUTH_COOKIE = "mcsm_auth";
const AUTH_TOKEN = randomBytes(32).toString("hex");

const normalizeTimeout = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const boundedNumber = (value, fallback, min, max) => {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const DEFAULT_DEATH_DROPS = {
  enabled: false,
  mode: "tighten",
  radius: 5,
  horizontalMotion: 0,
  verticalMotion: 0.05,
};

const DEFAULT_HOME_COMMAND = {
  enabled: false,
  cooldownSeconds: 0,
  costEnabled: false,
  costItem: "minecraft:ender_pearl",
  costCount: 1,
};

const normalizeItemIdSafe = (value, fallback = "minecraft:ender_pearl") => {
  const item = String(value || fallback).trim().toLowerCase();
  if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(item)) return fallback;
  return item.includes(":") ? item : `minecraft:${item}`;
};

const normalizeDeathDropsConfig = (value = {}) => {
  const mode = ["tighten", "keep", "drop", "chest"].includes(value.mode) ? value.mode : DEFAULT_DEATH_DROPS.mode;

  return {
    enabled: value.enabled === true || value.enabled === "true",
    mode,
    radius: Math.round(boundedNumber(value.radius, DEFAULT_DEATH_DROPS.radius, 1, 16)),
    horizontalMotion: boundedNumber(value.horizontalMotion, DEFAULT_DEATH_DROPS.horizontalMotion, 0, 1),
    verticalMotion: boundedNumber(value.verticalMotion, DEFAULT_DEATH_DROPS.verticalMotion, 0, 1),
  };
};

const normalizeHomeCommandConfig = (value = {}) => ({
  enabled: value.enabled === true || value.enabled === "true",
  cooldownSeconds: Math.round(boundedNumber(value.cooldownSeconds, DEFAULT_HOME_COMMAND.cooldownSeconds, 0, 86400)),
  costEnabled: value.costEnabled === true || value.costEnabled === "true",
  costItem: normalizeItemIdSafe(value.costItem || DEFAULT_HOME_COMMAND.costItem),
  costCount: Math.round(boundedNumber(value.costCount, DEFAULT_HOME_COMMAND.costCount, 1, 64)),
});

const requestError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

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
    deathDrops: normalizeDeathDropsConfig(server.deathDrops),
    homeCommand: normalizeHomeCommandConfig(server.homeCommand),
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
  deathDrops: normalizeDeathDropsConfig(server.deathDrops),
  homeCommand: normalizeHomeCommandConfig(server.homeCommand),
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

const splitCommand = (value = "docker") => {
  const matches = String(value || "docker").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || ["docker"];
  return matches.map((part) => part.replace(/^(['"])(.*)\1$/, "$2"));
};

const dockerCommandParts = (server) => splitCommand(server.dockerPath || "docker");

const dockerCommandArgs = (server, args) => [...dockerCommandParts(server), ...args];

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
  const dockerParts = dockerCommandParts(server);
  const command = server.type === "ssh" ? "ssh" : dockerParts[0];
  const commandArgs = server.type === "ssh" ? sshArgs(server, args) : [...dockerParts.slice(1), ...args];

  try {
    const { stdout } = await execFileAsync(command, commandArgs, {
      maxBuffer: 8 * 1024 * 1024,
      timeout,
      windowsHide: true,
    });
    return stdout.toString();
  } catch (error) {
    const notFoundMessage =
      error?.code === "ENOENT"
        ? `${command} was not found. For Local Docker in Coolify, install the Docker CLI and mount /var/run/docker.sock into this app.`
        : "";
    const timeoutMessage =
      error?.killed || error?.code === "ETIMEDOUT"
        ? `${server.type === "ssh" ? "ssh docker" : "docker"} ${args[0] || "command"} timed out after ${timeout}ms`
        : "";
    const parts = [notFoundMessage, timeoutMessage, error?.message, error?.stdout?.toString?.(), error?.stderr?.toString?.()].filter(Boolean);
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

const isManagedMinecraftImage = (image = "") => detectEdition(image) !== "unknown";

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

const normalizeJavaPlayerName = (value, field = "player") => {
  const player = normalizePlayerName(value);
  if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) {
    throw requestError(`${field} must be a Java username`);
  }
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

const ensureJavaControlServer = async (server) => {
  const { i, edition } = await getContainerMeta(server);
  ensureRunning(i);
  if (edition !== "java") {
    throw requestError("Control Center tools are currently available for Java servers only.");
  }
  return { i, edition };
};

const sendServerCommandWhenReady = async (server, args, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const i = await inspect(server);
      ensureRunning(i);
      return await sendServerCommand(server, i, args);
    } catch (error) {
      lastError = error;
      await sleep(1500);
    }
  }

  throw lastError || new Error("server command timed out");
};

const withServerCommandWhenReady = async (server, work, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const i = await inspect(server);
      ensureRunning(i);
      return await work(i);
    } catch (error) {
      lastError = error;
      await sleep(1500);
    }
  }

  throw lastError || new Error("server command timed out");
};

const assertServerProperty = (key) => {
  if (!/^[a-z0-9_.-]+$/i.test(key)) throw new Error(`invalid server property: ${key}`);
};

const normalizeServerPropertyValue = (value) => {
  const normalized = String(value ?? "")
    .replace(/\r?\n/g, "\\n")
    .trim();
  if (normalized.length > 240) throw new Error("server property values must be 240 characters or less");
  return normalized;
};

const parseBooleanFlag = (value, field = "enabled") => {
  if (![true, false, "true", "false"].includes(value)) {
    throw new Error(`${field} must be true or false`);
  }
  return value === true || value === "true";
};

const booleanPropertyValue = (enabled) => (enabled ? "true" : "false");

const dataPayload = (stdout = "") => {
  const text = String(stdout || "").trim();
  const marker = "data:";
  const markerIndex = text.indexOf(marker);
  if (markerIndex !== -1) return text.slice(markerIndex + marker.length).trim();
  const colonIndex = text.indexOf(":");
  return colonIndex === -1 ? text : text.slice(colonIndex + 1).trim();
};

const parseDataNumber = (stdout = "") => {
  const payload = dataPayload(stdout);
  const match = payload.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : null;
};

const parseDataString = (stdout = "") => {
  const payload = dataPayload(stdout);
  const quoted = payload.match(/"([^"]+)"/);
  if (quoted) return quoted[1];
  return payload || null;
};

const parsePosition = (stdout = "") => {
  const payload = dataPayload(stdout);
  const match = payload.match(/\[([^\]]+)\]/);
  if (!match) return null;
  const values = match[1]
    .split(",")
    .map((part) => Number.parseFloat(part.replace(/[dDfFbBsSlL]/g, "").trim()))
    .filter((value) => Number.isFinite(value));
  return values.length === 3 ? { x: values[0], y: values[1], z: values[2] } : null;
};

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseSnbtNumberField = (payload = "", field) => {
  const pattern = new RegExp(`(?:^|[,\\s{])["']?${escapeRegExp(field)}["']?\\s*:\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+))(?:[bBsSlLfFdD])?`, "i");
  const match = String(payload || "").match(pattern);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
};

const parseSnbtStringField = (payload = "", field) => {
  const text = String(payload || "");
  const quoted = text.match(new RegExp(`(?:^|[,\\s{])["']?${escapeRegExp(field)}["']?\\s*:\\s*"([^"]+)"`, "i"));
  if (quoted) return quoted[1];
  const unquoted = text.match(new RegExp(`(?:^|[,\\s{])["']?${escapeRegExp(field)}["']?\\s*:\\s*([a-z0-9_.-]+:[a-z0-9_./-]+)`, "i"));
  return unquoted ? unquoted[1] : null;
};

const parseSnbtIntListField = (payload = "", field) => {
  const pattern = new RegExp(
    `(?:^|[,\\s{])["']?${escapeRegExp(field)}["']?\\s*:\\s*\\[\\s*(?:[IiLlSsBb];)?\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*,\\s*(-?\\d+)\\s*\\]`,
    "i",
  );
  const match = String(payload || "").match(pattern);
  if (!match) return null;
  const values = match.slice(1, 4).map((value) => Number.parseInt(value, 10));
  return values.every((value) => Number.isFinite(value)) ? { x: values[0], y: values[1], z: values[2] } : null;
};

const extractNamedCompound = (payload = "", fieldNames = []) => {
  const text = String(payload || "");

  for (const field of fieldNames) {
    const pattern = new RegExp(`(?:^|[,\\s{])["']?${escapeRegExp(field)}["']?\\s*:\\s*\\{`, "i");
    const match = pattern.exec(text);
    if (!match) continue;

    const openIndex = text.indexOf("{", match.index);
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = openIndex; index < text.length; index += 1) {
      const char = text[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(openIndex, index + 1);
      }
    }
  }

  return "";
};

const normalizeDimensionId = (value) => {
  const dimension = String(value || "").trim().replace(/^["']|["']$/g, "");
  return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/i.test(dimension) ? dimension.toLowerCase() : "minecraft:overworld";
};

const spawnFromValues = (x, y, z, dimension) => {
  if (![x, y, z].every((value) => Number.isFinite(value))) return null;
  return { x, y, z, dimension: normalizeDimensionId(dimension) };
};

const parseJavaSpawnPayload = (stdout = "") => {
  const payload = dataPayload(stdout);
  const legacySpawn = spawnFromValues(
    parseSnbtNumberField(payload, "SpawnX") ?? parseSnbtNumberField(payload, "RespawnX") ?? parseSnbtNumberField(payload, "spawn_x"),
    parseSnbtNumberField(payload, "SpawnY") ?? parseSnbtNumberField(payload, "RespawnY") ?? parseSnbtNumberField(payload, "spawn_y"),
    parseSnbtNumberField(payload, "SpawnZ") ?? parseSnbtNumberField(payload, "RespawnZ") ?? parseSnbtNumberField(payload, "spawn_z"),
    parseSnbtStringField(payload, "SpawnDimension") || parseSnbtStringField(payload, "RespawnDimension"),
  );
  if (legacySpawn) return legacySpawn;

  const compound = extractNamedCompound(payload, ["respawn", "Respawn", "respawn_position", "RespawnPosition", "spawn_point", "SpawnPoint"]);
  if (!compound) return null;

  const pos =
    parseSnbtIntListField(compound, "pos") ||
    parseSnbtIntListField(compound, "Pos") ||
    spawnFromValues(
      parseSnbtNumberField(compound, "x") ?? parseSnbtNumberField(compound, "X"),
      parseSnbtNumberField(compound, "y") ?? parseSnbtNumberField(compound, "Y"),
      parseSnbtNumberField(compound, "z") ?? parseSnbtNumberField(compound, "Z"),
      null,
    );

  if (!pos) return null;

  return {
    x: pos.x,
    y: pos.y,
    z: pos.z,
    dimension: normalizeDimensionId(parseSnbtStringField(compound, "dimension") || parseSnbtStringField(compound, "Dimension")),
  };
};

const parseOnlinePlayers = (stdout = "") => {
  const text = String(stdout || "").trim();
  const match = text.match(/players online:\s*(.*)$/i);
  if (!match || !match[1].trim()) return [];
  return match[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
};

const extractTopLevelObjects = (value = "") => {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
};

const parseItemObjects = (stdout = "") => {
  const payload = dataPayload(stdout);
  return extractTopLevelObjects(payload)
    .map((object) => {
      const id = object.match(/\bid\s*:\s*"([^"]+)"/i)?.[1] || object.match(/\bid\s*:\s*'([^']+)'/i)?.[1] || null;
      if (!id) return null;
      const slotRaw = object.match(/\b(?:Slot|slot)\s*:\s*(-?\d+)/)?.[1];
      const countRaw = object.match(/\b(?:Count|count)\s*:\s*(-?\d+)/)?.[1];
      return {
        slot: slotRaw == null ? null : Number.parseInt(slotRaw, 10),
        id,
        count: countRaw == null ? 1 : Number.parseInt(countRaw, 10),
        raw: object,
      };
    })
    .filter(Boolean);
};

const normalizeCoordinate = (value, field) => {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) throw requestError(`${field} must be a number`);
  return String(number);
};

const normalizeChestScanRange = (value) => {
  const range = Number.parseInt(value || "5", 10);
  if (!Number.isInteger(range) || range < 1 || range > 8) {
    throw requestError("range must be between 1 and 8 blocks");
  }
  return range;
};

const normalizeItemId = (value) => {
  const item = String(value || "").trim().toLowerCase();
  if (!/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/.test(item)) throw requestError("item must be a valid item id");
  return normalizeItemIdSafe(item);
};

const normalizeCount = (value, fallback = 1, max = 640) => {
  const count = Number.parseInt(value || fallback, 10);
  if (!Number.isInteger(count) || count < 1 || count > max) throw requestError(`count must be between 1 and ${max}`);
  return String(count);
};

const normalizeGameMode = (value) => {
  const mode = String(value || "").toLowerCase();
  if (!["survival", "creative", "adventure", "spectator"].includes(mode)) {
    throw requestError("game mode must be survival, creative, adventure, or spectator");
  }
  return mode;
};

const javaErrorStatus = (error) => error.status || 500;

const collectJavaPlayerSnapshot = async (server, i, player) => {
  const [positionResult, dimensionResult, healthResult, foodResult, inventoryResult, lastDeathLocationResult] = await Promise.allSettled([
    sendServerCommand(server, i, ["data", "get", "entity", player, "Pos"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "Dimension"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "Health"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "foodLevel"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "Inventory"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "LastDeathLocation"]),
  ]);

  const valueFrom = (result) => (result.status === "fulfilled" ? result.value.stdout || "" : "");

  return {
    player,
    position: parsePosition(valueFrom(positionResult)),
    dimension: parseDataString(valueFrom(dimensionResult)),
    health: parseDataNumber(valueFrom(healthResult)),
    food: parseDataNumber(valueFrom(foodResult)),
    inventory: parseItemObjects(valueFrom(inventoryResult)),
    raw: {
      position: valueFrom(positionResult),
      dimension: valueFrom(dimensionResult),
      health: valueFrom(healthResult),
      food: valueFrom(foodResult),
      inventory: valueFrom(inventoryResult),
      lastDeathLocation: valueFrom(lastDeathLocationResult),
    },
  };
};

const readJavaSpawn = async (server, i, player) => {
  const [xResult, yResult, zResult, dimensionResult] = await Promise.allSettled([
    sendServerCommand(server, i, ["data", "get", "entity", player, "SpawnX"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "SpawnY"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "SpawnZ"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "SpawnDimension"]),
  ]);

  const valueFrom = (result) => (result.status === "fulfilled" ? result.value.stdout || "" : "");
  const directSpawn = spawnFromValues(
    parseDataNumber(valueFrom(xResult)),
    parseDataNumber(valueFrom(yResult)),
    parseDataNumber(valueFrom(zResult)),
    parseDataString(valueFrom(dimensionResult)),
  );
  if (directSpawn) return directSpawn;

  const fullEntity = await sendServerCommand(server, i, ["data", "get", "entity", player]).catch(() => null);
  const parsedSpawn = parseJavaSpawnPayload(fullEntity?.stdout || "");
  if (parsedSpawn) return parsedSpawn;

  throw requestError(`${player} does not have a bed or respawn anchor spawn recorded. Sleep in a bed or use a respawn anchor, then try again.`);
};

const deathDropMonitorKey = (server) => `${server.type}:${server.host || "local"}:${server.id}:${server.container}`;
const deathDropMonitors = new Map();

const getDeathDropMonitor = (server) => {
  const key = deathDropMonitorKey(server);
  if (!deathDropMonitors.has(key)) {
    deathDropMonitors.set(key, {
      deaths: new Map(),
      lastDeathLocations: new Map(),
      pendingClears: new Map(),
      processedDeaths: new Set(),
      snapshots: new Map(),
      objectiveReady: false,
      lastCheck: null,
      lastEvent: null,
      lastError: null,
      trackedPlayers: [],
    });
  }
  return deathDropMonitors.get(key);
};

const publicDeathDropMonitor = (server) => {
  const state = deathDropMonitors.get(deathDropMonitorKey(server));
  if (!state) {
    return {
      active: false,
      lastCheck: null,
      lastEvent: null,
      lastError: null,
      trackedPlayers: [],
    };
  }

  return {
    active: true,
    lastCheck: state.lastCheck,
    lastEvent: state.lastEvent,
    lastError: state.lastError,
    pendingClears: [...(state.pendingClears || new Map()).keys()],
    trackedPlayers: state.trackedPlayers || [],
  };
};

const HOME_OBJECTIVE = "home";
const homeCommandMonitors = new Map();

const getHomeCommandMonitor = (server) => {
  const key = deathDropMonitorKey(server);
  if (!homeCommandMonitors.has(key)) {
    homeCommandMonitors.set(key, {
      objectiveReady: false,
      lastCheck: null,
      lastError: null,
      lastEvent: null,
      lastUse: new Map(),
      trackedPlayers: [],
    });
  }
  return homeCommandMonitors.get(key);
};

const publicHomeCommandMonitor = (server) => {
  const state = homeCommandMonitors.get(deathDropMonitorKey(server));
  if (!state) {
    return {
      active: false,
      lastCheck: null,
      lastError: null,
      lastEvent: null,
      trackedPlayers: [],
    };
  }

  return {
    active: true,
    lastCheck: state.lastCheck,
    lastError: state.lastError,
    lastEvent: state.lastEvent,
    trackedPlayers: state.trackedPlayers || [],
  };
};

const markProcessedDeath = (state, key) => {
  state.processedDeaths.add(key);
  if (state.processedDeaths.size > 500) {
    state.processedDeaths.delete(state.processedDeaths.values().next().value);
  }
};

const parseDeathScore = (stdout = "") => {
  const text = String(stdout || "");
  const match = text.match(/\bhas\s+(-?\d+)\b/i);
  if (!match) return 0;
  const score = Number.parseInt(match[1], 10);
  return Number.isFinite(score) ? score : 0;
};

const readJavaDeathScore = async (server, i, player) => {
  try {
    const result = await sendServerCommand(server, i, ["scoreboard", "players", "get", player, "mcsm_deaths"]);
    return parseDeathScore(result.stdout);
  } catch (error) {
    const message = String(error.message || error);
    if (/has no score|can't get value|cannot get value/i.test(message)) return 0;
    throw error;
  }
};

const ensureDeathScoreObjective = async (server, i, state) => {
  if (state.objectiveReady) return;
  try {
    await sendServerCommand(server, i, ["scoreboard", "objectives", "add", "mcsm_deaths", "deathCount"]);
  } catch (error) {
    const message = String(error.message || error);
    if (!/already exists|exists already/i.test(message)) throw error;
  }
  state.objectiveReady = true;
};

const ensureHomeTriggerObjective = async (server, i, state) => {
  if (state.objectiveReady) return;
  try {
    await sendServerCommand(server, i, ["scoreboard", "objectives", "add", HOME_OBJECTIVE, "trigger", "Home"]);
  } catch (error) {
    const message = String(error.message || error);
    if (!/already exists|exists already/i.test(message)) throw error;
  }
  state.objectiveReady = true;
};

const readTriggerScore = async (server, i, player, objective) => {
  try {
    const result = await sendServerCommand(server, i, ["scoreboard", "players", "get", player, objective]);
    return parseDeathScore(result.stdout);
  } catch (error) {
    const message = String(error.message || error);
    if (/has no score|can't get value|cannot get value/i.test(message)) return 0;
    throw error;
  }
};

const tellPlayer = async (server, i, player, text, color = "gold") => {
  await sendServerCommand(server, i, [
    "tellraw",
    player,
    JSON.stringify({
      text,
      color,
    }),
  ]).catch(() => null);
};

const readJavaGameRule = async (server, i, rule) => {
  const result = await sendServerCommand(server, i, ["gamerule", rule]);
  const match = String(result.stdout || "").match(/\b(true|false)\b/i);
  return match ? match[1].toLowerCase() === "true" : null;
};

const KEEP_INVENTORY_RULES = ["minecraft:keep_inventory", "keepInventory", "keepinventory"];

const readKeepInventoryGameRule = async (server, i) => {
  let lastError = null;
  for (const rule of KEEP_INVENTORY_RULES) {
    try {
      const value = await readJavaGameRule(server, i, rule);
      if (value !== null) return { rule, value };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    rule: null,
    value: null,
    error: lastError ? String(lastError.message || lastError) : "No supported keepInventory gamerule name was accepted.",
  };
};

const setKeepInventoryGameRule = async (server, i, enabled) => {
  const value = enabled ? "true" : "false";
  let lastError = null;

  for (const rule of KEEP_INVENTORY_RULES) {
    try {
      await sendServerCommand(server, i, ["gamerule", rule, value]);
      if (enabled) {
        await sleep(150);
        await sendServerCommand(server, i, ["gamerule", rule, value]);
      }
      const confirmed = await readJavaGameRule(server, i, rule);
      if (confirmed === enabled) return { rule, value: confirmed };
      lastError = new Error(`${rule} returned ${confirmed}`);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    rule: null,
    value: null,
    error: lastError ? String(lastError.message || lastError) : "No supported keepInventory gamerule name was accepted.",
  };
};

const PVP_RULES = ["minecraft:pvp", "pvp"];

const readPvpGameRule = async (server, i) => {
  let lastError = null;
  for (const rule of PVP_RULES) {
    try {
      const value = await readJavaGameRule(server, i, rule);
      if (value !== null) return { rule, value };
    } catch (error) {
      lastError = error;
    }
  }
  return {
    rule: null,
    value: null,
    error: lastError ? String(lastError.message || lastError) : "No supported PVP gamerule name was accepted.",
  };
};

const setPvpGameRule = async (server, i, enabled) => {
  const value = enabled ? "true" : "false";
  let lastError = null;

  for (const rule of PVP_RULES) {
    try {
      await sendServerCommand(server, i, ["gamerule", rule, value]);
      await sleep(150);
      await sendServerCommand(server, i, ["gamerule", rule, value]);
      const confirmed = await readJavaGameRule(server, i, rule);
      if (confirmed === enabled) return { rule, value: confirmed };
      lastError = new Error(`${rule} returned ${confirmed}`);
    } catch (error) {
      lastError = error;
    }
  }

  return {
    rule: null,
    value: null,
    error: lastError ? String(lastError.message || lastError) : "No supported PVP gamerule name was accepted.",
  };
};

const applyDeathDropGameRules = async (server, i, config) => {
  if (!config.enabled) return null;
  const keepInventory = config.mode === "keep" || config.mode === "drop" || config.mode === "chest";
  const result = await setKeepInventoryGameRule(server, i, keepInventory);
  return result.value;
};

const commandNumber = (value, fallback = 0) => {
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return String(fallback);
  return String(Number(number.toFixed(4)));
};

const nbtDouble = (value) => `${commandNumber(value)}d`;

const deathPosition = (snapshot) => {
  if (!snapshot?.position) return null;
  return {
    x: Math.floor(snapshot.position.x),
    y: Math.floor(snapshot.position.y),
    z: Math.floor(snapshot.position.z),
    dimension: snapshot.dimension || "minecraft:overworld",
  };
};

const tightenDeathDrops = async (server, i, snapshot, config) => {
  const pos = deathPosition(snapshot);
  if (!pos) throw new Error("No recent death position was available.");

  const selector = `@e[type=minecraft:item,distance=..${config.radius}]`;
  const motion = `{Motion:[${nbtDouble(config.horizontalMotion)},${nbtDouble(config.verticalMotion)},${nbtDouble(config.horizontalMotion)}]}`;
  const command = [
    "execute",
    "in",
    pos.dimension,
    "positioned",
    String(pos.x),
    String(pos.y),
    String(pos.z),
    "as",
    selector,
    "run",
    "data",
    "merge",
    "entity",
    "@s",
    motion,
  ];

  for (const delay of [0, 300, 900]) {
    if (delay) await sleep(delay);
    await sendServerCommand(server, i, command).catch(() => null);
  }

  return pos;
};

const splitTopLevelNbtFields = (value = "") => {
  const fields = [];
  let depth = 0;
  let start = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      continue;
    }

    if (char === "," && depth === 0) {
      const field = value.slice(start, index).trim();
      if (field) fields.push(field);
      start = index + 1;
    }
  }

  const field = value.slice(start).trim();
  if (field) fields.push(field);
  return fields;
};

const chestItemNbt = (item, slot) => {
  const raw = String(item.raw || "").trim();
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const fields = splitTopLevelNbtFields(raw.slice(1, -1)).filter((field) => !/^(?:Slot|slot)\s*:/i.test(field));
    if (fields.length) return `{Slot:${slot}b,${fields.join(",")}}`;
  }
  return `{Slot:${slot}b,id:"${item.id}",count:${Number.parseInt(item.count || "1", 10) || 1}}`;
};

const itemStackNbt = (item) => {
  const raw = String(item.raw || "").trim();
  if (raw.startsWith("{") && raw.endsWith("}")) {
    const fields = splitTopLevelNbtFields(raw.slice(1, -1)).filter((field) => !/^(?:Slot|slot)\s*:/i.test(field));
    if (fields.length) return `{${fields.join(",")}}`;
  }
  return `{id:"${item.id}",count:${Number.parseInt(item.count || "1", 10) || 1}}`;
};

const clearPlayerInventoryAfterRespawn = async (server, i, player, options = {}) => {
  const attempts = Number.parseInt(options.attempts || "8", 10) || 8;
  const initialDelay = Number.parseInt(options.initialDelayMs || "500", 10) || 500;
  const retryDelay = Number.parseInt(options.retryDelayMs || "900", 10) || 900;
  let lastError = null;
  let lastStdout = "";
  let remainingStacks = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt === 1) {
      await sleep(initialDelay);
    } else {
      await sleep(retryDelay);
    }

    const clearResult = await sendServerCommand(server, i, ["clear", player]).catch((error) => ({ stdout: "", error: String(error.message || error) }));
    lastStdout = clearResult.stdout || "";

    if (clearResult.error) {
      lastError = clearResult.error;
      continue;
    }

    const snapshot = await collectJavaPlayerSnapshot(server, i, player).catch((error) => {
      lastError = String(error.message || error);
      return null;
    });

    if (!snapshot) continue;

    remainingStacks = (snapshot.inventory || []).filter((item) => item?.id).length;
    if (remainingStacks === 0) {
      return {
        cleared: true,
        attempts: attempt,
        remainingStacks,
        note: lastStdout || null,
      };
    }

    lastError = `${remainingStacks} inventory stack${remainingStacks === 1 ? "" : "s"} remained after clear`;
  }

  return {
    cleared: false,
    attempts,
    remainingStacks,
    note: lastError || lastStdout || "Player inventory was not confirmed empty after respawn.",
  };
};

const chunkItems = (items, size) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const placeChestBlock = async (server, i, pos, used) => {
  const offsets = [
    [0, 0, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, 1, 0],
    [0, 1, 1],
    [0, 1, -1],
    [2, 0, 0],
    [-2, 0, 0],
    [0, 0, 2],
    [0, 0, -2],
  ];

  for (const [dx, dy, dz] of offsets) {
    const x = pos.x + dx;
    const y = pos.y + dy;
    const z = pos.z + dz;
    const key = `${x},${y},${z}`;
    if (used.has(key)) continue;

    await sendServerCommand(server, i, ["execute", "in", pos.dimension, "run", "setblock", String(x), String(y), String(z), "minecraft:chest", "keep"]).catch(
      () => null,
    );

    const check = await sendServerCommand(server, i, ["execute", "in", pos.dimension, "run", "data", "get", "block", String(x), String(y), String(z), "Items"]).catch(
      () => null,
    );

    if (/block(?: entity)? data/i.test(String(check?.stdout || ""))) {
      used.add(key);
      return { x, y, z, dimension: pos.dimension };
    }
  }

  return null;
};

const createDeathChests = async (server, i, player, snapshot) => {
  const pos = deathPosition(snapshot);
  if (!pos) throw new Error("No recent death position was available.");

  const inventory = (snapshot.inventory || []).filter((item) => item?.id);
  if (!inventory.length) {
    return { position: pos, chests: [], itemStacks: 0, cleared: false, note: "No inventory snapshot was available." };
  }

  const used = new Set();
  const chests = [];
  const chunks = chunkItems(inventory, 27);

  for (const chunk of chunks) {
    const chest = await placeChestBlock(server, i, pos, used);
    if (!chest) throw new Error("Could not place a death chest near the death location without replacing a block.");

    const itemsNbt = chunk.map((item, index) => chestItemNbt(item, index)).join(",");
    await sendServerCommand(server, i, [
      "execute",
      "in",
      chest.dimension,
      "run",
      "data",
      "modify",
      "block",
      String(chest.x),
      String(chest.y),
      String(chest.z),
      "Items",
      "set",
      "value",
      `[${itemsNbt}]`,
    ]);
    chests.push(chest);
  }

  const firstChest = chests[0];
  await sendServerCommand(server, i, [
    "tellraw",
    player,
    JSON.stringify({
      text: `Death chest created at ${firstChest.x}, ${firstChest.y}, ${firstChest.z}`,
      color: "gold",
    }),
  ]).catch(() => null);

  const clearResult = await clearPlayerInventoryAfterRespawn(server, i, player);

  return {
    position: pos,
    chests,
    itemStacks: inventory.length,
    cleared: clearResult.cleared,
    clearAttempts: clearResult.attempts,
    remainingStacks: clearResult.remainingStacks,
    note: clearResult.cleared ? null : clearResult.note,
  };
};

const dropInventoryAtDeathSpot = async (server, i, player, snapshot) => {
  const pos = deathPosition(snapshot);
  if (!pos) throw new Error("No recent death position was available.");

  const inventory = (snapshot.inventory || []).filter((item) => item?.id);
  if (!inventory.length) {
    return { position: pos, droppedStacks: 0, cleared: false, note: "No inventory snapshot was available." };
  }

  const x = String(pos.x + 0.5);
  const y = String(pos.y + 0.25);
  const z = String(pos.z + 0.5);
  const motion = `{Motion:[${nbtDouble(0)},${nbtDouble(0)},${nbtDouble(0)}],PickupDelay:20s}`;

  for (const item of inventory) {
    await sendServerCommand(server, i, [
      "execute",
      "in",
      pos.dimension,
      "run",
      "summon",
      "minecraft:item",
      x,
      y,
      z,
      `{Item:${itemStackNbt(item)},${motion.slice(1)}`,
    ]);
  }

  await sendServerCommand(server, i, [
    "tellraw",
    player,
    JSON.stringify({
      text: `Items dropped at ${pos.x}, ${pos.y}, ${pos.z}`,
      color: "gold",
    }),
  ]).catch(() => null);

  const clearResult = await clearPlayerInventoryAfterRespawn(server, i, player);

  return {
    position: pos,
    droppedStacks: inventory.length,
    cleared: clearResult.cleared,
    clearAttempts: clearResult.attempts,
    remainingStacks: clearResult.remainingStacks,
    note: clearResult.cleared ? null : clearResult.note,
  };
};

const deathEventSnapshot = (config, previousSnapshot, currentSnapshot) => {
  const base = previousSnapshot || currentSnapshot;
  if (!base) return null;
  if (!["drop", "chest"].includes(config.mode)) return base;

  const currentInventory = Array.isArray(currentSnapshot?.inventory) && currentSnapshot.inventory.length ? currentSnapshot.inventory : null;
  if (!currentInventory) return base;

  return {
    ...base,
    inventory: currentInventory,
    raw: {
      ...(base.raw || {}),
      inventory: currentSnapshot.raw?.inventory || base.raw?.inventory || "",
    },
  };
};

const confirmKeepInventoryForVirtualDrops = async (server, i, config) => {
  const current = await readKeepInventoryGameRule(server, i).catch(() => ({ value: null }));
  if (current.value === true) return true;
  const updated = await applyDeathDropGameRules(server, i, config).catch(() => null);
  return updated === true;
};

const handleDeathDropEvent = async (server, i, player, snapshot, config, state) => {
  const event = {
    player,
    mode: config.mode,
    at: new Date().toISOString(),
    ok: false,
  };

  try {
    if (config.mode === "tighten") {
      event.position = await tightenDeathDrops(server, i, snapshot, config);
      event.ok = true;
    } else if (config.mode === "drop") {
      event.keepInventoryConfirmed = await confirmKeepInventoryForVirtualDrops(server, i, config);
      if (!event.keepInventoryConfirmed) {
        event.position = await tightenDeathDrops(server, i, snapshot, config);
        event.ok = true;
        event.note = "keepInventory was not active, so the manager skipped virtual item drops to prevent duplication. Normal drops were tightened and keepInventory was re-applied for future deaths.";
      } else {
        const result = await dropInventoryAtDeathSpot(server, i, player, snapshot);
        Object.assign(event, result);
        event.ok = result.cleared !== false;
        if (!event.ok) event.error = result.note || "Player inventory was not cleared after the virtual drop.";
      }
    } else if (config.mode === "chest") {
      event.keepInventoryConfirmed = await confirmKeepInventoryForVirtualDrops(server, i, config);
      if (!event.keepInventoryConfirmed) {
        event.position = await tightenDeathDrops(server, i, snapshot, config);
        event.ok = true;
        event.note = "keepInventory was not active, so the manager skipped death chest creation to prevent duplication. Normal drops were tightened and keepInventory was re-applied for future deaths.";
      } else {
        const result = await createDeathChests(server, i, player, snapshot);
        Object.assign(event, result);
        event.ok = result.cleared !== false;
        if (!event.ok) event.error = result.note || "Player inventory was not cleared after the death chest.";
      }
    } else {
      event.ok = true;
      event.note = "keepInventory is enabled; no death-drop action was needed.";
    }
    if (!event.ok && (event.droppedStacks > 0 || event.itemStacks > 0)) {
      state.pendingClears.set(player, {
        mode: config.mode,
        queuedAt: event.at,
        attempts: event.clearAttempts || 0,
        remainingStacks: event.remainingStacks ?? null,
      });
    } else if (event.ok) {
      state.pendingClears.delete(player);
    }
    state.lastError = event.ok ? null : event.error || event.note || "Death drop action was incomplete.";
  } catch (error) {
    event.error = String(error.message || error);
    state.lastError = event.error;
  }

  state.lastEvent = event;
};

const processPendingInventoryClears = async (server, i, players, state) => {
  const onlinePlayers = new Set(players);

  for (const [player, pending] of state.pendingClears) {
    if (!onlinePlayers.has(player)) continue;

    const result = await clearPlayerInventoryAfterRespawn(server, i, player, {
      attempts: 2,
      initialDelayMs: 100,
      retryDelayMs: 500,
    });
    pending.attempts = (pending.attempts || 0) + result.attempts;
    pending.remainingStacks = result.remainingStacks ?? pending.remainingStacks ?? null;

    if (result.cleared) {
      state.pendingClears.delete(player);
      state.lastEvent = {
        player,
        mode: pending.mode,
        at: new Date().toISOString(),
        ok: true,
        cleared: true,
        clearAttempts: pending.attempts,
        note: "Pending death-drop inventory clear completed.",
      };
      state.lastError = null;
    } else {
      state.lastError = result.note || `Pending inventory clear for ${player} has not completed yet.`;
    }
  }
};

const consumeHomeCommandCost = async (server, i, player, config) => {
  if (!config.costEnabled) return { ok: true, consumed: false };

  const result = await sendServerCommand(server, i, ["clear", player, config.costItem, String(config.costCount)]).catch((error) => ({
    stdout: "",
    error: String(error.message || error),
  }));

  if (result.error) {
    return { ok: false, consumed: false, note: result.error };
  }

  const stdout = String(result.stdout || "");
  const count = Number.parseInt(stdout.match(/\b(\d+)\s+item/i)?.[1] || "", 10);
  if (/no items? were found|found no items?/i.test(stdout) || count === 0) {
    return { ok: false, consumed: false, note: `Requires ${config.costCount} ${config.costItem}.` };
  }

  return { ok: true, consumed: true, stdout };
};

const handleHomeCommandRequest = async (server, i, player, config, state) => {
  const now = Date.now();
  const lastUse = state.lastUse.get(player) || 0;
  const cooldownMs = config.cooldownSeconds * 1000;
  const event = {
    player,
    at: new Date(now).toISOString(),
    ok: false,
  };

  try {
    if (cooldownMs > 0 && now - lastUse < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (now - lastUse)) / 1000);
      event.cooldownRemaining = remaining;
      event.note = `Home is on cooldown for ${remaining} more second${remaining === 1 ? "" : "s"}.`;
      await tellPlayer(server, i, player, event.note, "red");
      state.lastEvent = event;
      return;
    }

    const spawn = await readJavaSpawn(server, i, player);
    const cost = await consumeHomeCommandCost(server, i, player, config);
    if (!cost.ok) {
      event.note = cost.note || "Home cost could not be paid.";
      await tellPlayer(server, i, player, event.note, "red");
      state.lastEvent = event;
      return;
    }

    const command = ["execute", "in", spawn.dimension, "run", "tp", player, String(spawn.x), String(spawn.y), String(spawn.z)];
    const result = await sendServerCommand(server, i, command);
    state.lastUse.set(player, now);

    event.ok = true;
    event.consumedCost = cost.consumed;
    event.command = command.join(" ");
    event.stdout = result.stdout || "";
    event.position = spawn;
    state.lastError = null;
    await tellPlayer(server, i, player, "Teleported home.", "gold");
  } catch (error) {
    event.error = String(error.message || error);
    state.lastError = event.error;
    await tellPlayer(server, i, player, event.error, "red");
  } finally {
    await sendServerCommand(server, i, ["scoreboard", "players", "set", player, HOME_OBJECTIVE, "0"]).catch(() => null);
    await sendServerCommand(server, i, ["scoreboard", "players", "enable", player, HOME_OBJECTIVE]).catch(() => null);
    state.lastEvent = event;
  }
};

const monitorHomeCommandForServer = async (server) => {
  const config = normalizeHomeCommandConfig(server.homeCommand);
  if (!config.enabled) return;

  const state = getHomeCommandMonitor(server);
  state.lastCheck = new Date().toISOString();

  try {
    const { i, edition } = await getContainerMeta(server);
    if (edition !== "java" || !i.State?.Running) {
      state.trackedPlayers = [];
      state.lastError = edition === "java" ? "Java server is not running." : "Home command is Java-only.";
      return;
    }

    await ensureHomeTriggerObjective(server, i, state);
    const listResult = await sendServerCommand(server, i, ["list"]);
    const players = parseOnlinePlayers(listResult.stdout).filter((player) => /^[A-Za-z0-9_]{1,16}$/.test(player));
    state.trackedPlayers = players;
    await sendServerCommand(server, i, ["scoreboard", "players", "enable", "@a", HOME_OBJECTIVE]).catch(() => null);

    for (const player of players) {
      const score = await readTriggerScore(server, i, player, HOME_OBJECTIVE);
      if (score > 0) await handleHomeCommandRequest(server, i, player, config, state);
    }

    if (!state.lastError || /Java server is not running|Java-only/i.test(state.lastError)) state.lastError = null;
  } catch (error) {
    state.lastError = String(error.message || error);
  }
};

const monitorDeathDropsForServer = async (server) => {
  const config = normalizeDeathDropsConfig(server.deathDrops);
  if (!config.enabled) return;

  const state = getDeathDropMonitor(server);
  state.lastCheck = new Date().toISOString();

  try {
    const { i, edition } = await getContainerMeta(server);
    if (edition !== "java" || !i.State?.Running) {
      state.trackedPlayers = [];
      state.lastError = edition === "java" ? "Java server is not running." : "Death drops are Java-only.";
      return;
    }

    await ensureDeathScoreObjective(server, i, state);
    await applyDeathDropGameRules(server, i, config);
    if (config.mode === "keep") {
      state.lastError = null;
      return;
    }

    const listResult = await sendServerCommand(server, i, ["list"]);
    const players = parseOnlinePlayers(listResult.stdout).filter((player) => /^[A-Za-z0-9_]{1,16}$/.test(player));
    state.trackedPlayers = players;
    await processPendingInventoryClears(server, i, players, state);

    for (const player of players) {
      const previousScore = state.deaths.get(player);
      const previousSnapshot = state.snapshots.get(player);
      const [score, snapshot] = await Promise.all([
        readJavaDeathScore(server, i, player),
        collectJavaPlayerSnapshot(server, i, player).catch(() => null),
      ]);
      const lastDeathLocation = snapshot?.raw?.lastDeathLocation || "";
      const deathScoreIncreased = previousScore != null && score > previousScore;
      const deathKey = `${player}:${score}`;

      state.deaths.set(player, score);
      if (lastDeathLocation) state.lastDeathLocations.set(player, lastDeathLocation);
      if (snapshot) state.snapshots.set(player, snapshot);

      if (deathScoreIncreased && !state.processedDeaths.has(deathKey)) {
        markProcessedDeath(state, deathKey);
        await handleDeathDropEvent(server, i, player, deathEventSnapshot(config, previousSnapshot, snapshot), config, state);
      }
    }

    state.lastError = null;
  } catch (error) {
    state.lastError = String(error.message || error);
  }
};

let deathDropMonitorRunning = false;
let homeCommandMonitorRunning = false;

const runDeathDropMonitors = async () => {
  if (deathDropMonitorRunning) return;
  deathDropMonitorRunning = true;
  try {
    for (const server of SERVERS) {
      await monitorDeathDropsForServer(server);
    }
  } finally {
    deathDropMonitorRunning = false;
  }
};

const runHomeCommandMonitors = async () => {
  if (homeCommandMonitorRunning) return;
  homeCommandMonitorRunning = true;
  try {
    for (const server of SERVERS) {
      await monitorHomeCommandForServer(server);
    }
  } finally {
    homeCommandMonitorRunning = false;
  }
};

const parseNearbyChestScan = (raw = "") => {
  const sections = String(raw || "").split("---MCSM-CHEST---").slice(1);
  return sections
    .map((section, index) => {
      const pos = section.match(/pos=(-?\d+),(-?\d+),(-?\d+)/);
      if (!pos) return null;
      const x = Number.parseInt(pos[1], 10);
      const y = Number.parseInt(pos[2], 10);
      const z = Number.parseInt(pos[3], 10);
      const body = section.replace(/^\s*pos=-?\d+,-?\d+,-?\d+\s*/, "").trim();
      return {
        label: `Chest ${index + 1}`,
        x,
        y,
        z,
        items: parseItemObjects(body),
        raw: body,
      };
    })
    .filter(Boolean);
};

const scanNearbyChests = async (server, player, range) => {
  const { i } = await ensureJavaControlServer(server);
  const snapshot = await collectJavaPlayerSnapshot(server, i, player);
  if (!snapshot.position) throw requestError(`Could not read ${player}'s current location.`);

  const origin = {
    x: Math.floor(snapshot.position.x),
    y: Math.floor(snapshot.position.y),
    z: Math.floor(snapshot.position.z),
  };
  const dimension = snapshot.dimension || "minecraft:overworld";
  const script = [
    "set -eu",
    "dimension=$1",
    "origin_x=$2",
    "origin_y=$3",
    "origin_z=$4",
    "range=$5",
    "neg=$((0 - range))",
    "range2=$((range * range))",
    "scanned=0",
    "dx=$neg",
    'while [ "$dx" -le "$range" ]; do',
    "  dy=$neg",
    '  while [ "$dy" -le "$range" ]; do',
    "    dz=$neg",
    '    while [ "$dz" -le "$range" ]; do',
    "      distance2=$((dx * dx + dy * dy + dz * dz))",
    '      if [ "$distance2" -le "$range2" ]; then',
    "        x=$((origin_x + dx))",
    "        y=$((origin_y + dy))",
    "        z=$((origin_z + dz))",
    "        scanned=$((scanned + 1))",
    '        out="$(rcon-cli execute in "$dimension" run data get block "$x" "$y" "$z" Items 2>&1 || true)"',
    '        case "$out" in',
    '          *"has the following block data"*)',
    '            printf "\\n---MCSM-CHEST---\\n"',
    '            printf "pos=%s,%s,%s\\n" "$x" "$y" "$z"',
    '            printf "%s\\n" "$out"',
    "            ;;",
    "        esac",
    "      fi",
    "      dz=$((dz + 1))",
    "    done",
    "    dy=$((dy + 1))",
    "  done",
    "  dx=$((dx + 1))",
    "done",
    'printf "\\n---MCSM-SCAN---\\nscanned=%s\\n" "$scanned"',
  ].join("\n");

  const raw = await runDocker(
    server,
    CHEST_SCAN_TIMEOUT_MS,
    "exec",
    server.container,
    "sh",
    "-lc",
    script,
    "scan-nearby-chests",
    dimension,
    String(origin.x),
    String(origin.y),
    String(origin.z),
    String(range),
  );
  const scanned = Number.parseInt(raw.match(/---MCSM-SCAN---\s*scanned=(\d+)/)?.[1] || "0", 10);
  const chests = parseNearbyChestScan(raw)
    .map((chest) => ({
      ...chest,
      distance: Math.sqrt((chest.x - origin.x) ** 2 + (chest.y - origin.y) ** 2 + (chest.z - origin.z) ** 2),
    }))
    .sort((a, b) => a.distance - b.distance)
    .map((chest, index) => ({ ...chest, label: `Chest ${index + 1}` }));

  return {
    player,
    range,
    origin,
    dimension,
    scanned,
    chests,
    raw,
  };
};

const writeServerProperty = async (server, key, value) => {
  assertServerProperty(key);
  const normalized = normalizeServerPropertyValue(value);
  const script = [
    "set -e",
    "file=/data/server.properties",
    "key=$1",
    "value=$2",
    'touch "$file"',
    'tmp="${file}.tmp.$$"',
    "awk -v key=\"$key\" -v value=\"$value\" '",
    "BEGIN { updated = 0 }",
    "index($0, key \"=\") == 1 { print key \"=\" value; updated = 1; next }",
    "{ print }",
    "END { if (!updated) print key \"=\" value }",
    "' \"$file\" > \"$tmp\"",
    'cat "$tmp" > "$file"',
    'rm -f "$tmp"',
  ].join("\n");

  await run(server, "exec", server.container, "sh", "-lc", script, "set-property", key, normalized);
};

const parseServerProperties = (raw = "") =>
  Object.fromEntries(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );

const readServerProperties = async (server) => {
  try {
    const raw = await runQuick(server, "exec", server.container, "sh", "-lc", "test -f /data/server.properties && cat /data/server.properties || true");
    return parseServerProperties(raw);
  } catch {
    return {};
  }
};

const EDITABLE_SERVER_PROPERTIES = new Set([
  "allow-flight",
  "gamemode",
  "level-name",
  "max-players",
  "motd",
  "online-mode",
  "server-name",
  "simulation-distance",
  "spawn-protection",
  "view-distance",
]);

const containerInfoFromRow = async (server, container) => {
  const properties = await readServerProperties({ ...server, container: container.name });
  return {
    ...container,
    serverName: properties["server-name"] || null,
    motd: properties.motd || null,
    levelName: properties["level-name"] || null,
  };
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

const envWithUpdates = (currentEnv = [], updates = {}) => {
  const keys = Object.keys(updates);
  const nextEnv = (currentEnv || []).filter((entry) => !keys.some((key) => entry.startsWith(`${key}=`)));

  for (const [key, value] of Object.entries(updates)) {
    if (value == null || value === "") continue;
    nextEnv.push(`${key}=${value}`);
  }

  if (!nextEnv.some((entry) => entry.startsWith("EULA="))) nextEnv.push("EULA=TRUE");
  return nextEnv;
};

const recreateContainerWithEnv = async (server, containerInspect, envUpdates) => {
  const env = envWithUpdates(containerInspect.Config?.Env || [], envUpdates);

  const portFlags = [];
  const portBindings = containerInspect.HostConfig?.PortBindings || {};
  for (const [key, binds] of Object.entries(portBindings)) {
    if (!Array.isArray(binds)) continue;
    for (const bind of binds) {
      if (!bind?.HostPort) continue;
      const hostIp = bind.HostIp && bind.HostIp !== "0.0.0.0" ? `${bind.HostIp}:` : "";
      portFlags.push("-p", `${hostIp}${bind.HostPort}:${key}`);
    }
  }

  const volumeFlags = [];
  for (const mount of containerInspect.Mounts || []) {
    const source = mount.Type === "volume" ? mount.Name || mount.Source : mount.Source;
    const mode = mount.RW ? "" : ":ro";
    volumeFlags.push("-v", `${source}:${mount.Destination}${mode}`);
  }

  const envFlags = env.flatMap((entry) => ["-e", entry]);
  const restartName = containerInspect.HostConfig?.RestartPolicy?.Name || "unless-stopped";
  const image = containerInspect.Config?.Image || "itzg/minecraft-server:latest";
  const name = containerInspect.Name?.replace(/^\//, "") || server.container;

  try {
    await run(server, "stop", name);
  } catch {}
  try {
    await run(server, "rm", "-f", name);
  } catch {}

  await run(server, "run", "-d", "--name", name, ...portFlags, ...volumeFlags, ...envFlags, "--restart", restartName, image);
  await updateServerContainer(server.id, name);

  return name;
};

const listManagedContainers = async (server) => {
  const out = await run(server, "ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}");
  const rows = out
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, name, image, ...rest] = line.split(/\t/);
      return { id, name, image, status: rest.join(" "), edition: detectEdition(image) };
    })
    .filter((container) => isManagedMinecraftImage(container.image));
  return Promise.all(rows.map((container) => containerInfoFromRow(server, container)));
};

const EVENT_FAILURE_RE =
  /not white-?listed|whitelist|failed to verify username|invalid session|banned|server is full|outdated (?:client|server)|took too long to log in|authentication|multiplayer\.disconnect\.(?:not_whitelisted|banned|server_full|outdated_client|outdated_server|unverified_username|duplicate_login|authservers_down)/i;

const stripMinecraftLogPrefix = (line = "") =>
  String(line)
    .replace(/^\[[^\]]+\]\s+\[[^\]]+\]:\s*/, "")
    .replace(/^\[[^\]]+\]\s+\[[^\]]+\]\s*/, "")
    .trim();

const splitDockerTimestamp = (line = "") => {
  const match = String(line).match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/);
  if (!match) return { time: null, message: stripMinecraftLogPrefix(line) };
  return {
    time: match[1],
    message: stripMinecraftLogPrefix(match[2]),
  };
};

const extractFailurePlayer = (message = "") =>
  message.match(/\bname=([A-Za-z0-9_]{1,16})\b/i)?.[1] ||
  message.match(/^([A-Za-z0-9_]{1,16})\s+lost connection:/i)?.[1] ||
  message.match(/^Disconnecting\s+([A-Za-z0-9_]{1,16})\s*:/i)?.[1] ||
  "";

const eventFromLogLine = (line = "", index = 0) => {
  const { time, message } = splitDockerTimestamp(line);
  if (!message) return null;

  const chat =
    message.match(/^(?:\[[^\]]+\]\s*)?<([^>]+)>\s+(.+)$/) ||
    message.match(/^\[CHAT\]\s*(?:\[[^\]]+\]\s*)?<([^>]+)>\s*(.+)$/i);
  if (chat) {
    return {
      id: `event-${index}`,
      type: "chat",
      time,
      player: chat[1].trim(),
      message: chat[2].trim(),
      raw: line,
    };
  }

  const javaJoin = message.match(/^([A-Za-z0-9_]{1,16}) joined the game$/i);
  const bedrockJoin = message.match(/^Player connected:\s*([^,]+)(?:,|$)/i);
  if (javaJoin || bedrockJoin) {
    return {
      id: `event-${index}`,
      type: "join",
      time,
      player: (javaJoin?.[1] || bedrockJoin?.[1] || "").trim(),
      message: "Joined the server",
      raw: line,
    };
  }

  const javaLeave = message.match(/^([A-Za-z0-9_]{1,16}) left the game$/i);
  const bedrockLeave = message.match(/^Player disconnected:\s*([^,]+)(?:,|$)/i);
  if (javaLeave || bedrockLeave) {
    return {
      id: `event-${index}`,
      type: "leave",
      time,
      player: (javaLeave?.[1] || bedrockLeave?.[1] || "").trim(),
      message: "Left the server",
      raw: line,
    };
  }

  const lostConnection = message.match(/^([A-Za-z0-9_]{1,16}) lost connection:\s*(.+)$/i);
  if (lostConnection) {
    const reason = lostConnection[2].trim();
    if (EVENT_FAILURE_RE.test(reason)) {
      return {
        id: `event-${index}`,
        type: "failed_login",
        time,
        player: lostConnection[1],
        message: reason,
        raw: line,
      };
    }
    return {
      id: `event-${index}`,
      type: "leave",
      time,
      player: lostConnection[1],
      message: reason || "Disconnected",
      raw: line,
    };
  }

  const disconnecting = message.match(/^Disconnecting\s+(.+?):\s*(.+)$/i);
  if (disconnecting && EVENT_FAILURE_RE.test(disconnecting[2])) {
    const reason = message.match(/\):\s*(.+)$/)?.[1] || disconnecting[2].trim();
    return {
      id: `event-${index}`,
      type: "failed_login",
      time,
      player: extractFailurePlayer(message),
      message: reason,
      raw: line,
    };
  }

  if (EVENT_FAILURE_RE.test(message) && /login|username|whitelist|banned|disconnect/i.test(message)) {
    return {
      id: `event-${index}`,
      type: "failed_login",
      time,
      player: extractFailurePlayer(message),
      message,
      raw: line,
    };
  }

  return null;
};

const parseServerEvents = (raw = "") =>
  String(raw)
    .split(/\r?\n/)
    .map((line, index) => eventFromLogLine(line, index))
    .filter(Boolean);

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
    const properties = await readServerProperties(server);
    const livePvp = edition !== "unknown" && i.State?.Running ? await readPvpGameRule(server, i).catch((error) => ({ rule: null, value: null, error: String(error.message || error) })) : null;
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
      envPvp: env.PVP ?? null,
      envHardcore: env.HARDCORE ?? null,
      envOverrideServerProperties: env.OVERRIDE_SERVER_PROPERTIES ?? null,
      deathDrops: normalizeDeathDropsConfig(server.deathDrops),
      homeCommand: normalizeHomeCommandConfig(server.homeCommand),
      fileDifficulty: properties.difficulty || null,
      filePvp: properties.pvp || null,
      livePvp: livePvp?.value ?? null,
      livePvpRule: livePvp?.rule ?? null,
      livePvpError: livePvp?.error ?? null,
      fileHardcore: properties.hardcore || null,
      motd: properties.motd || null,
      serverName: properties["server-name"] || null,
      serverProperties: properties,
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

app.post("/api/difficulty", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const level = String(req.body?.level || "").toLowerCase();
    if (!["peaceful", "easy", "normal", "hard"].includes(level)) {
      return res.status(400).json({ error: "level must be peaceful|easy|normal|hard" });
    }

    const i = await inspect(server);
    if (i.State?.Running) {
      await writeServerProperty(server, "difficulty", level);
    }
    const name = await recreateContainerWithEnv(server, i, { DIFFICULTY: level, OVERRIDE_SERVER_PROPERTIES: "true" });
    res.json({ ok: true, newDifficulty: level, target: name, serverId: server.id });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/pvp", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    let enabled;
    try {
      enabled = parseBooleanFlag(req.body?.enabled);
    } catch (error) {
      return res.status(400).json({ error: String(error.message || error) });
    }
    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    const value = booleanPropertyValue(enabled);
    await writeServerProperty(server, "pvp", value);
    const target = await recreateContainerWithEnv(server, i, { PVP: value, OVERRIDE_SERVER_PROPERTIES: "true" });
    const notes = [`PVP server.properties and startup env set to ${value}.`];
    let livePvp = null;

    if (edition !== "unknown") {
      try {
        livePvp = await withServerCommandWhenReady({ ...server, container: target }, (readyInspect) => setPvpGameRule({ ...server, container: target }, readyInspect, enabled), 45000);
        if (livePvp.value === enabled) {
          notes.push(`Live gamerule ${livePvp.rule} confirmed ${value}.`);
        } else {
          notes.push(`Live gamerule was not confirmed: ${livePvp.error || "no supported PVP gamerule name was accepted"}.`);
        }
      } catch (error) {
        notes.push(`Live gamerule could not be confirmed: ${String(error.message || error)}`);
      }
    }

    res.json({
      ok: true,
      enabled,
      filePvp: value,
      livePvp: livePvp?.value ?? null,
      livePvpRule: livePvp?.rule ?? null,
      livePvpError: livePvp?.error ?? null,
      recreated: true,
      target,
      note: notes.join(" "),
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/hardcore", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    let enabled;
    try {
      enabled = parseBooleanFlag(req.body?.enabled);
    } catch (error) {
      return res.status(400).json({ error: String(error.message || error) });
    }
    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    if (edition !== "java") {
      return res.status(400).json({ error: "Hardcore mode is currently managed for Java servers only." });
    }

    const value = booleanPropertyValue(enabled);
    await writeServerProperty(server, "hardcore", value);
    const target = await recreateContainerWithEnv(server, i, { HARDCORE: value, OVERRIDE_SERVER_PROPERTIES: "true" });

    res.json({ ok: true, enabled, fileHardcore: value, recreated: true, target });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/properties", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const updates = req.body?.properties && typeof req.body.properties === "object" ? req.body.properties : {};
    const entries = Object.entries(updates).filter(([key, value]) => EDITABLE_SERVER_PROPERTIES.has(key) && value != null && String(value).trim() !== "");
    if (!entries.length) return res.status(400).json({ error: "no editable server properties provided" });

    const { i } = await getContainerMeta(server);
    ensureRunning(i);

    for (const [key, value] of entries) {
      await writeServerProperty(server, key, value);
    }

    const properties = await readServerProperties(server);
    await run(server, "restart", server.container);
    res.json({ ok: true, restarted: true, properties });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.post("/api/spawn", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const coords = ["x", "y", "z"].map((key) => {
      const value = Number.parseInt(req.body?.[key], 10);
      if (!Number.isInteger(value)) throw new Error(`spawn ${key.toUpperCase()} must be an integer`);
      return String(value);
    });

    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    const result = await sendServerCommand(server, i, ["setworldspawn", ...coords]);
    res.json({
      ok: true,
      edition,
      x: coords[0],
      y: coords[1],
      z: coords[2],
      stdout: result.stdout || null,
      note: result.note || null,
    });
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

app.post("/api/player/unlock", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const player = normalizePlayerName(req.body?.player);

    const { i, edition } = await getContainerMeta(server);
    ensureRunning(i);

    const playerArg = edition === "bedrock" && /\s/.test(player) ? quoteCommandArg(player) : player;
    let pardonNote = null;
    if (edition === "java") {
      try {
        await sendServerCommand(server, i, ["pardon", player]);
      } catch (error) {
        pardonNote = String(error.message || error);
      }
    }

    const result = await sendServerCommand(server, i, ["gamemode", "survival", playerArg]);

    res.json({
      ok: true,
      edition,
      player,
      stdout: result.stdout || null,
      note: result.note || (pardonNote ? "Player set to survival. Pardon was not needed or did not apply." : null),
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

app.get("/api/game/status", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const { i, edition } = await getContainerMeta(server);
    const running = !!i.State?.Running;

    if (edition !== "java") {
      return res.json({
        edition,
        running,
        available: false,
        message: "Control Center tools are currently available for Java servers only.",
        players: [],
      });
    }

    ensureRunning(i);
    const result = await sendServerCommand(server, i, ["list"]);
    const players = parseOnlinePlayers(result.stdout);

    res.json({
      edition,
      running,
      available: true,
      players,
      stdout: result.stdout || null,
    });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.get("/api/game/player", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const player = normalizeJavaPlayerName(req.query?.player);
    const { i } = await ensureJavaControlServer(server);

    res.json({
      ok: true,
      ...(await collectJavaPlayerSnapshot(server, i, player)),
    });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.post("/api/game/player/action", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const player = normalizeJavaPlayerName(req.body?.player);
    const action = String(req.body?.action || "").trim();
    const { i } = await ensureJavaControlServer(server);
    let command = null;

    if (action === "teleport-coords") {
      command = [
        "tp",
        player,
        normalizeCoordinate(req.body?.x, "x"),
        normalizeCoordinate(req.body?.y, "y"),
        normalizeCoordinate(req.body?.z, "z"),
      ];
    } else if (action === "teleport-player") {
      command = ["tp", player, normalizeJavaPlayerName(req.body?.targetPlayer, "target player")];
    } else if (action === "teleport-home") {
      const spawn = await readJavaSpawn(server, i, player);
      command = ["execute", "in", spawn.dimension, "run", "tp", player, String(spawn.x), String(spawn.y), String(spawn.z)];
    } else if (action === "gamemode") {
      command = ["gamemode", normalizeGameMode(req.body?.mode), player];
    } else if (action === "give") {
      command = ["give", player, normalizeItemId(req.body?.item), normalizeCount(req.body?.count, 1, 640)];
    } else if (action === "clear") {
      command = ["clear", player];
    } else if (action === "heal") {
      command = ["effect", "give", player, "minecraft:instant_health", "1", "20", "true"];
    } else if (action === "feed") {
      command = ["effect", "give", player, "minecraft:saturation", "1", "20", "true"];
    } else {
      return res.status(400).json({ error: "unsupported player action" });
    }

    const result = await sendServerCommand(server, i, command);
    const snapshot = await collectJavaPlayerSnapshot(server, i, player).catch(() => null);

    res.json({
      ok: true,
      action,
      player,
      command: command.join(" "),
      stdout: result.stdout || null,
      snapshot,
    });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.get("/api/game/nearby-chests", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const player = normalizeJavaPlayerName(req.query?.player);
    const range = normalizeChestScanRange(req.query?.range);
    res.json({ ok: true, ...(await scanNearbyChests(server, player, range)) });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.get("/api/game/death-drops", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const config = normalizeDeathDropsConfig(server.deathDrops);
    const response = {
      ok: true,
      config,
      monitor: publicDeathDropMonitor(server),
      available: false,
      running: false,
      edition: "unknown",
      keepInventory: null,
      keepInventoryRule: null,
      keepInventoryError: null,
    };

    const { i, edition } = await getContainerMeta(server);
    response.edition = edition;
    response.running = !!i.State?.Running;
    response.available = edition === "java" && response.running;

    if (response.available) {
      const keepInventory = await readKeepInventoryGameRule(server, i);
      response.keepInventory = keepInventory.value;
      response.keepInventoryRule = keepInventory.rule;
      response.keepInventoryError = keepInventory.error || null;
    }

    res.json(response);
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.post("/api/game/death-drops", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const managed = findServer(server.id);
    if (!managed) return res.status(400).json({ error: "Save this target before enabling death drops." });

    const config = normalizeDeathDropsConfig(req.body?.config || req.body || {});
    let appliedKeepInventory = null;
    let note = "Death drop settings saved.";
    const { i, edition } = await getContainerMeta(server);
    if (edition !== "java") {
      return res.status(400).json({ error: "Death drops are currently available for Java servers only." });
    }

    if (i.State?.Running) {
      await ensureDeathScoreObjective(server, i, getDeathDropMonitor(server));
      appliedKeepInventory = await applyDeathDropGameRules(server, i, config);
      const keepInventoryState = await readKeepInventoryGameRule(server, i);
      appliedKeepInventory = keepInventoryState.value;
      if (config.enabled && ["drop", "chest"].includes(config.mode) && appliedKeepInventory !== true) {
        const detail = keepInventoryState.error ? ` Last error: ${keepInventoryState.error}` : "";
        return res.status(409).json({
          error:
            `Minecraft did not confirm keepInventory=true, so this mode was not enabled. Drop-at-spot and death chest modes need keepInventory to prevent duplicated or lost items.${detail}`,
          keepInventory: appliedKeepInventory,
          keepInventoryRule: keepInventoryState.rule,
          keepInventoryError: keepInventoryState.error || null,
        });
      }
      const ruleText = keepInventoryState.rule ? ` via ${keepInventoryState.rule}` : "";
      note = appliedKeepInventory == null ? "Death drop settings saved." : `Death drop settings saved. keepInventory is ${appliedKeepInventory ? "enabled" : "disabled"}${ruleText}.`;
    } else {
      note = "Death drop settings saved. They will apply when the Java server is running.";
    }

    managed.deathDrops = config;
    server.deathDrops = config;
    await saveServers();

    res.json({
      ok: true,
      config,
      appliedKeepInventory,
      keepInventoryRule: i.State?.Running ? (await readKeepInventoryGameRule(server, i)).rule : null,
      note,
      monitor: publicDeathDropMonitor(server),
    });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.get("/api/game/home-command", async (req, res) => {
  try {
    const server = resolveServer(req.query);
    const config = normalizeHomeCommandConfig(server.homeCommand);
    const response = {
      ok: true,
      config,
      command: `/${HOME_OBJECTIVE === "home" ? "trigger home" : `trigger ${HOME_OBJECTIVE}`}`,
      monitor: publicHomeCommandMonitor(server),
      available: false,
      running: false,
      edition: "unknown",
    };

    const { i, edition } = await getContainerMeta(server);
    response.edition = edition;
    response.running = !!i.State?.Running;
    response.available = edition === "java" && response.running;

    res.json(response);
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.post("/api/game/home-command", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const managed = findServer(server.id);
    if (!managed) return res.status(400).json({ error: "Save this target before enabling the home command." });

    const config = normalizeHomeCommandConfig(req.body?.config || req.body || {});
    const { i, edition } = await getContainerMeta(server);
    if (edition !== "java") {
      return res.status(400).json({ error: "Home command is currently available for Java servers only." });
    }

    let note = "Home command settings saved.";
    if (i.State?.Running && config.enabled) {
      const state = getHomeCommandMonitor(server);
      await ensureHomeTriggerObjective(server, i, state);
      await sendServerCommand(server, i, ["scoreboard", "players", "enable", "@a", HOME_OBJECTIVE]).catch(() => null);
      note = `Home command settings saved. Players can use /trigger ${HOME_OBJECTIVE}.`;
    } else if (config.enabled) {
      note = "Home command settings saved. They will apply when the Java server is running.";
    }

    managed.homeCommand = config;
    server.homeCommand = config;
    await saveServers();

    res.json({
      ok: true,
      config,
      command: `/trigger ${HOME_OBJECTIVE}`,
      note,
      monitor: publicHomeCommandMonitor(server),
    });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
  }
});

app.post("/api/game/happy-ghast-speed", async (req, res) => {
  try {
    const server = resolveServer(req.body);
    const speed = Number.parseFloat(req.body?.speed);
    if (!Number.isFinite(speed) || speed < 0 || speed > 10) {
      return res.status(400).json({ error: "speed must be a number between 0 and 10" });
    }

    const { i } = await ensureJavaControlServer(server);
    const speedText = String(speed);
    const command = ["execute", "as", "@e[type=minecraft:happy_ghast]", "run", "attribute", "@s", "minecraft:flying_speed", "base", "set", speedText];
    const result = await sendServerCommand(server, i, command);

    res.json({
      ok: true,
      speed,
      command: command.join(" "),
      stdout: result.stdout || null,
      note: "Applied to loaded Happy Ghasts. This is version-sensitive in vanilla Minecraft.",
    });
  } catch (error) {
    res.status(javaErrorStatus(error)).json({ error: String(error.message || error) });
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
    const rows = await listManagedContainers(server);
    res.json({ serverId: server.id, hostLabel: hostLabel(server), defaultContainer: rows[0] || null, containers: rows });
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

app.get("/api/events", async (req, res) => {
  const lines = Math.max(1, Math.min(10000, Number.parseInt(req.query.lines || "1000", 10) || 1000));
  const type = String(req.query.type || "all");
  try {
    const server = resolveServer(req.query);
    const raw = await run(server, "logs", "--timestamps", "--tail", String(lines), server.container);
    const events = parseServerEvents(raw)
      .filter((event) => type === "all" || event.type === type)
      .reverse();
    res.json({
      serverId: server.id,
      target: server.container,
      lines,
      type,
      count: events.length,
      events,
    });
  } catch (error) {
    res.status(500).json({ error: String(error.message || error) });
  }
});

// serve static UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const deathDropTimer = setInterval(() => {
  Promise.all([runDeathDropMonitors(), runHomeCommandMonitors()]).catch((error) => {
    console.warn(`Server monitor failed: ${String(error.message || error)}`);
  });
}, normalizeTimeout(DEATH_DROP_POLL_MS, 2000));
deathDropTimer.unref?.();

app.listen(PORT, () => {
  const server = findServer(ACTIVE_SERVER_ID) || SERVERS[0];
  console.log(`UI: http://localhost:${PORT}  (target: ${server.label} / ${server.container})`);
});
