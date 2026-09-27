FROM node:24-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

ARG ACT_VERSION=0.2.89
ARG TARGETARCH
RUN set -eux; \
  case "${TARGETARCH:-amd64}" in amd64) arch=x86_64; checksum=0191d6f1f3b716b5c55820032605d05fc3c1cdbf581ebeff655019e5dd1524c0 ;; \
    arm64) arch=arm64; checksum=daa8679ba9615a74d2d0cec321dc593f21948a2a11bb65862b063d8b930f4bcb ;; \
    *) exit 1 ;; esac; \
  curl -fsSL "https://github.com/nektos/act/releases/download/v${ACT_VERSION}/act_Linux_${arch}.tar.gz" -o /tmp/act.tar.gz; \
  echo "${checksum}  /tmp/act.tar.gz" | sha256sum -c -; \
  tar -xz -f /tmp/act.tar.gz -C /usr/local/bin act; rm /tmp/act.tar.gz

WORKDIR /app
COPY scheduler/package*.json scheduler/
COPY dashboard/package*.json dashboard/
RUN npm ci --prefix scheduler && npm ci --prefix dashboard
COPY . .
RUN npm run build
EXPOSE 3001
CMD ["npm", "start", "--prefix", "scheduler"]
