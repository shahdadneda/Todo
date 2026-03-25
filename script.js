const SECTION_STORAGE_KEY = "shahdad-todo-active-section";
const API_BASE_URL = "https://server.shahdad.ca/api";
const APP_STATE_API_URL = `${API_BASE_URL}/app-state`;
const TASKS_API_URL = `${API_BASE_URL}/tasks`;
const TASK_REORDER_API_URL = `${API_BASE_URL}/tasks/reorder`;
const PLANNER_ENTRIES_API_URL = `${API_BASE_URL}/planner-entries`;
const PLANNER_STATE_API_URL = `${API_BASE_URL}/planner-state`;
const APP_STATE_POLL_INTERVAL_MS = 5000;
const GENERAL_SECTION_KEY = "general";
const WEEKEND_SECTION_KEY = "weekend-goals";
const ESS_SECTION_KEY = "ess-planner";
const PLANNER_SECTION_KEYS = [WEEKEND_SECTION_KEY, ESS_SECTION_KEY];
const PLANNER_SECTION_KEY_SET = new Set(PLANNER_SECTION_KEYS);
const SECTION_CONFIG = {
  [GENERAL_SECTION_KEY]: {
    title: "General",
    archiveButtonLabel: "Archives",
    archiveEmptyMessage: "No archived General tasks yet.",
    archiveNoSelectionMessage: "No archived General tasks yet."
  },
  [WEEKEND_SECTION_KEY]: {
    title: "Weekend Goals",
    createButtonLabel: "New Weekend Entry",
    archiveButtonLabel: "Archives",
    datePickerLabel: "Choose a weekend entry date",
    emptyPlannerMessage: "No weekend entries yet. Create one for an upcoming weekend.",
    selectionPrompt: "Choose a weekend to start planning.",
    noSelectionMessage: "Select a weekend first",
    noEntryMessage: "Create a weekend entry first",
    taskEmptyMessage: "No tasks for this weekend yet.",
    legacyEntryName: "Existing Weekend Goals",
    archiveEmptyMessage: "No archived weekend entries yet.",
    archiveSelectionPrompt: "Choose an archived weekend entry to view its tasks.",
    archiveNoSelectionMessage: "Select an archived weekend entry",
    archiveNoEntryMessage: "No archived weekend entries yet."
  },
  [ESS_SECTION_KEY]: {
    title: "ESS planner",
    createButtonLabel: "New ESS Entry",
    archiveButtonLabel: "Archives",
    datePickerLabel: "Choose an ESS entry date",
    emptyPlannerMessage: "No ESS planner entries yet. Create one for your next Tuesday or Thursday.",
    selectionPrompt: "Choose an ESS entry to start planning.",
    noSelectionMessage: "Select an ESS day first",
    noEntryMessage: "Create an ESS entry first",
    taskEmptyMessage: "No tasks for this ESS entry yet.",
    legacyEntryName: "Existing ESS Planner",
    archiveEmptyMessage: "No archived ESS entries yet.",
    archiveSelectionPrompt: "Choose an archived ESS entry to view its tasks.",
    archiveNoSelectionMessage: "Select an archived ESS entry",
    archiveNoEntryMessage: "No archived ESS entries yet."
  }
};

const todoForm = document.getElementById("todo-form");
const todoCard = document.querySelector(".todo-card");
const taskArea = document.getElementById("task-area");
const taskInput = document.getElementById("task-input");
const todoSubmitButton = todoForm.querySelector('button[type="submit"]');
const todoArchiveToggle = document.getElementById("todo-archive-toggle");
const taskList = document.getElementById("task-list");
const emptyState = document.getElementById("empty-state");
const formMessage = document.getElementById("form-message");
const todoHeading = document.getElementById("todo-heading");
const todoContext = document.getElementById("todo-context");
const sectionLinks = Array.from(document.querySelectorAll(".section-link"));
const plannerShell = document.getElementById("planner-shell");
const plannerCreateButton = document.getElementById("planner-create-button");
const plannerArchiveToggle = document.getElementById("planner-archive-toggle");
const plannerEntryList = document.getElementById("planner-entry-list");
const plannerEmptyMessage = document.getElementById("planner-empty-message");
const plannerDatePickerShell = document.getElementById("planner-date-picker-shell");
const plannerDatePicker = document.getElementById("planner-date-picker");
const plannerDatePickerTitle = document.getElementById("planner-date-picker-title");
const plannerDatePickerGrid = document.getElementById("planner-date-picker-grid");
const MONTH_TITLE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric"
});
const ENTRY_MONTH_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short"
});
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_INDEX_BY_LABEL = MONTH_LABELS.reduce(function (monthLookup, monthLabel, index) {
  monthLookup[monthLabel] = index;
  return monthLookup;
}, {});
const ENTRY_ARIA_LABEL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric"
});

let activeSection = loadActiveSection();
let tasksBySection = createEmptySections();
let draggedTaskId = null;
let dropIndicatorTaskId = null;
let isPlannerDatePickerOpen = false;
let plannerCalendarMonth = getStartOfMonth(new Date());
let archiveViewBySection = createArchiveViewState();
let isAppLoading = true;
let appLoadErrorMessage = "";
let isTaskCreationPending = false;
let isPlannerEntryCreationPending = false;
let lastAppStateSignature = "";
let appStatePollIntervalId = null;
let isAppStatePollInFlight = false;

renderSectionState();
renderPlannerControls();
renderTasks();
renderPlannerDatePicker();
initializeApp();
startAppStatePolling();

todoArchiveToggle.addEventListener("click", function () {
  if (activeSection !== GENERAL_SECTION_KEY) {
    return;
  }

  setArchiveView(GENERAL_SECTION_KEY, !isArchiveView(GENERAL_SECTION_KEY));
  renderSectionState();
  formMessage.textContent = "";
  renderTasks();
});

todoForm.addEventListener("submit", async function (event) {
  event.preventDefault();

  if (activeSection === GENERAL_SECTION_KEY && isArchiveView(GENERAL_SECTION_KEY)) {
    formMessage.textContent = "Leave Archives to add a new task.";
    return;
  }

  if (!canManageCurrentTasks()) {
    formMessage.textContent = getPlannerSelectionMessage();
    return;
  }

  const taskText = taskInput.value.trim();

  if (!taskText) {
    formMessage.textContent = "Please type a task before adding it.";
    return;
  }

  if (isTaskCreationPending) {
    return;
  }

  const activePlannerEntry = isPlannerSection(activeSection) ? getActivePlannerEntry() : null;

  if (activePlannerEntry && typeof activePlannerEntry.id !== "number") {
    formMessage.textContent = "This planner entry is not saved to the backend yet.";
    return;
  }

  isTaskCreationPending = true;
  updateTaskComposerState(canManageCurrentTasks());
  formMessage.textContent = "";

  try {
    const createdTask = await createTaskOnApi({
      sectionKey: activeSection,
      text: taskText,
      plannerEntryId: activePlannerEntry ? activePlannerEntry.id : null
    });
    const nextTasks = [createdTask].concat(getCurrentTasks());

    applyCurrentTasks(nextTasks);
    renderTasks();
    todoForm.reset();
    taskInput.focus();
    formMessage.textContent = "";
  } catch (error) {
    console.error("Could not create task.", error);
    formMessage.textContent = error.message || "Could not add the task.";
  } finally {
    isTaskCreationPending = false;
    updateTaskComposerState(canManageCurrentTasks());
  }
});

