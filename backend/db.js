const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dataDirectoryPath = path.join(__dirname, "data");
const databasePath = path.join(dataDirectoryPath, "todo.sqlite");
const schemaPath = path.join(__dirname, "schema.sql");

const LEGACY_USER_INITIALS = "SN";
const INITIALS_PATTERN = /^[A-Z]{2}$/;

function openDatabase() {
  fs.mkdirSync(dataDirectoryPath, { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(schemaPath, "utf8"));

  migrateDatabaseToUserAccounts(db);

  return db;
}

function migrateDatabaseToUserAccounts(db) {
  if (!tableHasColumn(db, "tasks", "user_id")) {
    db.exec("ALTER TABLE tasks ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  }

  if (!tableHasColumn(db, "planner_entries", "user_id")) {
    db.exec("ALTER TABLE planner_entries ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE");
  }

  const legacyUserId = ensureLegacyUserForOrphanedData(db);

  if (!tableHasColumn(db, "planner_state", "user_id")) {
    rebuildPlannerStateForUsers(db, legacyUserId);
  }

  if (legacyUserId !== null) {
    db.prepare("UPDATE tasks SET user_id = ? WHERE user_id IS NULL").run(legacyUserId);
    db.prepare("UPDATE planner_entries SET user_id = ? WHERE user_id IS NULL").run(legacyUserId);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user_section
    ON tasks (user_id, section_key, position, id);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_planner_entries_user
    ON planner_entries (user_id, section_key, sort_key DESC, id DESC);
  `);
}

function ensureLegacyUserForOrphanedData(db) {
  const orphanCountRow = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tasks WHERE user_id IS NULL) +
      (SELECT COUNT(*) FROM planner_entries WHERE user_id IS NULL) AS orphan_count
  `).get();

  if (!orphanCountRow || orphanCountRow.orphan_count === 0) {
    return null;
  }

  const existingUser = db.prepare(`
    SELECT id FROM users WHERE initials = ?
  `).get(LEGACY_USER_INITIALS);

  if (existingUser) {
    return existingUser.id;
  }

  const insertResult = db.prepare(`
    INSERT INTO users (initials) VALUES (?)
  `).run(LEGACY_USER_INITIALS);

  return Number(insertResult.lastInsertRowid);
}

function rebuildPlannerStateForUsers(db, legacyUserId) {
  db.exec("BEGIN");

  try {
    db.exec(`
      CREATE TABLE planner_state_users (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        section_key TEXT NOT NULL CHECK (section_key IN ('weekend-goals', 'ess-planner')),
        active_entry_id INTEGER REFERENCES planner_entries(id) ON DELETE SET NULL,
        PRIMARY KEY (user_id, section_key)
      );
    `);

    if (legacyUserId !== null) {
      db.prepare(`
        INSERT INTO planner_state_users (user_id, section_key, active_entry_id)
        SELECT ?, section_key, active_entry_id
        FROM planner_state
        WHERE active_entry_id IS NOT NULL
      `).run(legacyUserId);
    }

    db.exec("DROP TABLE planner_state");
    db.exec("ALTER TABLE planner_state_users RENAME TO planner_state");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function tableHasColumn(db, tableName, columnName) {
  const columnRow = db.prepare(`
    SELECT name FROM pragma_table_info(?) WHERE name = ?
  `).get(tableName, columnName);

  return columnRow !== undefined;
}

function normalizeInitials(rawInitials) {
  if (typeof rawInitials !== "string") {
    return null;
  }

  const initials = rawInitials.trim().toUpperCase();

  return INITIALS_PATTERN.test(initials) ? initials : null;
}

function getUserByInitials(db, rawInitials) {
  const initials = normalizeInitials(rawInitials);

  if (!initials) {
    return null;
  }

  const userRow = db.prepare(`
    SELECT id, initials FROM users WHERE initials = ?
  `).get(initials);

  return userRow || null;
}

function createUser(db, rawInitials) {
  const initials = normalizeInitials(rawInitials);

  if (!initials) {
    throw createHttpError(400, "Initials must be exactly two letters (A to Z).");
  }

  const existingUser = db.prepare(`
    SELECT id FROM users WHERE initials = ?
  `).get(initials);

  if (existingUser) {
    throw createHttpError(409, `${initials} is already taken. Pick a different two-letter combo.`);
  }

  const insertResult = db.prepare(`
    INSERT INTO users (initials) VALUES (?)
  `).run(initials);

  return {
    id: Number(insertResult.lastInsertRowid),
    initials: initials
  };
}

function getAppState(db, userId) {
  const generalTasks = db.prepare(`
    SELECT id, text, completed, archived
    FROM tasks
    WHERE section_key = 'general'
      AND user_id = ?
    ORDER BY position ASC, id DESC
  `).all(userId).map(mapTaskRow);

  const plannerStateRows = db.prepare(`
    SELECT section_key, active_entry_id
    FROM planner_state
    WHERE user_id = ?
  `).all(userId);

  const plannerEntries = db.prepare(`
    SELECT id, section_key, name, archived, deleted, sort_key
    FROM planner_entries
    WHERE user_id = ?
    ORDER BY sort_key DESC, id DESC
  `).all(userId);

  const plannerTaskRows = db.prepare(`
    SELECT id, planner_entry_id, text, completed, archived
    FROM tasks
    WHERE planner_entry_id IS NOT NULL
      AND user_id = ?
    ORDER BY position ASC, id DESC
  `).all(userId);

  const activeEntryIdBySection = new Map(
    plannerStateRows.map(function (row) {
      return [row.section_key, row.active_entry_id];
    })
  );

  const tasksByEntryId = new Map();

  plannerTaskRows.forEach(function (row) {
    if (!tasksByEntryId.has(row.planner_entry_id)) {
      tasksByEntryId.set(row.planner_entry_id, []);
    }

    tasksByEntryId.get(row.planner_entry_id).push(mapTaskRow(row));
  });

  return {
    general: generalTasks,
    "weekend-goals": buildPlannerSection("weekend-goals", plannerEntries, tasksByEntryId, activeEntryIdBySection),
    "ess-planner": buildPlannerSection("ess-planner", plannerEntries, tasksByEntryId, activeEntryIdBySection)
  };
}

function createTask(db, userId, taskInput) {
  const sectionKey = typeof taskInput.sectionKey === "string" ? taskInput.sectionKey : "";
  const text = typeof taskInput.text === "string" ? taskInput.text.trim() : "";
  const plannerEntryId = normalizePlannerEntryId(taskInput.plannerEntryId);

  if (!["general", "weekend-goals", "ess-planner"].includes(sectionKey)) {
    throw createHttpError(400, "A valid sectionKey is required.");
  }

  if (!text) {
    throw createHttpError(400, "Task text is required.");
  }

  if (text.length > 120) {
    throw createHttpError(400, "Task text must be 120 characters or less.");
  }

  let resolvedPlannerEntryId = null;

  if (sectionKey === "general") {
    if (plannerEntryId !== null) {
      throw createHttpError(400, "General tasks cannot include plannerEntryId.");
    }
  } else {
    if (!Number.isInteger(plannerEntryId)) {
      throw createHttpError(400, "plannerEntryId is required for planner tasks.");
    }

    const plannerEntry = db.prepare(`
      SELECT id, section_key
      FROM planner_entries
      WHERE id = ?
        AND user_id = ?
    `).get(plannerEntryId, userId);

    if (!plannerEntry || plannerEntry.section_key !== sectionKey) {
      throw createHttpError(404, "Planner entry not found.");
    }

    resolvedPlannerEntryId = plannerEntry.id;
  }

  const position = getNextTaskPosition(db, userId, sectionKey, resolvedPlannerEntryId);
  const insertTask = db.prepare(`
    INSERT INTO tasks (user_id, section_key, planner_entry_id, text, completed, archived, position)
    VALUES (?, ?, ?, ?, 0, 0, ?)
  `);
  const insertResult = insertTask.run(userId, sectionKey, resolvedPlannerEntryId, text, position);
  const createdTaskRow = db.prepare(`
    SELECT id, text, completed, archived
    FROM tasks
    WHERE id = ?
  `).get(insertResult.lastInsertRowid);

  return mapTaskRow(createdTaskRow);
}

function createPlannerEntry(db, userId, plannerEntryInput) {
  const sectionKey = typeof plannerEntryInput.sectionKey === "string" ? plannerEntryInput.sectionKey : "";
  const name = typeof plannerEntryInput.name === "string" ? plannerEntryInput.name.trim() : "";
  const sortKey = normalizeSortKey(plannerEntryInput.sortKey);

  if (!["weekend-goals", "ess-planner"].includes(sectionKey)) {
    throw createHttpError(400, "A valid planner sectionKey is required.");
  }

  if (!name) {
    throw createHttpError(400, "Planner entry name is required.");
  }

  if (!Number.isFinite(sortKey)) {
    throw createHttpError(400, "A valid sortKey is required.");
  }

  if (sectionKey === "weekend-goals") {
    const existingEntry = db.prepare(`
      SELECT id
      FROM planner_entries
      WHERE section_key = ?
        AND sort_key = ?
        AND deleted = 0
        AND user_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(sectionKey, sortKey, userId);

    if (existingEntry) {
      setActivePlannerEntry(db, userId, sectionKey, existingEntry.id);
      return getPlannerEntryById(db, userId, existingEntry.id);
    }
  }

  const insertPlannerEntry = db.prepare(`
    INSERT INTO planner_entries (user_id, section_key, name, archived, deleted, sort_key)
    VALUES (?, ?, ?, 0, 0, ?)
  `);
  const insertResult = insertPlannerEntry.run(userId, sectionKey, name, sortKey);

  setActivePlannerEntry(db, userId, sectionKey, insertResult.lastInsertRowid);

  return getPlannerEntryById(db, userId, insertResult.lastInsertRowid);
}

function updateTask(db, userId, taskId, taskInput) {
  const normalizedTaskId = normalizePlannerEntryId(taskId);
  const existingTask = db.prepare(`
    SELECT id, section_key, planner_entry_id, completed, archived
    FROM tasks
    WHERE id = ?
      AND user_id = ?
  `).get(normalizedTaskId, userId);

  if (!existingTask) {
    throw createHttpError(404, "Task not found.");
  }

  const hasCompletedUpdate = typeof taskInput.completed === "boolean";
  const hasArchivedUpdate = typeof taskInput.archived === "boolean";

  if (!hasCompletedUpdate && !hasArchivedUpdate) {
    throw createHttpError(400, "At least one valid task field is required.");
  }

  if (hasArchivedUpdate && existingTask.section_key !== "general") {
    throw createHttpError(400, "Only General tasks can be archived.");
  }

  if (hasCompletedUpdate) {
    reorderTaskScopeForCompletion(
      db,
      userId,
      existingTask.section_key,
      existingTask.planner_entry_id,
      existingTask.id,
      taskInput.completed
    );
  }

  if (hasArchivedUpdate) {
    db.prepare(`
      UPDATE tasks
      SET archived = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(taskInput.archived ? 1 : 0, existingTask.id);
  }
}

function deleteTask(db, userId, taskId) {
  const normalizedTaskId = normalizePlannerEntryId(taskId);
  const deleteResult = db.prepare(`
    DELETE FROM tasks
    WHERE id = ?
      AND user_id = ?
  `).run(normalizedTaskId, userId);

  if (deleteResult.changes === 0) {
    throw createHttpError(404, "Task not found.");
  }
}

function setPlannerSelection(db, userId, selectionInput) {
  const sectionKey = typeof selectionInput.sectionKey === "string" ? selectionInput.sectionKey : "";
  const activeEntryId = normalizePlannerEntryId(selectionInput.activeEntryId);

  if (!["weekend-goals", "ess-planner"].includes(sectionKey)) {
    throw createHttpError(400, "A valid planner sectionKey is required.");
  }

  if (activeEntryId === null) {
    setActivePlannerEntry(db, userId, sectionKey, null);
    return;
  }

  const plannerEntry = db.prepare(`
    SELECT id, section_key
    FROM planner_entries
    WHERE id = ?
      AND user_id = ?
  `).get(activeEntryId, userId);

  if (!plannerEntry || plannerEntry.section_key !== sectionKey) {
    throw createHttpError(404, "Planner entry not found.");
  }

  setActivePlannerEntry(db, userId, sectionKey, plannerEntry.id);
}

function updatePlannerEntry(db, userId, entryId, plannerEntryInput) {
  const normalizedEntryId = normalizePlannerEntryId(entryId);
  const plannerEntry = db.prepare(`
    SELECT id, section_key, archived
    FROM planner_entries
    WHERE id = ?
      AND user_id = ?
  `).get(normalizedEntryId, userId);

  if (!plannerEntry) {
    throw createHttpError(404, "Planner entry not found.");
  }

  if (typeof plannerEntryInput.archived !== "boolean") {
    throw createHttpError(400, "A valid archived value is required.");
  }

  db.prepare(`
    UPDATE planner_entries
    SET archived = ?, deleted = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(plannerEntryInput.archived ? 1 : 0, plannerEntry.id);

  const plannerState = db.prepare(`
    SELECT active_entry_id
    FROM planner_state
    WHERE user_id = ?
      AND section_key = ?
  `).get(userId, plannerEntry.section_key);

  if (plannerState && normalizePlannerEntryId(plannerState.active_entry_id) === plannerEntry.id) {
    setActivePlannerEntry(db, userId, plannerEntry.section_key, null);
  }
}

function deletePlannerEntry(db, userId, entryId) {
  const normalizedEntryId = normalizePlannerEntryId(entryId);
  const plannerEntry = db.prepare(`
    SELECT id, section_key
    FROM planner_entries
    WHERE id = ?
      AND user_id = ?
  `).get(normalizedEntryId, userId);

  if (!plannerEntry) {
    throw createHttpError(404, "Planner entry not found.");
  }

  db.prepare(`
    DELETE FROM planner_entries
    WHERE id = ?
  `).run(plannerEntry.id);

  const plannerState = db.prepare(`
    SELECT active_entry_id
    FROM planner_state
    WHERE user_id = ?
      AND section_key = ?
  `).get(userId, plannerEntry.section_key);

  if (plannerState && normalizePlannerEntryId(plannerState.active_entry_id) === plannerEntry.id) {
    setActivePlannerEntry(db, userId, plannerEntry.section_key, null);
  }
}

function reorderTasks(db, userId, reorderInput) {
  const sectionKey = typeof reorderInput.sectionKey === "string" ? reorderInput.sectionKey : "";
  const plannerEntryId = normalizePlannerEntryId(reorderInput.plannerEntryId);
  const orderedTaskIds = Array.isArray(reorderInput.orderedTaskIds)
    ? reorderInput.orderedTaskIds.map(normalizePlannerEntryId)
    : null;
  const visibleArchived = typeof reorderInput.visibleArchived === "boolean"
    ? reorderInput.visibleArchived
    : null;

  if (!["general", "weekend-goals", "ess-planner"].includes(sectionKey)) {
    throw createHttpError(400, "A valid sectionKey is required.");
  }

  if (!Array.isArray(orderedTaskIds)) {
    throw createHttpError(400, "orderedTaskIds must be an array.");
  }

  if (sectionKey === "general") {
    if (plannerEntryId !== null) {
      throw createHttpError(400, "General reorder cannot include plannerEntryId.");
    }

    if (visibleArchived === null) {
      throw createHttpError(400, "visibleArchived is required for General reorder.");
    }
  } else {
    if (!Number.isInteger(plannerEntryId)) {
      throw createHttpError(400, "plannerEntryId is required for planner reorder.");
    }

    const plannerEntry = db.prepare(`
      SELECT id, section_key
      FROM planner_entries
      WHERE id = ?
        AND user_id = ?
    `).get(plannerEntryId, userId);

    if (!plannerEntry || plannerEntry.section_key !== sectionKey) {
      throw createHttpError(404, "Planner entry not found.");
    }
  }

  const scopeRows = getTaskScopeRows(db, userId, sectionKey, plannerEntryId);
  const reorderedRows = getReorderedTaskScopeRows(scopeRows, orderedTaskIds, visibleArchived);

  db.exec("BEGIN");

  try {
    const updateTaskPosition = db.prepare(`
      UPDATE tasks
      SET position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    reorderedRows.forEach(function (taskRow, index) {
      updateTaskPosition.run(index, taskRow.id);
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getNextTaskPosition(db, userId, sectionKey, plannerEntryId) {
  const existingPositionRow = plannerEntryId === null
    ? db.prepare(`
        SELECT MIN(position) AS min_position
        FROM tasks
        WHERE section_key = ?
          AND planner_entry_id IS NULL
          AND user_id = ?
      `).get(sectionKey, userId)
    : db.prepare(`
        SELECT MIN(position) AS min_position
        FROM tasks
        WHERE planner_entry_id = ?
          AND user_id = ?
      `).get(plannerEntryId, userId);

  if (!existingPositionRow || existingPositionRow.min_position === null) {
    return 0;
  }

  return existingPositionRow.min_position - 1;
}

function reorderTaskScopeForCompletion(db, userId, sectionKey, plannerEntryId, taskId, isCompleted) {
  const taskRows = getTaskScopeRows(db, userId, sectionKey, plannerEntryId);
  const reorderedRows = getReorderedTaskRows(taskRows, taskId, isCompleted);

  db.exec("BEGIN");

  try {
    const updateTaskRow = db.prepare(`
      UPDATE tasks
      SET completed = ?, position = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    reorderedRows.forEach(function (taskRow, index) {
      updateTaskRow.run(taskRow.completed ? 1 : 0, index, taskRow.id);
    });

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getTaskScopeRows(db, userId, sectionKey, plannerEntryId) {
  return plannerEntryId === null
    ? db.prepare(`
        SELECT id, completed, archived, position
        FROM tasks
        WHERE section_key = ?
          AND planner_entry_id IS NULL
          AND user_id = ?
        ORDER BY position ASC, id DESC
      `).all(sectionKey, userId)
    : db.prepare(`
        SELECT id, completed, archived, position
        FROM tasks
        WHERE planner_entry_id = ?
          AND user_id = ?
        ORDER BY position ASC, id DESC
      `).all(plannerEntryId, userId);
}

function getReorderedTaskScopeRows(taskRows, orderedTaskIds, visibleArchived) {
  const taskRowById = new Map(
    taskRows.map(function (taskRow) {
      return [taskRow.id, taskRow];
    })
  );
  const visibleTaskRows = visibleArchived === null
    ? taskRows
    : taskRows.filter(function (taskRow) {
        return Boolean(taskRow.archived) === visibleArchived;
      });

  if (orderedTaskIds.length !== visibleTaskRows.length) {
    throw createHttpError(400, "orderedTaskIds does not match the visible task list.");
  }

  const visibleTaskIdSet = new Set(
    visibleTaskRows.map(function (taskRow) {
      return taskRow.id;
    })
  );

  if (new Set(orderedTaskIds).size !== orderedTaskIds.length) {
    throw createHttpError(400, "orderedTaskIds must not contain duplicates.");
  }

  const reorderedVisibleRows = orderedTaskIds.map(function (taskId) {
    if (!visibleTaskIdSet.has(taskId)) {
      throw createHttpError(400, "orderedTaskIds contains an invalid task id.");
    }

    return taskRowById.get(taskId);
  });
  const hiddenRows = visibleArchived === null
    ? []
    : taskRows.filter(function (taskRow) {
        return !visibleTaskIdSet.has(taskRow.id);
      });

  return reorderedVisibleRows.concat(hiddenRows);
}

function getReorderedTaskRows(taskRows, taskId, isCompleted) {
  const normalizedTaskId = normalizePlannerEntryId(taskId);
  const updatedTask = taskRows.find(function (taskRow) {
    return taskRow.id === normalizedTaskId;
  });

  if (!updatedTask) {
    throw createHttpError(404, "Task not found.");
  }

  const remainingTasks = taskRows.filter(function (taskRow) {
    return taskRow.id !== normalizedTaskId;
  });
  const nextTask = {
    ...updatedTask,
    completed: Boolean(isCompleted)
  };

  if (!isCompleted) {
    return [nextTask].concat(remainingTasks);
  }

  const firstCompletedIndex = remainingTasks.findIndex(function (taskRow) {
    return Boolean(taskRow.completed);
  });

  if (firstCompletedIndex === -1) {
    return remainingTasks.concat(nextTask);
  }

  remainingTasks.splice(firstCompletedIndex, 0, nextTask);
  return remainingTasks;
}

function getPlannerEntryById(db, userId, entryId) {
  const plannerEntryRow = db.prepare(`
    SELECT id, section_key, name, archived, deleted, sort_key
    FROM planner_entries
    WHERE id = ?
      AND user_id = ?
  `).get(entryId, userId);

  if (!plannerEntryRow) {
    return null;
  }

  const taskRows = db.prepare(`
    SELECT id, text, completed, archived
    FROM tasks
    WHERE planner_entry_id = ?
    ORDER BY position ASC, id DESC
  `).all(entryId);

  return mapPlannerEntryRow(plannerEntryRow, taskRows.map(mapTaskRow));
}

function setActivePlannerEntry(db, userId, sectionKey, entryId) {
  db.prepare(`
    INSERT INTO planner_state (user_id, section_key, active_entry_id)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id, section_key) DO UPDATE SET active_entry_id = excluded.active_entry_id
  `).run(userId, sectionKey, entryId);
}

function normalizePlannerEntryId(plannerEntryId) {
  if (plannerEntryId === null || plannerEntryId === undefined || plannerEntryId === "") {
    return null;
  }

  if (typeof plannerEntryId === "number" && Number.isInteger(plannerEntryId)) {
    return plannerEntryId;
  }

  if (typeof plannerEntryId === "string" && /^\d+$/.test(plannerEntryId)) {
    return Number(plannerEntryId);
  }

  return plannerEntryId;
}

function normalizeSortKey(sortKey) {
  if (typeof sortKey === "number" && Number.isFinite(sortKey)) {
    return sortKey;
  }

  if (typeof sortKey === "string" && sortKey.trim() !== "") {
    const numericSortKey = Number(sortKey);

    if (Number.isFinite(numericSortKey)) {
      return numericSortKey;
    }
  }

  return Number.NaN;
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function buildPlannerSection(sectionKey, plannerEntries, tasksByEntryId, activeEntryIdBySection) {
  const entries = plannerEntries
    .filter(function (entry) {
      return entry.section_key === sectionKey;
    })
    .map(function (entry) {
      return {
        id: entry.id,
        name: entry.name,
        tasks: tasksByEntryId.get(entry.id) || [],
        archived: Boolean(entry.archived),
        deleted: Boolean(entry.deleted),
        sortKey: entry.sort_key
      };
    });

  return {
    entries: entries,
    activeEntryId: activeEntryIdBySection.get(sectionKey) ?? null
  };
}

function mapPlannerEntryRow(row, tasks) {
  return {
    id: row.id,
    name: row.name,
    tasks: Array.isArray(tasks) ? tasks : [],
    archived: Boolean(row.archived),
    deleted: Boolean(row.deleted),
    sortKey: row.sort_key
  };
}

function mapTaskRow(row) {
  return {
    id: row.id,
    text: row.text,
    completed: Boolean(row.completed),
    archived: Boolean(row.archived)
  };
}

module.exports = {
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
};
