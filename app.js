// Shared utilities for TA Assignment prototype.
// All persistence in LocalStorage.

const LS_KEYS = {
  CURRENT_USER: 'taa.currentUser',
  STUDENT_RESPONSES: 'taa.studentResponses', // map netid -> response obj
  INSTRUCTOR_RESPONSES: 'taa.instructorResponses', // map courseId -> response obj
};

async function loadTSV(path) {
  const r = await fetch(path);
  const text = await r.text();
  const lines = text.trim().split('\n');
  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cols = line.split('\t');
    const row = {};
    headers.forEach((h, i) => row[h] = cols[i] || '');
    return row;
  });
}

async function loadAllData() {
  const [courses, faculty, students] = await Promise.all([
    loadTSV('courses.tsv'),
    loadTSV('faculty.tsv'),
    loadTSV('students.tsv')
  ]);
  // normalize numeric
  courses.forEach(c => {
    c.level = parseInt(c.level, 10);
    c.slots = parseInt(c.slots, 10);
    c.hasReqs = c.level >= 400; // 400+ have explicit requirements
  });
  students.forEach(s => { s.year = parseInt(s.year, 10); });
  return { courses, faculty, students };
}

// Deterministic pseudo-random so re-seeding is stable per netid
function seededRand(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function() {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return ((h >>> 0) % 10000) / 10000;
  };
}

function pickOne(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function buildSeededStudentResponse(student, courses, faculty) {
  const rng = seededRand(student.netid);
  const advisor = faculty.find(f => f.netid === student.advisor);

  // Faculty preferred: advisor + 1-2 area peers (excluding advisor)
  const peers = faculty.filter(f => f.area === student.area && f.netid !== student.advisor);
  const prefFaculty = [];
  if (advisor) prefFaculty.push(advisor.netid);
  const peerCount = Math.min(peers.length, 1 + Math.floor(rng() * 2));
  for (let i = 0; i < peerCount; i++) {
    const p = peers[Math.floor(rng() * peers.length)];
    if (p && !prefFaculty.includes(p.netid)) prefFaculty.push(p.netid);
  }
  // Avoid faculty: 0-1 random from outside area
  const avoidFaculty = [];
  if (rng() < 0.35) {
    const offArea = faculty.filter(f => f.area !== student.area && !prefFaculty.includes(f.netid));
    if (offArea.length) avoidFaculty.push(pickOne(rng, offArea).netid);
  }

  // Course ranks: bias toward A/B in matching area, especially lower-level
  const ranks = {};
  const taken = {};
  const priorTA = {};
  const aList = [];
  courses.forEach(c => {
    const areaMatch = c.area === student.area;
    const r = rng();
    let grade;
    if (c.hasReqs) {
      // 400-level: default F unless area match
      if (areaMatch && r < 0.45) grade = 'A';
      else if (areaMatch && r < 0.75) grade = 'B';
      else if (r < 0.10) grade = 'C';
      else grade = 'F';
    } else {
      // lower-level: default C
      if (r < 0.20) grade = 'A';
      else if (r < 0.50) grade = 'B';
      else if (r < 0.92) grade = 'C';
      else grade = 'F';
    }
    if (grade !== (c.hasReqs ? 'F' : 'C')) {
      // only store non-default to keep payload small
      ranks[c.course_id] = grade;
    }
    if (grade === 'A' || grade === 'B') {
      if (rng() < 0.45) {
        taken[c.course_id] = {
          took: true,
          sem: pickOne(rng, ['Fa23','Sp24','Fa24','Sp25']),
          prof: pickOne(rng, faculty).name.split(' ').slice(-1)[0],
          grade: pickOne(rng, ['A','A-','B+','A','A'])
        };
      }
      if (rng() < 0.30) {
        priorTA[c.course_id] = {
          tad: true,
          sem: pickOne(rng, ['Fa23','Sp24','Fa24','Sp25']),
          prof: pickOne(rng, faculty).name.split(' ').slice(-1)[0]
        };
      }
      if (grade === 'A') aList.push(c.course_id);
    }
  });

  // top 5 from A list
  const topFive = ['','','','',''];
  aList.slice(0, 5).forEach((cid, i) => topFive[i] = cid);

  const cppLevels = ['None','Minimal','Basic','Good','Very good','Excellent'];
  // Systems/Architecture/Parallel/PL bias toward higher C++
  const sysBias = ['Systems','Architecture','Parallel','PL','Graphics'].includes(student.area);
  const cppIdx = Math.min(5, Math.max(0,
    Math.floor((sysBias ? 2.5 : 1.5) + rng() * 3.5)));

  const apptOptions = ['50only','50pref','25pref','25only'];
  const apptWeights = student.program === 'MSc' ? [0.1, 0.5, 0.3, 0.1] : [0.2, 0.55, 0.2, 0.05];
  let apptR = rng(), apptSel = '50pref', acc = 0;
  for (let i = 0; i < apptOptions.length; i++) {
    acc += apptWeights[i];
    if (apptR <= acc) { apptSel = apptOptions[i]; break; }
  }

  const guarantee = student.program === 'MSc' ? 'na' : (student.year <= 5 ? 'yes' : 'no');
  const eligible = rng() < 0.92 ? 'yes' : (rng() < 0.5 ? 'exempt' : 'no');

  const unavailOptions = [
    '', '', '', // many have nothing
    'MWF 9-10am (CS 591 seminar)',
    'Tu/Th 11-12:15 (required course)',
    'MW 2-3:15pm (research group meeting)',
    'F 1-3pm (advisor meeting)'
  ];

  const priorTAStr = Object.entries(priorTA)
    .map(([cid, v]) => `${cid} (${v.sem} w/ ${v.prof})`).join(', ');

  return {
    fields: {
      advisor: advisor ? advisor.name : '',
      area: student.area,
      eligible,
      guarantee,
      quarter: rng() < 0.7 ? 'yes' : 'no',
      unavail: pickOne(rng, unavailOptions),
      cpp: cppLevels[cppIdx],
      priorTAList: priorTAStr,
      appt: apptSel,
    },
    state: {
      prefFaculty,
      avoidFaculty,
      ranks,
      taken,
      priorTA,
      topFive,
    }
  };
}

function ensureSeededStudentResponses(data) {
  const existing = getStudentResponses();
  if (Object.keys(existing).length > 0) return false;
  const all = {};
  data.students.forEach(s => {
    const r = buildSeededStudentResponse(s, data.courses, data.faculty);
    all[s.netid] = { ...r, updatedAt: new Date().toISOString(), seeded: true };
  });
  localStorage.setItem(LS_KEYS.STUDENT_RESPONSES, JSON.stringify(all));
  return true;
}

function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.CURRENT_USER) || 'null'); }
  catch { return null; }
}
function setCurrentUser(u) {
  localStorage.setItem(LS_KEYS.CURRENT_USER, JSON.stringify(u));
}

