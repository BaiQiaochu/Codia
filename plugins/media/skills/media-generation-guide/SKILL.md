# Media Generation

Use these tools when the user asks to create, edit, or animate media:

- `media_generate-image` for image creation, image editing, image variations, posters, covers, illustrations, avatars, logos, and visual concepts.
- `media_generate-video` for text-to-video, image-to-video, or short animation tasks.
- `media_describe-options` before using uncommon provider/model/mode/options fields.

Guidelines:

- Call the media tool directly for clear generation requests. Do not ask the user for a slash command.
- Prefer `referenceImages` or `image` with `{ "kind": "session_file", "fileId": "..." }` when the reference is already attached in the current session.
- Pass provider-specific advanced keys through `options` only after checking available options.
- For images, include `ratio`, `resolution`, `quality`, `model`, `mode`, and `provider` only when the user requested them or the task needs them.
- For videos, include `duration`, `ratio`, `resolution`, `mode`, `model`, and `provider` only when relevant.
- The tool submits asynchronous tasks. The UI will show pending generation cards and replace them with files when completed.
