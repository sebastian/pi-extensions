# AGENTS

This repository is a **jj (Jujutsu)** repository with a colocated Git repo.

## Workflow rules

- Use **jj** for repository workflow operations.
- **Start a new change** when beginning a new piece of work.
- **Describe every change** with a clear, meaningful change description before finishing the work.
- When the work is complete, **push the result to `main`**.

## Practical guidance

A typical flow is:

1. `jj new` when starting something new
2. make the changes
3. `jj commit -m "..."` or otherwise ensure the change has a good description
4. move `main` to the finished change if needed
5. push to `origin/main`
