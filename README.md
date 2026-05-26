# TA-to-Course Matching — Mock Prototype

A static, single-page-per-view mockup of a TA assignment system for the
Siebel School of Computing & Data Science (University of Illinois Urbana-Champaign).

The goal is to **showcase the workflow described in `PROCESS.md` and `NEEDs.md`** —
two web forms (student + instructor) plus an admin "Assigner" view that runs a
multi-phase course-proposing stable-marriage matching over the collected data.

> **Status:** prototype only. All data lives in your browser (`localStorage`).
> No backend, no authentication. Suitable for demos / requirements discussion.

---

## Quick start

The whole thing is static HTML/CSS/JS — host it anywhere that serves files.

**Locally:**
```bash
cd ta-assign-prototype1
python3 -m http.server 8080
# open http://localhost:8080/
```

**GitHub Pages:**
Commit the folder to a GitHub repo, enable Pages on the `main` branch root
(Settings → Pages → Source: Deploy from a branch). The site loads from
`https://<user>.github.io/<repo>/`.

A simple `file://` open won't work — the pages `fetch()` the TSV data files,
which requires HTTP(S).

---

## Pages

| File              | Purpose                                                                  |
|-------------------|---------------------------------------------------------------------------|
| `index.html`      | Landing page, summary of stored data, export/clear controls               |
| `student.html`    | Graduate student preference form                                          |
| `instructor.html` | Per-course instructor form (requirements, preferred / avoid students)     |
| `assigner.html`   | Admin view — runs multi-phase stable-marriage matching                    |

A persistent **"Acting as"** dropdown in the header switches identity between
any faculty member or student. The dropdown supports incremental search across
both display name and netid (typing `zo` finds Zoe Sullivan, `azone4`, etc).

---

## Data model

Three TSV files act as the read-only "directory":

- `courses.tsv` — ~80 CS courses (100–400 level), Fall 2026 line-up.
  500-level intentionally omitted. CS 498 is expanded into a dozen sections
  (e.g. `CS498-AI`, `CS498-CL`) with realistic section labels.
  Slot counts: 100–300 courses get 1–6, 400-level get 0–1.
- `faculty.tsv` — ~40 faculty (netid, name, primary research area).
- `students.tsv` — ~80 graduate students. netid format `[a-z]{7}[1-9]`.
  Program is `PhD` or `MSc`; PhD year captured for the 5-year funding-guarantee tier.

Submitted form responses live in `localStorage` under:
- `taa.studentResponses` — `{ netid → { fields, state, updatedAt } }`
- `taa.instructorResponses` — `{ "<instructorNetid>::<courseId>" → { fields, state, updatedAt } }`
- `taa.currentUser` — `{ role: "faculty" | "student", netid }`

The Assigner page reads these directly; nothing in this repo writes to a server.

---

## Auto-seeding

To make the demo immediately interactive, the app **automatically generates
realistic student responses for every student** the first time any page loads
with empty `localStorage`. Responses are deterministic per netid (seeded PRNG)
so the same student always gets the same generated answers across reloads.

Use the **Clear all local data** button on the home page (or your devtools
*Application → Local Storage → Clear*) to reset. The seed runs again on next load.

Instructor forms are **not** auto-seeded — there are too many possible
(instructor, course) pairings, and the right ones depend on who teaches what.
However, the Assigner page has an **"Auto-fill missing instructor forms"**
button that creates a minimal form for every course that doesn't yet have one,
picking an area-matched faculty member and three preferred students. Useful
for a one-click "show me a full matching run" demo.

---

## Matching process (Assigner page)

Implements the phased process described in `PROCESS.md`. Each phase is a fresh
many-to-one **Hospital-Residents** run (courses = hospitals, students = residents,
**courses do the proposing**) — i.e. the course-optimal stable matching. Previous
phases' assignments are **locked**; subsequent phases only consider students and
capacity that remain free.

