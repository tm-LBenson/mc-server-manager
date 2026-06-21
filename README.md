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

## Deploy with GitHub Actions and Coolify

This repo includes `.github/workflows/deploy.yml`. On every push to `main`, it:

1. Installs dependencies with `npm ci`.
2. Runs `npm run check`.
3. Builds the Docker image from `Dockerfile`.
4. Pushes the image to GitHub Container Registry as:

```text
ghcr.io/<github-owner>/<repo>:latest
ghcr.io/<github-owner>/<repo>:<commit-sha>
```

5. Calls the Coolify deploy webhook.

You can also run it manually from GitHub's `Actions` tab with `Deploy to Coolify` -> `Run workflow`.

### Coolify setup

1. In Coolify, create or update this app as a Docker image based resource.
2. Set the image to:

```text
ghcr.io/<github-owner>/<repo>:latest
```

3. Set the exposed port to `8881`.
4. Add production environment variables:

```env
ADMIN_PASSWORD=replace-with-a-long-password
PORT=8881
MC_SERVERS_FILE=/app/data/servers.json
```

5. Add persistent storage for `/app/data` so `servers.json` survives redeploys.
6. If this app should manage Docker containers on the same Coolify host, add the Docker socket bind mount:

```text
/var/run/docker.sock -> /var/run/docker.sock
```

or as a custom Docker option:

```text
-v /var/run/docker.sock:/var/run/docker.sock
```

7. Open the app's `Webhooks` page in Coolify and copy the `Deploy Webhook` URL.
8. In Coolify, go to `Settings` -> `Configuration` -> `Advanced` and enable `API Access`.
9. In Coolify, go to `Keys & Tokens` -> `API Tokens`, create a token with the `Deploy` permission, and copy it once.

### GitHub secrets

Add these repository secrets in GitHub under `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`:

```text
COOLIFY_WEBHOOK=<the Coolify Deploy Webhook URL>
COOLIFY_TOKEN=<the Coolify API token with Deploy permission>
```

The workflow uses GitHub's built-in `GITHUB_TOKEN` to push the Docker image to GHCR, so you do not need to add a separate registry token for the workflow.

If the workflow gets a package permission error, check `Settings` -> `Actions` -> `General` and make sure workflow permissions allow read/write access. The workflow also explicitly requests:

```yaml
permissions:
  contents: read
  packages: write
```

### GHCR access for Coolify

Coolify must be able to pull `ghcr.io/<github-owner>/<repo>:latest`.

For a public GHCR package, no extra registry key is usually needed.

For a private GHCR package:

1. In GitHub, create a personal access token, classic, with `read:packages`.
2. If GitHub requires repository access for the private package, also grant the minimum repo access needed for this repository.
3. Add those credentials to Coolify's registry authentication for GHCR, or log in on the Coolify server:

```sh
echo YOUR_GHCR_READ_TOKEN | docker login ghcr.io -u YOUR_GITHUB_USERNAME --password-stdin
```

Keep the Coolify deploy token and any GHCR read token scoped as narrowly as possible and rotate them if they are exposed.

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
