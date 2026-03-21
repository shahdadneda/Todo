const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const dataDirectoryPath = path.join(__dirname, "data");
const databasePath = path.join(dataDirectoryPath, "todo.sqlite");
const schemaPath = path.join(__dirname, "schema.sql");

function openDatabase() {
  fs.mkdirSync(dataDirectoryPath, { recursive: true });

  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(schemaPath, "utf8"));

  seedPlannerState(db);

  return db;
}

function seedPlannerState(db) {
  const insertPlannerState = db.prepare(`
    INSERT OR IGNORE INTO planner_state (section_key, active_entry_id)
    VALUES (?, NULL)
  `);

  insertPlannerState.run("weekend-goals");
  insertPlannerState.run("ess-planner");
}

function getAppState(db) {
  const generalTasks = db.prepare(`
    SELECT id, text, completed, archived
    FROM tasks
    WHERE section_key = 'general'
    ORDER BY position ASC, id DESC
  `).all().map(mapTaskRow);

  const plannerStateRows = db.prepare(`
    SELECT section_key, active_entry_id
    FROM planner_state
  `).all();

  const plannerEntries = db.prepare(`
    SELECT id, section_key, name, archived, deleted, sort_key
    FROM planner_entries
    ORDER BY sort_key DESC, id DESC
  `).all();

  const plannerTaskRows = db.prepare(`
    SELECT id, planner_entry_id, text, completed, archived
    FROM tasks
    WHERE planner_entry_id IS NOT NULL
    ORDER BY position ASC, id DESC
  `).all();

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

function createTask(db, taskInput) {
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
    `).get(plannerEntryId);

    if (!plannerEntry || plannerEntry.section_key !== sectionKey) {
      throw createHttpError(404, "Planner entry not found.");
    }

    resolvedPlannerEntryId = plannerEntry.id;
  }

  const position = getNextTaskPosition(db, sectionKey, resolvedPlannerEntryId);
  const insertTask = db.prepare(`
    INSERT INTO tasks (section_key, planner_entry_id, text, completed, archived, position)
    VALUES (?, ?, ?, 0, 0, ?)
  `);
  const insertResult = insertTask.run(sectionKey, resolvedPlannerEntryId, text, position);
  const createdTaskRow = db.prepare(`
    SELECT id, text, completed, archived
    FROM tasks
    WHERE id = ?
  `).get(insertResult.lastInsertRowid);

  return mapTaskRow(createdTaskRow);
}

function createPlannerEntry(db, plannerEntryInput) {
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
      ORDER BY id DESC
      LIMIT 1
    `).get(sectionKey, sortKey);

    if (existingEntry) {
      setActivePlannerEntry(db, sectionKey, existingEntry.id);
      return getPlannerEntryById(db, existingEntry.id);
    }
  }

  const insertPlannerEntry = db.prepare(`
    INSERT INTO planner_entries (section_key, name, archived, deleted, sort_key)
    VALUES (?, ?, 0, 0, ?)
  `);
  const insertResult = insertPlannerEntry.run(sectionKey, name, sortKey);

  setActivePlannerEntry(db, sectionKey, insertResult.lastInsertRowid);

  return getPlannerEntryById(db, insertResult.lastInsertRowid);
}

