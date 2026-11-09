# Rules for this project

1. Never write tests.
2. Never create, edit, or consider GitHub CI or workflow files.
3. If a plan exists, follow it exactly.
   - If a plan step is wrong or blocked, stop and ask.
   - Never deviate from the plan until the user confirms.
4. Before ending every session, delete everything inside `.cache/` and `build/`.
   - Keep the folders themselves.
   - Keep `.gitignore` files directly inside them.
   - Nothing else may remain.
