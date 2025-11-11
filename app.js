/* Improved undo/step-back model using serialized history */

const sim = new OSViz.Simulator();
let renderer;

/* ---------- History helpers ---------- */
function commitState(label) {
  sim.snapshot();
  if (label) sim.state.logs.push(`[commit] ${label}`);
  updateStatsAndLog();
}
function setBaseline(label) {
  sim.history = [ sim.state.serialize() ];
  if (label) sim.state.logs.push(`[baseline] ${label}`);
  updateStatsAndLog();
}

/* ---------- Init ---------- */
function init() {
  const canvas = document.getElementById('canvas');
  renderer = new OSViz.Renderer(canvas, sim);
  bindUI();
  loadSampleCycle();
  setBaseline('Default scenario loaded');
  refreshAll();
}

function bindUI() {
  el('btn-add-proc').addEventListener('click', () => {
    const name = el('proc-name').value.trim() || `P${sim.state.processes.length + 1}`;
    if (sim.state.addProcess(name)) {
      log(`Added process ${name}`);
      commitState(`Add process ${name}`);
      refreshAll();
    }
  });

  el('btn-add-res').addEventListener('click', () => {
    const name = el('res-name').value.trim() || `R${sim.state.resources.length + 1}`;
    const inst = Math.max(1, Number(el('res-instances').value) || 1);
    if (sim.state.addResource(name, inst)) {
      log(`Added resource ${name} (${inst})`);
      commitState(`Add resource ${name}`);
      refreshAll();
    }
  });

  el('btn-clear-all').addEventListener('click', () => {
    if (!confirm('Clear all and reset baseline?')) return;
    pause();
    sim.hardReset();
    setBaseline('Cleared all');
    refreshAll();
  });

  el('btn-sample-1').addEventListener('click', () => { loadSampleCycle(); setBaseline('Scenario: 2-Proc Cycle'); refreshAll(); });
  el('btn-sample-2').addEventListener('click', () => { loadSampleNoDeadlock(); setBaseline('Scenario: No Deadlock'); refreshAll(); });
  el('btn-sample-3').addEventListener('click', () => { loadSampleThreeProcCycle(); setBaseline('Scenario: 3-Proc Cycle'); refreshAll(); });
  el('btn-sample-4').addEventListener('click', () => { loadSampleContention(); setBaseline('Scenario: Contention'); refreshAll(); });
  el('btn-quick-demo').addEventListener('click', () => { loadSampleContention(); setBaseline('Scenario: Contention Quick Demo'); refreshAll(); play(); });

  el('chk-avoidance').addEventListener('change', (e) => {
    sim.setAvoidance(e.target.checked);
    statusState(`Mode: ${e.target.checked ? 'Avoidance' : 'Detection'}`);
    commitState(`Toggle avoidance ${e.target.checked}`);
    refreshAll();
  });

  el('chk-show-wfg').addEventListener('change', (e) => {
    renderer.setShowWFG(e.target.checked);
    renderer.draw();
  });

  el('btn-queue-event').addEventListener('click', () => {
    const p = el('event-proc').value;
    const r = el('event-res').value;
    const count = Math.max(1, Number(el('event-count').value) || 1);
    const type = el('event-type').value;
    if (!p || !r) { alert('Select a process and a resource'); return; }
    sim.state.enqueueEvent({ type, process: p, resource: r, count });
    commitState(`Queue event ${type} ${p} ${count}x ${r}`);
    refreshEventQueue();
    statusState(`Queued: ${type} ${p} ${count}x ${r}`);
  });

  el('btn-clear-events').addEventListener('click', () => {
    if (!sim.state.eventQueue.length) return;
    sim.state.clearEvents();
    commitState('Clear events');
    refreshEventQueue();
    refreshAll();
  });

  el('btn-reset').addEventListener('click', () => {
    pause();
    sim.resetToInitial();
    refreshAll();
    statusState('Reset to baseline');
  });
  el('btn-step-forward').addEventListener('click', stepForwardOnce);
  el('btn-step-back').addEventListener('click', stepBackwardOnce);
  el('btn-play').addEventListener('click', play);
  el('btn-pause').addEventListener('click', pause);

  el('speed-range').addEventListener('input', e => { sim.setSpeed(e.target.value); });

  el('btn-export-screenshot').addEventListener('click', exportScreenshot);
  el('btn-export-trace').addEventListener('click', exportTrace);

  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      e.preventDefault();
      if (sim.playing) pause(); else play();
    } else if (e.key === 'ArrowRight') {
      stepForwardOnce();
    } else if (e.key === 'ArrowLeft') {
      stepBackwardOnce();
    }
  });
}

