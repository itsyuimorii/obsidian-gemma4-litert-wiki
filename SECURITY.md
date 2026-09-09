# Security

## What this plugin touches

Knowing the shape of the thing is most of assessing it, so:

- **Runs a model in Obsidian's own process.** Gemma 4 E4B through LiteRT-LM and WebGPU,
  in the renderer. No inference API, no server that accepts requests.
- **Reads and writes your vault** through the Obsidian API — the notes you point it at,
  and the `gemma-wiki/` folder it maintains. Raw notes are modified by exactly two
  commands, both previewed first.
- **Uses Node's `fs`** for two things the vault API cannot do: streaming the ~3 GB model
  and the WASM runtime to disk inside the plugin folder, and loading the runtime with
  `require()`. The surface is declared in one file, `src/node-api.ts`.
- **Runs a loopback HTTP server** on `127.0.0.1` at an ephemeral port while the plugin is
  loaded, so the WebGPU runtime can be handed the model over HTTP. It serves only files
  matching `litertlm_wasm_*internal.{js,wasm}` and the model, from the plugin folder, and
  nothing user-supplied reaches it.
- **Makes exactly two kinds of network request**, both one-time downloads: the model from
  Hugging Face and the runtime from jsDelivr, at a version pinned at build time. No
  telemetry, no analytics, no account.
- **Writes the clipboard**, never reads it — the copy button on answers and the
  benchmark reports.

Releases are built by GitHub Actions from a clean checkout, signed with
`attest-build-provenance`, and the community store rebuilds from source and confirms the
published `main.js` matches byte for byte. `gh attestation verify main.js -R
itsyuimorii/obsidian-gemma4-litert-wiki` checks the signature locally.

## Reporting a vulnerability

Please **do not open a public issue** for anything that could let a note, a model reply,
or a served file do something the user did not ask for.

Use GitHub's private reporting: **Security → Report a vulnerability** on this repository.
You will get a reply within a week. If the report is valid, a fix ships as a patch release
and the advisory is published once users have had a chance to update.

## Supported versions

The latest release only. The plugin is small enough that a fix is a new version, not a
backport.
