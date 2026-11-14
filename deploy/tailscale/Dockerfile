# Tailscale sidecar: the official image, pinned by digest, made to run as a non-root user.
# Userspace networking (no /dev/net/tun, no NET_ADMIN). The only change is a state directory
# owned by uid 10002 so the named volume initializes with that ownership.
# FROM names the image directly (no ARG) so Dependabot (.github/dependabot.yml) can update it.
FROM tailscale/tailscale:v1.104.4@sha256:ed6480b33c6eb67c9cbd203ed42b9fb57e361986725b6856def71b7a3d9e276c
RUN mkdir -p /var/lib/tailscale && chown 10002:10002 /var/lib/tailscale && chmod 700 /var/lib/tailscale
USER 10002:10002
