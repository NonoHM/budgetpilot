# The clumsy user: what a user would stumble into

Each case is a mistake, not an attack. The oracle is that the app says what happened and writes nothing
wrong. A 500, a blank screen or a wrong row is severity 4.

- Double-click the submit button; reload the page mid-action; press Back after a success and submit
  again. No duplicate rows, and the duplicate is named.
- Upload the wrong thing: a PDF, an image, an empty file, a `.xlsx` that is really a CSV, a CSV in
  UTF-16.
- Answer a question, then change the file; choose an account, then switch to another.
- Open the same flow in two tabs and finish both.
- Paste a very long name, and a name with emoji, into every free-text field the flow shows.
- Leave a required choice empty and submit.

Record for each: the sentence shown (quoted), the rows written (counts only, from the database), and
whether a reader could tell what to do next.