function getStudentResponses() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.STUDENT_RESPONSES) || '{}'); }
  catch { return {}; }
}
function saveStudentResponse(netid, data) {
  const all = getStudentResponses();
  all[netid] = { ...data, updatedAt: new Date().toISOString() };
  localStorage.setItem(LS_KEYS.STUDENT_RESPONSES, JSON.stringify(all));
}

function getInstructorResponses() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.INSTRUCTOR_RESPONSES) || '{}'); }
  catch { return {}; }
}
function saveInstructorResponse(key, data) {
  const all = getInstructorResponses();
  all[key] = { ...data, updatedAt: new Date().toISOString() };
  localStorage.setItem(LS_KEYS.INSTRUCTOR_RESPONSES, JSON.stringify(all));
}

// ---- Combobox: wraps a <select> with an input that supports substring search across label AND value ----
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function escapeHTML(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function enhanceSelect(selectEl, opts = {}) {
  if (!selectEl || selectEl.dataset.comboboxed === '1') return;
  selectEl.dataset.comboboxed = '1';
  selectEl.style.display = 'none';

  const wrap = document.createElement('span');
  wrap.className = 'combobox' + (opts.fullWidth === false ? '' : ' cb-block');

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'combobox-input';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const placeholderOpt = Array.from(selectEl.querySelectorAll('option')).find(o => o.value === '');
  input.placeholder = opts.placeholder || (placeholderOpt ? placeholderOpt.textContent : 'Type to search...');

  const popup = document.createElement('div');
  popup.className = 'combobox-popup';
  popup.style.display = 'none';

  wrap.appendChild(input);
  wrap.appendChild(popup);
  selectEl.parentNode.insertBefore(wrap, selectEl.nextSibling);

  function gatherOptions() {
    const out = [];
    Array.from(selectEl.children).forEach(child => {
      if (child.tagName === 'OPTGROUP') {
        Array.from(child.children).forEach(o => {
          if (o.value !== '') out.push({ value: o.value, label: o.textContent, group: child.label });
        });
      } else if (child.tagName === 'OPTION') {
        if (child.value !== '') out.push({ value: child.value, label: child.textContent });
      }
    });
    return out;
  }

  function syncFromSelect() {
    const sel = selectEl.options[selectEl.selectedIndex];
    input.value = (sel && sel.value) ? sel.textContent : '';
  }
  syncFromSelect();

  let currentMatches = [];
  let activeIdx = -1;

  function render(filter) {
    const all = gatherOptions();
    const needle = filter.toLowerCase().trim();
    const matches = !needle ? all : all.filter(o =>
      o.value.toLowerCase().includes(needle) ||
      o.label.toLowerCase().includes(needle)
    );
    currentMatches = matches;

    if (!matches.length) {
      popup.innerHTML = '<div class="combobox-empty">No matches</div>';
      popup.style.display = 'block';
      activeIdx = -1;
      return;
    }

    let lastGroup = null;
    const html = matches.slice(0, 200).map((m, i) => {
      const groupHeader = (m.group && m.group !== lastGroup)
        ? `<div class="combobox-group">${escapeHTML(m.group)}</div>` : '';
      if (m.group) lastGroup = m.group;
      let lbl = escapeHTML(m.label);
      if (needle) {
        lbl = lbl.replace(new RegExp('(' + escapeRegex(needle) + ')', 'gi'), '<mark>$1</mark>');
      }
      return `${groupHeader}<div class="combobox-item" data-idx="${i}" data-value="${escapeHTML(m.value)}">${lbl}</div>`;
    }).join('');
    if (matches.length > 200) {
      popup.innerHTML = html + `<div class="combobox-empty">…${matches.length - 200} more — keep typing to narrow</div>`;
    } else {
      popup.innerHTML = html;
    }
    popup.style.display = 'block';

    popup.querySelectorAll('.combobox-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        selectMatch(currentMatches[parseInt(el.dataset.idx, 10)]);
      });
    });
    activeIdx = matches.length === 1 ? 0 : -1;
    updateActive();
  }

  function updateActive() {
    const items = popup.querySelectorAll('.combobox-item');
    items.forEach((it, i) => it.classList.toggle('active', i === activeIdx));
    if (items[activeIdx]) items[activeIdx].scrollIntoView({ block: 'nearest' });
  }

  function selectMatch(m) {
    if (!m) return;
    selectEl.value = m.value;
    input.value = m.label;
    popup.style.display = 'none';
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', () => { input.select(); render(''); });
  input.addEventListener('input', () => render(input.value));
  input.addEventListener('blur', () => {
    setTimeout(() => { popup.style.display = 'none'; syncFromSelect(); }, 150);
  });
  input.addEventListener('keydown', e => {
    if (popup.style.display === 'none' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      render(input.value);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(currentMatches.length - 1, activeIdx + 1);
      updateActive();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(0, activeIdx - 1);
      updateActive();
    } else if (e.key === 'Enter') {
      if (currentMatches.length) {
        e.preventDefault();
        const pick = activeIdx >= 0 ? currentMatches[activeIdx] : currentMatches[0];
        selectMatch(pick);
      }
    } else if (e.key === 'Escape') {
      popup.style.display = 'none';
      input.blur();
    }
  });

  // Programmatic value changes: keep input label in sync via MutationObserver on options/value.
  const origDescriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  // Listen on the select's "change" too in case external code dispatched it.
  selectEl.addEventListener('change', () => {
    if (document.activeElement !== input) syncFromSelect();
  });
}

