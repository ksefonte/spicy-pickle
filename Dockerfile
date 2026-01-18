FROM node:22-alpine

RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package.json package-lock.json* ./

# Install all dependencies (need devDependencies for build)
# Skip prepare script (husky) which fails in production
RUN npm ci --ignore-scripts && npm cache clean --force

# Copy source code
COPY . .

# Switch Prisma to PostgreSQL and use pg migrations
RUN sed -i 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma && \
    rm -rf prisma/migrations && \
    mv prisma/migrations-pg prisma/migrations

# Generate Prisma client for PostgreSQL
RUN npx prisma generate

# Build the app
RUN npm run build

# Remove dev dependencies
RUN npm prune --production

# Start script runs migrations then starts server
CMD ["sh", "-c", "npx prisma migrate deploy && npm run start"]