taskList.addEventListener("click", function (event) {
  const archiveButton = event.target.closest(".task-archive");

  if (archiveButton) {
    const taskId = Number(archiveButton.dataset.id);
    const taskToToggle = getCurrentTasks().find(function (task) {
      return task.id === taskId;
    });

    if (!taskToToggle) {
      return;
    }

    animateTaskExit(taskId, async function () {
      try {
        await mutateAppStateOnApi(`${TASKS_API_URL}/${taskId}`, {
          method: "PATCH",
          body: {
            archived: !taskToToggle.archived
          }
        });
        renderTasks();
        formMessage.textContent = "";
      } catch (error) {
        console.error("Could not update task archive state.", error);
        renderTasks();
        formMessage.textContent = error.message || "Could not update the task.";
      }
    });
    return;
  }

  const deleteButton = event.target.closest(".task-delete");

  if (deleteButton) {
    const taskId = Number(deleteButton.dataset.id);

    animateTaskExit(taskId, async function () {
      try {
        await mutateAppStateOnApi(`${TASKS_API_URL}/${taskId}`, {
          method: "DELETE"
        });
        renderTasks();
        formMessage.textContent = "";
      } catch (error) {
        console.error("Could not delete task.", error);
        renderTasks();
        formMessage.textContent = error.message || "Could not delete the task.";
      }
    });
  }
});

taskList.addEventListener("change", async function (event) {
  if (!event.target.classList.contains("task-checkbox")) {
    return;
  }

  const previousPositions = getTaskPositions();
  const taskId = Number(event.target.dataset.id);
  const isCompleted = event.target.checked;

  try {
    await mutateAppStateOnApi(`${TASKS_API_URL}/${taskId}`, {
      method: "PATCH",
      body: {
        completed: isCompleted
      }
    });
    renderTasks(previousPositions);
    formMessage.textContent = "";
  } catch (error) {
    console.error("Could not update task completion.", error);
    renderTasks();
    formMessage.textContent = error.message || "Could not update the task.";
  }
});

sectionLinks.forEach(function (link) {
  link.addEventListener("click", function () {
    const nextSection = link.dataset.section;

    if (!SECTION_CONFIG[nextSection] || nextSection === activeSection) {
      return;
    }

    activeSection = nextSection;
    resetDragState();
    formMessage.textContent = "";
    saveActiveSection();
    renderSectionState();
    renderPlannerControls();
    renderTasks();

    if (canManageCurrentTasks()) {
      taskInput.focus();
    }
  });
});

plannerCreateButton.addEventListener("click", function () {
  if (isPlannerEntryCreationPending) {
    return;
  }

  if (isPlannerDatePickerOpen) {
    closePlannerDatePicker();
    return;
  }

  plannerCalendarMonth = getStartOfMonth(new Date());
  renderPlannerDatePicker();
  openPlannerDatePicker();
});

plannerArchiveToggle.addEventListener("click", function () {
  if (!supportsPlannerArchives(activeSection)) {
    return;
  }

  setArchiveView(activeSection, !isArchiveView(activeSection));
  closePlannerDatePicker();
  formMessage.textContent = "";
  renderSectionState();
  renderPlannerControls();
  renderTasks();
});

plannerEntryList.addEventListener("click", function (event) {
  const archiveButton = event.target.closest(".planner-entry-archive");

  if (archiveButton) {
    const entryId = archiveButton.dataset.entryId;
    const entryToToggle = findPlannerEntryById(activeSection, entryId);

    if (!entryToToggle) {
      return;
    }

    animatePlannerEntryExit(entryId, async function () {
      try {
        await mutateAppStateOnApi(`${PLANNER_ENTRIES_API_URL}/${entryId}`, {
          method: "PATCH",
          body: {
            archived: !entryToToggle.archived
          }
        });
        formMessage.textContent = "";
        renderSectionState();
        renderPlannerControls();
        renderTasks();
      } catch (error) {
        console.error("Could not update planner entry.", error);
        renderSectionState();
        renderPlannerControls();
        renderTasks();
        formMessage.textContent = error.message || "Could not update the planner entry.";
      }
    });
    return;
  }

  const deleteButton = event.target.closest(".planner-entry-delete");

  if (deleteButton) {
    const entryIdToDelete = deleteButton.dataset.entryId;
    animatePlannerEntryExit(entryIdToDelete, async function () {
      try {
        await mutateAppStateOnApi(`${PLANNER_ENTRIES_API_URL}/${entryIdToDelete}`, {
          method: "DELETE"
        });
        resetDragState();
        formMessage.textContent = "";
        renderSectionState();
        renderPlannerControls();
        renderTasks();
      } catch (error) {
        console.error("Could not delete planner entry.", error);
        renderSectionState();
        renderPlannerControls();
        renderTasks();
        formMessage.textContent = error.message || "Could not delete the planner entry.";
      }
    });
    return;
  }

  const entryButton = event.target.closest(".planner-entry-button");

  if (!entryButton) {
    return;
  }

  const nextEntryId = entryButton.dataset.entryId;
  const planner = getPlannerData();
  const nextEntry = findPlannerEntryById(activeSection, nextEntryId);

  if (!nextEntry || areIdsEqual(planner.activeEntryId, nextEntry.id)) {
    return;
  }

  selectPlannerEntry(activeSection, nextEntry.id)
    .then(function () {
      resetDragState();
      formMessage.textContent = "";
      renderSectionState();
      renderPlannerControls();
      renderTasks();
      taskInput.focus();
    })
    .catch(function (error) {
      console.error("Could not select planner entry.", error);
      formMessage.textContent = error.message || "Could not select the planner entry.";
    });
});

plannerDatePicker.addEventListener("click", async function (event) {
  const navButton = event.target.closest(".planner-date-picker-nav-button");

  if (navButton) {
    plannerCalendarMonth = getStartOfMonth(
      createCalendarDate(
        plannerCalendarMonth.getFullYear(),
        plannerCalendarMonth.getMonth() + (navButton.dataset.calendarNav === "next" ? 1 : -1),
        1
      )
    );
    renderPlannerDatePicker();
    return;
  }

  const dayButton = event.target.closest(".planner-date-picker-day");

  if (!dayButton) {
    return;
  }

  if (dayButton.disabled) {
    return;
  }

  const selectedDate = createDateFromIso(dayButton.dataset.date);

  if (!selectedDate) {
    return;
  }

  let didCreatePlannerEntry = false;

  try {
    didCreatePlannerEntry = await createPlannerEntryFromDate(activeSection, selectedDate);
  } catch (error) {
    console.error("Could not create planner entry.", error);
    formMessage.textContent = error.message || "Could not create planner entry.";
    renderSectionState();
    renderPlannerControls();
    renderTasks();
    return;
  }

  if (!didCreatePlannerEntry) {
    return;
  }

  closePlannerDatePicker();
  formMessage.textContent = "";
  renderSectionState();
  renderPlannerControls();
  renderTasks();
  taskInput.focus();
});

document.addEventListener("click", function (event) {
  if (
    !isPlannerDatePickerOpen ||
    !plannerDatePickerShell ||
    plannerDatePickerShell.contains(event.target)
  ) {
    return;
  }

  closePlannerDatePicker();
});

document.addEventListener("keydown", function (event) {
  if (event.key !== "Escape" || !isPlannerDatePickerOpen) {
    return;
  }

  closePlannerDatePicker();
  plannerCreateButton.focus();
});

taskList.addEventListener("dragstart", function (event) {
  const draggedItem = event.target.closest(".task-item");

  if (!draggedItem || event.target.closest(".task-checkbox, .task-delete")) {
    event.preventDefault();
    return;
  }

  draggedTaskId = draggedItem.dataset.taskId;
  draggedItem.classList.add("is-dragging");

  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggedTaskId);
  }
});

