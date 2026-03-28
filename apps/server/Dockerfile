FROM oven/bun:1.3

WORKDIR /app

# Copy workspace root
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/
COPY apps/server/package.json apps/server/

# Install dependencies
RUN bun install

# Copy source
COPY packages/types/ packages/types/
COPY apps/server/ apps/server/

WORKDIR /app/apps/server

EXPOSE 3001

CMD ["bun", "run", "start"]
