# Web client only. The XFCE/TigerVNC/websocketify side of the desktop is
# assumed to already run in the pod; see README.md for how to wire the two
# together.
FROM node:22-alpine

WORKDIR /app

# Install dependencies first so the layer caches across code changes
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY client ./client

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER node

CMD ["node", "server/app.js"]