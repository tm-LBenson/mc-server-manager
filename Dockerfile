FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io openssh-client \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p /app/data /app/data/ssh

ENV NODE_ENV=production
ENV PORT=8881
ENV MC_SERVERS_FILE=/app/data/servers.json

EXPOSE 8881

CMD ["npm", "start"]
