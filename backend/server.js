const express = require("express");
const {
  createPlannerEntry,
  createTask,
  databasePath,
  deletePlannerEntry,
  deleteTask,
  getAppState,
  openDatabase,
  reorderTasks,
  setPlannerSelection,
  updatePlannerEntry,
  updateTask
} = require("./db");

const app = express();
const port = process.env.PORT || 3001;
const host = process.env.HOST || "127.0.0.1";
const db = openDatabase();
const configuredOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(function (origin) {
    return origin.trim();
  })
  .filter(Boolean);

const allowedOrigins = new Set([
  "https://shahdad.ca",
  "https://www.shahdad.ca",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  ...configuredOrigins
]);

app.use(function (request, response, next) {
  const origin = request.headers.origin;
  const isAllowedOrigin = allowedOrigins.has(origin);

  if (isAllowedOrigin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }

  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (request.method === "OPTIONS") {
    if (origin && !isAllowedOrigin) {
      response.status(403).json({
        error: "CORS origin not allowed."
      });
      return;
    }

    response.sendStatus(204);
    return;
  }

  if (origin && !isAllowedOrigin) {
    response.status(403).json({
      error: "CORS origin not allowed."
    });
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

app.post("/api/planner-entries", function (request, response) {
  try {
    const plannerEntry = createPlannerEntry(db, request.body || {});

    response.status(201).json(plannerEntry);
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not create planner entry.", error);
    response.status(500).json({
      error: "Could not create planner entry."
    });
  }
});

app.post("/api/tasks/reorder", function (request, response) {
  try {
    reorderTasks(db, request.body || {});
    response.json(getAppState(db));
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not reorder tasks.", error);
    response.status(500).json({
      error: "Could not reorder tasks."
    });
  }
});

app.patch("/api/tasks/:taskId", function (request, response) {
  try {
    updateTask(db, request.params.taskId, request.body || {});
    response.json(getAppState(db));
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not update task.", error);
    response.status(500).json({
      error: "Could not update task."
    });
  }
});

app.delete("/api/tasks/:taskId", function (request, response) {
  try {
    deleteTask(db, request.params.taskId);
    response.json(getAppState(db));
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not delete task.", error);
    response.status(500).json({
      error: "Could not delete task."
    });
  }
});

app.patch("/api/planner-state", function (request, response) {
  try {
    setPlannerSelection(db, request.body || {});
    response.json(getAppState(db));
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not update planner selection.", error);
    response.status(500).json({
      error: "Could not update planner selection."
    });
  }
});

app.patch("/api/planner-entries/:entryId", function (request, response) {
  try {
    updatePlannerEntry(db, request.params.entryId, request.body || {});
    response.json(getAppState(db));
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not update planner entry.", error);
    response.status(500).json({
      error: "Could not update planner entry."
    });
  }
});

app.delete("/api/planner-entries/:entryId", function (request, response) {
  try {
    deletePlannerEntry(db, request.params.entryId);
    response.json(getAppState(db));
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not delete planner entry.", error);
    response.status(500).json({
      error: "Could not delete planner entry."
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
