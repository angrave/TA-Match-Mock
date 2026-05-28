// Shared utilities for TA Assignment prototype.
// All persistence in LocalStorage.

const LS_KEYS = {
  CURRENT_USER: 'taa.currentUser',
  STUDENT_RESPONSES: 'taa.studentResponses', // map netid -> response obj
  INSTRUCTOR_RESPONSES: 'taa.instructorResponses', // map courseId -> response obj
  COURSE_OVERRIDES: 'taa.courseOverrides', // map courseId -> { slots?, allocTA? }
  DATA_VERSION: 'taa.dataVersion',
};

// Bump when the shape of seeded/stored data changes in a way that
// requires wiping LocalStorage and re-seeding from scratch.
const DATA_VERSION = 3;

// Wipe all app-owned LocalStorage so the next page load re-seeds demo data.
function resetAllDemoData() {
  localStorage.removeItem(LS_KEYS.STUDENT_RESPONSES);
  localStorage.removeItem(LS_KEYS.INSTRUCTOR_RESPONSES);
  localStorage.removeItem(LS_KEYS.COURSE_OVERRIDES);
  localStorage.removeItem(LS_KEYS.CURRENT_USER);
  localStorage.removeItem(LS_KEYS.DATA_VERSION);
}

// If the stored data version is missing or stale, wipe app data and stamp the
// current version so seeders rebuild on the next ensure* call.
function enforceDataVersion() {
  const stored = parseInt(localStorage.getItem(LS_KEYS.DATA_VERSION) || '0', 10);
  if (stored !== DATA_VERSION) {
    resetAllDemoData();
    localStorage.setItem(LS_KEYS.DATA_VERSION, String(DATA_VERSION));
  }
}

// Courses that by policy never get a TA, regardless of the TSV default.
// Senior Thesis, Independent Study (397/498/499), and CS124.
function policyDisallowsTA(c) {
  const id = c.course_id;
  if (id === 'CS397' || id === 'CS499' || id === 'CS498') return true;
  return false;
}

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
  enforceDataVersion();
  const [courses, faculty, students] = await Promise.all([
    loadTSV('courses.tsv'),
    loadTSV('faculty.tsv'),
    loadTSV('students.tsv')
  ]);
  // normalize numeric + apply allocTA defaults and admin overrides
  const overrides = getCourseOverrides();
  courses.forEach(c => {
    c.level = parseInt(c.level, 10);
    c.slots = parseInt(c.slots, 10);
    c.hasReqs = c.level >= 400; // 400+ have explicit requirements
    // allocTA: TSV value, then policy override, then admin override
    if (c.allocTA !== 'yes' && c.allocTA !== 'no') {
      c.allocTA = policyDisallowsTA(c) ? 'no' : 'yes';
    }
    if (policyDisallowsTA(c)) c.allocTA = 'no';
    const ov = overrides[c.course_id];
    if (ov) {
      if (typeof ov.slots === 'number' && !Number.isNaN(ov.slots)) c.slots = ov.slots;
      if ((ov.allocTA === 'yes' || ov.allocTA === 'no') && !policyDisallowsTA(c)) c.allocTA = ov.allocTA;
    }
  });
  students.forEach(s => {
    s.year = parseInt(s.year, 10);
    // Normalize guaranteed flag: explicit column wins; otherwise PhDs ≤5 yrs default yes, others no.
    if (s.guaranteed === 'yes' || s.guaranteed === 'no') {
      // keep as-is
    } else if (s.program === 'PhD' && s.year <= 5) {
      s.guaranteed = 'yes';
    } else {
      s.guaranteed = 'no';
    }
  });
  return { courses, faculty, students };
}

