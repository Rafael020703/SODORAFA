// Adiciona persistência de sessão via arquivo
require('dotenv').config();
const session = require('express-session');
const FileStore = require('session-file-store')(session);

module.exports = {
  sessionMiddleware: session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
  store: new FileStore({ path: './sessions', retries: 1 })
  })
};
