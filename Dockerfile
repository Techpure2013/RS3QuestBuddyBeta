FROM node:22-alpine AS builder
WORKDIR /app

ARG GIT_COMMIT

ENV GIT_COMMIT_HASH=$GIT_COMMIT
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN node -v && npm -v
RUN npm run build

FROM nginx:stable-alpine AS web

ARG GIT_COMMIT
ENV APP_VERSION=$GIT_COMMIT

COPY nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html

RUN sed -i "s/__APP_VERSION__/${APP_VERSION}/g" /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]