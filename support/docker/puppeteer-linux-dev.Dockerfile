FROM remirror/puppeteer-linux:0.0.2

RUN mkdir /remirror
WORKDIR /remirror
COPY . .
RUN yarn
