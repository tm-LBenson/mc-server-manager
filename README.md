# Minecraft Server Manager

Small web UI for managing Minecraft Docker containers locally or on external Docker/Coolify hosts.

## Run

```powershell
npm install
npm start
```

Open `http://localhost:8881`.

Default admin password:

```text
techtavern
```

Override it with:

```env
ADMIN_PASSWORD=your-password
```

## Managed Servers

Server targets are saved in `servers.json` and are intentionally gitignored. Each target has a display name, connection type, Docker container name, and optional SSH settings.

Connection types:

- `Local Docker`: runs `docker ...` on the same machine as this app.
- `SSH Docker`: runs `docker ...` on another machine through SSH.

For `Local Docker` in Coolify, mount the host Docker socket into this app:

```text
/var/run/docker.sock -> /var/run/docker.sock
```

In Coolify this can be added as a bind mount or as a custom Docker option:

```text
-v /var/run/docker.sock:/var/run/docker.sock
```

This lets the app's built-in Docker CLI control containers on the Coolify host. Treat the app like an admin tool: access to the Docker socket effectively grants host-level Docker control.

For Coolify-hosted Minecraft containers on another machine:

1. Add a server target with `Connection` set to `SSH Docker`.
2. Set `Host`, `SSH User`, optional `Identity File`, and the Coolify container name.
3. The SSH user must be able to run Docker commands on that host.
4. The app host must have `ssh` available and key-based auth configured.

The `Containers` button lists containers on the selected host, which is useful for finding Coolify-generated container names.

## Whitelist / Allowlist

The app adds and removes players by username/GamerTag through the running Minecraft server command interface:

- Java: `docker exec <container> rcon-cli whitelist add <username>`
- Bedrock: `docker exec <container> send-command allowlist add <GamerTag>`

For Java servers, use an image that includes `rcon-cli`, such as the common `itzg/minecraft-server` image, and keep RCON enabled. For Bedrock servers, use an image that includes `send-command`.
