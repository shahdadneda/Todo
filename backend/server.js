const express = require("express");
const {
  createPlannerEntry,
  createTask,
  createUser,
  databasePath,
  deletePlannerEntry,
  deleteTask,
  getAppState,
  getUserByInitials,
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
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-Initials");
  response.setHeader("Access-Control-Max-Age", "86400");

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

function requireUser(request, response, next) {
  const user = getUserByInitials(db, request.get("X-User-Initials") || "");

  if (!user) {
    response.status(401).json({
      error: "Sign in with your two-letter initials to continue."
    });
    return;
  }

  request.user = user;
  next();
}

["/api/tasks", "/api/planner-entries", "/api/planner-state", "/api/app-state"].forEach(function (path) {
  app.use(path, requireUser);
});

app.get("/api/health", function (request, response) {
  response.json({
    ok: true
  });
});

app.post("/api/users", function (request, response) {
  try {
    const user = createUser(db, (request.body || {}).initials);

    response.status(201).json({
      initials: user.initials
    });
  } catch (error) {
    if (error.status) {
      response.status(error.status).json({
        error: error.message
      });
      return;
    }

    console.error("Could not create user.", error);
    response.status(500).json({
      error: "Could not create the account."
    });
  }
});

app.post("/api/users/sign-in", function (request, response) {
  try {
    const rawInitials = (request.body || {}).initials;
    const user = getUserByInitials(db, typeof rawInitials === "string" ? rawInitials : "");

    if (!user) {
      const initialsLabel = typeof rawInitials === "string" && rawInitials.trim()
        ? rawInitials.trim().toUpperCase()
        : "those initials";

      response.status(404).json({
        error: `No account found for ${initialsLabel} yet. Tap Create account to claim it.`
      });
      return;
    }

    response.json({
      initials: user.initials
    });
  } catch (error) {
    console.error("Could not sign in.", error);
    response.status(500).json({
      error: "Could not sign in."
    });
  }
});

app.post("/api/tasks", function (request, response) {
  try {
    const task = createTask(db, request.user.id, request.body || {});

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
    const plannerEntry = createPlannerEntry(db, request.user.id, request.body || {});

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
    reorderTasks(db, request.user.id, request.body || {});
    response.json(getAppState(db, request.user.id));
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
    updateTask(db, request.user.id, request.params.taskId, request.body || {});
    response.json(getAppState(db, request.user.id));
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
    deleteTask(db, request.user.id, request.params.taskId);
    response.json(getAppState(db, request.user.id));
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
    setPlannerSelection(db, request.user.id, request.body || {});
    response.json(getAppState(db, request.user.id));
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
    updatePlannerEntry(db, request.user.id, request.params.entryId, request.body || {});
    response.json(getAppState(db, request.user.id));
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
    deletePlannerEntry(db, request.user.id, request.params.entryId);
    response.json(getAppState(db, request.user.id));
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
    response.json(getAppState(db, request.user.id));
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
