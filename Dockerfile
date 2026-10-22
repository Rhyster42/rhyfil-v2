# syntax=docker/dockerfile:1

FROM node:24-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.27-alpine AS server
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ cmd/
COPY internal/ internal/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/posd ./cmd/posd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/posd /app/posd
COPY --from=web /src/web/dist /app/web
ENV POS_ADDR=:8080 POS_WEB_DIR=/app/web
EXPOSE 8080
ENTRYPOINT ["/app/posd"]
CMD ["serve"]