// Programs: "PhD", "MS", "MSc" are the recognized values. MS and MSc are both masters.
function isMastersProgram(p) { return p === 'MS' || p === 'MSc'; }
function isGuaranteed(s) { return s.guaranteed === 'yes'; }

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
  const priorTARows = [];
  const aList = [];
  courses.forEach(c => {
    if (c.allocTA !== 'yes') return;
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
        priorTARows.push({
          course: c.course_id,
          sem: pickOne(rng, ['Fa23','Sp24','Fa24','Sp25']),
          prof: pickOne(rng, faculty).name.split(' ').slice(-1)[0]
        });
      }
      if (grade === 'A') aList.push(c.course_id);
    }
  });

  // Cap A-ranked courses to 5; downgrade extras to B
  if (aList.length > 5) {
    aList.slice(5).forEach(cid => { ranks[cid] = 'B'; });
    aList.length = 5;
  }

  // top 5 from A list
  const topFive = ['','','','',''];
  aList.forEach((cid, i) => topFive[i] = cid);

  const cppLevels = ['None','Minimal','Basic','Good','Very good','Excellent'];
  // Systems/Architecture/Parallel/PL bias toward higher C++
  const sysBias = ['Systems','Architecture','Parallel','PL','Graphics'].includes(student.area);
  const cppIdx = Math.min(5, Math.max(0,
    Math.floor((sysBias ? 2.5 : 1.5) + rng() * 3.5)));

  const apptOptions = ['50only','50pref','25pref','25only'];
  const apptWeights = isMastersProgram(student.program) ? [0.1, 0.5, 0.3, 0.1] : [0.2, 0.55, 0.2, 0.05];
  let apptR = rng(), apptSel = '50pref', acc = 0;
  for (let i = 0; i < apptOptions.length; i++) {
    acc += apptWeights[i];
    if (apptR <= acc) { apptSel = apptOptions[i]; break; }
  }

  const guarantee = isGuaranteed(student) ? 'yes' : 'no';
  const eligible = rng() < 0.92 ? 'yes' : (rng() < 0.5 ? 'exempt' : 'no');

  const unavailOptions = [
    '', '', '', // many have nothing
    'MWF 9-10am (CS 591 seminar)',
    'Tu/Th 11-12:15 (required course)',
    'MW 2-3:15pm (research group meeting)',
    'F 1-3pm (advisor meeting)'
  ];

  return {
    fields: {
      advisor: advisor ? advisor.name : '',
      area: student.area,
      eligible,
      guarantee,
      unavail: pickOne(rng, unavailOptions),
      cpp: cppLevels[cppIdx],
      priorTARows,
      prevTA: priorTARows.length > 0 || rng() < 0.25,
      appt: apptSel,
    },
    state: {
      prefFaculty,
      avoidFaculty,
      ranks,
      taken,
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

function getCourseOverrides() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS.COURSE_OVERRIDES) || '{}'); }
  catch { return {}; }
}
function saveCourseOverride(courseId, patch) {
  const all = getCourseOverrides();
  all[courseId] = { ...(all[courseId] || {}), ...patch };
  localStorage.setItem(LS_KEYS.COURSE_OVERRIDES, JSON.stringify(all));
}
function clearCourseOverrides() {
  localStorage.removeItem(LS_KEYS.COURSE_OVERRIDES);
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

// Per-course mock requirements and preferences for 400-level electives.
const COURSE_MOCK_DATA = {
  CS400: { reqs: 'Strong CS fundamentals equivalent to CS225 and CS374 with grade >= A-.', prefs: 'Prior TA experience in introductory courses. Good communication skills.', duties: 'Hold 2 office hours per week. Grade weekly homework and exams. Provide 1-on-1 tutoring as needed.' },
  CS401: { reqs: 'Must have taken CS374 or equivalent with a grade of at least A-.', prefs: 'Post-qual PhD in Theory. Prior TA experience in algorithms or theory.', duties: 'Grade problem sets and exams. Hold 2 office hours per week. Provide detailed feedback on student proofs.' },
  CS407: { reqs: 'Graduate-level cryptography or number theory coursework required. Strong mathematical background (algebra, modular arithmetic).', prefs: 'Experience with cryptographic software libraries (OpenSSL, libsodium). PhD in Security or Theory preferred.', duties: 'Grade cryptography problem sets and programming labs. Hold 2 office hours per week. Proctor exams.' },
  CS409: { reqs: 'Proficiency in JavaScript, HTML, CSS, and at least one server-side framework (Node.js, Flask, Django). Must have built and deployed a web application.', prefs: 'Experience with modern frontend frameworks (React, Vue). Has taken CS409 before.', duties: 'Grade web development projects and code reviews. Hold 2 office hours per week. Help students debug frontend and backend issues.' },
  CS410: { reqs: 'Graduate coursework in NLP or information retrieval required. Must have Python proficiency and familiarity with IR evaluation metrics. Has taken CS410 or equivalent with grade >= A-.', prefs: 'Active NLP or IR research. Experience with Lucene, Elasticsearch, or HuggingFace. PhD in DAIS or AI preferred.', duties: 'Grade programming assignments and a semester project. Hold 2 office hours per week. Help with IR evaluation and Python debugging.' },
  CS411: { reqs: 'Must have taken CS411 or equivalent relational database course with a grade of at least A-. Strong SQL skills.', prefs: 'Experience with query optimization or storage engines. Has TA\'d CS411 before. DAIS PhD preferred.', duties: 'Grade SQL assignments and the final project. Hold 2 office hours per week. Help students debug queries and schema designs.' },
  CS412: { reqs: 'Must have taken CS412 or equivalent data mining course with grade >= B+. Strong Python and scikit-learn proficiency.', prefs: 'Research background in data mining or ML. Experience with large-scale datasets. DAIS PhD preferred.', duties: 'Grade machine learning programming assignments. Hold 2 office hours per week. Assist with project feedback and debugging.' },
  CS415: { reqs: 'Experience with a game engine (Unity, Unreal, or Godot) required. Strong C# or C++ skills. Has completed a game development project.', prefs: 'Prior game development or game jam experience. Experience with physics simulation or procedural generation.', duties: 'Grade game development projects and live demos. Hold 2 office hours per week. Help students debug Unity or Unreal projects.' },
  CS417: { reqs: 'Experience with XR development platforms (Unity XR, OpenXR, WebXR) required. Familiarity with 3D math (quaternions, transforms).', prefs: 'Has built and deployed a VR or AR application. Knowledge of spatial audio or haptics a plus.', duties: 'Grade XR development projects. Supervise lab sessions. Hold 2 office hours per week.' },
  CS418: { reqs: 'Must have taken CS418 or equivalent computer graphics course with grade >= A-. Strong C++ and OpenGL/WebGL skills.', prefs: 'Experience with real-time rendering pipelines. Has taken or TA\'d CS418 before. Graphics PhD preferred.', duties: 'Grade 3D graphics projects and exams. Hold 2 office hours per week. Help students debug OpenGL and shader code.' },
  CS421: { reqs: 'Must have taken CS225 and CS374 with grade >= B+. Familiarity with functional programming (OCaml, Haskell, or similar).', prefs: 'Experience with formal language theory and type systems. Prior TA of CS421 strongly preferred.', duties: 'Grade OCaml programming assignments and exams. Lead one 50-min discussion section per week. Hold 2 office hours per week.' },
  CS422: { reqs: 'Must have taken CS421 with a grade of at least A-. Is a PhD student in the Programming Languages group.', prefs: 'Post-qual PhD in PL. Research experience in type systems, semantics, or program analysis.', duties: 'Grade research-style problem sets and presentations. Hold 2 office hours per week. Assist in grading seminar participation.' },
  CS423: { reqs: 'Must have taken CS341 with a grade of at least A-. Strong C/C++ programming skills. Availability MWF 10–11am for discussion sections.', prefs: 'Experience with Linux kernel development or OS internals. Systems PhD preferred.', duties: 'Lead one 50-min discussion section per week (MWF 10–11am). Grade OS programming assignments in C. Hold 2 office hours per week and help debug kernel code.' },
  CS425: { reqs: 'Must have taken CS425 or equivalent distributed systems course with grade >= B+. Proficiency in Java or Go.', prefs: 'Has implemented distributed consensus protocols (Paxos, Raft). Research background in systems.', duties: 'Grade distributed systems programming assignments. Hold 2 office hours per week. Help students debug Go or Java implementations.' },
  CS426: { reqs: 'Must have taken CS421 with a grade of at least A-. Familiarity with compiler toolchains (LLVM, flex, bison).', prefs: 'Experience building interpreters or compilers. PhD student in PL or Systems preferred.', duties: 'Grade compiler projects (lexer, parser, code generation, optimization). Hold 2 office hours per week. Help students debug LLVM passes.' },
  CS427: { reqs: 'Must have taken CS222 or CS427 with grade >= B+. Strong software engineering practices (testing, CI/CD, design patterns).', prefs: 'Experience with Agile/Scrum in a team project. Familiarity with automated testing frameworks (JUnit, pytest).', duties: 'Facilitate weekly team lab sessions. Grade design documents, code reviews, and testing deliverables. Hold 2 office hours per week.' },
  CS433: { reqs: 'Must have taken CS233 with a grade of at least A-. Strong C and assembly programming skills (x86 or RISC-V).', prefs: 'Experience with hardware simulation (gem5, RISC-V toolchain). Architecture PhD preferred. Availability Tu/Th 2–3pm.', duties: 'Lead one 50-min discussion section per week. Grade architecture assignments and assembly programming labs. Hold 2 office hours per week.' },
  CS437: { reqs: 'Must have taken CS438 or equivalent networking course with grade >= B+. Experience with embedded systems or IoT platforms (Arduino, Raspberry Pi).', prefs: 'Hands-on experience with sensor networks or wireless protocols (Zigbee, LoRa). C and Python proficiency.', duties: 'Grade IoT programming assignments and project demos. Supervise lab sessions with hardware kits. Hold 2 office hours per week.' },
  CS438: { reqs: 'Must have taken a networking course (CS438 or equivalent) with grade >= B+. Strong C/Python programming skills.', prefs: 'Experience with network simulation tools (ns-3, Mininet). Knowledge of socket programming and TCP/IP internals.', duties: 'Grade socket programming and protocol implementation assignments. Hold 2 office hours per week. Help students debug network code with Wireshark.' },
  CS440: { reqs: 'Must have taken an AI or ML course with grade >= A-. Strong Python skills. Background in search, probabilistic reasoning, or planning.', prefs: 'Research background in AI. Familiarity with PDDL, Bayes nets, or reinforcement learning.', duties: 'Grade AI programming assignments and written problem sets. Hold 2 office hours per week. Answer questions on Ed/Piazza.' },
  CS441: { reqs: 'Must have taken CS446 or equivalent ML course with grade >= B+. Strong Python, NumPy, and scikit-learn proficiency.', prefs: 'Applied ML research experience. Comfortable with Jupyter notebooks, pandas, and experiment tracking.', duties: 'Grade ML programming assignments and a final project. Hold 2 office hours per week. Help students debug Python and scikit-learn code.' },
  CS444: { reqs: 'Must have taken CS446 with grade >= A- or an equivalent deep learning course. GPU computing experience required (PyTorch or TensorFlow on CUDA).', prefs: 'Active research in deep learning or computer vision. Experience training large models. PhD in AI area preferred.', duties: 'Grade deep learning assignments and a project using PyTorch. Hold 2 office hours per week. Help students debug GPU training issues.' },
  CS445: { reqs: 'Must have taken CS445 or equivalent image processing course with grade >= B+. Strong Python/NumPy and OpenCV skills.', prefs: 'Background in computational photography or vision. Experience with camera calibration or HDR imaging.', duties: 'Grade image processing programming assignments. Hold 2 office hours per week. Help students debug OpenCV and NumPy code.' },
  CS446: { reqs: 'Graduate coursework in machine learning required. Strong mathematical background (linear algebra, probability, optimization). Python proficiency required. Must have taken CS446 with grade >= A or equivalent.', prefs: 'Active ML research. PhD in AI area strongly preferred. Experience with PyTorch, JAX, or TensorFlow.', duties: 'Grade machine learning problem sets and programming assignments. Hold 3 office hours per week. Assist with proctoring and grading exams.' },
  CS447: { reqs: 'Graduate coursework in NLP required. Python proficiency and familiarity with HuggingFace transformers or spaCy. Must have taken CS447 or equivalent with grade >= A-.', prefs: 'Active NLP research. Experience with transformer-based models (BERT, GPT-family). PhD in AI area preferred.', duties: 'Grade NLP programming assignments and a final project. Hold 2 office hours per week. Help students debug transformer model code.' },
  CS450: { reqs: 'Must have taken CS357 with grade >= A-. Strong background in numerical analysis. Proficiency in Python (NumPy/SciPy), MATLAB, or Julia.', prefs: 'Is a PhD or MS student in Scientific Computing. Experience with PETSc, FEniCS, or similar scientific computing libraries.', duties: 'Grade numerical methods programming assignments. Hold 2 office hours per week. Help students debug Python, MATLAB, or Julia implementations.' },
  CS452: { reqs: 'Experience with ROS or equivalent robotics middleware required. C++ and Python proficiency required. Has conducted robotics research or coursework.', prefs: 'Is a PhD student in the Robotics group. Hands-on experience with physical robot platforms. Availability for lab sessions.', duties: 'Supervise weekly robot lab sessions. Grade project demos and written reports. Hold 2 office hours per week.' },
  CS460: { reqs: 'Must have taken CS461 with grade >= B+. Hands-on experience with security tools (Wireshark, GDB, Metasploit or equivalent).', prefs: 'CTF or security competition experience. Background in reverse engineering or vulnerability analysis.', duties: 'Grade security lab assignments and CTF-style challenges. Hold 2 office hours per week. Help students with Wireshark, GDB, and exploit tooling.' },
  CS461: { reqs: 'Strong background in OS and networking (CS341 and CS438 or equivalents). C programming proficiency required.', prefs: 'Prior security research experience. Has taken CS461 before with grade >= A-. Security PhD preferred.', duties: 'Grade security labs and written assignments. Hold 2 office hours per week. Proctor midterm and final exams.' },
  CS463: { reqs: 'Must have taken CS461 with grade >= A-. Is a PhD student with research background in computer security.', prefs: 'Post-qual PhD in Security. Active research in vulnerability analysis, network security, or applied cryptography.', duties: 'Grade advanced security assignments and research presentations. Hold 2 office hours per week. Help facilitate seminar discussions.' },
  CS466: { reqs: 'Graduate coursework in bioinformatics or computational biology required. Programming proficiency in Python and R. Familiarity with sequence alignment and genomic file formats.', prefs: 'Is a PhD student in the Bioinformatics group. Experience with phylogenetics, variant calling, or transcriptomics pipelines.', duties: 'Grade bioinformatics programming assignments in Python and R. Hold 2 office hours per week. Help students debug genomic data pipelines.' },
  CS470: { reqs: 'Graduate coursework in data mining or network science required. Strong Python skills. Has taken CS412 or CS470 with grade >= B+.', prefs: 'Research background in social networks, graph ML, or information diffusion. DAIS PhD preferred.', duties: 'Grade data mining and network analysis assignments. Hold 2 office hours per week. Provide feedback on semester projects.' },
  CS473: { reqs: 'Must have taken CS374 with grade >= A-. Strong mathematical background in combinatorics, graph theory, and algorithm analysis.', prefs: 'Is a post-qual PhD student in Theory. Has served as TA for CS374 or CS473 previously.', duties: 'Grade proof-based problem sets and exams. Hold 2 office hours per week. Provide detailed written feedback on student proofs.' },
  CS483: { reqs: 'Strong C/C++ programming skills required. Experience with MPI, OpenMP, or CUDA. Has taken CS433 or equivalent parallel computing course with grade >= B+.', prefs: 'Has experience with GPU computing (CUDA or ROCm). Is a PhD student in Parallel Computing. Experience with performance profiling.', duties: 'Grade parallel programming assignments (MPI, OpenMP, CUDA). Hold 2 office hours per week. Help students profile and optimize parallel code.' },
  CS484: { reqs: 'Strong C/C++ skills required. Experience with parallel programming frameworks (MPI, OpenMP, TBB). Has taken CS483 or CS484 with grade >= B+.', prefs: 'Experience with performance optimization and roofline analysis. GPU computing experience preferred. Parallel Computing PhD preferred.', duties: 'Grade high-performance computing assignments and a final project. Hold 2 office hours per week. Help students with performance optimization and roofline analysis.' },
  CS492: { reqs: 'Strong software engineering background. Experience leading a multi-person software project required.', prefs: 'Has taken CS427 or CS492 before. Comfortable with project management tools and code review practices.', duties: 'Facilitate team project check-ins and code reviews. Grade project deliverables and final demo. Hold 2 office hours per week.' },
  CS497: { reqs: 'Strong software engineering background. Experience with agile team project workflows required.', prefs: 'Has participated in a CS497 or equivalent capstone-style project. Good communication and mentoring skills.', duties: 'Mentor student project teams during weekly check-ins. Grade project milestones and final demonstrations. Hold 2 office hours per week.' },
  'CS498-AI':  { reqs: 'Graduate coursework in AI ethics, philosophy of technology, or STS required. Strong writing and analytical skills.', prefs: 'Research experience in AI fairness, accountability, or transparency. Cross-disciplinary background (philosophy, law, social science) welcomed.', duties: 'Grade written analyses and reflection papers on AI ethics topics. Facilitate weekly discussion sections. Hold 2 office hours per week.' },
  'CS498-BD':  { reqs: 'Experience with big data frameworks (Hadoop, Spark, Flink) required. Has taken CS411 or CS412 with grade >= B+.', prefs: 'Hands-on experience with distributed data processing at scale (HDFS, Kafka, Hive). DAIS PhD preferred.', duties: 'Grade big data programming assignments (Spark, Kafka). Hold 2 office hours per week. Help students debug distributed data jobs.' },
  'CS498-CG':  { reqs: 'Must have taken CS418 with grade >= A-. Strong OpenGL/GLSL shader programming experience. Familiarity with physically-based rendering concepts.', prefs: 'Experience with real-time rendering, ray tracing, or path tracing. Graphics PhD preferred.', duties: 'Grade advanced rendering projects. Hold 2 office hours per week. Help students debug GLSL shaders and rendering pipelines.' },
  'CS498-CL':  { reqs: 'Experience with cloud platforms (AWS, GCP, or Azure) required. Has taken CS425 or equivalent with grade >= B+.', prefs: 'Experience with containerization (Docker, Kubernetes) and infrastructure-as-code (Terraform, Ansible). Systems PhD preferred.', duties: 'Grade cloud infrastructure assignments. Hold 2 office hours per week. Help students configure AWS/GCP/Azure environments and debug IaC scripts.' },
  'CS498-IT':  { reqs: 'Has taken CS461 with grade >= B+. Experience with embedded security and IoT protocols (MQTT, CoAP, BLE) required.', prefs: 'Hands-on experience with hardware security (side-channel attacks, firmware analysis). Security PhD preferred.', duties: 'Grade IoT security lab assignments. Supervise hands-on hardware security sessions. Hold 2 office hours per week.' },
  'CS498-ML':  { reqs: 'Strong background in ML systems engineering. Has taken CS446 with grade >= A- and has experience with PyTorch or JAX at scale (multi-GPU or distributed training).', prefs: 'Experience with ML infrastructure (model serving, data pipelines, distributed training). PhD in AI or Systems preferred.', duties: 'Grade ML systems engineering assignments (distributed training, serving pipelines). Hold 2 office hours per week. Help students debug multi-GPU training setups.' },
  'CS498-QC':  { reqs: 'Graduate coursework in quantum computing or quantum information theory required. Strong background in linear algebra, probability, and quantum mechanics basics.', prefs: 'Is a PhD student in Theory. Experience with quantum programming frameworks (Qiskit, Cirq, PennyLane). Post-qual preferred.', duties: 'Grade quantum computing problem sets and programming assignments (Qiskit/Cirq). Hold 2 office hours per week. Help students debug quantum circuit code.' },
  'CS498-RK':  { reqs: 'Experience with educational robotics platforms (LEGO Mindstorms, VEX, Arduino) required. Strong communication and curriculum-delivery skills.', prefs: 'Prior K–12 outreach or teaching experience. PhD or MS in Robotics preferred.', duties: 'Supervise robotics lab and K–12 outreach sessions. Grade project demos and curriculum deliverables. Hold 2 office hours per week.' },
  'CS498-VR':  { reqs: 'Has taken CS418 with grade >= A-. Experience with Unity or Unreal Engine XR development required.', prefs: 'Research or shipped-project experience in VR/AR. Knowledge of spatial audio, haptics, or avatar systems a plus.', duties: 'Grade XR development projects. Supervise Unity/Unreal lab sessions. Hold 2 office hours per week.' },
  'CS498-AC':  { reqs: 'Graduate coursework in cryptography required. Has taken CS407 with grade >= A-. Familiarity with cryptographic protocol design.', prefs: 'Experience with cryptographic protocol implementation (TLS, zero-knowledge proofs). Security PhD preferred.', duties: 'Grade cryptography problem sets and protocol design assignments. Hold 2 office hours per week. Proctor exams.' },
  'CS498-DS':  { reqs: 'Strong Python and data analysis skills required. Has taken CS411 and CS412 with grades >= B+. Experience with data visualization.', prefs: 'Applied data science research or industry experience. Familiarity with matplotlib, seaborn, Plotly. DAIS PhD preferred.', duties: 'Grade data science projects and visualizations. Hold 2 office hours per week. Provide feedback on exploratory data analysis reports.' },
  'CS498-HC':  { reqs: 'Background in HCI or UX research required. Experience with user study design and IRB protocols.', prefs: 'Has conducted user studies or usability evaluations. Experience with prototyping tools (Figma, Sketch) and statistical analysis of user data.', duties: 'Grade HCI research reports and prototypes. Help facilitate user study sessions. Hold 2 office hours per week.' },
  CS510: { reqs: 'Post-qual PhD in Theory required. Must have taken CS473 or equivalent graduate algorithms course with grade >= A-.', prefs: 'Active research in algorithms, complexity, or combinatorics. Prior seminar facilitation experience a plus.', duties: 'Grade student problem sets and presentations. Help facilitate weekly seminar discussions. Hold office hours as needed.' },
  CS511: { reqs: 'Post-qual PhD in Programming Languages required. Strong background in type theory, semantics, or program analysis.', prefs: 'Active PL research with conference publications. Experience mentoring junior PhD students.', duties: 'Grade research problem sets. Lead paper discussion sessions. Hold office hours and mentor junior students.' },
  CS512: { reqs: 'Post-qual PhD in Systems required. Strong background in OS, distributed systems, or storage. Must have taken CS423 or CS425 with grade >= A-.', prefs: 'Active systems research. Experience reading and presenting research papers. Has TA\'d a systems course before.', duties: 'Grade systems research assignments. Lead paper reading discussion sessions. Hold office hours.' },
  CS513: { reqs: 'Post-qual PhD in Security required. Active security research with at least one publication or conference presentation.', prefs: 'Experience in vulnerability research, applied cryptography, or network security. CTF competition background a plus.', duties: 'Grade security research assignments and presentations. Hold office hours. Help facilitate seminar discussions.' },
  CS514: { reqs: 'Post-qual PhD in AI or ML required. Must have taken CS446 with grade >= A or equivalent graduate ML course. Active ML research.', prefs: 'Publications in top ML venues (NeurIPS, ICML, ICLR). Experience with large-scale training infrastructure.', duties: 'Grade ML research assignments and lead paper discussion sessions. Hold office hours. Mentor students on research project direction.' },
  CS515: { reqs: 'Post-qual PhD in Parallel Computing required. Strong HPC background (MPI, OpenMP, CUDA). Must have taken CS483 or CS484 with grade >= A-.', prefs: 'Experience with performance modeling and roofline analysis. Contributions to open-source parallel libraries a plus.', duties: 'Grade HPC research assignments. Lead paper discussion sessions. Hold office hours and help with performance profiling questions.' },
  CS516: { reqs: 'Post-qual PhD in DAIS required. Strong background in database systems, data mining, or large-scale data processing.', prefs: 'Active research in data management, stream processing, or learned systems. Experience with Spark or similar frameworks.', duties: 'Grade data systems assignments and research presentations. Lead seminar discussion sessions. Hold office hours.' },
  CS517: { reqs: 'Post-qual PhD in Scientific Computing required. Strong numerical analysis background. Must have taken CS450 or equivalent with grade >= A-.', prefs: 'Experience with PETSc, FEniCS, or high-performance linear solvers. Background in PDEs or scientific simulation preferred.', duties: 'Grade numerical analysis problem sets and programming assignments. Hold office hours. Help students with solver and simulation debugging.' },
  CS518: { reqs: 'Post-qual PhD in Architecture required. Must have taken CS433 or equivalent graduate architecture course with grade >= A-.', prefs: 'Experience with architectural simulation (gem5, RISC-V). Research background in microarchitecture, memory systems, or accelerators.', duties: 'Grade architecture research assignments and presentations. Hold office hours. Help facilitate seminar paper discussions.' },
  CS519: { reqs: 'Post-qual PhD in Robotics required. Active robotics research with ROS experience and hands-on work with physical platforms.', prefs: 'Experience in motion planning, perception, or human-robot interaction. Publications at robotics venues (ICRA, IROS, RSS).', duties: 'Supervise robotics lab sessions. Grade research project demos and reports. Hold office hours.' },
  CS520: { reqs: 'Post-qual PhD in Bioinformatics required. Active research in computational biology. Python and R proficiency required.', prefs: 'Experience with genomics pipelines, single-cell analysis, or structural biology. Publications in bioinformatics venues preferred.', duties: 'Grade bioinformatics research assignments and presentations. Hold office hours. Help students debug computational biology pipelines.' },
  CS521: { reqs: 'Post-qual PhD in Software Engineering required. Active SE research in testing, static analysis, program repair, or formal methods.', prefs: 'Experience with automated testing tools or formal verification. Publications at SE venues (ICSE, FSE, ASE) preferred.', duties: 'Grade SE research assignments and lead paper discussion sessions. Hold office hours. Help facilitate seminar logistics.' },
};

const AREA_DEFAULT_MOCK_DATA = {
  Theory:        { reqs: 'Must have taken CS374 with grade >= A-. Strong mathematical background required.', prefs: 'Post-qual PhD in Theory. Prior TA experience in algorithms preferred.', duties: 'Grade weekly problem sets and exams. Hold 2 office hours per week. Provide detailed written feedback on proofs.' },
  PL:            { reqs: 'Must have taken CS421 with grade >= A-. Is a PhD student in Programming Languages.', prefs: 'Post-qual PhD in PL. Research experience in type systems or program analysis.', duties: 'Grade programming assignments and exams. Hold 2 office hours per week. Help students debug functional programs during office hours.' },
  Systems:       { reqs: 'Must have taken CS341 with grade >= A-. Strong C/C++ programming skills.', prefs: 'Systems PhD preferred. Experience with Linux, networking, or distributed systems.', duties: 'Hold 2–3 office hours per week. Grade low-level C programming assignments. Help students debug system calls and memory issues.' },
  Security:      { reqs: 'Has taken CS461 with grade >= B+. Strong systems and networking background.', prefs: 'Security PhD preferred. CTF or vulnerability research experience.', duties: 'Grade lab assignments and written reports. Hold 2 office hours per week. Proctor midterm and final exams.' },
  AI:            { reqs: 'Has taken CS446 or equivalent ML course with grade >= B+. Strong Python skills.', prefs: 'PhD in AI area preferred. Active ML or AI research background.', duties: 'Grade programming assignments and written problem sets. Hold 2 office hours per week. Answer student questions on Piazza/Ed.' },
  Graphics:      { reqs: 'Has taken CS418 with grade >= A-. Strong C++ and graphics programming skills.', prefs: 'Graphics PhD preferred. Experience with 3D rendering or OpenGL.', duties: 'Grade rendering projects and exams. Hold 2 office hours per week. Help students debug shader and OpenGL/WebGL code.' },
  Parallel:      { reqs: 'Strong C/C++ skills. Experience with MPI, OpenMP, or CUDA required.', prefs: 'PhD in Parallel Computing group. Has experience with GPU computing.', duties: 'Grade parallel programming assignments. Hold 2 office hours per week. Help students profile and optimize parallel code.' },
  DAIS:          { reqs: 'Has taken CS411 or CS412 with grade >= B+. Strong Python and SQL skills.', prefs: 'DAIS PhD preferred. Research background in data management or mining.', duties: 'Grade SQL and Python data analysis assignments. Hold 2 office hours per week. Provide project feedback.' },
  SciComp:       { reqs: 'Has taken CS357 with grade >= A-. Strong numerical methods background.', prefs: 'PhD in Scientific Computing group. Proficiency in Python, MATLAB, or Julia.', duties: 'Grade numerical programming assignments. Hold 2 office hours per week. Help students debug Python, MATLAB, or Julia code.' },
  Bioinformatics:{ reqs: 'Graduate coursework in bioinformatics required. Python and R proficiency.', prefs: 'Bioinformatics PhD preferred. Experience with genomic data analysis.', duties: 'Grade programming assignments and lab reports. Hold 2 office hours per week. Help with bioinformatics pipeline debugging.' },
  Robotics:      { reqs: 'Experience with ROS required. C++ and Python proficiency.', prefs: 'Robotics PhD preferred. Hands-on experience with physical robot platforms.', duties: 'Supervise weekly lab sessions. Grade project demos and written reports. Hold 2 office hours per week.' },
  Architecture:  { reqs: 'Has taken CS233 with grade >= A-. Strong C and assembly skills.', prefs: 'Architecture PhD preferred. Experience with computer architecture simulation.', duties: 'Lead one 50-min discussion section per week. Grade assembly and C programming assignments. Hold 2 office hours per week.' },
  SE:            { reqs: 'Has taken CS222 or CS427 with grade >= B+. Strong software engineering background.', prefs: 'SE PhD preferred. Experience with testing, static analysis, or formal methods.', duties: 'Facilitate lab and team sessions. Grade code reviews and project deliverables. Hold 2 office hours per week.' },
  General:       { reqs: '', prefs: 'Prior TA experience preferred. Good communication skills.', duties: 'Hold 2 office hours per week. Grade homework and exams. Answer student questions on the course forum.' },
};

function buildSeededInstructorResponse(course, instructor, students, rng) {
  const entry = (course.level >= 400 ? COURSE_MOCK_DATA[course.course_id] : null)
    || AREA_DEFAULT_MOCK_DATA[course.area]
    || AREA_DEFAULT_MOCK_DATA['General'];

  // Thesis students for this instructor
  const thesisStudents = students.filter(s => s.advisor === instructor.netid);
  const thesisStr = thesisStudents.map(s => `${s.netid} (${s.program} Y${s.year})`).join(', ');

  // Preferred students: area-matching guaranteed PhDs first, shuffle deterministically
  const areaPool = students.filter(s => s.area === course.area);
  const shuffled = [...areaPool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // Guaranteed students first
  shuffled.sort((a, b) => (isGuaranteed(b) ? 1 : 0) - (isGuaranteed(a) ? 1 : 0));
  // Thesis students always appear in preferred list
  const thesisNetids = thesisStudents.map(s => s.netid);
  const prefBase = [...thesisNetids];
  for (const s of shuffled) {
    if (!prefBase.includes(s.netid) && prefBase.length < 3) prefBase.push(s.netid);
  }
  const prefStudents = prefBase.slice(0, Math.min(3, prefBase.length));

  // Backup: 1 extra from area pool, occasionally
  const backupStudents = [];
  const remaining = shuffled.filter(s => !prefStudents.includes(s.netid));
  if (remaining.length && rng() < 0.55) {
    backupStudents.push(remaining[0].netid);
  }

  // Avoid: 0–1 student from outside area, rarely
  const avoidStudents = [];
  if (rng() < 0.15) {
    const outsidePool = students.filter(s => s.area !== course.area && !isGuaranteed(s));
    if (outsidePool.length) avoidStudents.push(pickOne(rng, outsidePool).netid);
  }

  return {
    instructor: instructor.netid,
    course_id: course.course_id,
    fields: {
      course_id: course.course_id,
      area: course.level < 400 ? 'N/A' : course.area,
      thesis: thesisStr,
      reqs: entry.reqs,
      prefs: entry.prefs,
      duties: entry.duties || '',
    },
    state: { prefStudents, backupStudents, avoidStudents },
  };
}

function ensureSeededInstructorResponses(data) {
  const existing = getInstructorResponses();
  if (Object.keys(existing).length > 0) return false;

  // Group faculty by area for cycling assignment
  const facultyByArea = {};
  data.faculty.forEach(f => {
    if (!facultyByArea[f.area]) facultyByArea[f.area] = [];
    facultyByArea[f.area].push(f);
  });
  const areaIndex = {};

  const all = {};
  data.courses.forEach(c => {
    if (c.allocTA !== 'yes' || c.slots <= 0) return;
    const candidates = facultyByArea[c.area] || data.faculty;
    const idx = areaIndex[c.area] || 0;
    areaIndex[c.area] = idx + 1;
    const instructor = candidates[idx % candidates.length];
    const rng = seededRand(instructor.netid + '::' + c.course_id);
    const resp = buildSeededInstructorResponse(c, instructor, data.students, rng);
    const key = `${instructor.netid}::${c.course_id}`;
    all[key] = { ...resp, updatedAt: new Date().toISOString(), seeded: true };
  });
  localStorage.setItem(LS_KEYS.INSTRUCTOR_RESPONSES, JSON.stringify(all));
  return true;
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
          if (o.value !== '') out.push({ value: o.value, label: o.textContent, search: o.dataset.search || o.textContent, group: child.label });
        });
      } else if (child.tagName === 'OPTION') {
        if (child.value !== '') out.push({ value: child.value, label: child.textContent, search: child.dataset.search || child.textContent });
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
      o.search.toLowerCase().includes(needle)
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
      e.preventDefault();
      if (activeIdx >= 0 && currentMatches[activeIdx]) {
        selectMatch(currentMatches[activeIdx]);
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

  const showFaculty = activePage !== 'student';
  const showStudents = activePage !== 'instructor';
  const placeholder = activePage === 'instructor' ? '— Search faculty —'
                    : activePage === 'student'     ? '— Search students —'
                    : '— Search faculty or students —';
  const groupsHTML = showFaculty && showStudents
    ? `<optgroup label="Faculty">${facOpts}</optgroup><optgroup label="Students">${stOpts}</optgroup>`
    : showFaculty
    ? facOpts
    : stOpts;

  const header = document.getElementById('app-header');
  header.innerHTML = `
    <div class="topbar">
      <div class="topbar-inner">
        <div class="brand"><span class="block-i">I</span>Siebel TA Matching</div>
        <nav class="topnav">
          <a href="index.html" class="${activePage==='home'?'active':''}">Home</a>
          <a href="student.html" class="${activePage==='student'?'active':''}">Student Form</a>
          <a href="instructor.html" class="${activePage==='instructor'?'active':''}">Instructor Form</a>
          <a href="course.html" class="${activePage==='course'?'active':''}">Course Admin</a>
          <a href="assigner.html" class="${activePage==='assigner'?'active':''}">Assigner</a>
        </nav>
        <div class="user-switch">
          <span class="who">Acting as:</span>
          <select id="userSelect" data-combobox>
            <option value="">${placeholder}</option>
            ${groupsHTML}
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
  if (f) f.innerHTML = `<footer>Siebel School of Computing &amp; Data Science</footer>`;
}
