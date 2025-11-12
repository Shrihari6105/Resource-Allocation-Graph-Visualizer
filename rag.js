function deepClone(obj) {
  if (typeof structuredClone === 'function') return structuredClone(obj);
  return JSON.parse(JSON.stringify(obj));
}

/* ---------------------------- Data model ---------------------------- */

class Process {
  constructor(name) {
    this.name = name;
  this.state = 'ready'; // ready | blocked
  }
}

class Resource {
  constructor(name, instances = 1) {
    this.name = name;
    this.total = Math.max(1, Number(instances) || 1);
  }
}

class RAGState {
  constructor() {
    this.processes = [];
    this.resources = [];
    this.assignments = {};
    this.waitingRequests = {};
    this.eventQueue = [];
    this.step = 0;
    this.logs = [];
    this.avoidance = false;
  }

  getProcess(name) { return this.processes.find(p => p.name === name); }
  getResource(name) { return this.resources.find(r => r.name === name); }

  ensureResourceMaps(resName) {
    if (!this.assignments[resName]) this.assignments[resName] = {};
    if (!this.waitingRequests[resName]) this.waitingRequests[resName] = [];
  }

  availableOf(resName) {
    const r = this.getResource(resName);
    if (!r) return 0;
    const assigned = Object.values(this.assignments[resName] || {}).reduce((a,b)=>a+b,0);
    return r.total - assigned;
  }

  addProcess(name) {
    if (!name || this.getProcess(name)) return false;
    this.processes.push(new Process(name));
    return true;
  }

  addResource(name, instances) {
    if (!name || this.getResource(name)) return false;
    const res = new Resource(name, instances);
    this.resources.push(res);
    this.ensureResourceMaps(name);
    return true;
  }

  removeAll() {
    this.processes = [];
    this.resources = [];
    this.assignments = {};
    this.waitingRequests = {};
    this.eventQueue = [];
    this.step = 0;
    this.logs = [];
  }

  enqueueEvent(evt) { this.eventQueue.push(evt); }
  clearEvents() { this.eventQueue = []; }

  /* ---------------- Avoidance helpers ---------------- */

  static cycleUsesOnlySingleInstanceResources(cycleProcesses, state) {
    for (let i = 0; i < cycleProcesses.length; i++) {
      const waiter = cycleProcesses[i];
      const holder = cycleProcesses[(i + 1) % cycleProcesses.length];
      let foundEdge = false;
      for (const r of state.resources) {
        const resName = r.name;
        const q = state.waitingRequests[resName] || [];
        const holders = Object.keys(state.assignments[resName] || {});
        if (q.find(req => req.process === waiter) && holders.includes(holder)) {
          foundEdge = true;
          if (r.total > 1) return false;
        }
      }
      if (!foundEdge) return false;
    }
    return true;
  }

  static stateHasDefiniteCycle(nextState) {
    const deadInfo = RAGState.detectDeadlock(nextState);
    if (!deadInfo.hasCycle) return { hasCycle:false, definite:false, deadInfo };
    let allDefinite = true;
    for (const cyc of deadInfo.cycles) {
      if (!RAGState.cycleUsesOnlySingleInstanceResources(cyc, nextState)) {
        allDefinite = false;
        break;
      }
    }
    return { hasCycle:true, definite:allDefinite, deadInfo };
  }

  static addWaitWouldCreateDefiniteCycle(state, procName, resName, count) {
    const next = RAGState.from(state.serialize());
    next.ensureResourceMaps(resName);
    next.waitingRequests[resName].push({ process:procName, count:Math.max(1,Number(count)||1) });
    const proc = next.getProcess(procName);
    if (proc) proc.state = 'blocked';
    return RAGState.stateHasDefiniteCycle(next);
  }

  static grantWouldCreateDefiniteCycle(state, procName, resName, count) {
    const next = RAGState.from(state.serialize());
    next.ensureResourceMaps(resName);
    if (!next.assignments[resName][procName]) next.assignments[resName][procName] = 0;
    next.assignments[resName][procName] += Math.max(1, Number(count)||1);
    return RAGState.stateHasDefiniteCycle(next);
  }

