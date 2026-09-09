# syntax=docker/dockerfile:1
# Multi-stage build. -mod=mod resolves the SQLite dependency (and transitive
# modules) inside the builder, so no local go.sum is required. CGO is disabled
# so the binary is fully static and runs in scratch/alpine.
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -mod=mod -trimpath -ldflags="-s -w" -o /out/backend .

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/backend /usr/local/bin/backend
EXPOSE 8081
ENTRYPOINT ["backend"]
