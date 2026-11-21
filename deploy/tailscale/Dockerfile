# Tailscale sidecar: the official image, pinned by digest, made to run as a non-root user.
# Userspace networking (no /dev/net/tun, no NET_ADMIN). The only change is a state directory
# owned by uid 10002 so the named volume initializes with that ownership.
# FROM names the image directly (no ARG) so Dependabot (.github/dependabot.yml) can update it.
FROM tailscale/tailscale:v1.104.7@sha256:72c1e19e0aedca96b8533bbb0b4368564410ff20b17e53b804eb6c1f04a31be4
RUN mkdir -p /var/lib/tailscale && chown 10002:10002 /var/lib/tailscale && chmod 700 /var/lib/tailscale
USER 10002:10002