  /* ---------------- Request / Release ---------------- */

  request(procName, resName, count=1, options={enqueueIfBlocked:true}) {
    const p=this.getProcess(procName), r=this.getResource(resName);
    if (!p || !r) return { ok:false, reason:'Invalid process or resource' };
    this.ensureResourceMaps(resName);
    count=Math.max(1,Number(count)||1);

    const avail=this.availableOf(resName);
    const canGrant=avail>=count;

    if (canGrant) {
      if (this.avoidance) {
        const { hasCycle, definite, deadInfo } = RAGState.grantWouldCreateDefiniteCycle(this, procName, resName, count);
        if (hasCycle && definite) {
          this.logs.push(`Avoided (definite cycle): granting ${count} ${resName} to ${procName} would create ${deadInfo.cycles.map(c=>'['+c.join('->')+']').join(' ')}`);
          return { ok:false, reason:'Avoided cycle (definite)' };
        } else if (hasCycle && !definite) {
          this.logs.push(`Allowed (potential cycle): granting ${count} ${resName} to ${procName} may form a multi-instance cycle.`);
        }
      }
      if (!this.assignments[resName][procName]) this.assignments[resName][procName]=0;
      this.assignments[resName][procName]+=count;
      this.logs.push(`Granted: ${procName} <- ${count} ${resName} (avail ${this.availableOf(resName)})`);
      return { ok:true, granted:true };
    } else {
      if (options.enqueueIfBlocked) {
        if (this.avoidance) {
          const { hasCycle, definite, deadInfo } = RAGState.addWaitWouldCreateDefiniteCycle(this, procName, resName, count);
            if (hasCycle && definite) {
              this.logs.push(`Avoided (definite cycle): queuing wait ${procName} → ${resName} would create ${deadInfo.cycles.map(c=>'['+c.join('->')+']').join(' ')}`);
              return { ok:false, reason:'Avoided waiting cycle (definite)' };
            } else if (hasCycle && !definite) {
              this.logs.push(`Allowed (potential cycle): queuing wait ${procName} → ${resName} may form a multi-instance cycle.`);
            }
        }
        this.waitingRequests[resName].push({ process:procName, count });
        p.state='blocked';
        this.logs.push(`Blocked: ${procName} waiting for ${count} ${resName}`);
        return { ok:true, granted:false, queued:true };
      }
      return { ok:false, reason:'Insufficient resources and not enqueued' };
    }
  }

  release(procName, resName, count=1) {
    const p=this.getProcess(procName), r=this.getResource(resName);
    if (!p || !r) return { ok:false, reason:'Invalid process or resource' };
    this.ensureResourceMaps(resName);
    count=Math.max(1,Number(count)||1);
    const held=this.assignments[resName][procName]||0;
    if (held<=0) {
      this.logs.push(`No-op: ${procName} holds 0 of ${resName}`);
      return { ok:true, released:0 };
    }
    const rel=Math.min(count,held);
    this.assignments[resName][procName]=held-rel;
    if (this.assignments[resName][procName]===0) delete this.assignments[resName][procName];
    this.logs.push(`Released: ${procName} -> ${rel} ${resName} (avail ${this.availableOf(resName)})`);
    this.tryGrantWaiting(resName);
    return { ok:true, released:rel };
  }

