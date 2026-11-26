# Agent instructions

## Default workflow
- Make the smallest change that fully solves the request.
- Keep the task narrowly scoped. Do not refactor, rename, reformat, or modify unrelated files.
- Start with the user's description and the most likely relevant code. Search for specific symbols or terms; do not inspect the entire repository unless the task genuinely requires it.
- Read only the files needed to understand and change the behavior. Expand the investigation only when evidence shows it is necessary.
- Do not print whole files, large directory listings, or full logs. Use targeted searches and show only relevant excerpts.
- Do not repeat searches, file reads, or commands when their results are already available in the current task.
- Do not delegate to subagents or run parallel investigations for a small, localized change.

## Before editing
- Briefly identify the likely file(s) and intended change. For a straightforward task, proceed without a lengthy plan.
- Check the relevant code and nearby conventions before editing; do not infer project structure or APIs without evidence.
- If the request is ambiguous in a way that could cause a wrong or broad change, ask one concise clarification. Otherwise use the narrowest reasonable interpretation.

## Editing and validation
- Preserve existing behavior outside the requested change.
- Prefer a focused patch over rewriting a file or introducing new abstractions.
- Run the most relevant, smallest available test or check. Do not run the full suite unless the change warrants it.
- If a check fails, report the failure accurately; do not spend multiple rounds investigating unrelated failures.
- Do not install dependencies, alter project configuration, or make unrelated cleanup changes unless required by the request.

## Response
- Keep the final response concise: summarize what changed and which relevant check was run.
- Mention important limitations or unverified behavior. Do not include a long exploration transcript.

