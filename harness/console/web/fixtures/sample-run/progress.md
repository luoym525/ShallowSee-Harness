# Progress (synthetic sample)

## Iteration 1 — W1 "Page layout and city search" — attempt 1 (builder: anthropic/claude-haiku-5-5)
- Build: done, commit a1c3e5f, files: index.html, styles.css, app.js
- Tests: 2/2 passed
- Decision: next

## Iteration 2 — W2 "Tomorrow's forecast and the umbrella verdict" — attempt 1 (builder: anthropic/claude-haiku-5-5)
- Build: done, commit b7d2e90, files: forecast.mjs, app.js
- Tests: 4/5 passed (A4 failed: expected "Take an umbrella" for 60% rain, got "No umbrella needed")
- Decision: escalate: read daily.precipitation_probability_max[1], not the hourly arrays
- Lessons: Open-Meteo daily values need daily= in the query string; index 1 is tomorrow

## Iteration 3 — W2 "Tomorrow's forecast and the umbrella verdict" — attempt 2 (builder: anthropic/claude-sonnet-5-5)
- Build: done, commit c4f9a12, files: forecast.mjs
- Tests: 5/5 passed
- Decision: next

## Iteration 4 — W3 "Friendly errors and a README" — attempt 1 (builder: anthropic/claude-haiku-5-5)
- Build: done, commit d81b0c3, files: app.js, README.md
- Tests: 7/7 passed
- Decision: finish
