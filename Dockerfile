# zai-quota-guard — zero runtime deps, so the image is just Node + two files.
FROM node:22-alpine

# Run as the unprivileged built-in node user, not root.
WORKDIR /app
COPY package.json index.js ./

# The monitor logs to stdout/stderr; no TTY needed.
ENV NODE_ENV=production
ENTRYPOINT ["node", "index.js"]
