FROM node:18.15.0

COPY ./index.js ./package.json /app/
COPY ./src/* /app/src/

WORKDIR /app

RUN npm install .

COPY ./config/docker_default.json /app/config/default.json

ENV NODE_ENV=production

CMD node index.js