taskList.addEventListener("dragover", function (event) {
  if (!draggedTaskId) {
    return;
  }

  event.preventDefault();

  const draggedItem = taskList.querySelector(`[data-task-id="${draggedTaskId}"]`);

  if (!draggedItem) {
    return;
  }

  const nextItem = getDragAfterElement(event.clientY);
  updateDropIndicator(nextItem);

  if (!nextItem) {
    animateTaskShift(function () {
      taskList.appendChild(draggedItem);
    });
    return;
  }

  if (nextItem !== draggedItem) {
    animateTaskShift(function () {
      taskList.insertBefore(draggedItem, nextItem);
    });
  }
});

taskList.addEventListener("drop", async function (event) {
  if (!draggedTaskId) {
    return;
  }

  event.preventDefault();
  clearDropIndicator();

  try {
    await syncTasksToDomOrder();
    formMessage.textContent = "";
  } catch (error) {
    console.error("Could not reorder tasks.", error);
    renderTasks();
    formMessage.textContent = error.message || "Could not reorder the tasks.";
  }
});

taskList.addEventListener("dragend", function () {
  const draggedItem = taskList.querySelector(".task-item.is-dragging");

  if (draggedItem) {
    draggedItem.classList.remove("is-dragging");
  }

  clearDropIndicator();
  draggedTaskId = null;
});

function renderTasks(previousPositions) {
  taskList.innerHTML = "";
  renderGeneralArchiveToggle();

  if (isAppLoading) {
    updateTaskComposerState(false);
    updateTaskCount([]);
    emptyState.querySelector("p").textContent = "Loading tasks...";
    emptyState.classList.remove("is-hidden");
    return;
  }

  if (appLoadErrorMessage) {
    updateTaskComposerState(false);
    updateTaskCount([]);
    emptyState.querySelector("p").textContent = appLoadErrorMessage;
    emptyState.classList.remove("is-hidden");
    return;
  }

  const currentTasks = getVisibleTasks();
  const hasPlannerEntry = canManageCurrentTasks();

  updateTaskComposerState(hasPlannerEntry);

  if (!hasPlannerEntry) {
    updateTaskCount(currentTasks);
    emptyState.querySelector("p").textContent = getPlannerSelectionMessage();
    emptyState.classList.remove("is-hidden");
    return;
  }

  currentTasks.forEach(function (task) {
    const listItem = document.createElement("li");
    listItem.className = "task-item";
    listItem.dataset.taskId = String(task.id);
    listItem.draggable = true;

    if (task.completed) {
      listItem.classList.add("completed");
    }

    const taskActionsMarkup =
      activeSection === GENERAL_SECTION_KEY
        ? `
          <div class="task-actions">
            <button
              class="task-archive planner-entry-archive${task.archived ? " is-archived" : ""}"
              type="button"
              data-id="${task.id}"
              aria-label="${task.archived ? "Unarchive" : "Archive"} ${escapeHtml(task.text)}"
              title="${task.archived ? "Unarchive" : "Archive"}"
            >
              ${task.archived ? getCheckIconMarkup() : getArchiveIconMarkup()}
            </button>
            <button class="task-delete" type="button" data-id="${task.id}">
              Delete
            </button>
          </div>
        `
        : `
          <button class="task-delete" type="button" data-id="${task.id}">
            Delete
          </button>
        `;

    listItem.innerHTML = `
      <label class="task-main">
        <span class="task-toggle">
          <input
            class="task-checkbox"
            type="checkbox"
            data-id="${task.id}"
            ${task.completed ? "checked" : ""}
            aria-label="Mark ${escapeHtml(task.text)} as complete"
          />
          <span class="task-checkmark" aria-hidden="true"></span>
        </span>
        <span class="task-text">${escapeHtml(task.text)}</span>
      </label>
      ${taskActionsMarkup}
    `;

    taskList.appendChild(listItem);
  });

  emptyState.querySelector("p").textContent = getEmptyStateMessage();
  emptyState.classList.toggle("is-hidden", currentTasks.length > 0);

  if (previousPositions) {
    animateTaskReorder(previousPositions);
  }
}

function updateTaskCount(taskItems) {
  const taskCount = document.getElementById("task-count");

  if (!taskCount) {
    return;
  }

  const remainingTasks = taskItems.filter(function (task) {
    return !task.completed;
  }).length;

  taskCount.textContent = String(remainingTasks);
}

async function initializeApp() {
  try {
    tasksBySection = await loadTasksBySectionFromApi();
    lastAppStateSignature = getAppStateSignature(tasksBySection);
    appLoadErrorMessage = "";
  } catch (error) {
    console.error("Could not load tasks from backend.", error);
    tasksBySection = createEmptySections();
    lastAppStateSignature = getAppStateSignature(tasksBySection);
    appLoadErrorMessage = `Could not load tasks from the backend. Make sure the backend is running on ${API_BASE_URL.replace(/\/api$/, "")}.`;
  } finally {
    isAppLoading = false;
    renderSectionState();
    renderPlannerControls();
    renderTasks();
    formMessage.textContent = appLoadErrorMessage;
  }
}

