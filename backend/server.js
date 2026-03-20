const express = require("express");
const { createTask, databasePath, getAppState, openDatabase } = require("./db");

const app = express();
const port = process.env.PORT || 3001;
const host = process.env.HOST || "127.0.0.1";
const db = openDatabase();

app.use(function (request, response, next) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json());

app.get("/api/health", function (request, response) {
  response.json({
    ok: true
  });
});

app.post("/api/tasks", function (request, response) {
  try {
    const task = createTask(db, request.body || {});

    response.status(201).json(task);
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not create task.", error);
    response.status(500).json({
      error: "Could not create task."
    });
  }
});

app.get("/api/app-state", function (request, response) {
  try {
    response.json(getAppState(db));
  } catch (error) {
    console.error("Could not load app state.", error);
    response.status(500).json({
      error: "Could not load app state."
    });
  }
});

app.listen(port, host, function () {
  console.log(`Backend listening on http://${host}:${port}`);
  console.log(`SQLite database file: ${databasePath}`);
});
