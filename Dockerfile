FROM node:22-alpine

ENV NODE_ENV=production

# yt-dlp downloads TikTok videos; curl-cffi lets it impersonate a browser so TikTok doesn't block it.
# ffmpeg compresses videos over Discord's upload limit.
RUN apk add --no-cache python3 py3-pip ffmpeg
# Busts the build cache whenever yt-dlp publishes a new release, so extractor fixes get picked up.
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/yt-dlp-release.json
RUN pip install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node . .
# Persistent state (dynamic voice channels); compose mounts a volume here.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

CMD ["node", "index.js"]
