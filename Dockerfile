FROM node

COPY . /app

WORKDIR /app

CMD node index.js