  tryGrantWaiting(resName) {
    this.ensureResourceMaps(resName);
    let i=0, changed=false;
    while (i < this.waitingRequests[resName].length) {
      const req=this.waitingRequests[resName][i];
      const avail=this.availableOf(resName);
      if (avail>=req.count) {
        if (this.avoidance) {
          const { hasCycle, definite } = RAGState.grantWouldCreateDefiniteCycle(this, req.process, resName, req.count);
          if (hasCycle && definite) { i++; continue; }
          else if (hasCycle && !definite) {
            this.logs.push(`Queue grant allowed (potential cycle) for ${req.process} on ${resName}.`);
          }
        }
        if (!this.assignments[resName][req.process]) this.assignments[resName][req.process]=0;
        this.assignments[resName][req.process]+=req.count;
        this.waitingRequests[resName].splice(i,1);
        const proc=this.getProcess(req.process);
        if (proc) proc.state='ready';
        this.logs.push(`Unblocked: ${req.process} granted ${req.count} ${resName} from queue`);
        changed=true;
      } else {
        i++;
      }
    }
    return changed;
  }

  /* ---------------- Deadlock detection ---------------- */

  static buildWFG(state) {
    const adj={}; for (const p of state.processes) adj[p.name]=new Set();
    for (const r of state.resources) {
      state.ensureResourceMaps(r.name);
      const holders=Object.keys(state.assignments[r.name]||{});
      const avail=state.availableOf(r.name);
      for (const req of state.waitingRequests[r.name]||[]) {
        if (avail>=req.count) continue;
        for (const h of holders) adj[req.process].add(h);
      }
    }
    const res={};
    Object.keys(adj).forEach(k => res[k]=Array.from(adj[k]));
    return res;
  }

  static detectCyclesInAdj(adj) {
    const color={}, stack=[], cycles=[];
    const WHITE=0, GRAY=1, BLACK=2;
    Object.keys(adj).forEach(k=>color[k]=WHITE);
    function dfs(u){
      color[u]=GRAY; stack.push(u);
      for (const v of adj[u]) {
        if (color[v]===WHITE) dfs(v);
        else if (color[v]===GRAY){
          const idx=stack.lastIndexOf(v);
          if (idx!==-1) cycles.push(stack.slice(idx));
        }
      }
      stack.pop(); color[u]=BLACK;
    }
    for (const u of Object.keys(adj)) if (color[u]===WHITE) dfs(u);
    const involved=new Set(); cycles.forEach(c=>c.forEach(x=>involved.add(x)));
    return { hasCycle: cycles.length>0, cycles, involved: Array.from(involved) };
  }

  static detectDeadlock(state){
    const wfg=RAGState.buildWFG(state);
    const r=RAGState.detectCyclesInAdj(wfg);
    return { hasCycle:r.hasCycle, cycles:r.cycles, involved:r.involved, wfg };
  }

  /* ---------------- Simulation step & stats ---------------- */

  stepForward(options={autoGrant:true}) {
    this.step+=1;
    if (this.eventQueue.length>0){
      const evt=this.eventQueue.shift();
      if (evt.type==='request') this.request(evt.process, evt.resource, evt.count, {enqueueIfBlocked:true});
      else if (evt.type==='release') this.release(evt.process, evt.resource, evt.count);
    } else if (options.autoGrant){
      let changed=false;
      for (const r of this.resources) changed=this.tryGrantWaiting(r.name)||changed;
      if (!changed) this.logs.push('No-op step: no pending events and nothing can be granted.');
    }
    for (const p of this.processes){
      let blocked=false;
      for (const r of this.resources){
        const q=this.waitingRequests[r.name]||[];
        if (q.find(req=>req.process===p.name)){ blocked=true; break; }
      }
      p.state=blocked?'blocked':'ready';
    }
    return true;
  }

  getStats(){
    const dead=RAGState.detectDeadlock(this);
    const available=Object.fromEntries(this.resources.map(r=>[r.name,this.availableOf(r.name)]));
    const assigned={}, queues={};
    for (const r of this.resources){
      assigned[r.name]=deepClone(this.assignments[r.name]||{});
      queues[r.name]=(this.waitingRequests[r.name]||[]).map(x=>`${x.process}:${x.count}`);
    }
    return {
      step:this.step,
      processes:this.processes.map(p=>({name:p.name,state:p.state})),
      resources:this.resources.map(r=>({name:r.name,total:r.total})),
      available, assigned, queues,
      pendingEvents:this.eventQueue.length,
      deadlock: dead.hasCycle ? { involved:dead.involved, cycles:dead.cycles } : null
    };
  }

