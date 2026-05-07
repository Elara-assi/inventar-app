FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM node:24-alpine AS runner
WORKDIR /app
ARG NEXT_PUBLIC_API_URL=http://localhost:8000
ARG NEXT_PUBLIC_APP_VERSION=unbekannt
ENV NODE_ENV=production
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_VERSION=$NEXT_PUBLIC_APP_VERSION
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps/web ./apps/web
RUN npm --workspace apps/web run build
EXPOSE 3000
CMD ["npm", "--workspace", "apps/web", "run", "start"]
