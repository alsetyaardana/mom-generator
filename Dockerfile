FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p data/auth_state outputs

CMD ["node", "src/index.js"]