/* ---------- Simulation controls ---------- */
function stepForwardOnce() {
  const autoGrant = el('chk-auto-grant').checked;
  sim.stepForward({ autoGrant });
  statusState('Stepped forward');
  refreshAll();
}
function stepBackwardOnce() {
  if (sim.playing) pause();
  if (!sim.canStepBack()) {
    statusState('At baseline (cannot step back)');
    return;
  }
  sim.stepBackward();
  statusState('Stepped backward');
  refreshAll();
}

let playHandle = null;
function play() {
  if (sim.playing) return;
  sim.playing = true;
  el('btn-play').disabled = true;
  el('btn-pause').disabled = false;
  statusState('Playing');
  tick.lastTime = undefined;
  tick();
}
function pause() {
  if (!sim.playing) return;
  sim.playing = false;
  el('btn-play').disabled = false;
  el('btn-pause').disabled = true;
  statusState('Paused');
  if (playHandle) cancelAnimationFrame(playHandle);
}
function tick() {
  if (!sim.playing) return;
  const speed = sim.speed;
  if (!tick.lastTime) tick.lastTime = performance.now();
  const now = performance.now();
  const dt = now - tick.lastTime;
  const interval = 700 / speed;
  if (dt >= interval) {
    const autoGrant = el('chk-auto-grant').checked;
    sim.stepForward({ autoGrant });
    refreshAll();
    tick.lastTime = now;
  }
  playHandle = requestAnimationFrame(tick);
}

/* ---------- UI Refresh ---------- */
function refreshLists() {
  const pList = el('proc-list');
  pList.innerHTML = '';
  sim.state.processes.forEach(p => {
    const li=document.createElement('li');
    li.innerHTML = `<span>${p.name}</span><span class="pill">${p.state}</span>`;
    pList.appendChild(li);
  });

  const rList = el('res-list');
  rList.innerHTML = '';
  sim.state.resources.forEach(r => {
    const li=document.createElement('li');
    li.innerHTML = `<span>${r.name}</span><span class="pill">${sim.state.availableOf(r.name)}/${r.total}</span>`;
    rList.appendChild(li);
  });

  el('event-proc').innerHTML = sim.state.processes.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
  el('event-res').innerHTML = sim.state.resources.map(r => `<option value="${r.name}">${r.name}</option>`).join('');
}

function refreshEventQueue() {
  const ol = el('event-queue');
  ol.innerHTML = '';
  sim.state.eventQueue.forEach((evt, idx) => {
    const li=document.createElement('li');
    li.textContent = `${idx+1}. ${evt.type.toUpperCase()} ${evt.process} ${evt.count}x ${evt.resource}`;
    ol.appendChild(li);
  });
}

function updateStatsAndLog() {
  const s = sim.state.getStats();
  const dead = s.deadlock ? `YES (involved: ${s.deadlock.involved.join(', ')}; cycles: ${s.deadlock.cycles.map(c=>`[${c.join('->')}]`).join(' ')})` : 'No';
  el('status-step').textContent = String(s.step);
  el('status-deadlock').innerHTML = s.deadlock ? `<span style="color: var(--danger)">YES</span>` : `<span style="color: var(--ok)">No</span>`;

  const procStr = s.processes.map(p => `  - ${p.name}: ${p.state}`).join('\n');
  const resStr = s.resources.map(r => `  - ${r.name}: total=${r.total} avail=${s.available[r.name]} assigned=${JSON.stringify(s.assigned[r.name]||{})}`).join('\n');
  const qStr = Object.entries(s.queues).map(([r, arr]) => `  - ${r}: [${arr.join(', ')}]`).join('\n');

  el('stats-content').textContent =
`Step: ${s.step}
Mode: ${sim.state.avoidance ? 'Avoidance' : 'Detection'}
Processes:
${procStr}
Resources:
${resStr}
Queues:
${qStr}
Pending events: ${s.pendingEvents}
Deadlock: ${dead}
History length: ${sim.history.length}
`;

  el('log-content').textContent = sim.state.logs.slice(-100).join('\n');
}

