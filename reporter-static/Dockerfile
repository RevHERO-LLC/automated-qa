# Tiny nginx sidecar that serves the /mnt/qa-reports volume on
# qa-reports.test.revhero.io. Auto-indexes directories so testers can
# browse runs by date, then drill into report.md / report.json.
FROM nginx:1.27-alpine

COPY default.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/index.html

# /mnt/qa-reports is the shared volume — Dokploy mounts the same volume
# into both the runner and this sidecar.
VOLUME ["/mnt/qa-reports"]

EXPOSE 80
