FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY config ./config
COPY public ./public
COPY src ./src

RUN mkdir -p /app/data

ENV HOST=0.0.0.0 \
    PORT=8787 \
    DATA_FILE=/app/data/arena-tracker.sqlite

EXPOSE 8787
VOLUME ["/app/data"]

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
