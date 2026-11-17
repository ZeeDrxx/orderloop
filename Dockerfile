FROM node:24-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# CLI (migrate / sync / probe), migrations and the mock SAP server run from source with Node's TypeScript support
COPY db ./db
COPY src/core ./src/core
COPY mock-sap ./mock-sap
USER node
EXPOSE 3000 4004
CMD ["node", "server.js"]
