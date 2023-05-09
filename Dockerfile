FROM node:18.15.0

COPY ./index.js ./package.json ./src /app/

WORKDIR /app

RUN npm install .

COPY ./config/docker_default.json /app/config/default.json

ENV NODE_ENV=production

CMD node index.js
