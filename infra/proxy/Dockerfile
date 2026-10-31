# Trustwork single-origin reverse proxy image (OPS-002): Caddy with infra/proxy/Caddyfile, non-root, no state.
#   docker build -f infra/proxy/Dockerfile -t trustwork-proxy .
# Upstreams and the listen port are runtime variables (see the Caddyfile header); nothing secret is baked in.
FROM caddy:2.11.4-alpine
COPY infra/proxy/Caddyfile /etc/caddy/Caddyfile
ENV XDG_CONFIG_HOME=/tmp/caddy-config XDG_DATA_HOME=/tmp/caddy-data TRUSTWORK_PROXY_PORT=8080
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --start-interval=2s --retries=3 \
  CMD ["sh", "-c", "wget -q -O /dev/null \"http://127.0.0.1:${TRUSTWORK_PROXY_PORT}/proxy/health\""]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
