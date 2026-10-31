# Trustwork web application container (engine default, no hosting-provider specifics).
#   docker build -f infra/Dockerfile --build-arg BASE_PATH=/ --build-arg SITE_URL=https://example.invalid -t trustwork-web .
#   docker run -p 3000:3000 -e TRUSTWORK_ALLOWED_ORIGINS=example.invalid trustwork-web
# The app listens on PORT (default 3000). Set BASE_PATH when it is served under a path prefix.
FROM node:24-alpine AS build
WORKDIR /src
ARG BASE_PATH=
ARG SITE_URL=http://127.0.0.1:3000
ENV NEXT_PUBLIC_BASE_PATH=$BASE_PATH NEXT_PUBLIC_SITE_URL=$SITE_URL NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
RUN npm ci --no-audit --no-fund
RUN npm run build -w @trustwork/web

FROM node:24-alpine
WORKDIR /src
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build /src ./
EXPOSE 3000
CMD ["sh", "-c", "node node_modules/next/dist/bin/next start apps/web --hostname :: --port ${PORT:-3000}"]