function refreshAll() {
  refreshLists();
  refreshEventQueue();
  renderer.layout();
  renderer.draw();
  updateStatsAndLog();
}

function statusState(msg){ el('status-state').textContent = msg; }
function log(msg){ sim.state.logs.push(msg); updateStatsAndLog(); }

/* ---------- Exports ---------- */
function exportScreenshot() {
  const canvas=el('canvas');
  const url=canvas.toDataURL('image/png');
  const a=el('download-link');
  a.href=url;
  a.download=`rag_screenshot_step${sim.state.step}.png`;
  a.click();
}

function exportTrace() {
  const trace=sim.exportTrace();
  const blob=new Blob([JSON.stringify({ trace, generatedAt:new Date().toISOString() }, null, 2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=el('download-link');
  a.href=url;
  a.download=`rag_trace_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------- Scenarios ---------- */
function loadSampleCycle() {
  sim.hardReset();
  sim.state.addProcess('P1');
  sim.state.addProcess('P2');
  sim.state.addResource('R1',1);
  sim.state.addResource('R2',1);
  sim.state.assignments['R1']['P1']=1;
  sim.state.assignments['R2']['P2']=1;
  sim.state.enqueueEvent({type:'request',process:'P1',resource:'R2',count:1});
  sim.state.enqueueEvent({type:'request',process:'P2',resource:'R1',count:1});
  sim.state.logs.push('Loaded sample: 2-process cycle deadlock scenario');
}
function loadSampleNoDeadlock() {
  sim.hardReset();
  sim.state.addProcess('P1'); sim.state.addProcess('P2'); sim.state.addProcess('P3');
  sim.state.addResource('R1',2); sim.state.addResource('R2',1);
  sim.state.assignments['R1']['P1']=1;
  sim.state.assignments['R1']['P2']=1;
  sim.state.enqueueEvent({type:'request',process:'P3',resource:'R1',count:1});
  sim.state.enqueueEvent({type:'release',process:'P1',resource:'R1',count:1});
  sim.state.enqueueEvent({type:'request',process:'P2',resource:'R2',count:1});
  sim.state.enqueueEvent({type:'release',process:'P2',resource:'R2',count:1});
  sim.state.logs.push('Loaded sample: No deadlock scenario');
}
function loadSampleThreeProcCycle() {
  sim.hardReset();
  sim.state.addProcess('P1'); sim.state.addProcess('P2'); sim.state.addProcess('P3');
  sim.state.addResource('R1',1); sim.state.addResource('R2',1); sim.state.addResource('R3',1);
  sim.state.assignments['R1']['P1']=1;
  sim.state.assignments['R2']['P2']=1;
  sim.state.assignments['R3']['P3']=1;
  sim.state.enqueueEvent({type:'request',process:'P1',resource:'R2',count:1});
  sim.state.enqueueEvent({type:'request',process:'P2',resource:'R3',count:1});
  sim.state.enqueueEvent({type:'request',process:'P3',resource:'R1',count:1});
  sim.state.logs.push('Loaded sample: 3-process cycle deadlock scenario');
}
function loadSampleContention() {
  sim.hardReset();
  sim.state.addProcess('P1'); sim.state.addProcess('P2'); sim.state.addProcess('P3'); sim.state.addProcess('P4');
  sim.state.addResource('CPU',2); sim.state.addResource('IO',1);
  sim.state.assignments['CPU']['P1']=1;
  sim.state.assignments['CPU']['P2']=1;
  sim.state.enqueueEvent({type:'request',process:'P3',resource:'CPU',count:1});
  sim.state.enqueueEvent({type:'request',process:'P4',resource:'IO',count:1});
  sim.state.enqueueEvent({type:'release',process:'P2',resource:'CPU',count:1});
  sim.state.enqueueEvent({type:'request',process:'P1',resource:'IO',count:1});
  sim.state.enqueueEvent({type:'release',process:'P4',resource:'IO',count:1});
  sim.state.enqueueEvent({type:'request',process:'P2',resource:'IO',count:1});
  sim.state.logs.push('Loaded sample: Contention scenario');
}

/* ---------- Helpers ---------- */
function el(id){ return document.getElementById(id); }

window.addEventListener('load', init);