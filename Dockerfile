FROM node:20-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/"

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p data/auth_state outputs

CMD ["node", "src/index.js"]
