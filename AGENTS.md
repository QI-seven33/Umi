# Umi repository guide

## Start here

- Product name: **Umi**. The local folder name `Umi_v2.0` is not the product name.
- Read `docs/handoff.zh-CN.md` for the latest dated handoff, then `docs/current-project-report.zh-CN.md` and `docs/code-reading-guide.zh-CN.md`.
- Run `git status` and inspect existing diffs before editing. Preserve user edits and learning annotations. Handoff facts are dated snapshots, not a guarantee that the working tree is still unchanged.
- The current implementation is `apps/` + `packages/`. The old Python backend is available in Git history; it is not required by the current runtime.

## Architecture

- Keep one Agent loop: `UmiApplication` assembles `AgentEngine`; desktop IPC calls the existing application.
- `packages/protocol` defines runtime schemas and pure state reduction; `packages/agent` owns orchestration/context/tools; adapters implement model, SQLite and host effects.
- Renderer access passes through fixed preload APIs, main, broker and the utility process. Do not expose arbitrary IPC channels, SQL, filesystem access or shell execution to the renderer.
- Persist dispatch and authority facts before effects; recovery reconciles unknown outcomes before deciding whether another execution is safe.
- Work-copy edits and source delivery are different authorities. Delivery uses a frozen ChangeSet and approval bound to the concrete request/environment.
- Host commands currently have no OS filesystem/network sandbox. Job management and cwd must not be described as that sandbox.
- Preserve raw history and source provenance. Context maintenance must preserve complete assistant tool-call/result groups.

## Development and verification

- Root npm package, Node `>=24.11.0 <25`; use the lockfile and existing scripts.
- `npm run dev` rebuilds desktop assets. `npm run desktop` uses existing dist. Portable release has a separate embedded dist and requires repackaging to receive source changes.
- Use the Umi quit menu to fully exit; closing the window hides it. A second instance may only focus the first instance.
- CSS loads `global.css`, `desktop.css`, then `surface.css`; inspect winning rules before adding another override.
- Match validation to the changed behavior and current user instructions. Report exactly what ran; historical acceptance counts are not current test results.
- Model verification scripts can spend money. Do not make them part of routine checks without task authorization; do not modify production conversation data for tests.
- Never commit API keys, personal databases/config/evidence, dependencies, dist or release artifacts. Existing `.gitignore` covers common locations.

## Collaboration and teaching

- Explain in clear Chinese when working with this user. Point to real files/functions and connect changes to actual execution flow.
- Keep UI controls compact, round corners consistent and process disclosures free of extra shadows. Consult the handoff for accepted visual choices.
- Preserve user preferences but follow the current request if it changes scope. A handoff is not permanent authorization to push, spend API credits or perform major redesigns.
- Update the dated handoff or current report when a substantial behavior changes, including remaining limitations and verification evidence.
