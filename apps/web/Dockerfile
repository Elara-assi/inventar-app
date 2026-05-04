FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY package.json ./
COPY apps/web ./apps/web
EXPOSE 3000
CMD ["npm", "--workspace", "apps/web", "run", "dev"]
