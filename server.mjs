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
  return item.includes(":") ? item : `minecraft:${item}`;
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
  const [positionResult, dimensionResult, healthResult, foodResult, inventoryResult] = await Promise.allSettled([
    sendServerCommand(server, i, ["data", "get", "entity", player, "Pos"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "Dimension"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "Health"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "foodLevel"]),
    sendServerCommand(server, i, ["data", "get", "entity", player, "Inventory"]),
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
  const x = parseDataNumber(valueFrom(xResult));
  const y = parseDataNumber(valueFrom(yResult));
  const z = parseDataNumber(valueFrom(zResult));
  const dimension = parseDataString(valueFrom(dimensionResult)) || "minecraft:overworld";

  if (![x, y, z].every((value) => Number.isFinite(value))) {
    throw requestError(`${player} does not have a bed spawn recorded.`);
  }

  return { x, y, z, dimension };
};

const deathDropMonitorKey = (server) => `${server.type}:${server.host || "local"}:${server.id}:${server.container}`;
const deathDropMonitors = new Map();

const getDeathDropMonitor = (server) => {
  const key = deathDropMonitorKey(server);
  if (!deathDropMonitors.has(key)) {
    deathDropMonitors.set(key, {
      deaths: new Map(),
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
    trackedPlayers: state.trackedPlayers || [],
  };
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

const readJavaGameRule = async (server, i, rule) => {
  const result = await sendServerCommand(server, i, ["gamerule", rule]);
  const match = String(result.stdout || "").match(/\b(true|false)\b/i);
  return match ? match[1].toLowerCase() === "true" : null;
};

const applyDeathDropGameRules = async (server, i, config) => {
  if (!config.enabled) return null;
  const keepInventory = config.mode === "keep" || config.mode === "drop" || config.mode === "chest";
  await sendServerCommand(server, i, ["gamerule", "keepInventory", keepInventory ? "true" : "false"]);
  return keepInventory;
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

  await sleep(1500);
  const clearResult = await sendServerCommand(server, i, ["clear", player]).catch((error) => ({ stdout: "", error: String(error.message || error) }));

  return {
    position: pos,
    chests,
    itemStacks: inventory.length,
    cleared: !clearResult.error,
    note: clearResult.error || null,
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

  await sleep(1500);
  const clearResult = await sendServerCommand(server, i, ["clear", player]).catch((error) => ({ stdout: "", error: String(error.message || error) }));

  return {
    position: pos,
    droppedStacks: inventory.length,
    cleared: !clearResult.error,
    note: clearResult.error || null,
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
      Object.assign(event, await dropInventoryAtDeathSpot(server, i, player, snapshot));
      event.ok = true;
    } else if (config.mode === "chest") {
      Object.assign(event, await createDeathChests(server, i, player, snapshot));
      event.ok = true;
    } else {
      event.ok = true;
      event.note = "keepInventory is enabled; no death-drop action was needed.";
    }
    state.lastError = null;
  } catch (error) {
    event.error = String(error.message || error);
    state.lastError = event.error;
  }

  state.lastEvent = event;
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

    for (const player of players) {
      const previousScore = state.deaths.get(player);
      const previousSnapshot = state.snapshots.get(player);
      const [score, snapshot] = await Promise.all([
        readJavaDeathScore(server, i, player),
        collectJavaPlayerSnapshot(server, i, player).catch(() => null),
      ]);

      if (previousScore != null && score > previousScore) {
        await handleDeathDropEvent(server, i, player, deathEventSnapshot(config, previousSnapshot, snapshot), config, state);
      }

      state.deaths.set(player, score);
      if (snapshot) state.snapshots.set(player, snapshot);
    }

    state.lastError = null;
  } catch (error) {
    state.lastError = String(error.message || error);
  }
};

let deathDropMonitorRunning = false;

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
      fileDifficulty: properties.difficulty || null,
      filePvp: properties.pvp || null,
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
    let note = null;

    if (edition === "bedrock") {
      try {
        await sendServerCommandWhenReady({ ...server, container: target }, ["gamerule", "pvp", value]);
        note = `Bedrock gamerule pvp ${value} applied.`;
      } catch (error) {
        note = `PVP file/startup config updated, but Bedrock gamerule could not be confirmed: ${String(error.message || error)}`;
      }
    }

    res.json({ ok: true, enabled, filePvp: value, recreated: true, target, note });
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
    };

    const { i, edition } = await getContainerMeta(server);
    response.edition = edition;
    response.running = !!i.State?.Running;
    response.available = edition === "java" && response.running;

    if (response.available) {
      response.keepInventory = await readJavaGameRule(server, i, "keepInventory").catch(() => null);
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
    managed.deathDrops = config;
    server.deathDrops = config;
    await saveServers();

    let appliedKeepInventory = null;
    let note = "Death drop settings saved.";
    const { i, edition } = await getContainerMeta(server);
    if (edition !== "java") {
      return res.status(400).json({ error: "Death drops are currently available for Java servers only." });
    }

    if (i.State?.Running) {
      await ensureDeathScoreObjective(server, i, getDeathDropMonitor(server));
      appliedKeepInventory = await applyDeathDropGameRules(server, i, config);
      note = appliedKeepInventory == null ? "Death drop settings saved." : `Death drop settings saved. keepInventory is ${appliedKeepInventory ? "enabled" : "disabled"}.`;
    } else {
      note = "Death drop settings saved. They will apply when the Java server is running.";
    }

    res.json({
      ok: true,
      config,
      appliedKeepInventory,
      note,
      monitor: publicDeathDropMonitor(server),
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

// serve static UI
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const deathDropTimer = setInterval(() => {
  runDeathDropMonitors().catch((error) => {
    console.warn(`Death drop monitor failed: ${String(error.message || error)}`);
  });
}, normalizeTimeout(DEATH_DROP_POLL_MS, 2000));
deathDropTimer.unref?.();

app.listen(PORT, () => {
  const server = findServer(ACTIVE_SERVER_ID) || SERVERS[0];
  console.log(`UI: http://localhost:${PORT}  (target: ${server.label} / ${server.container})`);
});
