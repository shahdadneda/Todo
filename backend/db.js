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
  getAppState,
  openDatabase
};
