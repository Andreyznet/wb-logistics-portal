FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=8787 DATABASE_FILE=/app/data/portal.sqlite
EXPOSE 8787
CMD ["node", "src/server.js"]