async function loadTasksBySectionFromApi() {
  const response = await fetch(APP_STATE_API_URL, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}.`);
  }

  const parsedTasks = await response.json();
  const emptySections = createEmptySections();

  if (!parsedTasks || typeof parsedTasks !== "object") {
    return emptySections;
  }

  return normalizeSections({
    ...emptySections,
    ...parsedTasks
  });
}

function replaceAppState(nextAppState) {
  tasksBySection = normalizeSections({
    ...createEmptySections(),
    ...(nextAppState && typeof nextAppState === "object" ? nextAppState : {})
  });
  lastAppStateSignature = getAppStateSignature(tasksBySection);
}

function startAppStatePolling() {
  if (appStatePollIntervalId) {
    return;
  }

  appStatePollIntervalId = window.setInterval(function () {
    void refreshAppStateFromApi();
  }, APP_STATE_POLL_INTERVAL_MS);
}

async function refreshAppStateFromApi() {
  if (isAppStatePollInFlight || draggedTaskId) {
    return;
  }

  isAppStatePollInFlight = true;

  try {
    const nextAppState = await loadTasksBySectionFromApi();
    const nextSignature = getAppStateSignature(nextAppState);

    if (
      nextSignature === lastAppStateSignature &&
      !isAppLoading &&
      !appLoadErrorMessage
    ) {
      return;
    }

    tasksBySection = nextAppState;
    lastAppStateSignature = nextSignature;
    isAppLoading = false;
    appLoadErrorMessage = "";
    renderSectionState();
    renderPlannerControls();
    renderTasks();
  } catch (error) {
    if (isAppLoading) {
      appLoadErrorMessage = `Could not load tasks from the backend. Make sure the backend is running on ${API_BASE_URL.replace(/\/api$/, "")}.`;
      renderSectionState();
      renderPlannerControls();
      renderTasks();
    }

    console.error("Could not refresh app state.", error);
  } finally {
    isAppStatePollInFlight = false;
  }
}

async function createTaskOnApi(taskPayload) {
  const response = await fetch(TASKS_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(taskPayload)
  });

  const responseData = await response.json().catch(function () {
    return null;
  });

  if (!response.ok) {
    throw new Error(
      responseData && responseData.error ? responseData.error : "Could not add the task."
    );
  }

  return responseData;
}

async function mutateAppStateOnApi(url, options) {
  const requestOptions = {
    method: options && options.method ? options.method : "PATCH",
    headers: {
      "Content-Type": "application/json"
    }
  };

  if (options && Object.prototype.hasOwnProperty.call(options, "body")) {
    requestOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, requestOptions);
  const responseData = await response.json().catch(function () {
    return null;
  });

  if (!response.ok) {
    throw new Error(
      responseData && responseData.error ? responseData.error : "Could not update the app state."
    );
  }

  replaceAppState(responseData);
  return responseData;
}

async function reorderTasksOnApi(reorderPayload) {
  return mutateAppStateOnApi(TASK_REORDER_API_URL, {
    method: "POST",
    body: reorderPayload
  });
}

async function selectPlannerEntry(sectionKey, entryId) {
  return mutateAppStateOnApi(PLANNER_STATE_API_URL, {
    method: "PATCH",
    body: {
      sectionKey: sectionKey,
      activeEntryId: entryId
    }
  });
}

async function createPlannerEntryOnApi(plannerEntryPayload) {
  const response = await fetch(PLANNER_ENTRIES_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(plannerEntryPayload)
  });

  const responseData = await response.json().catch(function () {
    return null;
  });

  if (!response.ok) {
    throw new Error(
      responseData && responseData.error ? responseData.error : "Could not create planner entry."
    );
  }

  return responseData;
}

function createEmptySections() {
  return {
    general: [],
    [WEEKEND_SECTION_KEY]: {
      entries: [],
      activeEntryId: null
    },
    [ESS_SECTION_KEY]: {
      entries: [],
      activeEntryId: null
    }
  };
}

function normalizeSections(sectionMap) {
  return {
    general: normalizeTaskList(sectionMap.general),
    [WEEKEND_SECTION_KEY]: normalizePlannerSection(
      sectionMap[WEEKEND_SECTION_KEY],
      SECTION_CONFIG[WEEKEND_SECTION_KEY],
      WEEKEND_SECTION_KEY
    ),
    [ESS_SECTION_KEY]: normalizePlannerSection(
      sectionMap[ESS_SECTION_KEY],
      SECTION_CONFIG[ESS_SECTION_KEY],
      ESS_SECTION_KEY
    )
  };
}

function saveActiveSection() {
  localStorage.setItem(SECTION_STORAGE_KEY, activeSection);
}

function loadActiveSection() {
  const savedSection = localStorage.getItem(SECTION_STORAGE_KEY);
  return SECTION_CONFIG[savedSection] ? savedSection : "general";
}

function renderSectionState() {
  todoHeading.textContent = SECTION_CONFIG[activeSection].title;
  todoContext.textContent = getSectionContext();
  todoContext.classList.toggle("is-hidden", !todoContext.textContent);
  plannerShell.classList.toggle("is-hidden", !isPlannerSection(activeSection));
  todoCard.classList.toggle("is-planner-layout", isPlannerSection(activeSection));

  if (!isPlannerSection(activeSection)) {
    closePlannerDatePicker();
  }

  sectionLinks.forEach(function (link) {
    const isActive = link.dataset.section === activeSection;
    link.classList.toggle("is-active", isActive);

    if (isActive) {
      link.setAttribute("aria-current", "page");
      return;
    }

    link.removeAttribute("aria-current");
  });
}

function renderPlannerControls() {
  if (!isPlannerSection(activeSection)) {
    plannerEntryList.innerHTML = "";
    plannerEmptyMessage.textContent = "";
    plannerEmptyMessage.classList.add("is-hidden");
    plannerArchiveToggle.classList.add("is-hidden");
    plannerArchiveToggle.classList.remove("is-active");
    plannerArchiveToggle.setAttribute("aria-pressed", "false");
    closePlannerDatePicker();
    return;
  }

  const plannerConfig = getPlannerConfig();

  if (isAppLoading) {
    plannerCreateButton.textContent = plannerConfig.createButtonLabel;
    plannerCreateButton.disabled = true;
    plannerDatePicker.setAttribute("aria-label", plannerConfig.datePickerLabel);
    plannerArchiveToggle.textContent = plannerConfig.archiveButtonLabel || "Archives";
    plannerArchiveToggle.classList.toggle("is-hidden", !supportsPlannerArchives(activeSection));
    plannerArchiveToggle.classList.remove("is-active");
    plannerArchiveToggle.setAttribute("aria-pressed", "false");
    plannerArchiveToggle.disabled = true;
    plannerEntryList.innerHTML = "";
    plannerEmptyMessage.textContent = "Loading planner entries...";
    plannerEmptyMessage.classList.remove("is-hidden");
    closePlannerDatePicker();
    return;
  }

  const visibleEntries = getVisiblePlannerEntries();
  const hasArchivedEntries = getArchivedPlannerEntriesCount(activeSection) > 0;
  plannerCreateButton.textContent = plannerConfig.createButtonLabel;
  plannerCreateButton.disabled = isPlannerEntryCreationPending;
  plannerDatePicker.setAttribute("aria-label", plannerConfig.datePickerLabel);
  plannerArchiveToggle.textContent = plannerConfig.archiveButtonLabel || "Archives";
  plannerArchiveToggle.classList.toggle("is-hidden", !supportsPlannerArchives(activeSection));
  plannerArchiveToggle.classList.toggle("is-active", isArchiveView(activeSection));
  plannerArchiveToggle.setAttribute("aria-pressed", String(isArchiveView(activeSection)));
  plannerArchiveToggle.disabled = supportsPlannerArchives(activeSection)
    ? !hasArchivedEntries && !isArchiveView(activeSection)
    : false;
  plannerEntryList.innerHTML = "";

  visibleEntries.forEach(function (entry) {
    const entryItem = document.createElement("div");
    const archiveButtonMarkup = supportsPlannerArchives(activeSection)
      ? `
        <button
          class="planner-entry-archive${entry.archived ? " is-archived" : ""}"
          type="button"
          data-entry-id="${entry.id}"
          aria-label="${entry.archived ? "Unarchive" : "Archive"} ${escapeHtml(entry.name)}"
          title="${entry.archived ? "Unarchive" : "Archive"}"
        >
          ${entry.archived ? getCheckIconMarkup() : getArchiveIconMarkup()}
        </button>
      `
      : "";

    entryItem.className = "planner-entry-item";

    if (areIdsEqual(entry.id, getPlannerData().activeEntryId)) {
      entryItem.classList.add("is-active");
    }

    entryItem.innerHTML = `
      <button class="planner-entry-button" type="button" data-entry-id="${entry.id}">
        <span class="planner-entry-name">${escapeHtml(entry.name)}</span>
      </button>
      <div class="planner-entry-actions">
        ${archiveButtonMarkup}
        <button
          class="planner-entry-delete"
          type="button"
          data-entry-id="${entry.id}"
          aria-label="Delete ${escapeHtml(entry.name)}"
          title="Delete"
        >
          X
        </button>
      </div>
    `;

    plannerEntryList.appendChild(entryItem);
  });

  if (visibleEntries.length === 0) {
    plannerEmptyMessage.textContent = getPlannerListEmptyMessage();
    plannerEmptyMessage.classList.remove("is-hidden");
    return;
  }

  plannerEmptyMessage.textContent = "";
  plannerEmptyMessage.classList.add("is-hidden");
}

function normalizeTaskOrder(taskItems) {
  const activeTasks = taskItems.filter(function (task) {
    return !task.completed;
  });
  const completedTasks = taskItems.filter(function (task) {
    return task.completed;
  });

  return activeTasks.concat(completedTasks);
}

function reorderTask(taskItems, taskId, isCompleted) {
  const updatedTask = taskItems.find(function (task) {
    return task.id === taskId;
  });

  if (!updatedTask) {
    return taskItems;
  }

  const remainingTasks = taskItems.filter(function (task) {
    return task.id !== taskId;
  });
  const nextTask = {
    ...updatedTask,
    completed: isCompleted
  };

  if (!isCompleted) {
    return [nextTask].concat(remainingTasks);
  }

  const firstCompletedIndex = remainingTasks.findIndex(function (task) {
    return task.completed;
  });

  if (firstCompletedIndex === -1) {
    return remainingTasks.concat(nextTask);
  }

  remainingTasks.splice(firstCompletedIndex, 0, nextTask);
  return remainingTasks;
}

async function syncTasksToDomOrder() {
  const currentTasks = getCurrentTasks();
  const taskLookup = new Map(
    currentTasks.map(function (task) {
      return [String(task.id), task];
    })
  );

  const reorderedVisibleTasks = Array.from(taskList.querySelectorAll(".task-item"))
    .map(function (taskItem) {
      return taskLookup.get(taskItem.dataset.taskId);
    })
    .filter(Boolean);
  const orderedTaskIds = reorderedVisibleTasks.map(function (task) {
    return task.id;
  });

  if (orderedTaskIds.length === 0) {
    return;
  }

  if (activeSection !== GENERAL_SECTION_KEY) {
    const activePlannerEntry = getActivePlannerEntry();

    if (!activePlannerEntry) {
      return;
    }

    await reorderTasksOnApi({
      sectionKey: activeSection,
      plannerEntryId: activePlannerEntry.id,
      orderedTaskIds: orderedTaskIds
    });
    return;
  }

  await reorderTasksOnApi({
    sectionKey: GENERAL_SECTION_KEY,
    plannerEntryId: null,
    orderedTaskIds: orderedTaskIds,
    visibleArchived: isArchiveView(GENERAL_SECTION_KEY)
  });
}

function getDragAfterElement(pointerY) {
  const taskItems = Array.from(taskList.querySelectorAll(".task-item:not(.is-dragging)"));

  return taskItems.reduce(
    function (closest, taskItem) {
      const box = taskItem.getBoundingClientRect();
      const offset = pointerY - box.top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return {
          offset: offset,
          element: taskItem
        };
      }

      return closest;
    },
    {
      offset: Number.NEGATIVE_INFINITY,
      element: null
    }
  ).element;
}

function updateDropIndicator(nextItem) {
  taskList.classList.toggle("show-drop-at-end", !nextItem);

  if (dropIndicatorTaskId && (!nextItem || nextItem.dataset.taskId !== dropIndicatorTaskId)) {
    const previousIndicatorItem = taskList.querySelector(
      `[data-task-id="${dropIndicatorTaskId}"]`
    );

    if (previousIndicatorItem) {
      previousIndicatorItem.classList.remove("show-drop-before");
    }
  }

  if (!nextItem) {
    dropIndicatorTaskId = null;
    return;
  }

  nextItem.classList.add("show-drop-before");
  dropIndicatorTaskId = nextItem.dataset.taskId;
}

function clearDropIndicator() {
  taskList.classList.remove("show-drop-at-end");

  if (!dropIndicatorTaskId) {
    return;
  }

  const indicatorItem = taskList.querySelector(`[data-task-id="${dropIndicatorTaskId}"]`);

  if (indicatorItem) {
    indicatorItem.classList.remove("show-drop-before");
  }

  dropIndicatorTaskId = null;
}

function getTaskPositions() {
  const positions = new Map();

  taskList.querySelectorAll(".task-item").forEach(function (taskItem) {
    positions.set(taskItem.dataset.taskId, taskItem.getBoundingClientRect().top);
  });

  return positions;
}

function animateTaskShift(updateTaskOrder) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    updateTaskOrder();
    return;
  }

  const previousPositions = getTaskPositions();

  updateTaskOrder();

  taskList.querySelectorAll(".task-item:not(.is-dragging)").forEach(function (taskItem) {
    const previousTop = previousPositions.get(taskItem.dataset.taskId);

    if (previousTop === undefined) {
      return;
    }

    const currentTop = taskItem.getBoundingClientRect().top;
    const offset = previousTop - currentTop;

    if (offset === 0) {
      return;
    }

    taskItem.animate(
      [
        { transform: `translateY(${offset}px)` },
        { transform: "translateY(0)" }
      ],
      {
        duration: 220,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)"
      }
    );
  });
}

function animateTaskReorder(previousPositions) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }

  taskList.querySelectorAll(".task-item").forEach(function (taskItem) {
    const previousTop = previousPositions.get(taskItem.dataset.taskId);

    if (previousTop === undefined) {
      return;
    }

    const currentTop = taskItem.getBoundingClientRect().top;
    const offset = previousTop - currentTop;

    if (offset === 0) {
      return;
    }

    taskItem.animate(
      [
        { transform: `translateY(${offset}px)` },
        { transform: "translateY(0)" }
      ],
      {
        duration: 320,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)"
      }
    );
  });
}

function normalizeTaskList(taskItems) {
  if (!Array.isArray(taskItems)) {
    return [];
  }

  return taskItems.reduce(function (normalizedTasks, task, index) {
    if (!task || typeof task !== "object") {
      return normalizedTasks;
    }

    const text = typeof task.text === "string" ? task.text.trim() : "";

    if (!text) {
      return normalizedTasks;
    }

    normalizedTasks.push({
      id: typeof task.id === "number" ? task.id : Date.now() + index,
      text: text,
      completed: Boolean(task.completed),
      archived: Boolean(task.archived)
    });

    return normalizedTasks;
  }, []);
}

function getAppStateSignature(appState) {
  return JSON.stringify(appState);
}

function normalizePlannerSection(sectionValue, plannerConfig, sectionKey) {
  if (Array.isArray(sectionValue)) {
    const legacyTasks = normalizeTaskList(sectionValue);

    if (legacyTasks.length === 0) {
      return {
        entries: [],
        activeEntryId: null
      };
    }

    const legacyEntryId = createEntryId("legacy");

    return {
      entries: [
        {
          id: legacyEntryId,
          name: plannerConfig.legacyEntryName,
          tasks: legacyTasks,
          archived: false,
          deleted: false,
          sortKey: 0
        }
      ],
      activeEntryId: legacyEntryId
    };
  }

  if (!sectionValue || typeof sectionValue !== "object") {
    return {
      entries: [],
      activeEntryId: null
    };
  }

  const rawEntries = Array.isArray(sectionValue.entries) ? sectionValue.entries : [];
  const entries = rawEntries.reduce(function (normalizedEntries, entry, index) {
    if (!entry || typeof entry !== "object") {
      return normalizedEntries;
    }

    const name = typeof entry.name === "string" ? entry.name.trim() : "";

    if (!name) {
      return normalizedEntries;
    }

    normalizedEntries.push({
      id:
        (typeof entry.id === "string" && entry.id) || typeof entry.id === "number"
          ? entry.id
          : createEntryId(index),
      name: name,
      tasks: normalizeTaskList(entry.tasks),
      archived: Boolean(entry.archived),
      deleted: Boolean(entry.deleted),
      sortKey: getPlannerEntrySortKey(entry, name, sectionKey)
    });

    return normalizedEntries;
  }, []);

  const activeEntryId = entries.some(function (entry) {
    return areIdsEqual(entry.id, sectionValue.activeEntryId);
  })
    ? sectionValue.activeEntryId
    : null;

  return {
    entries: sortPlannerEntries(entries),
    activeEntryId: activeEntryId
  };
}

function getCurrentTasks() {
  if (!isPlannerSection(activeSection)) {
    return tasksBySection[activeSection];
  }

  const activeEntry = getActivePlannerEntry();
  return activeEntry ? activeEntry.tasks : [];
}

function setCurrentTasks(nextTasks) {
  applyCurrentTasks(nextTasks);
}

function applyCurrentTasks(nextTasks) {
  if (!isPlannerSection(activeSection)) {
    tasksBySection[activeSection] = nextTasks;
    lastAppStateSignature = getAppStateSignature(tasksBySection);
    return;
  }

  const planner = getPlannerData();
  planner.entries = planner.entries.map(function (entry) {
    if (!areIdsEqual(entry.id, planner.activeEntryId)) {
      return entry;
    }

    return {
      ...entry,
      tasks: nextTasks
    };
  });

  lastAppStateSignature = getAppStateSignature(tasksBySection);
  renderPlannerControls();
}

function applyPlannerEntry(sectionKey, plannerEntry) {
  const planner = getPlannerData(sectionKey);
  const normalizedSection = normalizePlannerSection(
    {
      entries: [plannerEntry],
      activeEntryId: plannerEntry.id
    },
    getPlannerConfig(sectionKey),
    sectionKey
  );
  const normalizedEntry = normalizedSection.entries[0];

  if (!normalizedEntry) {
    return;
  }

  planner.entries = sortPlannerEntries(
    planner.entries
      .filter(function (entry) {
        return !areIdsEqual(entry.id, normalizedEntry.id);
      })
      .concat(normalizedEntry)
  );
  planner.activeEntryId = normalizedEntry.id;
  lastAppStateSignature = getAppStateSignature(tasksBySection);
}

function canManageCurrentTasks() {
  if (!isPlannerSection(activeSection)) {
    return true;
  }

  return Boolean(getActivePlannerEntry());
}

function getSectionContext() {
  if (!isPlannerSection(activeSection)) {
    if (activeSection === GENERAL_SECTION_KEY && isArchiveView(GENERAL_SECTION_KEY)) {
      return "Archives";
    }

    return "";
  }

  const activeEntry = getActivePlannerEntry();

  if (!activeEntry) {
    return getPlannerSelectionPrompt();
  }

  return activeEntry.name;
}

function updateTaskComposerState(hasPlannerEntry) {
  const canEditTasks = typeof hasPlannerEntry === "boolean" ? hasPlannerEntry : canManageCurrentTasks();
  const isGeneralArchiveMode =
    activeSection === GENERAL_SECTION_KEY && isArchiveView(GENERAL_SECTION_KEY);
  const shouldDisableComposer =
    isAppLoading ||
    isTaskCreationPending ||
    Boolean(appLoadErrorMessage) ||
    !canEditTasks ||
    isGeneralArchiveMode;

  taskInput.disabled = shouldDisableComposer;
  todoSubmitButton.disabled = shouldDisableComposer;
  taskInput.placeholder = shouldDisableComposer
    ? isAppLoading
      ? "Loading tasks..."
      : isTaskCreationPending
        ? "Adding task..."
      : appLoadErrorMessage
        ? "Backend unavailable"
        : isGeneralArchiveMode
          ? "Leave Archives to add a new task"
          : getPlannerSelectionMessage()
    : getTaskPlaceholder();
}

function renderGeneralArchiveToggle() {
  if (!todoArchiveToggle) {
    return;
  }

  const isGeneralSection = activeSection === GENERAL_SECTION_KEY;
  const isActive = isGeneralSection && isArchiveView(GENERAL_SECTION_KEY);
  const hasArchivedTasks = getArchivedGeneralTasksCount() > 0;

  todoArchiveToggle.classList.toggle("is-hidden", !isGeneralSection);
  todoArchiveToggle.classList.toggle("is-active", isActive);
  todoArchiveToggle.setAttribute("aria-pressed", String(isActive));
  todoArchiveToggle.disabled = isGeneralSection ? !hasArchivedTasks && !isActive : false;
}

function getTaskPlaceholder() {
  if (activeSection === GENERAL_SECTION_KEY) {
    return "What do you want to get done?";
  }

  if (isPlannerSection(activeSection)) {
    const activeEntry = getActivePlannerEntry();
    return activeEntry ? `Add a task for ${activeEntry.name}` : getPlannerSelectionMessage();
  }

  return "What do you want to get done?";
}

function getVisibleTasks() {
  const currentTasks = getCurrentTasks();

  if (activeSection !== GENERAL_SECTION_KEY) {
    return currentTasks;
  }

  return currentTasks.filter(function (task) {
    return isArchiveView(GENERAL_SECTION_KEY) ? task.archived : !task.archived;
  });
}

function getArchivedGeneralTasksCount() {
  return tasksBySection[GENERAL_SECTION_KEY].filter(function (task) {
    return task.archived;
  }).length;
}

function animateTaskExit(taskId, onComplete) {
  const taskItem = taskList.querySelector(`[data-task-id="${taskId}"]`);

  if (
    !taskItem ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    onComplete();
    return;
  }

  const taskHeight = taskItem.getBoundingClientRect().height;
  let hasCompleted = false;

  function finishTransition() {
    if (hasCompleted) {
      return;
    }

    hasCompleted = true;
    onComplete();
  }

  taskItem.style.height = `${taskHeight}px`;
  taskItem.style.overflow = "hidden";

  window.requestAnimationFrame(function () {
    taskItem.classList.add("is-exiting");
    taskItem.style.height = "0px";
  });

  taskItem.addEventListener("transitionend", finishTransition, { once: true });
  window.setTimeout(finishTransition, 260);
}

function getEmptyStateMessage() {
  if (activeSection === GENERAL_SECTION_KEY) {
    return isArchiveView(GENERAL_SECTION_KEY)
      ? SECTION_CONFIG[GENERAL_SECTION_KEY].archiveEmptyMessage
      : "No tasks yet. Add your first one above.";
  }

  if (isPlannerSection(activeSection)) {
    return getPlannerConfig().taskEmptyMessage;
  }

  return "No tasks yet. Add your first one above.";
}

function getPlannerData(sectionKey) {
  const resolvedSectionKey = sectionKey || activeSection;
  return tasksBySection[resolvedSectionKey];
}

function getActivePlannerEntry(sectionKey) {
  const planner = getPlannerData(sectionKey);
  const visibleEntries = getVisiblePlannerEntries(sectionKey);

  return (
    visibleEntries.find(function (entry) {
      return areIdsEqual(entry.id, planner.activeEntryId);
    }) || null
  );
}

function createPlannerEntry(sectionKey, entryDescriptor) {
  return createPlannerEntryOnApi({
    sectionKey: sectionKey,
    name: entryDescriptor.name,
    sortKey: entryDescriptor.sortKey
  });
}

async function createAndApplyPlannerEntry(sectionKey, entryDescriptor) {
  isPlannerEntryCreationPending = true;
  renderPlannerControls();
  formMessage.textContent = "";

  try {
    const createdEntry = await createPlannerEntry(sectionKey, entryDescriptor);

    applyPlannerEntry(sectionKey, createdEntry);

    if (supportsPlannerArchives(sectionKey)) {
      setArchiveView(sectionKey, false);
    }
  } catch (error) {
    console.error("Could not create planner entry.", error);
    formMessage.textContent = error.message || "Could not create planner entry.";
    return false;
  } finally {
    isPlannerEntryCreationPending = false;
    renderPlannerControls();
  }

  return true;
}

async function createPlannerEntryFromDate(sectionKey, selectedDate) {
  const entryDescriptor = getPlannerEntryDescriptorFromDate(sectionKey, selectedDate);

  if (!entryDescriptor) {
    return false;
  }

  if (sectionKey !== WEEKEND_SECTION_KEY) {
    return createAndApplyPlannerEntry(sectionKey, entryDescriptor);
  }

  const planner = getPlannerData(sectionKey);
  const existingEntry = planner.entries.find(function (entry) {
    return entry.sortKey === entryDescriptor.sortKey && !entry.deleted;
  });

  if (existingEntry) {
    await selectPlannerEntry(sectionKey, existingEntry.id);
    return true;
  }

  return createAndApplyPlannerEntry(sectionKey, entryDescriptor);
}

function getPlannerEntryDescriptorFromDate(sectionKey, selectedDate) {
  if (sectionKey === WEEKEND_SECTION_KEY) {
    const weekendStartDate = getWeekendStartDate(selectedDate);

    if (!weekendStartDate) {
      formMessage.textContent = "Pick a Saturday or Sunday to create a Weekend Goals entry.";
      return null;
    }

    return {
      name: formatWeekendEntryDate(weekendStartDate),
      sortKey: getStartOfDay(weekendStartDate).getTime()
    };
  }

  if (sectionKey === ESS_SECTION_KEY && !isEssPlannerDateSelectable(selectedDate)) {
    formMessage.textContent = "Pick a Tuesday or Thursday to create an ESS entry.";
    return null;
  }

  return {
    name: formatPlannerEntryDate(selectedDate),
    sortKey: getStartOfDay(selectedDate).getTime()
  };
}

function getVisiblePlannerEntries(sectionKey) {
  const resolvedSectionKey = sectionKey || activeSection;
  const planner = getPlannerData(resolvedSectionKey);

  if (!planner) {
    return [];
  }

  if (supportsPlannerArchives(resolvedSectionKey)) {
    return sortPlannerEntries(
      planner.entries.filter(function (entry) {
        if (isArchiveView(resolvedSectionKey)) {
          return entry.archived;
        }

        return !entry.archived && !entry.deleted;
      })
    );
  }

  return sortPlannerEntries(planner.entries);
}

function sortPlannerEntries(entries) {
  return entries.slice().sort(function (firstEntry, secondEntry) {
    return getComparableSortKey(secondEntry) - getComparableSortKey(firstEntry);
  });
}

function getComparableSortKey(entry) {
  return typeof entry.sortKey === "number" && Number.isFinite(entry.sortKey) ? entry.sortKey : 0;
}

function getPlannerEntrySortKey(entry, entryName, sectionKey) {
  if (typeof entry.sortKey === "number" && Number.isFinite(entry.sortKey)) {
    return entry.sortKey;
  }

  return inferPlannerEntrySortKey(entryName, sectionKey);
}

function inferPlannerEntrySortKey(entryName, sectionKey) {
  if (sectionKey === ESS_SECTION_KEY) {
    return inferEssPlannerSortKey(entryName);
  }

  if (sectionKey === WEEKEND_SECTION_KEY) {
    return inferWeekendPlannerSortKey(entryName);
  }

  return 0;
}

function inferEssPlannerSortKey(entryName) {
  const essMatch = entryName.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{2})'$/);

  if (!essMatch) {
    return 0;
  }

  const monthIndex = MONTH_INDEX_BY_LABEL[essMatch[1]];
  const dayOfMonth = Number(essMatch[2]);
  const fullYear = 2000 + Number(essMatch[3]);

  if (monthIndex === undefined || Number.isNaN(dayOfMonth) || Number.isNaN(fullYear)) {
    return 0;
  }

  return createCalendarDate(fullYear, monthIndex, dayOfMonth).getTime();
}

function inferWeekendPlannerSortKey(entryName) {
  const currentYear = new Date().getFullYear();
  const sameMonthMatch = entryName.match(/^([A-Z][a-z]{2}) (\d{1,2})-(\d{1,2})$/);
  const splitMonthMatch = entryName.match(/^([A-Z][a-z]{2}) (\d{1,2})-([A-Z][a-z]{2}) (\d{1,2})$/);

  if (sameMonthMatch) {
    const monthIndex = MONTH_INDEX_BY_LABEL[sameMonthMatch[1]];
    const dayOfMonth = Number(sameMonthMatch[2]);

    if (monthIndex === undefined || Number.isNaN(dayOfMonth)) {
      return 0;
    }

    return createCalendarDate(currentYear, monthIndex, dayOfMonth).getTime();
  }

  if (!splitMonthMatch) {
    return 0;
  }

  const startMonthIndex = MONTH_INDEX_BY_LABEL[splitMonthMatch[1]];
  const dayOfMonth = Number(splitMonthMatch[2]);

  if (startMonthIndex === undefined || Number.isNaN(dayOfMonth)) {
    return 0;
  }

  return createCalendarDate(currentYear, startMonthIndex, dayOfMonth).getTime();
}

function getArchivedPlannerEntriesCount(sectionKey) {
  const planner = getPlannerData(sectionKey);

  if (!planner || !supportsPlannerArchives(sectionKey)) {
    return 0;
  }

  return planner.entries.filter(function (entry) {
    return entry.archived;
  }).length;
}

function animatePlannerEntryExit(entryId, onComplete) {
  const entryControl = plannerEntryList.querySelector(`[data-entry-id="${entryId}"]`);
  const entryItem = entryControl ? entryControl.closest(".planner-entry-item") : null;

  if (
    !entryItem ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    onComplete();
    return;
  }

  const entryHeight = entryItem.getBoundingClientRect().height;
  let hasCompleted = false;

  function finishTransition() {
    if (hasCompleted) {
      return;
    }

    hasCompleted = true;
    onComplete();
  }

  entryItem.style.height = `${entryHeight}px`;
  entryItem.style.overflow = "hidden";

  window.requestAnimationFrame(function () {
    entryItem.classList.add("is-exiting");
    entryItem.style.height = "0px";
  });

  entryItem.addEventListener("transitionend", finishTransition, { once: true });
  window.setTimeout(finishTransition, 260);
}

function findPlannerEntryById(sectionKey, entryId) {
  const planner = getPlannerData(sectionKey);

  return (
    planner.entries.find(function (entry) {
      return areIdsEqual(entry.id, entryId);
    }) || null
  );
}

function getPlannerSelectionPrompt() {
  const plannerConfig = getPlannerConfig();

  if (supportsPlannerArchives(activeSection) && isArchiveView(activeSection)) {
    return plannerConfig.archiveSelectionPrompt;
  }

  return plannerConfig.selectionPrompt;
}

function getPlannerListEmptyMessage() {
  const plannerConfig = getPlannerConfig();

  if (supportsPlannerArchives(activeSection) && isArchiveView(activeSection)) {
    return plannerConfig.archiveEmptyMessage;
  }

  return plannerConfig.emptyPlannerMessage;
}

function renderPlannerDatePicker() {
  if (!plannerDatePickerTitle || !plannerDatePickerGrid) {
    return;
  }

  plannerDatePickerTitle.textContent = MONTH_TITLE_FORMATTER.format(plannerCalendarMonth);
  plannerDatePickerGrid.innerHTML = "";

  const calendarStartDate = getCalendarGridStart(plannerCalendarMonth);
  const today = getStartOfDay(new Date());

  for (let dayOffset = 0; dayOffset < 42; dayOffset += 1) {
    const dayDate = createCalendarDate(
      calendarStartDate.getFullYear(),
      calendarStartDate.getMonth(),
      calendarStartDate.getDate() + dayOffset
    );
    const dayButton = document.createElement("button");
    const isCurrentMonth = dayDate.getMonth() === plannerCalendarMonth.getMonth();
    const isToday = areSameCalendarDay(dayDate, today);
    const isSelectable = isPlannerCalendarDateSelectable(activeSection, dayDate);

    dayButton.className = "planner-date-picker-day";
    dayButton.type = "button";
    dayButton.dataset.date = formatDateForDataset(dayDate);
    dayButton.textContent = String(dayDate.getDate());
    dayButton.setAttribute("aria-label", ENTRY_ARIA_LABEL_FORMATTER.format(dayDate));

    if (!isCurrentMonth) {
      dayButton.classList.add("is-outside-month");
    }

    if (isToday) {
      dayButton.classList.add("is-today");
    }

    if (!isSelectable) {
      dayButton.classList.add("is-disabled");
      dayButton.disabled = true;
      dayButton.setAttribute("aria-disabled", "true");
    }

    plannerDatePickerGrid.appendChild(dayButton);
  }
}

function openPlannerDatePicker() {
  if (!plannerDatePicker) {
    return;
  }

  isPlannerDatePickerOpen = true;
  plannerDatePicker.classList.remove("is-hidden");
  plannerDatePicker.setAttribute("aria-hidden", "false");
  plannerCreateButton.setAttribute("aria-expanded", "true");

  window.requestAnimationFrame(function () {
    const todayButton = plannerDatePicker.querySelector(".planner-date-picker-day.is-today");
    const firstVisibleButton = plannerDatePicker.querySelector(".planner-date-picker-day");
    const nextFocusTarget = todayButton || firstVisibleButton;

    if (nextFocusTarget) {
      nextFocusTarget.focus();
    }
  });
}

function closePlannerDatePicker() {
  if (!plannerDatePicker) {
    return;
  }

  isPlannerDatePickerOpen = false;
  plannerDatePicker.classList.add("is-hidden");
  plannerDatePicker.setAttribute("aria-hidden", "true");
  plannerCreateButton.setAttribute("aria-expanded", "false");
}

function formatPlannerEntryDate(date) {
  return `${getEssWeekdayLabel(date)}, ${ENTRY_MONTH_FORMATTER.format(date)} ${date.getDate()}, ${date.getFullYear()}`;
}

function formatWeekendEntryDate(weekendStartDate) {
  const weekendEndDate = createCalendarDate(
    weekendStartDate.getFullYear(),
    weekendStartDate.getMonth(),
    weekendStartDate.getDate() + 1
  );
  const startMonth = ENTRY_MONTH_FORMATTER.format(weekendStartDate);
  const endMonth = ENTRY_MONTH_FORMATTER.format(weekendEndDate);
  const startYear = String(weekendStartDate.getFullYear()).slice(-2);
  const endYear = String(weekendEndDate.getFullYear()).slice(-2);

  if (weekendStartDate.getFullYear() !== weekendEndDate.getFullYear()) {
    return `${startMonth} ${weekendStartDate.getDate()}, ${startYear}'-${endMonth} ${weekendEndDate.getDate()}, ${endYear}'`;
  }

  if (weekendStartDate.getMonth() === weekendEndDate.getMonth()) {
    return `${startMonth} ${weekendStartDate.getDate()}-${weekendEndDate.getDate()}`;
  }

  return `${startMonth} ${weekendStartDate.getDate()}-${endMonth} ${weekendEndDate.getDate()}`;
}

function getCalendarGridStart(monthDate) {
  return createCalendarDate(
    monthDate.getFullYear(),
    monthDate.getMonth(),
    1 - monthDate.getDay()
  );
}

function formatDateForDataset(date) {
  const monthValue = String(date.getMonth() + 1).padStart(2, "0");
  const dayValue = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${monthValue}-${dayValue}`;
}

