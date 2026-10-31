# Trustwork single-origin reverse proxy image (OPS-002): Caddy with infra/proxy/Caddyfile, non-root, no state.
#   docker build -f infra/proxy/Dockerfile -t trustwork-proxy .
# Upstreams and the listen port are runtime variables (see the Caddyfile header); nothing secret is baked in.
# The binary is copied onto plain Alpine without the file capability (cap_net_bind_service) the Caddy image sets: the
# proxy listens on an unprivileged port, so it runs with every capability dropped.
ARG CADDY_IMAGE=caddy:2.11.4-alpine
ARG RUNTIME_IMAGE=alpine:3.24

FROM ${CADDY_IMAGE} AS caddy
# A plain copy drops the security.capability extended attribute; COPY --from alone would keep it.
RUN cp /usr/bin/caddy /caddy

FROM ${RUNTIME_IMAGE}
RUN addgroup -g 1000 -S trustwork && adduser -u 1000 -S -G trustwork -H -h /tmp trustwork
COPY --from=caddy --chmod=0755 /caddy /usr/bin/caddy
COPY infra/proxy/Caddyfile /etc/caddy/Caddyfile
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data TRUSTWORK_PROXY_PORT=8080
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --start-interval=2s --retries=3 \
  CMD ["sh", "-c", "wget -q -O /dev/null \"http://127.0.0.1:${TRUSTWORK_PROXY_PORT}/proxy/health\""]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
