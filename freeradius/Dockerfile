FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    freeradius freeradius-mysql && rm -rf /var/lib/apt/lists/*
COPY mods-available/sql /etc/freeradius/3.0/mods-available/sql
COPY sites-available/portal /etc/freeradius/3.0/sites-available/portal
COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh && ln -s ../mods-available/sql /etc/freeradius/3.0/mods-enabled/sql \
    && ln -s ../sites-available/portal /etc/freeradius/3.0/sites-enabled/portal \
    && rm -f /etc/freeradius/3.0/sites-enabled/default /etc/freeradius/3.0/sites-enabled/inner-tunnel
EXPOSE 1812/udp 1813/udp
ENTRYPOINT ["/entrypoint.sh"]
