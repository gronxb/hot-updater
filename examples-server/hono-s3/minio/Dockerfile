FROM golang:1.24.7-alpine3.22 AS build

# MinIO RELEASE.2025-09-07T16-13-09Z; upstream images are no longer public.
RUN CGO_ENABLED=0 GOBIN=/out go install github.com/minio/minio@07c3a429bfed433e49018cb0f78a52145d4bedeb

FROM alpine:3.22.1
RUN apk add --no-cache ca-certificates
COPY --from=build /out/minio /usr/local/bin/minio
ENTRYPOINT ["minio"]
