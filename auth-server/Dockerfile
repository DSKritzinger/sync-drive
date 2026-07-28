FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./

USER node

EXPOSE 8787

CMD ["node", "server.js"]