  serialize(){
    return {
      processes:this.processes.map(p=>({name:p.name,state:p.state})),
      resources:this.resources.map(r=>({name:r.name,total:r.total})),
      assignments:deepClone(this.assignments),
      waitingRequests:deepClone(this.waitingRequests),
      eventQueue:deepClone(this.eventQueue),
      step:this.step,
      logs:deepClone(this.logs),
      avoidance:this.avoidance
    };
  }

  static from(data){
    const st=new RAGState();
    st.processes=(data.processes||[]).map(d=>{ const p=new Process(d.name); p.state=d.state; return p; });
    st.resources=(data.resources||[]).map(d=>new Resource(d.name,d.total));
    st.assignments=deepClone(data.assignments||{});
    st.waitingRequests=deepClone(data.waitingRequests||{});
    st.eventQueue=deepClone(data.eventQueue||[]);
    st.step=data.step||0;
    st.logs=deepClone(data.logs||[]);
    st.avoidance=!!data.avoidance;
    return st;
  }

  explainCurrentState(){
    const stats=this.getStats();
    const dead=stats.deadlock;
    const lines=[];
    lines.push(`Step ${stats.step}: ${stats.processes.length} processes, ${stats.resources.length} resources.`);
    const blocked=stats.processes.filter(p=>p.state==='blocked').map(p=>p.name);
    lines.push(blocked.length?`Blocked processes: ${blocked.join(', ')}.`:'No processes are currently blocked.');
    if (dead){
      for (const cyc of dead.cycles){
        const definite=RAGState.cycleUsesOnlySingleInstanceResources(cyc,this);
        lines.push(`Cycle [${cyc.join(' -> ')}]: ${definite?'definite deadlock':'potential deadlock (multi-instance)'} .`);
      }
    } else {
      lines.push('No wait-for cycle present.');
    }
    lines.push(`Avoidance Mode: ${this.avoidance?'ON':'OFF'}.`);
    return lines.join('\n');
  }
}

/* ---------------- Simulator ---------------- */

class Simulator {
  constructor(){
    this.state=new RAGState();
    this.history=[this.state.serialize()];
    this.playing=false;
    this.speed=1.0;
  }
  setAvoidance(on){ this.state.avoidance=!!on; }
  setSpeed(v){ this.speed=Math.max(0.1,Number(v)||1); }
  snapshot(){
    this.history.push(this.state.serialize());
    if (this.history.length>1000) this.history.shift();
  }
  canStepBack(){ return this.history.length>1; }
  stepForward(options){ this.state.stepForward(options); this.snapshot(); }
  stepBackward(){
    if (this.history.length>1){
      this.history.pop();
      const prev=this.history[this.history.length-1];
      this.state=RAGState.from(prev);
    }
  }
  resetToInitial(){
    if (this.history.length){
      const first=this.history[0];
      this.state=RAGState.from(first);
      this.history=[first];
    }
  }
  hardReset(){
    this.state=new RAGState();
    this.history=[this.state.serialize()];
  }
  exportTrace(){ return this.history.map(h=>deepClone(h)); }
}

/* ---------------- Renderer ---------------- */

