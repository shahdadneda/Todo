# Shahdad Todo Context

## What This Project Is

This repo is the standalone source for Shahdad's to-do / planner app. It is a
plain app with:

- A static frontend built with HTML, CSS, and vanilla JavaScript
- A small Node.js / Express backend
- A SQLite database for persistence

There is still:

- No React / Next.js / framework
- No frontend build step

The app is designed to feel like a lightweight planner that fits the visual
style of `shahdad.ca`.

## Deployment / Environment Setup

Current known environments:

- Production frontend: `https://shahdad.ca/todo`
- Production backend: `https://server.shahdad.ca`
- Local development backend API: `http://127.0.0.1:3001/api`
- Allowed local frontend origins for development:
  - `http://127.0.0.1:8080`
  - `http://localhost:8080`

Frontend API routing is currently pinned to production in `script.js`:

- The frontend uses `https://server.shahdad.ca/api` for all API requests,
  including when the page is opened locally
- All frontend API endpoints are derived from the shared `API_BASE_URL`
  constant
- This means local frontend testing now depends on the production backend's CORS
  policy allowing the frontend origin

Frontend sync behavior:

- The frontend loads the full app snapshot from `/api/app-state`
- It polls the backend every 5 seconds for fresh app state
- It only rerenders when the fetched app state actually differs from the
  current in-memory state

## Main Features

The app has 3 main sections:

- `General`
- `Weekend Goals`
- `ESS planner`

### General

- Simple task list
- Add, complete, delete, reorder tasks
- Has an archive mode for General tasks
- General tasks can be archived/unarchived individually

### Weekend Goals

- Planner-style section with separate dated entries
- New entries are created through a date picker
- Intended for weekend dates only
- Each weekend entry has its own separate tasks
- Supports archives for planner entries

### ESS Planner

- Planner-style section with separate dated entries
- New entries are created through a date picker
- Intended for ESS days (Tuesday / Thursday)
- Each ESS entry has its own separate tasks
- Supports archives for planner entries

## Important Files

- `/Users/shahdadneda/Documents/Code/shahdad-todo/index.html`
  Main app markup and layout structure
- `/Users/shahdadneda/Documents/Code/shahdad-todo/style.css`
  Entire visual styling, layout, spacing, responsive behavior, dark theme
- `/Users/shahdadneda/Documents/Code/shahdad-todo/script.js`
  All client-side behavior, state management, planner logic, archive logic,
  date picker logic, drag/reorder behavior, and frontend API calls
- `/Users/shahdadneda/Documents/Code/shahdad-todo/backend/server.js`
  Express API server, CORS policy, route definitions, JSON handling, and server
  startup
- `/Users/shahdadneda/Documents/Code/shahdad-todo/backend/db.js`
  SQLite access layer and data mutations for tasks, planner entries, selection,
  and reorder logic
- `/Users/shahdadneda/Documents/Code/shahdad-todo/backend/schema.sql`
  Database schema
- `/Users/shahdadneda/Documents/Code/shahdad-todo/backend/package.json`
  Backend runtime dependencies and scripts

## How Data Is Saved

App data is stored in SQLite through the backend API.

The frontend still uses `localStorage` for lightweight UI state:

- `shahdad-todo-active-section`

What is persisted:

- General tasks
- Weekend planner entries and their tasks
- ESS planner entries and their tasks
- Archived state / archived entries
- Planner active entry selection
- Last active section in the browser UI

This means:

- Task and planner data comes from the backend and is shared by whichever
  frontend is connected to that backend database
- Clearing browser storage does not remove task data
- Clearing browser storage can still reset the locally remembered active section

## State / Data Model Basics

High-level shape:

- `General` stores a flat task list
- `Weekend Goals` stores planner entries
- `ESS planner` stores planner entries

Planner sections use an object shape like:

- `entries`: array of dated planner entries
- `activeEntryId`: currently open planner entry

Each planner entry has:

- `id`
- `name`
- `tasks`
- archive-related state when applicable

Tasks typically include:

- `id`
- `text`
- `completed`
- archive-related state for General tasks

## Planner Behavior

Both planner sections (`Weekend Goals` and `ESS planner`) work differently from
General:

- The user creates a dated entry first
- Then tasks are added inside that entry
- Each entry keeps its own separate task list
- Clicking an entry switches the left task panel to that entry
- Deleting an entry removes that entry and its tasks

The date picker is part of the planner flow:

- `Weekend Goals` should only allow weekend dates
- `ESS planner` should only allow Tuesday / Thursday dates

