# OS Visualization: Deadlock Detection & Avoidance - Resource Allocation Graph

Live version of the website [here]([https://vercel.com/shrihari6105s-projects/resource-allocation-graph-visualizer/9pfFKDGF2RJuxqYvFkWJNkbPs4fU](https://resource-allocation-graph-vis-git-7d86c1-shrihari6105s-projects.vercel.app/))

A standalone, client-only web application to visualize core Operating System concepts around deadlock detection and simple avoidance using a Resource Allocation Graph (RAG). Runs locally in any modern browser with zero server dependencies.

- Technology: HTML5, CSS3, JavaScript (ES6+) and Canvas API
- Deployment: Open `index.html` directly (no build, no server)
- Platform: Works on Windows, macOS, Linux via modern browsers (Chrome, Edge, Firefox, Safari)

## Quick Start

1. Download or clone the project files into a folder:
   - `index.html`
   - `styles.css`
   - `rag.js`
   - `app.js`
2. Double-click `index.html` to open it in your browser.

Tip: If the browser caches old CSS/JS, force refresh:
- Windows/Linux: Ctrl+F5
- macOS: Cmd+Shift+R

## What You Can Do

- Visualize a Resource Allocation Graph (RAG) with:
  - Processes (P) and Resources (R) with instance counts
  - Assignment edges (R → P), pending requests (P → R)
  - Optional Wait-For Graph (WFG) overlay (P → P)
- Interactively:
  - Add processes and resources
  - Queue Request/Release events
  - Play, Pause, Step forward/backward with adjustable speed
  - Auto-grant available resources during playback
  - Toggle simple Avoidance mode (deny cycle-creating grants)
- Inspect:
  - Queues and per-resource availability
  - Process states (ready/blocked)
  - Deadlock detection results (involved processes, cycles)
- Export:
  - Canvas screenshot (PNG)
  - Execution trace (JSON of snapshots)

## UI Overview

- Sidebar
  - Setup: Add processes and resources, see current lists
  - Scenarios: One-click sample setups for fast demos
  - Mode & Options:
    - Avoidance Mode: Deny grants that would immediately create a WFG cycle
    - Auto-grant: Fulfill waiting requests automatically during Play
    - Show WFG: Overlay wait-for edges between processes
  - Create Event: Queue Request/Release events
  - Execution Controls: Reset, Step Back/Forward, Play/Pause, Speed
- Canvas (main area)
  - Processes: circles (left)
  - Resources: rounded squares (right)
  - Edges:
    - R → P: assignment (green, solid; labeled with count)
    - P → R: waiting request (red, dashed; labeled with count)
    - P → P: WFG (purple, dotted; labeled “W”)
  - Resource dots: show total and assigned units — availability shown below each resource
  - Legend: top-right overlay
  - Tooltip: hover nodes to see details
- Stats & Log
  - Stats: snapshot of processes, resources, queues, deadlock, mode
  - Log: recent actions (grants, blocks, releases, avoidance decisions)

## Built-in Scenarios

Use the “Scenarios” section (buttons) for ready-made setups:

1. 2-Proc Cycle (deadlock)
   - R1(1) held by P1, R2(1) held by P2
   - P1 requests R2, P2 requests R1 → cycle
2. No Deadlock (multi-instance)
   - R1(2) held by P1 and P2
   - P3 requests R1 (waits), then P1 releases → P3 gets R1
   - P2 uses/releases R2 without deadlock
3. 3-Proc Cycle (deadlock)
   - R1(1)→P1, R2(1)→P2, R3(1)→P3
   - P1→R2, P2→R3, P3→R1 → 3-way cycle
4. Contention (progress, no cycle expected)
   - CPU(2), IO(1); four processes with mixed requests and releases
   - Demonstrates waiting and unblocking

There’s also a “Quick Demo (Load & Play)” button to load a scenario and start playback immediately.

## Controls and Shortcuts

- Play ▶ / Pause ⏸
- Step ⟳ forward, Step ⟲ back
- Reset: return to the initial snapshot of the current scenario
- Speed slider: adjust step interval (faster/slower)
- Keyboard:
  - Space: Play/Pause
  - Arrow Right: Step Forward
  - Arrow Left: Step Backward

## Deadlock Detection and Avoidance Model

- Detection:
  - Build the Wait-For Graph (WFG). For each blocking request P→R (insufficient availability), add edges from P to every process currently holding R.
  - Run cycle detection (DFS) on the WFG. Any cycle indicates deadlock among the involved processes.
- Avoidance (simple RAG-based):
  - Before granting a request, tentatively grant and rebuild WFG; if a cycle would be created, deny the grant.
  - Accurate for single-instance resources; for multi-instance resources, this is a practical heuristic (not a full Banker's algorithm).

## Exports

- Export Screenshot: Downloads the current canvas as PNG.
- Export Trace: Downloads a JSON array of snapshots (state history), including:
  - Step number
  - Processes (name, state)
  - Resources (name, total)
  - Available and assigned maps
  - Queues per resource
  - Recent logs

## Troubleshooting

- Graph not visible (blank canvas)
  - Ensure `index.html` links the correct CSS file:
    - If your stylesheet is named `styles.css`, the link must be `<link rel="stylesheet" href="./styles.css" />`.
    - If it’s named `style.css`, update the filename or the link accordingly. Only keep one stylesheet to avoid confusion.
  - The canvas must not have percentage height relative to an “auto” parent. This project sets a concrete responsive height via CSS; verify the `#canvas` element has a computed height greater than 0px (DevTools → Computed).
  - Hard refresh to clear cache (Ctrl+F5 / Cmd+Shift+R).
- Flickering
  - The renderer uses a debounced ResizeObserver and stable canvas sizing to prevent flicker.
  - If any flicker persists, try disabling WFG overlay temporarily and check GPU acceleration settings.
- Nothing happens when playing
  - Ensure there are queued events (check Pending Events list) or use a built-in scenario.
  - Enable “Auto-grant available requests during Play” to drain queues automatically.
- Tooltips or legend overlap
  - Resize the window or scroll the sidebar if needed; the canvas area adapts responsively.

## Architecture

- `rag.js`
  - Core model:
    - Processes, Resources (with instance counts)
    - Assignments and waiting queues
    - Wait-For Graph construction and cycle detection
  - Simulation:
    - Event queue (request/release)
    - Step-forward logic; auto-grant; avoidance check
    - Snapshot exporting
  - Rendering:
    - Canvas-based layout and draw routines
    - Stable resizing and pixel ratio handling
    - Tooltip and optional WFG overlay
- `app.js`
  - UI wiring and controls
  - Scenario loaders
  - Playback loop
  - Stats and logs rendering
  - Export handlers
- `styles.css`
  - Responsive layout and theming
  - Concrete canvas sizing (clamp) to ensure visibility across platforms

## Extending the App

- True Banker's Algorithm
  - Add per-process maximum claims and current allocations.
  - Implement safety check to simulate after-grant state and ensure a safe sequence exists.
  - Extend UI with inputs for max claims matrix.
- More Visualizations
  - Draggable nodes (store positions per node, update layout on drag end)
  - Zoom/pan (transform canvas coordinates)
  - Per-resource FIFO queues rendered as sub-nodes
- Import/Export Scenarios
  - JSON or CSV import of processes/resources/events
  - Save/load scenario to local file

## Known Limitations

- Avoidance mode is heuristic for multi-instance resources; it’s exact for single-instance cases.
- Step-back history is capped (default 500 snapshots) to limit memory usage.
- Layout places processes on the left and resources on the right; with very large graphs, overlapping may occur (consider zoom/pan or multi-row layouts if needed).

## Browser Support

- Tested on recent versions of Chrome, Edge, Firefox, Safari
- Requires Canvas and ES6+ support (all modern browsers)

## License

MIT