function enhanceAllSelects(root = document) {
  root.querySelectorAll('select[data-combobox]').forEach(s => enhanceSelect(s));
}

function buildHeader(activePage, data) {
  const user = getCurrentUser();
  const facOpts = data.faculty.map(f =>
    `<option value="faculty:${f.netid}" ${user && user.role==='faculty' && user.netid===f.netid ? 'selected':''}>Faculty — ${f.name} (${f.netid})</option>`
  ).join('');
  const stOpts = data.students.map(s =>
    `<option value="student:${s.netid}" ${user && user.role==='student' && user.netid===s.netid ? 'selected':''}>Student — ${s.name} (${s.netid}, ${s.program} Y${s.year})</option>`
  ).join('');

  const header = document.getElementById('app-header');
  header.innerHTML = `
    <div class="topbar">
      <div class="topbar-inner">
        <div class="brand"><span class="block-i">I</span>Siebel TA Matching</div>
        <nav class="topnav">
          <a href="index.html" class="${activePage==='home'?'active':''}">Home</a>
          <a href="student.html" class="${activePage==='student'?'active':''}">Student Form</a>
          <a href="instructor.html" class="${activePage==='instructor'?'active':''}">Instructor Form</a>
        </nav>
        <div class="user-switch">
          <span class="who">Acting as:</span>
          <select id="userSelect" data-combobox>
            <option value="">— Search faculty or students —</option>
            <optgroup label="Faculty">${facOpts}</optgroup>
            <optgroup label="Students">${stOpts}</optgroup>
          </select>
        </div>
      </div>
    </div>
  `;
  enhanceSelect(document.getElementById('userSelect'), { placeholder: 'Type name or netid…' });
  document.getElementById('userSelect').addEventListener('change', e => {
    const v = e.target.value;
    if (!v) { localStorage.removeItem(LS_KEYS.CURRENT_USER); location.reload(); return; }
    const [role, netid] = v.split(':');
    setCurrentUser({ role, netid });
    // Auto-route to appropriate form
    if (role === 'faculty' && activePage !== 'instructor') location.href = 'instructor.html';
    else if (role === 'student' && activePage !== 'student') location.href = 'student.html';
    else location.reload();
  });
}

function buildFooter() {
  const f = document.getElementById('app-footer');
  if (f) f.innerHTML = `<footer>Mock prototype — Siebel School of Computing &amp; Data Science · Data stored in your browser (LocalStorage) only</footer>`;
}