function updateTask(db, taskId, taskInput) {
  const normalizedTaskId = normalizePlannerEntryId(taskId);
  const existingTask = db.prepare(`
    SELECT id, section_key, planner_entry_id, completed, archived
    FROM tasks
    WHERE id = ?
  `).get(normalizedTaskId);

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

function deleteTask(db, taskId) {
  const normalizedTaskId = normalizePlannerEntryId(taskId);
  const deleteResult = db.prepare(`
    DELETE FROM tasks
    WHERE id = ?
  `).run(normalizedTaskId);

  if (deleteResult.changes === 0) {
    throw createHttpError(404, "Task not found.");
  }
}

function setPlannerSelection(db, selectionInput) {
  const sectionKey = typeof selectionInput.sectionKey === "string" ? selectionInput.sectionKey : "";
  const activeEntryId = normalizePlannerEntryId(selectionInput.activeEntryId);

  if (!["weekend-goals", "ess-planner"].includes(sectionKey)) {
    throw createHttpError(400, "A valid planner sectionKey is required.");
  }

  if (activeEntryId === null) {
    setActivePlannerEntry(db, sectionKey, null);
    return;
  }

  const plannerEntry = db.prepare(`
    SELECT id, section_key
    FROM planner_entries
    WHERE id = ?
  `).get(activeEntryId);

  if (!plannerEntry || plannerEntry.section_key !== sectionKey) {
    throw createHttpError(404, "Planner entry not found.");
  }

  setActivePlannerEntry(db, sectionKey, plannerEntry.id);
}

function updatePlannerEntry(db, entryId, plannerEntryInput) {
  const normalizedEntryId = normalizePlannerEntryId(entryId);
  const plannerEntry = db.prepare(`
    SELECT id, section_key, archived
    FROM planner_entries
    WHERE id = ?
  `).get(normalizedEntryId);

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
    WHERE section_key = ?
  `).get(plannerEntry.section_key);

  if (plannerState && normalizePlannerEntryId(plannerState.active_entry_id) === plannerEntry.id) {
    setActivePlannerEntry(db, plannerEntry.section_key, null);
  }
}

function deletePlannerEntry(db, entryId) {
  const normalizedEntryId = normalizePlannerEntryId(entryId);
  const plannerEntry = db.prepare(`
    SELECT id, section_key
    FROM planner_entries
    WHERE id = ?
  `).get(normalizedEntryId);

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
    WHERE section_key = ?
  `).get(plannerEntry.section_key);

  if (plannerState && normalizePlannerEntryId(plannerState.active_entry_id) === plannerEntry.id) {
    setActivePlannerEntry(db, plannerEntry.section_key, null);
  }
}

function reorderTasks(db, reorderInput) {
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
    `).get(plannerEntryId);

    if (!plannerEntry || plannerEntry.section_key !== sectionKey) {
      throw createHttpError(404, "Planner entry not found.");
    }
  }

  const scopeRows = getTaskScopeRows(db, sectionKey, plannerEntryId);
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

function getNextTaskPosition(db, sectionKey, plannerEntryId) {
  const existingPositionRow = plannerEntryId === null
    ? db.prepare(`
        SELECT MIN(position) AS min_position
        FROM tasks
        WHERE section_key = ?
          AND planner_entry_id IS NULL
      `).get(sectionKey)
    : db.prepare(`
        SELECT MIN(position) AS min_position
        FROM tasks
        WHERE planner_entry_id = ?
      `).get(plannerEntryId);

  if (!existingPositionRow || existingPositionRow.min_position === null) {
    return 0;
  }

  return existingPositionRow.min_position - 1;
}

function reorderTaskScopeForCompletion(db, sectionKey, plannerEntryId, taskId, isCompleted) {
  const taskRows = getTaskScopeRows(db, sectionKey, plannerEntryId);
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

function getTaskScopeRows(db, sectionKey, plannerEntryId) {
  return plannerEntryId === null
    ? db.prepare(`
        SELECT id, completed, archived, position
        FROM tasks
        WHERE section_key = ?
          AND planner_entry_id IS NULL
        ORDER BY position ASC, id DESC
      `).all(sectionKey)
    : db.prepare(`
        SELECT id, completed, archived, position
        FROM tasks
        WHERE planner_entry_id = ?
        ORDER BY position ASC, id DESC
      `).all(plannerEntryId);
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

function getPlannerEntryById(db, entryId) {
  const plannerEntryRow = db.prepare(`
    SELECT id, section_key, name, archived, deleted, sort_key
    FROM planner_entries
    WHERE id = ?
  `).get(entryId);

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

function setActivePlannerEntry(db, sectionKey, entryId) {
  db.prepare(`
    INSERT INTO planner_state (section_key, active_entry_id)
    VALUES (?, ?)
    ON CONFLICT(section_key) DO UPDATE SET active_entry_id = excluded.active_entry_id
  `).run(sectionKey, entryId);
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
  databasePath,
  deletePlannerEntry,
  deleteTask,
  getAppState,
  openDatabase,
  reorderTasks,
  setPlannerSelection,
  updatePlannerEntry,
  updateTask
};