function createDateFromIso(dateValue) {
  const dateParts = dateValue.split("-");

  if (dateParts.length !== 3) {
    return null;
  }

  const year = Number(dateParts[0]);
  const month = Number(dateParts[1]) - 1;
  const day = Number(dateParts[2]);

  if ([year, month, day].some(Number.isNaN)) {
    return null;
  }

  return createCalendarDate(year, month, day);
}

function createCalendarDate(year, month, day) {
  return new Date(year, month, day);
}

function getWeekendStartDate(date) {
  const dayOfWeek = date.getDay();

  if (dayOfWeek === 6) {
    return getStartOfDay(date);
  }

  if (dayOfWeek === 0) {
    return createCalendarDate(date.getFullYear(), date.getMonth(), date.getDate() - 1);
  }

  return null;
}

function getEssWeekdayLabel(date) {
  return date.getDay() === 2 ? "Tue" : "Thurs";
}

function isPlannerCalendarDateSelectable(sectionKey, date) {
  if (sectionKey === WEEKEND_SECTION_KEY) {
    return isWeekendPlannerDateSelectable(date);
  }

  if (sectionKey === ESS_SECTION_KEY) {
    return isEssPlannerDateSelectable(date);
  }

  return true;
}

function isEssPlannerDateSelectable(date) {
  const dayOfWeek = date.getDay();
  return dayOfWeek === 2 || dayOfWeek === 4;
}