| Phase | Eligible students                                  | Course capacity          |
|-------|-----------------------------------------------------|--------------------------|
| 2     | Guaranteed PhDs (program=PhD AND year ≤ 5)          | Initial quota            |
| 3     | + Post-year-5 PhDs                                  | Initial quota            |
| 4     | + MSc students                                      | Full slot count          |

- **Initial quota** = `slots` for Set A (400-level) courses, else `max(1, floor(slots/2))`.
- **Set A vs Set B** — Set A = 400-level (strong constraints expected per PROCESS.md);
  Set B = the rest. Unfilled Set A courses after Phase 2 trigger the
  "intervention may be needed" banner from the doc.

**Preference list construction**

- *Course's preference over students*: the instructor's `prefStudents` list
  (in order) first, then everyone else who finds the course acceptable, sorted by:
  the student's letter rank of the course (A → B → C, F excluded) →
  area match → funding tier → no-prior-TA tiebreaker → netid alphabetical.
  Any student in the instructor's `avoidStudents` list is excluded outright.
- *Student's preference over courses*: ranks A → B → C (F excluded), with the
  student's top-5 ordering imposed inside the A tier; area match breaks
  remaining ties.

**What's intentionally skipped for this MVP**

- Phase 0 (publishing constraints document)
- 48–72hr instructor preference-revision window between sub-rounds
- 25% ↔ 50% appointment upgrade pass (Phase 4a)
- Signed faculty advising agreement tiebreaker for non-guaranteed students

Re-running phases after editing form data approximates the revision rounds.

---

## Recommended demo script

1. **Open the home page.** Auto-seeding fills in ~80 student responses on first load.
2. **Switch to a faculty user** via "Acting as", e.g. `forsyth`. The Instructor Form
   opens. Pick a course (try `CS440 — Artificial Intelligence`), watch the
   "Smart suggestions" panel populate from saved student responses. Save.
3. **Switch to a student**, e.g. `amelia2`. Their pre-filled preferences are
   visible and editable. Show how the **Top 5** picker is auto-populated from
   A-ranked courses.
4. **Open the Assigner page.** Click **Auto-fill missing instructor forms** to
   give every course an instructor (one-time setup for a clean demo).
5. Click **Run Phase 2 ▶**, then 3, then 4. Watch the assignments panel fill in,
   colour-coded by fill state. The algorithm log explains proposals/acceptances/rejections.
6. Toggle filters (Set A only / Unfilled / etc) to highlight problem areas.

---

## File layout

```
ta-assign-prototype1/
├── index.html         # landing + summary of stored data
├── student.html       # student preference form
├── instructor.html    # instructor / per-course form
├── assigner.html      # phased matching admin view
├── app.js             # shared utilities (TSV loader, LocalStorage, combobox, header, seeding)
├── styles.css         # all styling (Illinois blue/orange palette, Siebel-ish header)
├── courses.tsv        # course directory
├── faculty.tsv        # faculty directory
├── students.tsv       # student directory
├── NEEDs.md           # original form-content requirements
├── PROCESS.md         # multi-phase matching process spec
└── README.md          # this file
```

---

## Known limitations & known-unknowns

- **No persistence beyond browser.** Clearing site data wipes everything.
  Use the **Export JSON** button on the home page to take a snapshot.
- **`CS 498` section labels are invented.** The Illinois course schedule didn't
  expose them when this was assembled; replace in `courses.tsv` once known.
- **Faculty/student names are mostly fabricated** to fit the requested netid patterns.
- **Eligibility checks are stub-grade.** A real system would verify language-exam
  status, course-grade prerequisites against student records, etc.
- **Algorithm correctness vs. realism.** This is a textbook HR implementation;
  ties broken deterministically by netid. Real-world ranking criteria
  (advisor agreement, prior-semester evaluations, time conflicts) are not yet wired in.

Pull requests / forks welcome.