class Renderer {
  constructor(canvas, simulator){
    this.canvas=canvas;
    this.ctx=canvas.getContext('2d');
    this.sim=simulator;
    this.pixelRatio=Math.max(1,window.devicePixelRatio||1);
    this.margin=40;
    this.nodeRadius=18;
    this.instanceDot=6;
    this.positions={};
    this.hover=null;
    this.showWFG=false;
    const ch=parseFloat(getComputedStyle(canvas).height);
    if (!ch || ch<40){
      canvas.style.minHeight='420px';
      canvas.style.height='50vh';
      canvas.style.maxHeight='720px';
      console.warn('[RAG] Canvas height was zero; applied fallback sizing.');
    }
    const cs=getComputedStyle(document.documentElement);
    this.colors={
      assign:cs.getPropertyValue('--edge-assign').trim()||'#44d37c',
      wait:cs.getPropertyValue('--edge-wait').trim()||'#ff6b6b',
      wfg:cs.getPropertyValue('--edge-wfg').trim()||'#9e8dff',
      cycle:'#ff2f6d'
    };
    this._resizeRaf=null;
    this._observer=null;
    const target=canvas.parentElement||canvas;
    try {
      this._observer=new ResizeObserver(()=>this.scheduleResize());
      this._observer.observe(target);
    } catch {}
    window.addEventListener('resize',()=>this.scheduleResize(),{passive:true});
    this.scheduleResize();
    this.initEvents();
    this.cyclePulse=0;
    this.animateCycleHighlight();
  }

  setShowWFG(on){ this.showWFG=!!on; }
  scheduleResize(){
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf=requestAnimationFrame(()=>{ this._resizeRaf=null; this.resize(); });
  }
  resize(){
    const rect=this.canvas.getBoundingClientRect();
    const cssW=Math.max(1,Math.round(rect.width||800));
    const cssH=Math.max(1,Math.round(rect.height||520));
    const targetW=Math.max(1,Math.floor(cssW*this.pixelRatio));
    const targetH=Math.max(1,Math.floor(cssH*this.pixelRatio));
    if (this.canvas.width!==targetW || this.canvas.height!==targetH){
      this.canvas.width=targetW;
      this.canvas.height=targetH;
      this.ctx.setTransform(this.pixelRatio,0,0,this.pixelRatio,0,0);
    }
    this.layout();
    this.draw();
  }

  layout(){
    const processes=this.sim.state.processes;
    const resources=this.sim.state.resources;
    const w=this.canvas.clientWidth || Math.round(this.canvas.width/this.pixelRatio);
    const h=this.canvas.clientHeight || Math.round(this.canvas.height/this.pixelRatio);
    const leftX=this.margin+80;
    const rightX=Math.max(w-this.margin-80,leftX+260);
    const pSpacing=Math.max(60,(h-2*this.margin)/Math.max(1,processes.length));
    const rSpacing=Math.max(60,(h-2*this.margin)/Math.max(1,resources.length));
    this.positions={};
    processes.forEach((p,i)=>{ this.positions[p.name]={x:leftX,y:this.margin+(i+0.5)*pSpacing,type:'P'}; });
    resources.forEach((r,i)=>{ this.positions[r.name]={x:rightX,y:this.margin+(i+0.5)*rSpacing,type:'R'}; });
  }

  drawNode(name,type,x,y,opts={}){
    const ctx=this.ctx, r=this.nodeRadius;
    ctx.save(); ctx.lineWidth=2;
    if (type==='P'){
      ctx.fillStyle='#141b4a'; ctx.strokeStyle=opts.stroke||'#5b74ff';
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillStyle='#141b4a'; ctx.strokeStyle=opts.stroke||'#67e8f9';
      const w=r*2, h=r*2;
      if (ctx.roundRect){
        ctx.beginPath(); ctx.roundRect(x-r,y-r,w,h,6); ctx.fill(); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.rect(x-r,y-r,w,h); ctx.fill(); ctx.stroke();
      }
    }
    ctx.fillStyle='#dfe6ff'; ctx.font='12px ui-monospace, monospace'; ctx.textAlign='center';
    ctx.fillText(name,x,y+r+14);
    ctx.restore();
  }

