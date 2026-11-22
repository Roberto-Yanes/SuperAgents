# Copias de seguridad: misma versión de Postgres que la base (pg_dump compatible) + openssl.
FROM pgvector/pgvector:pg16
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY backup.sh restore.sh loop.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh /usr/local/bin/loop.sh
ENTRYPOINT ["/usr/local/bin/loop.sh"]