function isWeekendPlannerDateSelectable(date) {
  const dayOfWeek = date.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function getStartOfMonth(date) {
  return createCalendarDate(date.getFullYear(), date.getMonth(), 1);
}

function getStartOfDay(date) {
  return createCalendarDate(date.getFullYear(), date.getMonth(), date.getDate());
}

function areSameCalendarDay(firstDate, secondDate) {
  return (
    firstDate.getFullYear() === secondDate.getFullYear() &&
    firstDate.getMonth() === secondDate.getMonth() &&
    firstDate.getDate() === secondDate.getDate()
  );
}

function getPlannerSelectionMessage() {
  const plannerConfig = getPlannerConfig();
  const visibleEntries = getVisiblePlannerEntries();

  if (supportsPlannerArchives(activeSection) && isArchiveView(activeSection)) {
    return visibleEntries.length > 0
      ? plannerConfig.archiveNoSelectionMessage
      : plannerConfig.archiveNoEntryMessage;
  }

  return visibleEntries.length > 0 ? plannerConfig.noSelectionMessage : plannerConfig.noEntryMessage;
}

function createEntryId(prefix) {
  return `${prefix || "planner"}-entry-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function areIdsEqual(firstId, secondId) {
  if (firstId === null || firstId === undefined || secondId === null || secondId === undefined) {
    return false;
  }

  return String(firstId) === String(secondId);
}

function isPlannerSection(sectionKey) {
  return PLANNER_SECTION_KEY_SET.has(sectionKey);
}

function getPlannerConfig(sectionKey) {
  return SECTION_CONFIG[sectionKey || activeSection];
}

function supportsPlannerArchives(sectionKey) {
  return isPlannerSection(sectionKey);
}

function createArchiveViewState() {
  return {
    [GENERAL_SECTION_KEY]: false,
    [WEEKEND_SECTION_KEY]: false,
    [ESS_SECTION_KEY]: false
  };
}

function isArchiveView(sectionKey) {
  return Boolean(archiveViewBySection[sectionKey]);
}

function setArchiveView(sectionKey, nextValue) {
  archiveViewBySection = {
    ...archiveViewBySection,
    [sectionKey]: Boolean(nextValue)
  };
}

function getArchiveIconMarkup() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M4 6.75h16M7 6.75V5.5a1.5 1.5 0 0 1 1.5-1.5h7A1.5 1.5 0 0 1 17 5.5v1.25m-11 0v11.75A1.5 1.5 0 0 0 7.5 20h9A1.5 1.5 0 0 0 18 18.5V6.75m-7 4h2"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="1.7"
      />
    </svg>
  `;
}

function getCheckIconMarkup() {
  return `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        d="M6.5 12.5 10 16l7.5-8"
        fill="none"
        stroke="currentColor"
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width="2"
      />
    </svg>
  `;
}

function resetDragState() {
  clearDropIndicator();
  draggedTaskId = null;
}

function escapeHtml(text) {
  const temporaryElement = document.createElement("div");
  temporaryElement.textContent = text;
  return temporaryElement.innerHTML;
}