  drawEdge(x1,y1,x2,y2,color='#fff',style='solid',label=''){
    const ctx=this.ctx;
    ctx.save();
    ctx.strokeStyle=color;
    ctx.lineWidth=2;
    if (style==='dashed') ctx.setLineDash([6,6]);
    else if (style==='dotted') ctx.setLineDash([2,4]);
    const dx=x2-x1, dy=y2-y1;
    const len=Math.hypot(dx,dy)||1;
    const ux=dx/len, uy=dy/len;
    const pad=this.nodeRadius+3;
    const xStart=x1+ux*pad, yStart=y1+uy*pad;
    const xEnd=x2-ux*pad, yEnd=y2-uy*pad;
    ctx.beginPath(); ctx.moveTo(xStart,yStart); ctx.lineTo(xEnd,yEnd); ctx.stroke();
    const arrow=7;
    ctx.beginPath();
    ctx.moveTo(xEnd,yEnd);
    ctx.lineTo(xEnd-ux*10-uy*arrow,yEnd-uy*10+ux*arrow);
    ctx.lineTo(xEnd-ux*10+uy*arrow,yEnd-uy*10-ux*arrow);
    ctx.closePath();
    ctx.fillStyle=color; ctx.fill();
    if (label){
      ctx.fillStyle='#c8d2ff';
      ctx.font='11px ui-monospace, monospace';
      ctx.textAlign='center';
      ctx.fillText(label,(xStart+xEnd)/2,(yStart+yEnd)/2 - 6);
    }
    ctx.restore();
  }

  drawResourceInstances(r){
    const pos=this.positions[r.name]; if (!pos) return;
    const ctx=this.ctx;
    const total=r.total;
    const available=this.sim.state.availableOf(r.name);
    const assigned=total-available;
    const dotR=this.instanceDot;
    const startX=pos.x-24, startY=pos.y-this.nodeRadius-16;
    for (let i=0;i<total;i++){
      const x=startX+(i%6)*(dotR+4);
      const y=startY-Math.floor(i/6)*(dotR+4);
      ctx.beginPath();
      ctx.arc(x,y,dotR,0,Math.PI*2);
      ctx.fillStyle=i<assigned?'#67e8f9':'#1f2a66';
      ctx.fill();
      ctx.strokeStyle='#2b3876'; ctx.lineWidth=1; ctx.stroke();
    }
    ctx.fillStyle='#9aa5d1'; ctx.font='11px ui-monospace, monospace'; ctx.textAlign='left';
    ctx.fillText(`avail: ${available}/${total}`, pos.x - this.nodeRadius, pos.y + this.nodeRadius + 28);
  }

  drawQueues(){
    const state=this.sim.state;
    const ctx=this.ctx;
    for (const r of state.resources){
      const pos=this.positions[r.name]; if (!pos) continue;
      const q=state.waitingRequests[r.name]||[];
      if (!q.length) continue;
      ctx.fillStyle='#ffbd59'; ctx.font='11px ui-monospace, monospace'; ctx.textAlign='left';
      ctx.fillText(`Q: ${q.map(e=>`${e.process}:${e.count}`).join(', ')}`, pos.x - this.nodeRadius, pos.y + this.nodeRadius + 42);
    }
  }