The current UI includes:

- A planner sidebar/rail for entries
- A date picker popover
- Archive toggle buttons for planner sections

## Archive Behavior

This repo already has archive behavior and future agents should preserve it.

### General archives

- General tasks can be archived individually
- There is a dedicated `Archives` toggle in the General composer area
- Archive view changes what tasks are shown and disables normal task creation

### Planner archives

- Planner sections also support archived entries
- Archive mode changes which entries are shown in the planner rail
- Archive buttons exist in the planner controls and on planner entries

Important practical note:

- If changing section logic, planner entry rendering, or filters, be careful not
  to break archive mode

## Interaction Patterns

The app includes several important interaction patterns:

- Clickable left section navigation
- Frontend API loading and mutation flows
- Background polling of backend app state every 5 seconds
- Planner entry selection
- Drag-and-drop task reordering
- Checkbox completion toggles
- Archive toggles
- Date picker open/close navigation
- Animated removal/reordering in some flows

Future agents should test these flows after changes, especially in `script.js`.

## Style And Theme

The theme is intentionally consistent with Shahdad's website:

- Dark navy / blue background
- Light foreground text
- Muted blue-gray secondary text
- Rounded corners
- Subtle borders and hover states
- Minimal, polished, non-framework look

Typography:

- Uses `"Uber Move"` first when available
- Falls back to Inter / system sans-serif

Design expectations:

- Keep it clean and practical
- Avoid flashy or overbuilt UI
- Preserve the dark theme unless the user explicitly asks otherwise

## Layout Notes

The app uses nested layout containers:

- `.page`
- `.todo-layout`
- `.todo-card`
- `.todo-body`
- `.planner-shell`

If something looks visually constrained, check the parent grid/container rules
first before only editing child card styles.

This matters especially for the planner sections, where width problems often
come from:

- `.page`
- `.todo-layout`
- `.todo-card.is-planner-layout .todo-body`
- `.planner-shell`

## Important JavaScript Areas

Future agents should start with these parts of `script.js`:

- `API_BASE_URL` and API endpoint constants
- Section constants and `SECTION_CONFIG`
- `initializeApp()` and API-loading helpers
- API mutation helpers
- Storage helpers for the active section only
- `renderSectionState()`
- `renderPlannerControls()`
- `renderTasks()`
- Planner entry creation / deletion / archive functions
- Date picker rendering and validation
- Archive view state helpers

Because the app is a single-file JS app, many behaviors are connected. Small
changes in one render/helper function can affect multiple sections.

## Backend Notes

The backend is an Express server backed by SQLite.

Current API areas include:

- `/api/health`
- `/api/app-state`
- `/api/tasks`
- `/api/tasks/reorder`
- `/api/planner-entries`
- `/api/planner-state`

Current CORS policy is intentionally restrictive. Only these origins are
allowed:

- `https://shahdad.ca`
- `https://www.shahdad.ca`
- `http://127.0.0.1:8080`
- `http://localhost:8080`

The backend supports:

- `GET`
- `POST`
- `PATCH`
- `DELETE`
- `OPTIONS`
- JSON requests with `Content-Type`

If changing frontend hosting or dev ports later, remember to update the backend
CORS allowlist too.

## Things To Be Careful About

- Do not accidentally remove archive behavior while changing planner logic
- Do not assume General and planner sections use the same data shape
- Do not break date restrictions for Weekend vs ESS entries
- Do not introduce frameworks or a build system unless explicitly requested
- Do not hardcode localhost API URLs in frontend fetches; use the shared
  frontend API base
- Do not loosen backend CORS without an explicit reason
- Be careful with route/back-link assumptions if this is embedded into the main
  site later
- Reordering, archiving, and section switching can be easy to regress because
  they share render/state functions
- Frontend and backend need to stay aligned on API paths and allowed origins

## Testing Guidance For Future Agents

After any meaningful change, manually test:

1. Switch between General / Weekend Goals / ESS planner
2. Add a task in General
3. Archive and unarchive a General task
4. Create a Weekend entry from the date picker
5. Create an ESS entry from the date picker
6. Select planner entries and add tasks inside them
7. Delete a planner entry
8. Toggle planner archives
9. Refresh the page and verify data persisted
10. Confirm frontend requests hit the expected backend for the current
    environment
11. Confirm browser requests are not blocked by CORS

## Repo Reality Check

This repo is the actual working Todo app source, including both the frontend and
the backend.

If a future agent is trying to fix planner behavior, this repo is likely the
correct place to work first.
