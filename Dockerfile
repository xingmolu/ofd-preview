# Simple production image
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build
ENV NODE_ENV=production
ENV PORT=3000
ENV OFD_ROOT=/data
EXPOSE 3000
CMD ["node", "dist/main.js"]