  draw(){
    const ctx=this.ctx;
    const w=this.canvas.clientWidth || Math.round(this.canvas.width/this.pixelRatio);
    const h=this.canvas.clientHeight || Math.round(this.canvas.height/this.pixelRatio);
    ctx.clearRect(0,0,w,h);
    const state=this.sim.state;

    // Assignments
    for (const r of state.resources){
      const map=state.assignments[r.name]||{};
      for (const pName of Object.keys(map)){
        const cnt=map[pName];
        const from=this.positions[r.name], to=this.positions[pName];
        if (from && to) this.drawEdge(from.x,from.y,to.x,to.y,this.colors.assign,'solid',`${cnt}`);
      }
    }
    // Waiting
    for (const r of state.resources){
      const q=state.waitingRequests[r.name]||[];
      for (const req of q){
        const from=this.positions[req.process], to=this.positions[r.name];
        if (from && to) this.drawEdge(from.x,from.y,to.x,to.y,this.colors.wait,'dashed',`${req.count}`);
      }
    }
    // WFG overlay
    if (this.showWFG){
      const det=RAGState.detectDeadlock(state);
      for (const u of Object.keys(det.wfg)){
        for (const v of det.wfg[u]){
          const from=this.positions[u], to=this.positions[v];
          if (from && to) this.drawEdge(from.x,from.y,to.x,to.y,this.colors.wfg,'dotted','W');
        }
      }
    }
    // Cycle pulse
    const dead=RAGState.detectDeadlock(state);
    if (dead.hasCycle){
      const cycSet=new Set(dead.involved);
      const adj=dead.wfg;
      const alpha=0.4+0.3*Math.sin(this.cyclePulse);
      ctx.save(); ctx.globalAlpha=alpha;
      for (const u of Object.keys(adj)){
        if (!cycSet.has(u)) continue;
        for (const v of adj[u]){
          if (!cycSet.has(v)) continue;
          const from=this.positions[u], to=this.positions[v];
          if (from && to) this.drawEdge(from.x,from.y,to.x,to.y,this.colors.cycle,'solid','');
        }
      }
      ctx.restore();
    }
    // Nodes
    const deadset=new Set(dead.involved||[]);
    for (const p of state.processes){
      const pos=this.positions[p.name]; if (!pos) continue;
      const stroke=deadset.has(p.name)?'#ff2f6d':(p.state==='blocked'?'#ffbd59':'#5b74ff');
      this.drawNode(p.name,'P',pos.x,pos.y,{stroke});
    }
    for (const r of state.resources){
      const pos=this.positions[r.name]; if (!pos) continue;
      this.drawNode(r.name,'R',pos.x,pos.y,{stroke:'#67e8f9'});
      this.drawResourceInstances(r);
    }
    this.drawQueues();

    const t=document.getElementById('tooltip');
    if (this.hover){
      t.style.display='block';
      t.style.left=`${this.hover.x+12}px`;
      t.style.top=`${this.hover.y+12}px`;
      t.innerHTML=this.hover.text;
    } else {
      t.style.display='none';
    }
  }

  animateCycleHighlight(){
    this.cyclePulse+=0.06;
    this.draw();
    requestAnimationFrame(()=>this.animateCycleHighlight());
  }

  findHit(x,y){
    for (const [name,pos] of Object.entries(this.positions)){
      const r=this.nodeRadius;
      const dx=x-pos.x, dy=y-pos.y;
      if (Math.hypot(dx,dy)<=r+3) return { name, type:pos.type, x:pos.x, y:pos.y };
    }
    return null;
  }

  initEvents(){
    const c=this.canvas;
    c.addEventListener('mousemove',(e)=>{
      const rect=c.getBoundingClientRect();
      const x=e.clientX-rect.left, y=e.clientY-rect.top;
      const hit=this.findHit(x,y);
      if (hit){
        let text='';
        if (hit.type==='P'){
          const p=this.sim.state.getProcess(hit.name);
          text+=`Process ${p.name}\nState: ${p.state}`;
          const holds=[];
          for (const r of this.sim.state.resources){
            const cnt=(this.sim.state.assignments[r.name]||{})[p.name]||0;
            if (cnt>0) holds.push(`${r.name}:${cnt}`);
          }
          text+=`\nHolds: ${holds.join(', ')||'none'}`;
        } else {
          const r=this.sim.state.getResource(hit.name);
          const avail=this.sim.state.availableOf(r.name);
          const q=(this.sim.state.waitingRequests[r.name]||[]).map(x=>`${x.process}:${x.count}`);
          text+=`Resource ${r.name}\nTotal: ${r.total}\nAvailable: ${avail}\nQueue: ${q.join(', ')||'empty'}`;
        }
        this.hover={x,y,text:text.replace(/\n/g,'<br/>')};
      } else {
        this.hover=null;
      }
      this.draw();
    });
    c.addEventListener('mouseleave',()=>{ this.hover=null; this.draw(); });
  }
}

/* Expose globally */
window.OSViz={ Simulator, Renderer, RAGState };