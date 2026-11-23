FROM node:20-slim
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY *.json *.bin *.js ./
EXPOSE 9000
CMD ["node", "index.js"]
