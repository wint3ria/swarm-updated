FROM node

COPY . /app

WORKDIR /app

CMD NODE_ENV=production node index.js
